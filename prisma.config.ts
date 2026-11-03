import { defineConfig } from "prisma/config";

// Prisma CLI commands (migrate, generate, studio) read this file.
//
// - Node does not load .env by itself; in Docker Compose the variables come
//   from the container environment, which is the supported way to run this repo.
// - Migrations need schema-changing rights, so they use the owner connection.
//   The running app uses DATABASE_URL (a restricted role) instead.
// - process.env is read directly, not Prisma's env() helper, because env()
//   throws when unset, which would break `prisma generate` on machines (like a
//   fresh host checkout) that have no database settings.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  },
});
