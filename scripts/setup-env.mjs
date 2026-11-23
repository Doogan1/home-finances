// Creates .env from .env.example with freshly generated local secrets.
// Refuses to overwrite an existing .env so a working setup (and the
// encryption key protecting stored tokens) is never clobbered by accident.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplePath = join(root, ".env.example");

// Flags (both optional): --out <file> writes somewhere other than ./.env (the
// server keeps its secrets in ~/home-finances/prod.env); --app-url <https url>
// sets APP_URL, for an address other than localhost.
const args = process.argv.slice(2);
let outPath;
let appUrl;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) outPath = args[++i];
  else if (args[i] === "--app-url" && args[i + 1]) appUrl = args[++i];
  else {
    console.error("Usage: node scripts/setup-env.mjs [--out <file>] [--app-url <https url>]");
    process.exit(1);
  }
}
if (appUrl !== undefined && !isPlainHttpsOrigin(appUrl)) {
  console.error("--app-url must be an https:// address with no path, query or fragment, e.g. https://homelab.your-tailnet.ts.net");
  process.exit(1);
}

function isPlainHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value.replace(/\/$/, "");
  } catch {
    return false;
  }
}

const envPath = outPath ? resolve(outPath) : join(root, ".env");

if (existsSync(envPath)) {
  console.error(".env already exists; leaving it untouched.");
  console.error("Delete it yourself first if you really want new secrets.");
  console.error("Warning: a new TOKEN_ENCRYPTION_KEY cannot decrypt tokens stored under the old one.");
  process.exit(1);
}

const values = new Map(
  readFileSync(examplePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);

const ownerPassword = randomBytes(24).toString("hex");
const appPassword = randomBytes(24).toString("hex");
const dbName = values.get("POSTGRES_DB");
values.set("POSTGRES_PASSWORD", ownerPassword);
values.set("APP_DB_PASSWORD", appPassword);
values.set(
  "MIGRATION_DATABASE_URL",
  `postgresql://${values.get("POSTGRES_USER")}:${ownerPassword}@db:5432/${dbName}`,
);
values.set(
  "DATABASE_URL",
  `postgresql://${values.get("APP_DB_USER")}:${appPassword}@db:5432/${dbName}`,
);
values.set("AUTH_SECRET", randomBytes(48).toString("hex"));
values.set("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
if (appUrl !== undefined) values.set("APP_URL", appUrl.replace(/\/$/, ""));

// Rewrite the template line by line so comments and ordering are preserved.
const output = readFileSync(examplePath, "utf8")
  .split(/\r?\n/)
  .map((line) => {
    if (!line || line.startsWith("#")) return line;
    const name = line.slice(0, line.indexOf("="));
    return `${name}=${values.get(name)}`;
  })
  .join("\n");

writeFileSync(envPath, output, { mode: 0o600 });

console.log(`Created ${outPath ? envPath : ".env"} with new secrets (values not shown).`);
console.log("Back up TOKEN_ENCRYPTION_KEY somewhere safe; stored bank tokens are unreadable without it.");
console.log("Add your Plaid Sandbox PLAID_CLIENT_ID and PLAID_SECRET when you want to connect a bank.");
