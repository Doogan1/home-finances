"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SignOutButton } from "@/app/sign-out-button";
import { NavIcon, type NavIconName } from "./nav-icons";

type Item = { href: string; label: string; short?: string; icon: NavIconName };

// On a phone the first four are the bottom bar and the rest are behind More.
const PRIMARY: readonly Item[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/register", label: "Register", icon: "register" },
  { href: "/calendar", label: "Calendar", icon: "calendar" },
  { href: "/bills", label: "Bills & income", short: "Bills", icon: "bills" },
];
const SECONDARY: readonly Item[] = [
  { href: "/accounts", label: "Accounts", icon: "accounts" },
  { href: "/transactions", label: "Transactions", icon: "transactions" },
  { href: "/connections", label: "Connections", icon: "connections" },
  { href: "/accounts/balances", label: "Update balances", icon: "balances" },
];
const ITEMS = [...PRIMARY, ...SECONDARY];

/** The page a path belongs to: the longest link that is the path itself or a folder above it. */
function currentHref(pathname: string | null): string | null {
  if (pathname === null) return null;
  const matches = ITEMS.filter(({ href }) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)));
  return matches.sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}

export function NavWithPath() {
  const pathname = usePathname();
  // Nothing to navigate to before signing in. Unmounting also closes the More
  // sheet, so it is not still open after signing out and in again.
  return pathname === "/login" ? null : <NavShell pathname={pathname} />;
}

export function NavShell({ pathname }: { pathname: string | null }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const current = currentHref(pathname);
  const close = () => setOpen(false);
  const inMore = SECONDARY.some(({ href }) => href === current);

  return (
    <nav aria-label="Main" className="main-nav">
      <p className="nav-brand">Home Finances</p>
      <div className="nav-primary">
        <NavList items={PRIMARY} current={current} onNavigate={close} />
        <button
          ref={toggle}
          type="button"
          className="nav-link nav-toggle"
          aria-expanded={open}
          aria-controls="nav-more"
          aria-current={inMore ? "true" : undefined}
          onClick={() => setOpen(!open)}
        >
          <NavIcon name="more" />
          More
        </button>
      </div>
      {open && <button type="button" className="nav-backdrop" aria-label="Close menu" onClick={close} />}
      <div id="nav-more" className="nav-more" data-open={open}>
        <NavList items={SECONDARY} current={current} onNavigate={close} />
        <div className="nav-signout">
          <SignOutButton />
        </div>
      </div>
    </nav>
  );
}

function NavList({ items, current, onNavigate }: { items: readonly Item[]; current: string | null; onNavigate: () => void }) {
  return (
    <ul>
      {items.map(({ href, label, short, icon }) => (
        <li key={href}>
          <Link href={href} className="nav-link" aria-current={href === current ? "page" : undefined} onClick={onNavigate}>
            <NavIcon name={icon} />
            {short ? (
              <>
                <span className="nav-short">{short}</span>
                <span className="nav-long">{label}</span>
              </>
            ) : (
              label
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
