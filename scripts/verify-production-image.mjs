// Builds the production image and checks it the way it would be used:
//
//   1. the image builds (Linux, standalone output, no .env baked in);
//   2. none of your secrets appear anywhere in the image's files, including the
//      JavaScript sent to browsers;
//   3. it runs as a non-root user;
//   4. the whole browser test suite passes against it (not just the dev server).
//
//   npm run verify:image                (builds, ~minutes)
//   npm run verify:image -- --skip-build   (reuse the image from the last run)
//
// Needs Docker Desktop with the stack up (`docker compose up -d`) and Playwright's
// browser installed (`npx playwright install chromium`). The container it starts
// listens on 127.0.0.1:3100 only and is removed afterwards. It uses your normal
// .env and database, like the dev app; the browser tests create and delete only
// their own labelled test user.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "home-finances:verify";
const CONTAINER = "hf-verify";
const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;
const skipBuild = process.argv.includes("--skip-build");

function run(command, args, { stream = false, shell = false, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      shell,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: stream ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (error) => resolve({ code: 1, out: String(error.message) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function cleanup() {
  await run("docker", ["rm", "-f", CONTAINER]);
}

async function main() {
  if (!existsSync(path.join(repoRoot, ".env"))) {
    console.error("No .env found. Run `npm run setup:env` first.");
    process.exit(1);
  }

  // 1. Build.
  if (skipBuild) {
    record("image build", true, "skipped (--skip-build)");
  } else {
    console.log("Building the production image (this takes a few minutes)...");
    const build = await run("docker", ["build", "--target", "production", "-t", IMAGE, "."]);
    record("image builds", build.code === 0, build.code === 0 ? "" : build.out.split("\n").slice(-6).join(" | "));
    if (build.code !== 0) return;
  }

  // 2. Secrets must not be anywhere in the image's files.
  const scan = [
    "fail=0",
    "for v in TOKEN_ENCRYPTION_KEY AUTH_SECRET PLAID_SECRET PLAID_CLIENT_ID POSTGRES_PASSWORD APP_DB_PASSWORD; do",
    '  val=$(printenv "$v") || continue',
    '  [ "${#val}" -ge 8 ] || continue',
    '  if grep -r -F -l -- "$val" /app 2>/dev/null | head -1 | grep -q .; then echo "LEAK: $v appears in the image files"; fail=1; fi',
    "done",
    'if [ -e /app/.env ]; then echo "LEAK: a .env file is inside the image"; fail=1; fi',
    "exit $fail",
  ].join("\n");
  const scanned = await run("docker", ["run", "--rm", "--env-file", ".env", IMAGE, "sh", "-c", scan]);
  record("no secret value appears in any file of the image", scanned.code === 0, scanned.code === 0 ? "" : scanned.out.trim());

  // 3. Not root.
  const who = await run("docker", ["run", "--rm", IMAGE, "id", "-u"]);
  record("runs as a non-root user", who.code === 0 && who.out.trim() !== "0", `uid ${who.out.trim()}`);

  // 4. Run it and test it in a real browser.
  await cleanup();
  const dbId = (await run("docker", ["compose", "ps", "-q", "db"])).out.trim();
  const network = (
    await run("docker", ["inspect", dbId, "--format", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}"])
  ).out.trim();
  if (!dbId || !network) {
    record("the stack is up", false, "start it with `docker compose up -d`");
    return;
  }
  const started = await run("docker", [
    "run", "-d", "--name", CONTAINER, "--network", network,
    "--env-file", ".env",
    // The app checks the Origin of requests against APP_URL, so it must name this port.
    "-e", `APP_URL=${BASE_URL}`,
    "-p", `127.0.0.1:${PORT}:3000`,
    IMAGE,
  ]);
  if (started.code !== 0) {
    record("production container starts", false, started.out.trim());
    return;
  }
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i++) {
    try {
      healthy = (await fetch(`${BASE_URL}/api/health`)).ok;
    } catch {
      /* not up yet */
    }
    if (!healthy) await new Promise((r) => setTimeout(r, 1500));
  }
  record("production container is healthy", healthy);
  if (!healthy) return;

  console.log(`\nRunning the browser tests against the production image at ${BASE_URL} ...\n`);
  const browser = await run("npx", ["playwright", "test"], { stream: true, shell: true, env: { E2E_BASE_URL: BASE_URL } });
  record("browser test suite passes against the production image", browser.code === 0);
}

try {
  await main();
} finally {
  await cleanup();
}

console.log("\nSummary");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
if (results.some((r) => !r.ok)) process.exit(1);
