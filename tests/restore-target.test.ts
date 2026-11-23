import { describe, expect, it } from "vitest";
import { BackupError, restoreTargetName } from "../scripts/lib/backup.mjs";

const live = "home_finances";
const stamp = "20261123t213709z";

describe("restoreTargetName", () => {
  it("restores into a new, separate database by default", () => {
    expect(restoreTargetName({ liveDatabase: live, stamp })).toBe("home_finances_restore_20261123t213709z");
  });

  it("uses the target that was asked for", () => {
    expect(restoreTargetName({ target: "my_copy", liveDatabase: live, stamp })).toBe("my_copy");
  });

  it("aims --replace-live at the live database when no target is given", () => {
    // Before this, the default target was a separate copy, so `--replace-live
    // --confirm home_finances` restored into a copy and said the live database
    // was not touched.
    expect(restoreTargetName({ replaceLive: true, liveDatabase: live, stamp })).toBe(live);
    expect(restoreTargetName({ replaceLive: true, target: live, liveDatabase: live, stamp })).toBe(live);
  });

  it("refuses --replace-live with a target that is not the live database", () => {
    expect(() => restoreTargetName({ replaceLive: true, target: "my_copy", liveDatabase: live, stamp })).toThrow(BackupError);
    expect(() => restoreTargetName({ replaceLive: true, target: "my_copy", liveDatabase: live, stamp })).toThrow(
      /--replace-live replaces the live database "home_finances"/,
    );
  });
});
