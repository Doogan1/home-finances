import { execFileSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");

function inAppContainer(...args: string[]): string {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "app", "npx", "tsx", "scripts/e2e-user.mts", ...args],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

// Creates a labelled throwaway household + user, hands its credentials to the
// tests through environment variables, and removes it when the run ends.
export default async function globalSetup() {
  inAppContainer("reset-throttle");
  const created = inAppContainer("create").trim().split("\n").at(-1) ?? "";
  const { email, password } = JSON.parse(created) as { email: string; password: string };
  process.env.E2E_EMAIL = email;
  process.env.E2E_PASSWORD = password;

  return () => {
    inAppContainer("delete", email);
    inAppContainer("reset-throttle");
  };
}
