import { formatMoney } from "@/features/plaid/format";
import { fromCents, type Cents } from "@/lib/cents";

/** "$1,500.00", "-$300.00". */
export const money = (cents: Cents) => formatMoney(fromCents(cents), "USD");

/** Like money, with a "+" before money coming in: "+$700.00", "-$2,500.00". */
export const signedMoney = (cents: Cents) => (cents > 0n ? `+${money(cents)}` : money(cents));

/** For a chart's scale, where room is short: "$500", "$2.5k", "-$1k", "$1.2M". */
export function compactMoney(cents: Cents): string {
  const negative = cents < 0n;
  const dollars = Number(negative ? -cents : cents) / 100;
  const [value, unit] = dollars >= 1_000_000 ? [dollars / 1_000_000, "M"] : dollars >= 1000 ? [dollars / 1000, "k"] : [dollars, ""];
  const fixed = value.toFixed(2);
  const text = fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed.endsWith("0") ? fixed.slice(0, -1) : fixed;
  return `${negative ? "-" : ""}$${text}${unit}`;
}
