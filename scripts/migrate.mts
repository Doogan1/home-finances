// Explicit, non-destructive migration command: `npm run db:migrate`.
// Applies committed migrations as the owner role, then (re)applies the
// restricted app role's grants. The app itself never runs migrations on startup.
import { ensureAppRole, runMigrations } from "./lib/database.mjs";

const required = ["MIGRATION_DATABASE_URL", "APP_DB_USER", "APP_DB_PASSWORD"] as const;
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  console.error("Run `npm run setup:env` for a new setup, or see .env.example.");
  process.exit(1);
}

const ownerUrl = process.env.MIGRATION_DATABASE_URL!;

runMigrations(ownerUrl);
await ensureAppRole(ownerUrl, {
  user: process.env.APP_DB_USER!,
  password: process.env.APP_DB_PASSWORD!,
});
console.log("Migrations applied and app role grants are current.");
