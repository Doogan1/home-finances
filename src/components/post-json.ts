// Small client-side helper for the app's own JSON routes (never a third party).

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
