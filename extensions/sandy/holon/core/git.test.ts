import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitHeadReader } from "./git.ts";
import { tempDir } from "../test/temp.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

function repo(): string {
  const temp = tempDir();
  disposers.push(() => temp.dispose());
  git(temp.dir, "init", "-q", "-b", "main");
  return temp.dir;
}

function commit(dir: string, text: string): string {
  writeFileSync(join(dir, "file.txt"), text);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", text);
  return git(dir, "rev-parse", "HEAD");
}

describe("gitHeadReader", () => {
  it("follows loose refs, packed refs, a detached HEAD and a linked worktree", () => {
    const dir = repo();
    const read = gitHeadReader(dir);
    expect(read()).toBeNull();
    const first = commit(dir, "one");
    expect(read()).toBe(first);
    git(dir, "pack-refs", "--all");
    expect(read()).toBe(first);
    const second = commit(dir, "two");
    expect(read()).toBe(second);
    git(dir, "checkout", "-q", "--detach", first);
    expect(read()).toBe(first);
    const linked = join(dir, "linked");
    git(dir, "worktree", "add", "-q", "-b", "side", linked, second);
    const readLinked = gitHeadReader(linked);
    expect(readLinked()).toBe(second);
    expect(read()).toBe(first);
    const third = commit(linked, "three");
    expect(readLinked()).toBe(third);
  });

  it("answers null outside a repository", () => {
    const temp = tempDir();
    disposers.push(() => temp.dispose());
    expect(gitHeadReader(temp.dir)()).toBeNull();
  });
});
