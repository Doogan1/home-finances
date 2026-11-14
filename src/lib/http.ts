import "server-only";
import { z } from "zod";

const MAX_BODY_BYTES = 4 * 1024;

export function jsonNoStore(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    // Household data and one-time tokens must never sit in a shared cache.
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Parse a small JSON body against a strict schema; null means "reject with 400". */
export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function badRequest(): Response {
  return jsonNoStore({ error: "invalid_request", message: "The request was not understood." }, 400);
}
