"use client";

import { AllCommunityModule, ModuleRegistry, colorSchemeDark, colorSchemeLight, themeQuartz } from "ag-grid-community";

// AG Grid Community (MIT). Registering all community modules once for every grid in the app.
ModuleRegistry.registerModules([AllCommunityModule]);

const base = {
  accentColor: "#0070ba",
  fontFamily: "inherit",
  headerFontWeight: 600,
  fontSize: 13,
  rowVerticalPaddingScale: 0.9,
  wrapperBorderRadius: 10,
};

export const lightTheme = themeQuartz.withPart(colorSchemeLight).withParams({ ...base, backgroundColor: "#ffffff", oddRowBackgroundColor: "#fafbfc" });
export const darkTheme = themeQuartz.withPart(colorSchemeDark).withParams({ ...base, backgroundColor: "#111a2e", oddRowBackgroundColor: "#121c32", borderColor: "#233049" });

export function useGridTheme() {
  if (typeof window === "undefined") return lightTheme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? darkTheme : lightTheme;
}

export const usd = (v: number | null | undefined, currency = "USD") =>
  v === null || v === undefined || Number.isNaN(v) ? "" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(v);

export const shortDate = (iso: string | undefined) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
