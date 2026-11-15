import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Rules about the SOURCE TREE that keep secrets server-side and every mutation
// guarded. They read files; nothing runs. If one fails, a recent change broke a
// property the app relies on, and the message names the file.

const ROOT = path.resolve(__dirname, "..");
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

function walk(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full, found);
    else if (/\.(ts|tsx)$/.test(name)) found.push(full);
  }
  return found;
}

const sourceFiles = walk(path.join(ROOT, "src"));
const read = (file: string) => readFileSync(file, "utf8");

/** Import specifiers of runtime (non-type) imports. */
function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^import\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

const startsWithUseClient = (source: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);

/** Modules that must never reach a browser bundle. */
const SERVER_ONLY_SPECIFIERS = [
  /^@\/lib\/db$/,
  /^@\/lib\/config$/,
  /^@\/lib\/crypto\//,
  /^@\/lib\/auth\/(auth|household)$/,
  /^@\/lib\/data\//,
  /^@\/features\/plaid\/(client|link|accounts|lifecycle|sync|deps|http|queries|environment|key-rotation)$/,
  /^@\/generated\/prisma/,
  /^server-only$/,
  /^plaid$/,
  /^pg$/,
  /^@prisma\//,
  /^@node-rs\/argon2$/,
  /^exceljs$/,
  /^node:/,
];

describe("secrets stay on the server", () => {
  it("no client component imports a server-only module", () => {
    const clientFiles = sourceFiles.filter((f) => startsWithUseClient(read(f)));
    expect(clientFiles.length).toBeGreaterThan(5); // the rule is checking something real

    const offenders: string[] = [];
    for (const file of clientFiles) {
      for (const specifier of runtimeImports(read(file))) {
        if (SERVER_ONLY_SPECIFIERS.some((pattern) => pattern.test(specifier))) offenders.push(`${rel(file)} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every library module that touches a secret, the database or Plaid is marked server-only", () => {
    // Pure helpers used by both the app and command-line tools are deliberately unmarked.
    const deliberatelyUnmarked = new Set([
      "src/lib/auth/password.ts", // also used by the bootstrap CLI; holds no secret
      "src/lib/auth/origin.ts", // pure functions
      "src/lib/auth/client.ts", // browser-side helper
      "src/lib/calendar-date.ts", // pure date helpers, usable from forms
      "src/lib/money.ts", // pure money parsing, usable from forms
      "src/lib/cents.ts", // pure money arithmetic, usable from forms
      "src/lib/zod-fields.ts", // pure request-body fields, usable from forms
      "src/features/accounts/input.ts", // zod schemas and account kinds only; forms share them
      "src/features/rules/recurrence.ts", // pure date calculations, usable from forms
      "src/features/rules/splits.ts", // pure split arithmetic
      "src/features/rules/summary.ts", // pure display helpers
      "src/features/rules/versions.ts", // pure planning of changes, shared with form previews
      "src/features/rules/messages.ts", // fixed messages only
      "src/features/rules/input.ts", // zod schemas only; forms share them
      "src/features/rules/form-drafts.ts", // pure form state helpers
      "src/features/forecast/snapshots.ts", // pure: picks the latest balance
      "src/features/forecast/occurrences.ts", // pure: occurrences with per-date edits
      "src/features/forecast/engine.ts", // pure: the forecast itself
      "src/features/forecast/attention.ts", // pure: Needs attention and the next 7 days
      "src/features/forecast/chart.ts", // pure: chart geometry
      "src/features/import/workbook.ts", // reads a workbook's bytes into plain values; no database, no files
      "src/features/import/parse.ts", // pure: sheets to typed rows
      "src/features/import/choices.ts", // zod schema for choices.json only
      "src/features/import/plan.ts", // pure: what the import would create
      "src/features/import/schedule.ts", // pure: the Bill Schedule check
      "src/features/import/cash-flow.ts", // pure: the Cash Flow check, through the forecast engine
      "src/features/plaid/types.ts", // types and error classes only
      "src/features/plaid/format.ts", // pure display helpers
    ]);
    const mustBeMarked = sourceFiles.filter((f) => {
      const r = rel(f);
      return (r.startsWith("src/lib/") || r.startsWith("src/features/")) && !deliberatelyUnmarked.has(r);
    });
    expect(mustBeMarked.length).toBeGreaterThan(10);

    const unmarked = mustBeMarked.filter((f) => !/^import ["']server-only["'];?/m.test(read(f))).map(rel);
    expect(unmarked).toEqual([]);
  });

  it("the deliberately unmarked modules really are free of secrets and server dependencies", () => {
    for (const file of ["src/lib/auth/origin.ts", "src/features/plaid/format.ts", "src/features/plaid/types.ts"]) {
      const source = read(path.join(ROOT, file));
      expect(source, file).not.toMatch(/process\.env|getServerConfig|@\/lib\/db|node:crypto/);
    }
  });

  it("configuration is read from the environment in exactly one place", () => {
    const readers = sourceFiles.filter((f) => /process\.env/.test(read(f))).map(rel);

    expect(readers).toEqual(["src/lib/config.ts"]);
  });

  it("nothing is exposed to the browser through NEXT_PUBLIC_ variables", () => {
    const files = [...sourceFiles, path.join(ROOT, "next.config.ts"), path.join(ROOT, ".env.example")];
    const offenders = files.filter((f) => /NEXT_PUBLIC_/.test(read(f))).map(rel);

    expect(offenders).toEqual([]);
  });

  it("no raw HTML injection or dynamic code evaluation", () => {
    const offenders = sourceFiles.filter((f) => /dangerouslySetInnerHTML|\beval\(|new Function\(/.test(read(f))).map(rel);

    expect(offenders).toEqual([]);
  });

  it("secrets and sensitive files are kept out of git and out of the Docker build context", () => {
    const gitignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    const dockerignore = readFileSync(path.join(ROOT, ".dockerignore"), "utf8");

    for (const entry of [".env*", "/backups/", "*.dump", "/imports/"]) expect(gitignore, `.gitignore: ${entry}`).toContain(entry);
    for (const entry of [".env", "backups", "*.dump", "imports"]) expect(dockerignore, `.dockerignore: ${entry}`).toContain(entry);
    const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).not.toMatch(/COPY[^\n]*\.env\b/);
  });
});

describe("every mutation is guarded", () => {
  const routes = sourceFiles.filter((f) => /\/route\.ts$/.test(f.split(path.sep).join("/")));
  const MUTATING = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s*\{[^}]*\b(POST|PUT|PATCH|DELETE)\b/;

  it("finds the routes this rule is meant to cover", () => {
    const mutating = routes.filter((f) => MUTATING.test(read(f))).map(rel);

    expect(mutating.length).toBeGreaterThanOrEqual(8);
    expect(mutating).toContain("src/app/api/plaid/exchange/route.ts");
  });

  it("every route that can change data checks origin and session first (authorizeMutation)", () => {
    // Better Auth's own endpoint is the one exception: it enforces origin
    // checking, throttling and sessions itself (see tests/auth.integration.test.ts).
    const exceptions = new Set(["src/app/api/auth/[...all]/route.ts"]);
    const unguarded = routes
      .filter((f) => MUTATING.test(read(f)) && !exceptions.has(rel(f)))
      .filter((f) => !/authorizeMutation\(request\)/.test(read(f)))
      .map(rel);

    expect(unguarded).toEqual([]);
  });

  it("the guard runs before any other work in each route", () => {
    for (const file of routes.filter((f) => MUTATING.test(read(f)) && !rel(f).includes("[...all]"))) {
      const source = read(file);
      const guard = source.indexOf("authorizeMutation(request)");
      // Nothing that talks to Plaid, the database or the body may precede it.
      const before = source.slice(0, guard).split("export async function POST").pop() ?? "";
      expect(before, rel(file)).not.toMatch(/getLinkDeps|readJson|request\.(json|text)|getDb/);
    }
  });

  it("no GET route changes data", () => {
    const offenders = routes
      .filter((f) => /export\s+(?:async\s+)?function\s+GET\b/.test(read(f)) && /\.(create|update|delete|upsert)\w*\(/.test(read(f)))
      .map(rel);

    expect(offenders).toEqual([]);
  });
});

describe("logging cannot leak", () => {
  it("never logs a whole error object, request, or response", () => {
    // SDK errors carry the request (and so the secret). Logs may name an error
    // class or a safe code; they never receive the error itself.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const [index, line] of read(file).split("\n").entries()) {
        if (!/console\.(log|info|warn|error|debug)\(/.test(line)) continue;
        if (/[(,]\s*(error|err|e|request|response|req|res)\s*[,)]/.test(line)) offenders.push(`${rel(file)}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the only logging in the app is in the four reviewed places", () => {
    const loggers = sourceFiles.filter((f) => /console\.(log|info|warn|error|debug)\(/.test(read(f))).map(rel);

    expect(loggers).toEqual([
      "src/features/accounts/http.ts",
      "src/features/plaid/http.ts",
      "src/features/plaid/sync.ts",
      "src/features/rules/http.ts",
    ]);
  });
});
