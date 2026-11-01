// Git in a thread's checkout, run by the plugin's host entry on the host that holds the checkout (the
// Delegates panel's Merge button and its writer details). mergeBranch never leaves a merge behind: a
// conflict is aborted and reported, and a checkout with uncommitted changes is refused before anything runs.
import { execFile } from "node:child_process";
import type { z } from "zod";
import type { branchChangesResult, mergeResult } from "./host-contract.ts";

export type GitRun = { code: number; stdout: string; stderr: string };

export function git(cwd: string, args: readonly string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code !== 0 ? error.message : "")) });
    });
  });
}

const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");

export type BranchChanges = z.infer<typeof branchChangesResult>;

// The child's branch against the checkout's HEAD: commits not yet in HEAD and the files they change
// (three-dot diff, from the merge base). merged: no commit is left to merge.
export async function branchChanges(path: string, branch: string): Promise<BranchChanges> {
  const base = (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const log = await git(path, ["log", "--format=%h %s", "--max-count=50", `HEAD..${branch}`]);
  if (log.code !== 0) throw new Error(`git log HEAD..${branch}: ${log.stderr.trim()}`);
  const diff = await git(path, ["diff", "--name-status", `HEAD...${branch}`]);
  if (diff.code !== 0) throw new Error(`git diff HEAD...${branch}: ${diff.stderr.trim()}`);
  const commits = lines(log.stdout);
  const files = lines(diff.stdout).map((line) => {
    const [status, ...rest] = line.split(/\s+/);
    return { status, path: rest.join(" ") };
  });
  return { branch, base, commits, files, merged: commits.length === 0 };
}

export type MergeResult = z.infer<typeof mergeResult>;

const isClean = async (path: string): Promise<boolean> => {
  const status = await git(path, ["status", "--porcelain", "--untracked-files=no"]);
  return status.code === 0 && status.stdout.trim() === "";
};

// git merge --no-ff of branch into the checkout's current branch. Refused (dirty) when tracked files have
// uncommitted changes or a merge is already in progress; on a conflict or any other failure the merge is
// aborted and the result says whether the checkout is clean again.
export async function mergeBranch(path: string, branch: string, message: string): Promise<MergeResult> {
  const into = (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const status = await git(path, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) return { status: "failed", message: status.stderr.trim(), clean: false };
  const inProgress = (await git(path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
  if (status.stdout.trim() !== "" || inProgress) {
    return { status: "dirty", message: inProgress ? "a merge is already in progress in the checkout" : "the checkout has uncommitted changes; commit or discard them first", files: lines(status.stdout) };
  }
  const ahead = await git(path, ["rev-list", "--count", `HEAD..${branch}`]);
  if (ahead.code !== 0) return { status: "failed", message: ahead.stderr.trim(), clean: true };
  if (ahead.stdout.trim() === "0") return { status: "up_to_date", branch, into };
  const merge = await git(path, ["merge", "--no-ff", "--no-edit", "-m", message, branch]);
  if (merge.code === 0) {
    const commit = (await git(path, ["rev-parse", "--short", "HEAD"])).stdout.trim();
    return { status: "merged", branch, into, commit };
  }
  const conflicted = lines((await git(path, ["diff", "--name-only", "--diff-filter=U"])).stdout);
  await git(path, ["merge", "--abort"]);
  const clean = await isClean(path);
  const text = (merge.stdout + "\n" + merge.stderr).trim();
  if (conflicted.length > 0) return { status: "conflict", message: `merge of ${branch} into ${into} conflicts; aborted`, files: conflicted, clean };
  return { status: "failed", message: text || `git merge ${branch} failed`, clean };
}
