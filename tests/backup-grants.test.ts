import { describe, expect, it } from "vitest";
import { BackupError, reapplyGrantsArgs } from "../scripts/lib/backup.mjs";

describe("reapplyGrantsArgs", () => {
  it("uses the dev app container by default", () => {
    expect(reapplyGrantsArgs({})).toEqual(["run", "--rm", "--no-deps", "app", "npm", "run", "db:migrate"]);
  });

  it("uses the named one-off service on the server", () => {
    expect(reapplyGrantsArgs({ HF_MIGRATE_SERVICE: "migrate" })).toEqual(["run", "--rm", "migrate"]);
  });

  it("refuses a service name that is not a plain name", () => {
    expect(() => reapplyGrantsArgs({ HF_MIGRATE_SERVICE: "migrate --entrypoint sh" })).toThrow(BackupError);
  });
});
