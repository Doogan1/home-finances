/**
 * Origin ("CSRF") defence for custom mutation routes, plus the cookie-security
 * rule that depends on where the app is served from. Pure functions, so they are
 * easy to test and safe to import from anywhere.
 *
 * Browsers always attach an `Origin` header to cross-site POST/PUT/PATCH/DELETE
 * requests and page scripts cannot forge it. Requiring it to equal the app's
 * own origin stops another website from making a signed-in browser mutate data.
 * Better Auth does this for its own /api/auth routes; every custom route handler
 * must call this too. (Next.js Server Actions have an equivalent built in.)
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `null` when the request may proceed, otherwise a 403 response to return. */
export function checkMutationOrigin(request: Request, appUrl: string): Response | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  // Referer is intentionally not a fallback: it can be stripped by policy and
  // a missing Origin on a mutation is not something a real browser produces.
  const origin = request.headers.get("origin");
  if (origin !== null && origin === new URL(appUrl).origin) return null;

  return new Response(JSON.stringify({ error: "Forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/**
 * Session cookies are `Secure` for https. Plain http is only acceptable on
 * loopback development, where browsers treat localhost as a secure context
 * anyway; any other http URL is a misconfiguration that would send the session
 * cookie in clear text, so it is refused rather than silently downgraded.
 */
export function shouldUseSecureCookies(appUrl: string): boolean {
  const url = new URL(appUrl);
  if (url.protocol === "https:") return true;
  if (isLoopbackHost(url.hostname)) return false;
  throw new Error("APP_URL must be https unless it points at localhost");
}
