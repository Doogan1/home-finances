// Types for deploy.mjs (plain JavaScript so it runs on the host with no build step).
export function releaseId(sha: string): string;
export function deployProblems(state: {
  branch: string;
  trackedChanges: string;
  head: string;
  remoteHead: string;
  ci: string | null;
  skipCi: boolean;
}): string[];
