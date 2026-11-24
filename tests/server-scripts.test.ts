import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPTS = ["env.sh", "hf.sh", "backup.sh", "release.sh"].map((f) => `deploy/server/${f}`);

describe("server shell scripts", () => {
  it.each(SCRIPTS)("%s is valid POSIX sh with LF line endings", (file) => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("\r");
    execFileSync("sh", ["-n", file]); // throws on a syntax error
  });

  it.each(SCRIPTS.filter((f) => !f.endsWith("env.sh")))("%s stops on the first error", (file) => {
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toMatch(/^set -eu$/m);
  });

  it("keeps line endings LF on checkout and in git archive", () => {
    const attributes = readFileSync(".gitattributes", "utf8");
    expect(attributes).toMatch(/^\*\.sh text eol=lf$/m);
    expect(attributes).toMatch(/^deploy\/server\/systemd\/\* text eol=lf$/m);
  });

  it("the timer runs the backup nightly and catches up after downtime", () => {
    const timer = readFileSync("deploy/server/systemd/home-finances-backup.timer", "utf8");
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 03:30:00$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    const service = readFileSync("deploy/server/systemd/home-finances-backup.service", "utf8");
    expect(service).toMatch(/^ExecStart=%h\/home-finances\/hf backup$/m);
  });

  it("backup.sh never leaves a plaintext dump behind", () => {
    const text = readFileSync("deploy/server/backup.sh", "utf8");
    expect(text).toContain("command -v age");
    expect(text).toMatch(/^trap 'rm -f "\$work"\/\*\.dump .*' EXIT$/m);
  });

  it("backup.sh takes the lock before it installs its cleanup trap", () => {
    const text = readFileSync("deploy/server/backup.sh", "utf8");
    expect(text).toContain("flock -n 9");
    expect(text.indexOf("flock -n 9")).toBeLessThan(text.indexOf("trap '"));
  });

  it("hf preflight works out the newest encrypted backup's age on the server and passes it in", () => {
    const hf = readFileSync("deploy/server/hf.sh", "utf8");
    expect(hf).toContain('"$HF_HOME"/backups/*.dump.age');
    expect(hf).toContain('docker compose run --rm preflight npm run preflight -- --backup-age-hours "$age"');
  });

  it("env.sh names the production project, file and env file", () => {
    const env = readFileSync("deploy/server/env.sh", "utf8");
    expect(env).toContain("export COMPOSE_PROJECT_NAME=home-finances");
    expect(env).toContain("export COMPOSE_FILE=compose.prod.yaml");
    expect(env).toContain('export COMPOSE_ENV_FILES="$HF_HOME/prod.env"');
    expect(env).toContain("export HF_MIGRATE_SERVICE=migrate");
    // compose.prod.yaml mounts the database from here and refuses without it.
    expect(env).toContain('HF_VAULT="${HF_VAULT:-/srv/hf-secure}"');
    expect(env).toContain("export HF_VAULT");
  });
});
