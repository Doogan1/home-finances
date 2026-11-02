import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Emit a self-contained server (.next/standalone) for the production image.
  output: "standalone",
};

export default nextConfig;
