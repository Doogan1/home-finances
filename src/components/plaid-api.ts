// Small client-side helper for the app's own Plaid routes (never Plaid itself).

export { postJson } from "./post-json";

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
