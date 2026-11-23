// Deploys the pushed main branch to the homelab server, or rolls back.
//
//   npm run deploy                  check, upload this commit, build and start it there
//   npm run deploy -- --skip-ci     the same without waiting for GitHub's CI result
//   npm run deploy -- --rollback    go back to the previous release
//
// Runs on the PC. Needs `ssh homelab` to work (see docs/homelab-deployment.md).
// Only committed files are sent (git archive), so untracked notes and .env never
// leave this computer. Secrets live only on the server, in ~/home-finances/prod.env.

import { spawn } from "node:child_process";
import { deployProblems, releaseId } from "./lib/deploy.mjs";

const HOST = process.env.HF_DEPLOY_HOST || "homelab";
const REMOTE_HOME = "home-finances"; // relative to the server user's home folder
const args = process.argv.slice(2);
const rollback = args.includes("--rollback");
const skipCi = args.includes("--skip-ci");
if (args.some((a) => a !== "--rollback" && a !== "--skip-ci")) {
  console.error("Usage: npm run deploy [-- --skip-ci | --rollback]");
  process.exit(1);
}

/** Runs a command without a shell; resolves with its exit code and output. */
function run(command, commandArgs, { inherit = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (error) => resolve({ code: 1, out: error.message }));
    child.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

async function must(command, commandArgs, what) {
  const result = await run(command, commandArgs);
  if (result.code !== 0) {
    console.error(`${what} failed: ${result.out.split("\n").slice(-3).join(" | ")}`);
    process.exit(1);
  }
  return result.out;
}

/**
 * `git archive HEAD` piped straight into tar on the server; no shell, so the bytes are untouched.
 * Extracts into <target>.partial and only renames it into place once both git and ssh
 * succeeded, so a truncated archive is never promoted. Always resolves; never throws.
 */
async function upload(id) {
  const target = `${REMOTE_HOME}/releases/${id}`;
  const streamed = await new Promise((resolve) => {
    let gitCode = null;
    let sshCode = null;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const check = () => {
      if (gitCode !== null && sshCode !== null) finish(gitCode === 0 && sshCode === 0);
    };
    const git = spawn("git", ["archive", "--format=tar", "HEAD"], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const ssh = spawn(
      "ssh",
      [HOST, `rm -rf ${target}.partial && mkdir -p ${target}.partial && tar -x -C ${target}.partial`],
      { stdio: ["pipe", "inherit", "inherit"], windowsHide: true },
    );
    ssh.stdin.on("error", () => {}); // ssh may exit before reading everything (EPIPE); its exit code reports that
    git.on("error", () => finish(false));
    ssh.on("error", () => finish(false));
    git.on("close", (code) => {
      gitCode = code ?? 1;
      check();
    });
    ssh.on("close", (code) => {
      sshCode = code ?? 1;
      check();
    });
    git.stdout.pipe(ssh.stdin);
  });
  if (streamed) {
    const promoted = await run("ssh", [HOST, `mv ${target}.partial ${target}`]);
    if (promoted.code === 0) return true;
  }
  await run("ssh", [HOST, `rm -rf ${target}.partial`]);
  return false;
}

if (rollback) {
  const result = await run("ssh", [HOST, `sh ${REMOTE_HOME}/current/deploy/server/release.sh --rollback`], { inherit: true });
  process.exit(result.code ?? 1);
}

await must("git", ["fetch", "--quiet", "origin", "main"], "Fetching from GitHub");
const head = await must("git", ["rev-parse", "HEAD"], "Reading HEAD");
const state = {
  branch: await must("git", ["rev-parse", "--abbrev-ref", "HEAD"], "Reading the branch"),
  trackedChanges: await must("git", ["status", "--porcelain", "--untracked-files=no"], "Reading git status"),
  head,
  remoteHead: await must("git", ["rev-parse", "origin/main"], "Reading origin/main"),
  ci: null,
  skipCi,
};
if (!skipCi) {
  const ci = await run("gh", ["run", "list", "--workflow", "ci.yml", "--commit", head, "--json", "status,conclusion", "--limit", "1"]);
  const [latest] = ci.code === 0 ? JSON.parse(ci.out || "[]") : [];
  state.ci = latest?.status === "completed" ? latest.conclusion : null;
}

const problems = deployProblems(state);
if (problems.length > 0) {
  console.error("Not deploying:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const id = releaseId(head);
const exists = await run("ssh", [HOST, `test -d ${REMOTE_HOME}/releases/${id}`]);
if (exists.code !== 0) {
  console.log(`Uploading ${id} to ${HOST}...`);
  if (!(await upload(id))) {
    console.error("The upload failed; nothing on the server was changed.");
    process.exit(1);
  }
}
const result = await run("ssh", [HOST, `sh ${REMOTE_HOME}/releases/${id}/deploy/server/release.sh ${id}`], { inherit: true });
process.exit(result.code ?? 1);
