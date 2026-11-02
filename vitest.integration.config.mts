import { defineConfig } from "vitest/config";
import { alias } from "./vitest.shared.mjs";

// Integration tests talk to a real (synthetic, isolated) database.
export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
  },
});
