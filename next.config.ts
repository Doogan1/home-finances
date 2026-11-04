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
        // ...and do not leak it to other sites through the Referer header either.
        source: "/plaid/oauth",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
