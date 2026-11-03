import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic gate: visitors with no session cookie at all go straight to the
 * login page with a real HTTP redirect, before any page code runs.
 *
 * This only checks that a cookie exists, not that it is valid, so it is a
 * convenience and NOT the security boundary. Every page, action and route
 * handler still verifies the session on the server (`requireHousehold()`).
 *
 * API routes are excluded: they answer 401/403 themselves rather than redirect,
 * and /api/auth must stay reachable so people can sign in.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|login).*)"],
};
