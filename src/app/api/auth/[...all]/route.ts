import { connection } from "next/server";
import { getAuth } from "@/lib/auth/auth";

// Better Auth serves every /api/auth/* endpoint (sign-in, sign-out, session
// lookup, ...) through this single catch-all route. Registration is disabled in
// its configuration, and it checks the Origin header and throttles sign-in.
//
// Auth is built lazily inside the handler so a missing secret is reported when
// a request arrives, not while `next build` imports this file.
async function handle(request: Request): Promise<Response> {
  // Always evaluated per request (see the health route for why this is needed
  // under Cache Components).
  await connection();

  const response = await getAuth().handler(request);

  // Session cookies and session lookups must never be stored by a cache.
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export { handle as GET, handle as POST };
