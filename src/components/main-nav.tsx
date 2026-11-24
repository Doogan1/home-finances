import { Suspense } from "react";
import { NavShell, NavWithPath } from "./nav-shell";

/**
 * The bottom bar on phones and the sidebar on wide screens: one list, laid out
 * by CSS. It knows nothing about the session. Reading the path suspends on
 * routes with dynamic parameters, so the same links show unmarked until then.
 */
export function MainNav() {
  return (
    <Suspense fallback={<NavShell pathname={null} />}>
      <NavWithPath />
    </Suspense>
  );
}
