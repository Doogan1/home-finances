"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";

// Deliberately vague: the same text for a wrong password and an unknown email,
// so the form cannot be used to discover which emails have accounts.
const GENERIC_FAILURE = "That email and password did not work.";
const THROTTLED = "Too many sign-in attempts. Wait a minute and try again.";

export function LoginForm() {
  const router = useRouter();
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
    <form onSubmit={onSubmit} className="form">
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
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
