// Small client-side helper for the app's own Plaid routes (never Plaid itself).

type ApiError = { message?: string };

export async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as T & ApiError;
    if (response.ok) return { ok: true, data };
    return { ok: false, message: data.message ?? "Something went wrong. Try again." };
  } catch {
    return { ok: false, message: "Could not reach the server. Check your connection and try again." };
  }
}

/**
 * The id of the attempt in progress, kept only for the length of a bank's OAuth
 * round trip so the return page knows which attempt to resume. It is just an
 * opaque id (not a token); the server decides whether this browser session may
 * use it. Storage can be unavailable (private windows), so every use is guarded.
 */
const ATTEMPT_KEY = "hf.plaid.attempt";

export const attemptMemory = {
  save(attemptId: string) {
    try {
      sessionStorage.setItem(ATTEMPT_KEY, attemptId);
    } catch {
      /* the OAuth return page will say it cannot resume */
    }
  },
  read(): string | null {
    try {
      return sessionStorage.getItem(ATTEMPT_KEY);
    } catch {
      return null;
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(ATTEMPT_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};
