import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Emit a self-contained server (.next/standalone) for the production image.
  output: "standalone",

  // The page a bank redirects back to (OAuth) carries Plaid's state id in its
  // query string. Do not print that address in the dev server's request log.
  logging: { incomingRequests: { ignore: [/^\/plaid\/oauth/] } },

  async headers() {
    return [
      {
        // Basic browser hardening for every response. Deliberately no
        // Content-Security-Policy yet: Plaid Link loads a script and frames from
        // Plaid, and a policy that is not tested against it would break linking.
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Nothing here is meant to be shown inside another site's frame.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // The page a bank redirects back to (OAuth) carries Plaid's state id in
        // its query string, so it sends no Referer to anyone. Listed after the
        // rule above so that this stricter value wins.
        source: "/plaid/oauth",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
