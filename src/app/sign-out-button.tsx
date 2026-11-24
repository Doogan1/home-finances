"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { NavIcon } from "@/components/nav-icons";
import { authClient } from "@/lib/auth/client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    // Deletes the session row on the server, so the cookie is dead everywhere,
    // not just forgotten by this browser.
    await authClient.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <button type="button" className="nav-link" onClick={signOut} disabled={pending}>
      <NavIcon name="signOut" />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
