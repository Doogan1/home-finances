import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { PrismaClient } from "@/generated/prisma/client";
import { getServerConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getAuth, type Auth } from "./auth";
import { checkMutationOrigin } from "./origin";

/**
 * Who is making this request, and which household do they belong to?
 *
 * The answer comes only from the server-side session. Household ids supplied
 * by the browser (form fields, query strings, headers) are never authority:
 * every page, action and route handler that touches household data must call
 * one of these and pass the returned `householdId` into its queries. A route
 * guard such as proxy.ts is only an optimisation on top of this.
 */

export type HouseholdContext = { userId: string; householdId: string };

export class UnauthorizedError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "UnauthorizedError";
  }
}

/** Pure core, used by the helpers below and by tests with an injected auth/db. */
export async function resolveHousehold(
  { auth, db }: { auth: Auth; db: PrismaClient },
  requestHeaders: Headers,
): Promise<HouseholdContext | null> {
  // Verifies the signed cookie, looks the session up, and rejects expired or
  // revoked sessions (a revoked session no longer has a row).
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;

  // A valid login without a household has access to nothing.
  const membership = await db.membership.findFirst({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    select: { householdId: true },
  });
  if (!membership) return null;

  return { userId: session.user.id, householdId: membership.householdId };
}

/** For server code serving the current request. Throws if not signed in. */
export async function requireHousehold(): Promise<HouseholdContext> {
  // Read the request FIRST. Under Cache Components, `headers()` is what tells
  // Next.js this render is request-time. Building the auth instance first would
  // read configuration during `next build`'s prerender (where no secrets exist)
  // and fail the build instead of simply deferring to request time.
  const requestHeaders = await headers();
  const context = await resolveHousehold({ auth: getAuth(), db: getDb() }, requestHeaders);
  if (!context) throw new UnauthorizedError();
  return context;
}

/** For pages and layouts: send anonymous visitors to the login page. */
export async function requireHouseholdOrRedirect(): Promise<HouseholdContext> {
  try {
    return await requireHousehold();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }
}

export type MutationAuthorization =
  | { ok: true; context: HouseholdContext }
  | { ok: false; response: Response };

/**
 * The guard every custom mutation route handler starts with: same-origin check
 * first (cheap, and stops cross-site requests before any work), then the
 * session. Authorize before making any call to a provider such as Plaid.
 *
 *   const authorization = await authorizeMutation(request);
 *   if (!authorization.ok) return authorization.response;
 *   const { householdId } = authorization.context;
 */
export async function authorizeMutation(request: Request): Promise<MutationAuthorization> {
  const rejected = checkMutationOrigin(request, getServerConfig().appUrl);
  if (rejected) return { ok: false, response: rejected };

  try {
    return { ok: true, context: await requireHousehold() };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
      };
    }
    throw error;
  }
}
