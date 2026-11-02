import path from "node:path";

export const alias = {
  "@": path.resolve(import.meta.dirname, "src"),
  // `server-only` throws when imported outside a Next.js server bundle;
  // under Vitest we are always on the server, so stub it out.
  "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
};
