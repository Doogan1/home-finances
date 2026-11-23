import { describe, expect, it } from "vitest";
import { deployProblems, releaseId } from "../scripts/lib/deploy.mjs";

const SHA = "49c071f0123456789abcdef0123456789abcdef0";
const ready = { branch: "main", trackedChanges: "", head: SHA, remoteHead: SHA, ci: "success", skipCi: false };

describe("releaseId", () => {
  it("is the first 12 characters of the commit", () => {
    expect(releaseId(SHA)).toBe("49c071f01234");
  });

  it("refuses anything that is not a full commit id", () => {
    expect(() => releaseId("main")).toThrow();
    expect(() => releaseId("49c071f")).toThrow();
  });
});

describe("deployProblems", () => {
  it("has nothing to say about a pushed, clean main with green CI", () => {
    expect(deployProblems(ready)).toEqual([]);
  });

  it("names every reason to refuse", () => {
    expect(
      deployProblems({ branch: "feature/x", trackedChanges: " M src/app/page.tsx", head: SHA, remoteHead: "0".repeat(40), ci: "failure", skipCi: false }),
    ).toEqual([
      'You are on "feature/x"; deploy from main.',
      "There are uncommitted changes to tracked files.",
      "Your main is not the same as GitHub's (push or pull first).",
      'CI for this commit finished as "failure".',
    ]);
  });

  it("asks to wait for CI that has not finished or not run", () => {
    expect(deployProblems({ ...ready, ci: null })).toEqual([
      "CI has not finished for this commit (or GitHub could not be asked). Wait, or pass --skip-ci.",
    ]);
  });

  it("lets the person skip the CI check, and only that", () => {
    expect(deployProblems({ ...ready, ci: null, skipCi: true })).toEqual([]);
    expect(deployProblems({ ...ready, branch: "x", skipCi: true })).toHaveLength(1);
  });
});
