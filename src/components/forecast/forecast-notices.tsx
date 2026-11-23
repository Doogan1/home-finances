import Link from "next/link";
import { TimeZoneForm } from "@/components/accounts/time-zone-form";

export function NeedsTimeZone() {
  return (
    <section className="notice">
      <p>Choose your household&apos;s time zone to see the forecast. It decides what &quot;today&quot; is.</p>
      <TimeZoneForm current={null} zones={Intl.supportedValuesOf("timeZone")} />
    </section>
  );
}

export function NoForecastAccount() {
  return (
    <p className="muted">
      Add a checking or savings account and its balance to see a forecast: <Link href="/accounts">Accounts</Link> ·{" "}
      <Link href="/accounts/balances">Update balances</Link>
    </p>
  );
}
