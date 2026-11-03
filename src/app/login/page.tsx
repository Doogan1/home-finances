import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · Home Finances" };

// A plain Server Component: static markup that is prerendered, with the one
// interactive piece (the form) as a Client Component.
export default function LoginPage() {
  return (
    <main>
      <h1>Sign in</h1>
      <p className="muted">Home Finances is private to one household. Accounts are created by the household owner.</p>
      <LoginForm />
    </main>
  );
}
