import Link from "next/link";

/** The spec's navigation. Static: it knows nothing about the session or the path. */
const LINKS = [
  { href: "/", label: "Home" },
  { href: "/register", label: "Register" },
  { href: "/calendar", label: "Calendar" },
  { href: "/bills", label: "Bills & income" },
  { href: "/accounts", label: "Accounts" },
  { href: "/connections", label: "Connections" },
] as const;

export function MainNav() {
  return (
    <nav aria-label="Main" className="main-nav">
      <ul>
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link href={link.href}>{link.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
