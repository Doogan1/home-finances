import { inAppContainer } from "./helpers";

// Creates a labelled throwaway household + user (with a synthetic bank
// connection), hands its credentials to the tests through environment
// variables, and removes everything when the run ends.
export default async function globalSetup() {
  inAppContainer("reset-throttle");
  const created = inAppContainer("create").trim().split("\n").at(-1) ?? "";
  const { email, password } = JSON.parse(created) as { email: string; password: string };
  process.env.E2E_EMAIL = email;
  process.env.E2E_PASSWORD = password;
  inAppContainer("seed-bank", email);

  return () => {
    inAppContainer("delete", email);
    inAppContainer("reset-throttle");
  };
}
