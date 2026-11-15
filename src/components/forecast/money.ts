import { formatMoney } from "@/features/plaid/format";
import { fromCents, type Cents } from "@/lib/cents";

/** "$1,500.00", "-$300.00". */
export const money = (cents: Cents) => formatMoney(fromCents(cents), "USD");

/** Like money, with a "+" before money coming in: "+$700.00", "-$2,500.00". */
export const signedMoney = (cents: Cents) => (cents > 0n ? `+${money(cents)}` : money(cents));
