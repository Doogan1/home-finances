"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";

// Deliberately vague: the same text for a wrong password and an unknown email,
// so the form cannot be used to discover which emails have accounts.
const GENERIC_FAILURE = "That email and password did not work.";
const THROTTLED = "Too many sign-in attempts. Wait a minute and try again.";

// False while the server renders and during hydration, true once this component
// is running in the browser. Used to keep the form inert until onSubmit exists.
const subscribeToNothing = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(subscribeToNothing, () => true, () => false);
}

export function LoginForm() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);

    const { error: failure } = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });

    if (failure) {
      setError(failure.status === 429 ? THROTTLED : GENERIC_FAILURE);
      setPending(false);
      return;
    }
    // The session cookie is set; load the protected page with it.
    router.replace("/");
    router.refresh();
  }

  return (
    // method="post" is a safety net: if the form is ever submitted natively
    // (script not loaded, blocked or failed), the browser must not fall back to
    // GET, which would put the email and password in the URL, history and logs.
    // The button is also disabled until hydration so that normally cannot happen.
    <form onSubmit={onSubmit} method="post" className="form">
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending || !hydrated}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
