import Link from "next/link";
import type { AccountSeries } from "@/features/forecast/engine";

/** One forecast account at a time: the chosen one in bold, the others as links. Hidden with only one. */
export function AccountPicker({
  charted,
  selected,
  hrefFor,
}: {
  charted: readonly AccountSeries[];
  selected: AccountSeries;
  hrefFor: (accountId: string) => string;
}) {
  if (charted.length < 2) return null;
  return (
    <nav aria-label="Accounts in the forecast" className="actions">
      {charted.map((a) =>
        a === selected ? (
          <strong key={a.account.id}>{a.account.name}</strong>
        ) : (
          <Link key={a.account.id} href={hrefFor(a.account.id)}>
            {a.account.name}
          </Link>
        ),
      )}
    </nav>
  );
}
