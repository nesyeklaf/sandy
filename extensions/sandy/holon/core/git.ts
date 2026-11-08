import { execFileSync } from "node:child_process";
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
