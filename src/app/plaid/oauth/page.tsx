import type { Metadata } from "next";
import { OAuthResume } from "@/components/oauth-resume";

export const metadata: Metadata = { title: "Finishing connection · Home Finances" };

// Register this exact address (for example http://localhost:3000/plaid/oauth
// in Sandbox) as an allowed redirect URI in the Plaid Dashboard, and set it as
// PLAID_REDIRECT_URI. Its query string (Plaid's oauth_state_id) is handled
// entirely in the browser; see next.config.ts for how it is kept out of logs
// and Referer headers.
export default function PlaidOAuthPage() {
  return (
    <main>
      <h1>Finishing your connection</h1>
      <OAuthResume />
    </main>
  );
}
