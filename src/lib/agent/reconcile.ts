import type { Invoice, Transaction } from "../paypal/types";
import { isOpenInvoice, round2, unappliedAmount } from "../paypal/types";

export type MatchKind = "exact" | "fee_adjusted" | "partial" | "combined" | "overpayment" | "ambiguous" | "amount-only" | "duplicate" | "refund";

/**
 * The named rule that produced a match. Finer than `kind` (the benchmark reports precision/recall per rule):
 *   memo_exact        invoice number in the memo, amount equals the balance
 *   memo_other_payer  invoice number in the memo, amount equals the balance, paid from an email that is not the client's
 *   partial_memo      invoice number in the memo, amount under the balance
 *   payer_exact       same payer, one open invoice with that balance
 *   fee_adjusted      same payer, amount equals a balance net of a PayPal fee (2.9% + $0.30 .. 3.49% + $0.49, or the transaction's own fee)
 *   combined          same payer, amount equals the sum of 2-4 open invoices
 *   duplicate         same payer, same amount as a payment applied in the last 3 days and no open invoice for it
 *   overpayment       same payer, at most $20 / 2% over exactly one balance (rounded up): closes it, remainder stays unapplied
 *   partial           same payer, less than the oldest open balance
 *   ambiguous         same payer, two or more invoices (or combinations) fit equally: shown for review, not recorded
 *   amount_only       unknown payer, exactly one open invoice with that balance: shown for review
 *   refund            a refund not linked by PayPal, matched to the payer's paid invoice
 */
export type MatchRule = "memo_exact" | "memo_other_payer" | "partial_memo" | "payer_exact" | "fee_adjusted" | "combined" | "duplicate" | "overpayment" | "partial" | "ambiguous" | "amount_only" | "refund";

/** What the agent should do with the match. `review` matches are never recorded without a human. */
export type MatchAction = "record_payment" | "record_refund" | "review";

export interface Match {
  transaction_id: string;
  payer_email?: string;
  amount: number;
  kind: MatchKind;
  rule: MatchRule;
  action: MatchAction;
  confidence: number; // 0..1
  /** Allocation of the payment across invoices (positive amounts; for a refund, the amount refunded against the invoice). */
  allocations: Array<{ invoice_id: string; invoice_number: string; amount: number; closes: boolean }>;
  reasoning: string;
  /** For duplicates: the earlier payment this one repeats. */
  related_transaction_id?: string;
  /** For fee-adjusted matches: the balance left on the invoice once the net amount is recorded (the fee). */
  fee_gap?: number;
}

export interface Unmatched {
  transaction_id: string;
  amount: number;
  payer_email?: string;
  memo?: string;
  reason: string;
  rule: "unmatched";
}

export interface ReconcileResult {
  matches: Match[];
  unmatched: Unmatched[];
}

export const ALL_RULES: Array<MatchRule | "unmatched"> = ["memo_exact", "memo_other_payer", "partial_memo", "payer_exact", "fee_adjusted", "combined", "duplicate", "overpayment", "partial", "ambiguous", "amount_only", "refund", "unmatched"];

/** PayPal's published fee bands (standard domestic 2.9% + $0.30 .. 3.49% + $0.49): a net amount is "fee adjusted" when gross - net sits inside them. */
export function feeBand(gross: number): { min: number; max: number } {
  return { min: round2(gross * 0.029 + 0.3), max: round2(gross * 0.0349 + 0.49) };
}

const DUPLICATE_WINDOW_DAYS = 3;
/** "Rounded up" tolerance for the overpayment rule: at most $20 or 2% over one balance. */
const OVERPAY_MAX_ABS = 20;
const OVERPAY_MAX_PCT = 0.02;

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Does the memo name this invoice? Accepts the number itself with any punctuation ("B-0001", "b 0001", "Invoice #INV-0013")
 * and "inv / invoice" followed by the digits ("inv 0013", "Inv. 0013", "invoice #13"). Bare numbers are not accepted.
 */
export function memoRefers(memo: string, invoiceNumber: string): boolean {
  if (!memo) return false;
  const m = norm(memo);
  const n = norm(invoiceNumber);
  if (n.length >= 4) {
    const idx = m.indexOf(n);
    if (idx >= 0 && !/\d/.test(m[idx + n.length] ?? "")) return true;
  }
  const digits = invoiceNumber.match(/(\d{3,6})\s*$/)?.[1];
  if (!digits) return false;
  return new RegExp(`\\binv(?:oice)?\\.?\\s*#?\\s*-?\\s*0*${Number(digits)}(?!\\d)`, "i").test(memo);
}

/** Enumerate subsets (size 2..maxSize) of invoices whose due amounts sum to `target`. */
function subsetsSummingTo(invs: Invoice[], target: number, tol: number, maxSize = 4): Invoice[][] {
  const out: Invoice[][] = [];
  const n = Math.min(invs.length, 12);
  const rec = (start: number, chosen: Invoice[], total: number) => {
    if (chosen.length >= 2 && Math.abs(total - target) <= tol) out.push([...chosen]);
    if (chosen.length >= maxSize || total > target + tol) return;
    for (let i = start; i < n; i++) rec(i + 1, [...chosen, invs[i]], round2(total + invs[i].due));
  };
  rec(0, [], 0);
  return out;
}

/**
 * Pure matcher: link successful, not-yet-linked payments (and refunds) to invoices.
 * Rules run in the order listed on MatchRule; the first that fits wins. Every match carries its rule, a confidence,
 * a reason and an action; `review` matches are for a human and are never recorded by the agent.
 */
export function matchTransactions(transactions: Transaction[], invoices: Invoice[], tolerance = 0.01): ReconcileResult {
  const open = invoices.filter(isOpenInvoice);
  const matches: Match[] = [];
  const unmatched: Unmatched[] = [];
  const claimed = new Set<string>();
  // Balance still open for each invoice after the allocations made earlier in this run (memo'd instalments stack).
  const remaining = new Map<string, number>(open.map((i) => [i.id, i.due]));
  const take = (inv: Invoice, amount: number) => remaining.set(inv.id, round2((remaining.get(inv.id) ?? inv.due) - amount));
  const byEmail = (email: string | undefined, ccy: string) => open.filter((i) => !claimed.has(i.id) && !!email && i.client.email.toLowerCase() === email && i.currency === ccy);
  const oldestFirst = (xs: Invoice[]) => [...xs].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.invoice_number.localeCompare(b.invoice_number));

  // A payment is a candidate while part of it is unapplied (never linked by PayPal, or only partly allocated here).
  const candidates = transactions
    .map((t) => ({ ...t, amount: unappliedAmount(t) }))
    .filter((t) => t.amount > 0.01)
    .sort((a, b) => b.amount - a.amount || a.date.localeCompare(b.date));
  const applied = transactions.filter((t) => t.type === "PAYMENT" && t.status === "S" && t.amount > 0 && (t.invoice_id || t.allocations?.length));

  for (const t of candidates) {
    const email = t.payer_email?.toLowerCase();
    const memo = t.memo ?? "";
    const mine = byEmail(email, t.currency);

    // 1-3. Memo names an invoice number.
    {
      const named = open.filter((i) => (remaining.get(i.id) ?? i.due) > 0.01 && i.currency === t.currency && memoRefers(memo, i.invoice_number));
      const own = named.filter((i) => i.client.email.toLowerCase() === email);
      const target = own[0] ?? named[0];
      if (target) {
        const samePayer = own.length > 0;
        const due = remaining.get(target.id) ?? target.due;
        if (Math.abs(due - t.amount) <= tolerance) {
          claimed.add(target.id);
          take(target, t.amount);
          matches.push(mk(t, "exact", samePayer ? "memo_exact" : "memo_other_payer", "record_payment", samePayer ? 0.99 : 0.85, [[target, t.amount]], samePayer ? `Memo references ${target.invoice_number} and the amount equals the balance due.` : `Memo references ${target.invoice_number} and the amount equals the balance due; paid from ${t.payer_email ?? "an unknown email"} rather than the client's ${target.client.email}.`, due));
          continue;
        }
        if (samePayer && t.amount < due) {
          claimed.add(target.id);
          take(target, t.amount);
          matches.push(mk(t, "partial", "partial_memo", "record_payment", 0.9, [[target, t.amount]], `Memo references ${target.invoice_number}; ${fmt(t.amount)} is less than the ${fmt(due)} balance, so this is a partial payment${due !== target.due ? ` (after ${fmt(round2(target.due - due))} already allocated in this batch)` : ""}.`, due));
          continue;
        }
        if (samePayer) {
          const band = feeBand(due);
          const gap = round2(due - t.amount);
          if (gap >= band.min - tolerance && gap <= band.max + tolerance) {
            claimed.add(target.id);
            take(target, t.amount);
            matches.push({ ...mk(t, "fee_adjusted", "fee_adjusted", "record_payment", 0.9, [[target, t.amount]], `Memo references ${target.invoice_number}; ${fmt(t.amount)} is the ${fmt(due)} balance net of a ${fmt(gap)} PayPal fee.`, due), fee_gap: gap });
            continue;
          }
        }
      }
    }

    // 4. Same payer, exact balance (two equal balances = ambiguous, left for review).
    const exact = mine.filter((i) => Math.abs(i.due - t.amount) <= tolerance);
    if (exact.length === 1) {
      claimed.add(exact[0].id);
      take(exact[0], t.amount);
      matches.push(mk(t, "exact", "payer_exact", "record_payment", 0.95, [[exact[0], t.amount]], `Payer ${t.payer_email} matches the client on ${exact[0].invoice_number} and the amount equals the balance due.`));
      continue;
    }
    if (exact.length > 1) {
      const pick = oldestFirst(exact)[0];
      matches.push(mk(t, "ambiguous", "ambiguous", "review", 0.5, [[pick, t.amount]], `Payer matches, but ${exact.map((i) => i.invoice_number).join(" and ")} both have a ${fmt(t.amount)} balance and the memo does not say which. Oldest shown; needs a human.`));
      continue;
    }

    // 5. Same payer, amount is a balance net of a PayPal fee.
    const net = mine.filter((i) => {
      const gap = round2(i.due - t.amount);
      const band = feeBand(i.due);
      const ownFee = t.fee > 0 && Math.abs(round2(t.amount + t.fee) - i.due) <= tolerance;
      return ownFee || (gap >= band.min - tolerance && gap <= band.max + tolerance);
    });
    if (net.length === 1) {
      const inv = net[0];
      const gap = round2(inv.due - t.amount);
      claimed.add(inv.id);
      take(inv, t.amount);
      matches.push({ ...mk(t, "fee_adjusted", "fee_adjusted", "record_payment", 0.85, [[inv, t.amount]], `Payer matches ${inv.invoice_number}; ${fmt(t.amount)} is the ${fmt(inv.due)} balance less a ${fmt(gap)} fee (PayPal's 2.9% + $0.30 to 3.49% + $0.49 band). Record it and write the fee gap off.`), fee_gap: gap });
      continue;
    }

    // 6. Same payer, sum of several open invoices.
    const combos = subsetsSummingTo(oldestFirst(mine), t.amount, tolerance);
    if (combos.length === 1) {
      const combo = combos[0];
      combo.forEach((i) => {
        claimed.add(i.id);
        take(i, i.due);
      });
      matches.push(mk(t, "combined", "combined", "record_payment", 0.9, combo.map((i) => [i, i.due] as [Invoice, number]), `Payer matches and the amount equals the combined balance of ${combo.map((i) => i.invoice_number).join(" + ")}.`));
      continue;
    }
    if (combos.length > 1) {
      matches.push(mk(t, "ambiguous", "ambiguous", "review", 0.5, combos[0].map((i) => [i, i.due] as [Invoice, number]), `Payer matches and ${combos.length} different combinations of invoices add up to ${fmt(t.amount)} (${combos.map((c) => c.map((i) => i.invoice_number).join("+")).join(" or ")}). First shown; needs a human.`));
      continue;
    }

    // 7. Same payer, a little over exactly one balance (rounded up): close it, keep the rest unapplied.
    const over = mine.filter((i) => t.amount > i.due + tolerance && round2(t.amount - i.due) <= Math.max(OVERPAY_MAX_ABS, i.due * OVERPAY_MAX_PCT));
    if (over.length === 1) {
      const target = over[0];
      claimed.add(target.id);
      take(target, target.due);
      matches.push(mk(t, "overpayment", "overpayment", "record_payment", 0.7, [[target, target.due]], `Payer matches ${target.invoice_number} and ${fmt(t.amount)} is ${fmt(round2(t.amount - target.due))} over its ${fmt(target.due)} balance (rounded up); the balance closes the invoice and the rest stays unapplied for you.`));
      continue;
    }

    // 8. Duplicate: the same payer paid the same amount in the same currency within 3 days and that payment is already applied.
    const earlier = [...applied, ...matches.filter((m) => m.action === "record_payment").map((m) => transactions.find((x) => x.id === m.transaction_id)!)].find(
      (p) => p && p.id !== t.id && p.currency === t.currency && p.payer_email?.toLowerCase() === email && Math.abs(p.amount - t.amount) <= tolerance && Math.abs(new Date(p.date).getTime() - new Date(t.date).getTime()) <= DUPLICATE_WINDOW_DAYS * 86_400_000,
    );
    if (earlier && email) {
      const first = transactions.find((x) => x.id === earlier.id)!;
      const number = first.allocations?.map((a) => a.invoice_number).join(" + ") || invoices.find((i) => i.id === first.invoice_id)?.invoice_number || matches.find((m) => m.transaction_id === first.id)?.allocations.map((a) => a.invoice_number).join(" + ") || "an invoice";
      matches.push({ ...mk(t, "duplicate", "duplicate", "review", 0.8, [], `Looks like a duplicate: ${t.payer_email} already paid ${fmt(t.amount)} on ${first.date.slice(0, 10)} (${first.id}, applied to ${number}) and no open invoice for this amount remains. Refund or apply by hand.`), related_transaction_id: first.id });
      continue;
    }

    // 9. Same payer, partial payment on the oldest open invoice.
    if (mine.length > 0 && t.amount < Math.max(...mine.map((i) => i.due))) {
      const target = oldestFirst(mine).find((i) => i.due > t.amount)!;
      claimed.add(target.id);
      take(target, t.amount);
      matches.push(mk(t, "partial", "partial", "record_payment", mine.length === 1 ? 0.85 : 0.7, [[target, t.amount]], `Payer matches ${target.invoice_number}; amount is less than the balance, so this is a partial payment${/\bpart/i.test(memo) ? " (memo says so too)" : ""}.`));
      continue;
    }

    // 10. Amount-only hint across all clients.
    const byAmount = open.filter((i) => !claimed.has(i.id) && i.currency === t.currency && Math.abs(i.due - t.amount) <= tolerance);
    if (byAmount.length === 1) {
      matches.push(mk(t, "amount-only", "amount_only", "review", 0.4, [[byAmount[0], t.amount]], `Amount equals ${byAmount[0].invoice_number} but the payer email (${t.payer_email ?? "unknown"}) does not match the client. Needs a human look.`));
      continue;
    }

    const otherCcy = open.some((i) => i.client.email.toLowerCase() === email && i.currency !== t.currency);
    unmatched.push({ transaction_id: t.id, amount: t.amount, payer_email: t.payer_email, memo: t.memo, rule: "unmatched", reason: otherCcy ? `Payer matches invoices in another currency (payment is ${t.currency}); PayPal records invoice payments in the invoice currency, so this is not one of them.` : mine.length ? "Payer matches but no open invoice or combination fits the amount." : "No open invoice with a matching payer or amount." });
  }

  // 11. Refunds PayPal did not link: match to the payer's paid invoice (a refund with no payer has nothing to match on).
  for (const t of transactions.filter((x) => x.type === "REFUND" && x.status === "S" && x.amount < 0 && !x.invoice_id && x.payer_email)) {
    const email = t.payer_email?.toLowerCase();
    const amount = round2(-t.amount);
    const paidByPayer = invoices.filter((i) => i.client.email.toLowerCase() === email && i.paid >= amount - tolerance && i.currency === t.currency && i.status !== "DRAFT");
    const named = paidByPayer.find((i) => memoRefers(t.memo ?? "", i.invoice_number));
    const pick = named ?? (paidByPayer.length === 1 ? paidByPayer[0] : paidByPayer.find((i) => Math.abs(i.paid - amount) <= tolerance));
    if (pick) {
      matches.push({ transaction_id: t.id, payer_email: t.payer_email, amount: t.amount, kind: "refund", rule: "refund", action: "record_refund", confidence: named ? 0.95 : paidByPayer.length === 1 ? 0.85 : 0.7, allocations: [{ invoice_id: pick.id, invoice_number: pick.invoice_number, amount, closes: false }], reasoning: `Refund of ${fmt(amount)} to ${t.payer_email}${named ? `; memo references ${pick.invoice_number}` : paidByPayer.length === 1 ? `; ${pick.invoice_number} is their only paid invoice` : `; ${pick.invoice_number} was paid for exactly this amount`}. Record with record_refund_for_invoice.` });
    } else {
      unmatched.push({ transaction_id: t.id, amount: t.amount, payer_email: t.payer_email, memo: t.memo, rule: "unmatched", reason: paidByPayer.length ? "Refund fits several of the payer's paid invoices and the memo does not say which." : "Refund to a payer with no paid invoice covering it." });
    }
  }

  return { matches, unmatched };
}

const fmt = (n: number) => `$${n.toFixed(2)}`;

function mk(t: Transaction, kind: MatchKind, rule: MatchRule, action: MatchAction, confidence: number, allocs: Array<[Invoice, number]>, reasoning: string, openBalance?: number): Match {
  return {
    transaction_id: t.id,
    payer_email: t.payer_email,
    amount: t.amount,
    kind,
    rule,
    action,
    confidence,
    allocations: allocs.map(([inv, amount]) => ({ invoice_id: inv.id, invoice_number: inv.invoice_number, amount: round2(amount), closes: Math.abs((openBalance ?? inv.due) - amount) <= 0.01 })),
    reasoning,
  };
}
