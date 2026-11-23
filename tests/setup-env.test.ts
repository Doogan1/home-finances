import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/setup-env.mjs");
const run = (args: string[]) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    const e = error as { status: number; stderr: string };
    return { code: e.status, out: e.stderr };
  }
};
const values = (file: string) =>
  new Map(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
  );

describe("setup-env --out --app-url", () => {
  it("writes a new env file with fresh secrets and the given https address", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "hf-env-")), "prod.env");
    const result = run(["--out", file, "--app-url", "https://homelab.example-tailnet.ts.net"]);
    expect(result.code).toBe(0);
    const env = values(file);
    expect(env.get("APP_URL")).toBe("https://homelab.example-tailnet.ts.net");
    for (const key of ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "AUTH_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
      expect(env.get(key)?.length).toBeGreaterThan(20);
    }
    expect(env.get("DATABASE_URL")).toMatch(/^postgresql:\/\/home_finances_app:[0-9a-f]+@db:5432\/home_finances$/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing file", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "hf-env-")), "prod.env");
    writeFileSync(file, "KEEP=me\n");
    expect(run(["--out", file, "--app-url", "https://homelab.example-tailnet.ts.net"]).code).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("KEEP=me\n");
  });

  it("refuses an address that is not plain https", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hf-env-"));
    for (const url of ["http://homelab.example-tailnet.ts.net", "https://homelab.example-tailnet.ts.net/app", "nonsense"]) {
      const result = run(["--out", path.join(dir, "prod.env"), "--app-url", url]);
      expect(result.code).toBe(1);
      expect(result.out).toContain("--app-url must be an https:// address with no path");
    }
  });

  it("refuses unknown arguments", () => {
    expect(run(["--force"]).code).toBe(1);
  });
});
