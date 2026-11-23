// Pure checks for scripts/deploy.mjs, kept apart so they can be tested.

/** The release id: the first 12 hex characters of a full commit id. */
export function releaseId(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Not a full commit id: ${sha}`);
  return sha.slice(0, 12);
}

/** Every reason this checkout must not be deployed, in a fixed order. Empty means go. */
export function deployProblems({ branch, trackedChanges, head, remoteHead, ci, skipCi }) {
  const problems = [];
  if (branch !== "main") problems.push(`You are on "${branch}"; deploy from main.`);
  if (trackedChanges.trim() !== "") problems.push("There are uncommitted changes to tracked files.");
  if (head !== remoteHead) problems.push("Your main is not the same as GitHub's (push or pull first).");
  if (!skipCi) {
    if (ci === null) problems.push("CI has not finished for this commit (or GitHub could not be asked). Wait, or pass --skip-ci.");
    else if (ci !== "success") problems.push(`CI for this commit finished as "${ci}".`);
  }
  return problems;
}
