import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeChanges } from "./evaluate.ts";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

export function gitHead(cwd: string): string | null {
  return git(cwd, ["rev-parse", "HEAD"])?.trim() || null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function gitHeadReader(cwd: string): () => string | null {
  const dirs = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])?.split("\n").filter((line) => line !== "");
  if (dirs === undefined || dirs.length !== 2) return () => null;
  const [gitDir, commonDir] = dirs as [string, string];
  const resolveRef = (ref: string): string | null => {
    for (const dir of [gitDir, commonDir]) {
      const loose = readText(join(dir, ref))?.trim();
      if (loose !== undefined && SHA.test(loose)) return loose;
    }
    const packed = readText(join(commonDir, "packed-refs"));
    for (const line of packed?.split("\n") ?? []) {
      const [sha, name] = line.split(" ");
      if (name === ref && sha !== undefined && SHA.test(sha)) return sha;
    }
    return null;
  };
  return () => {
    const head = readText(join(gitDir, "HEAD"))?.trim();
    if (head === undefined) return gitHead(cwd);
    if (SHA.test(head)) return head;
    const ref = head.startsWith("ref: ") ? resolveRef(head.slice("ref: ".length)) : null;
    return ref ?? gitHead(cwd);
  };
}

export function gitTopLevel(cwd: string): string | null {
  return git(cwd, ["rev-parse", "--show-toplevel"])?.trim() || null;
}

export function gitCodeChanges(root: string): CodeChanges {
  const cache = new Map<string, readonly string[] | null>();
  return {
    changedPaths(build, commit) {
      const key = `${build}..${commit}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const known = git(root, ["cat-file", "-e", `${build}^{commit}`]) !== null && git(root, ["cat-file", "-e", `${commit}^{commit}`]) !== null;
      const output = known ? git(root, ["diff", "--name-only", "-z", "--relative", "--no-renames", build, commit]) : null;
      const result = output === null ? null : output.split("\u0000").filter((path) => path !== "");
      cache.set(key, result);
      return result;
    },
  };
}
