import { describe, expect, it } from "vitest";
import { backupsToDelete, newestBackupAgeHours, parseBackupName } from "../scripts/lib/retention.mjs";

const name = (stamp: string) => `home-finances-home_finances-${stamp}.dump.age`;
const NOW = new Date("2026-12-31T12:00:00Z");

describe("parseBackupName", () => {
  it("reads the UTC time from a backup name", () => {
    expect(parseBackupName(name("20261231T033000Z"))?.toISOString()).toBe("2026-12-31T03:30:00.000Z");
  });

  it("refuses anything else, including plaintext dumps and partial files", () => {
    expect(parseBackupName("home-finances-home_finances-20261231T033000Z.dump")).toBeNull();
    expect(parseBackupName(`${name("20261231T033000Z")}.partial`)).toBeNull();
    expect(parseBackupName("notes.txt")).toBeNull();
    expect(parseBackupName(name("20261399T033000Z"))).toBeNull();
  });
});

describe("backupsToDelete", () => {
  it("keeps everything from the last 48 hours", () => {
    const names = [name("20261231T110000Z"), name("20261231T033000Z"), name("20261230T033000Z"), name("20261229T130000Z")];
    expect(backupsToDelete(names, NOW)).toEqual([]);
  });

  it("keeps only the newest backup of an older day", () => {
    const names = [name("20261220T033000Z"), name("20261220T180000Z")];
    expect(backupsToDelete(names, NOW)).toEqual([name("20261220T033000Z")]);
  });

  it("keeps 7 daily and 4 weekly backups from a long nightly history", () => {
    const names: string[] = [];
    for (let d = new Date("2026-10-01T03:30:00Z"); d <= NOW; d = new Date(d.getTime() + 86_400_000)) {
      names.push(name(d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")));
    }
    const kept = names.filter((n) => !backupsToDelete(names, NOW).includes(n));
    // The 4 weeks are those starting Mon Dec 7, 14, 21 and 28 (the current one).
    expect(kept).toEqual([
      name("20261213T033000Z"), // newest of the week starting Dec 7
      name("20261220T033000Z"), // newest of the week starting Dec 14
      name("20261225T033000Z"), // the 7 most recent days...
      name("20261226T033000Z"),
      name("20261227T033000Z"), // ...this one is also the newest of the week starting Dec 21
      name("20261228T033000Z"),
      name("20261229T033000Z"),
      name("20261230T033000Z"),
      name("20261231T033000Z"), // ...and of the week starting Dec 28
    ]);
  });

  it("counts days that have a backup, so a week with the server off loses nothing extra", () => {
    const names = [name("20261201T033000Z"), name("20261202T033000Z"), name("20261203T033000Z")];
    expect(backupsToDelete(names, NOW)).toEqual([]);
  });

  it("never deletes a file it does not recognise", () => {
    expect(backupsToDelete(["notes.txt", "x.dump.age.partial"], NOW)).toEqual([]);
  });
});

describe("newestBackupAgeHours", () => {
  it("is the age of the newest recognised backup, or null when there is none", () => {
    expect(newestBackupAgeHours([name("20261230T120000Z"), name("20261231T000000Z"), "notes.txt"], NOW)).toBe(12);
    expect(newestBackupAgeHours(["notes.txt"], NOW)).toBeNull();
  });
});
