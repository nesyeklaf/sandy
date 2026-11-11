import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { HolonError } from "./error.ts";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function gitTopLevel(cwd: string): string | null {
  try {
    const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.trim() || null;
  } catch {
    return null;
  }
}

export function resolveRoot(root: string | undefined, cwd: string | undefined): string {
  const base = cwd ?? process.cwd();
  if (root !== undefined) {
    const absolute = isAbsolute(root) ? root : resolve(base, root);
    if (!existsSync(absolute) || !isDirectory(absolute)) throw new HolonError(`--root ${root} is no directory`, "root_not_found");
    return absolute;
  }
  return gitTopLevel(base) ?? resolve(base);
}
