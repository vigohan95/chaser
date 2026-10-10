import type { Invoice, Transaction } from "../paypal/types";
import { isOpenInvoice, round2 } from "../paypal/types";

export type MatchKind = "exact" | "partial" | "combined" | "amount-only";

export interface Match {
  transaction_id: string;
  payer_email?: string;
  amount: number;
  kind: MatchKind;
  confidence: number; // 0..1
  /** Allocation of the payment across invoices. */
  allocations: Array<{ invoice_id: string; invoice_number: string; amount: number; closes: boolean }>;
  reasoning: string;
}

export interface ReconcileResult {
  matches: Match[];
  unmatched: Array<{ transaction_id: string; amount: number; payer_email?: string; memo?: string; reason: string }>;
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
 * Pure matcher: link successful, not-yet-linked payments to open invoices.
 * Signals in priority order: same payer + exact amount; same payer + sum of several invoices;
 * same payer + partial; amount-only (no payer match) as a low-confidence hint.
 */
export function matchTransactions(transactions: Transaction[], invoices: Invoice[], tolerance = 0.01): ReconcileResult {
  const open = invoices.filter(isOpenInvoice);
  const matches: Match[] = [];
  const unmatched: ReconcileResult["unmatched"] = [];
  const claimed = new Set<string>();

  const candidates = transactions
    .filter((t) => t.type === "PAYMENT" && t.status === "S" && !t.invoice_id && t.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  for (const t of candidates) {
    const email = t.payer_email?.toLowerCase();
    const memo = (t.memo ?? "").toLowerCase();
    const mine = open.filter((i) => !claimed.has(i.id) && email && i.client.email.toLowerCase() === email);

    // 1. Memo names an invoice number explicitly.
    const memoInv = mine.find((i) => memo.includes(i.invoice_number.toLowerCase()));
    if (memoInv && Math.abs(memoInv.due - t.amount) <= tolerance) {
      claimed.add(memoInv.id);
      matches.push(mk(t, "exact", 0.99, [[memoInv, t.amount]], `Memo references ${memoInv.invoice_number} and the amount equals the balance due.`));
      continue;
    }

    // 2. Same payer, exact balance.
    const exact = mine.find((i) => Math.abs(i.due - t.amount) <= tolerance);
    if (exact) {
      claimed.add(exact.id);
      matches.push(mk(t, "exact", 0.95, [[exact, t.amount]], `Payer ${t.payer_email} matches the client on ${exact.invoice_number} and the amount equals the balance due.`));
      continue;
    }

    // 3. Same payer, sum of several open invoices.
    const combos = subsetsSummingTo(mine, t.amount, tolerance);
    if (combos.length === 1) {
      const combo = combos[0];
      combo.forEach((i) => claimed.add(i.id));
      matches.push(
        mk(t, "combined", 0.9, combo.map((i) => [i, i.due] as [Invoice, number]), `Payer matches and the amount equals the combined balance of ${combo.map((i) => i.invoice_number).join(" + ")}.`),
      );
      continue;
    }

    // 4. Same payer, partial payment on the oldest open invoice.
    if (mine.length > 0 && t.amount < Math.max(...mine.map((i) => i.due))) {
      const target = [...mine].sort((a, b) => a.due_date.localeCompare(b.due_date)).find((i) => i.due > t.amount)!;
      claimed.add(target.id);
      matches.push(mk(t, "partial", mine.length === 1 ? 0.85 : 0.7, [[target, t.amount]], `Payer matches ${target.invoice_number}; amount is less than the balance, so this is a partial payment${memo.includes("part") ? " (memo says so too)" : ""}.`));
      continue;
    }

    // 5. Amount-only hint across all clients.
    const byAmount = open.filter((i) => !claimed.has(i.id) && Math.abs(i.due - t.amount) <= tolerance);
    if (byAmount.length === 1) {
      matches.push(mk(t, "amount-only", 0.4, [[byAmount[0], t.amount]], `Amount equals ${byAmount[0].invoice_number} but the payer email (${t.payer_email ?? "unknown"}) does not match the client. Needs a human look.`));
      continue;
    }

    unmatched.push({ transaction_id: t.id, amount: t.amount, payer_email: t.payer_email, memo: t.memo, reason: "No open invoice with a matching payer or amount." });
  }

  return { matches, unmatched };
}

function mk(t: Transaction, kind: MatchKind, confidence: number, allocs: Array<[Invoice, number]>, reasoning: string): Match {
  return {
    transaction_id: t.id,
    payer_email: t.payer_email,
    amount: t.amount,
    kind,
    confidence,
    allocations: allocs.map(([inv, amount]) => ({ invoice_id: inv.id, invoice_number: inv.invoice_number, amount: round2(amount), closes: Math.abs(inv.due - amount) <= 0.01 })),
    reasoning,
  };
}
