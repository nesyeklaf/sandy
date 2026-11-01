import { describe, expect, it } from "vitest";
import { isSandyManagedWorkspacePath } from "./workspace-paths.js";

const dataDir = "/home/user/.sandy";

describe("isSandyManagedWorkspacePath", () => {
  it("recognises a worktree under a plugin's host data directory", () => {
    expect(
      isSandyManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/plugins/environment-git-worktree/host-data/worktrees/thr_abc-1/repo`,
      }),
    ).toBe(true);
  });

  it("recognises a personal workspace under a plugin's host data directory", () => {
    expect(
      isSandyManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/plugins/environment-personal-workspace/host-data/personal-workspaces/thr_abc`,
      }),
    ).toBe(true);
  });

  it("recognises the pre-plugin workspace roots", () => {
    expect(
      isSandyManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/worktrees/env_abc/repo`,
      }),
    ).toBe(true);
    expect(
      isSandyManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/personal-workspaces/env_abc`,
      }),
    ).toBe(true);
  });

  it("leaves plugin storage that is not process data alone", () => {
    expect(
      isSandyManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/plugins/some-plugin/source/index.ts`,
      }),
    ).toBe(false);
    expect(
      isSandyManagedWorkspacePath({ dataDir, path: `${dataDir}/plugins` }),
    ).toBe(false);
  });

  it("leaves paths outside the data directory alone", () => {
    expect(
      isSandyManagedWorkspacePath({ dataDir, path: "/home/user/code/repo" }),
    ).toBe(false);
    expect(
      isSandyManagedWorkspacePath({
        dataDir,
        path: "/home/user/.sandy-other/worktrees/env_abc",
      }),
    ).toBe(false);
  });

  it("recognises managed roots on a Windows host in any spelling", () => {
    const windowsDataDir = "C:\\Users\\me\\.sandy";
    expect(
      isSandyManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "c:/users/me/.sandy/plugins/environment-git-worktree/host-data/worktrees/thr_abc-1/repo",
      }),
    ).toBe(true);
    expect(
      isSandyManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "C:\\Users\\me\\.sandy\\worktrees\\env_abc\\repo",
      }),
    ).toBe(true);
    expect(
      isSandyManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "C:\\Users\\me\\.sandy\\plugins\\some-plugin\\source\\index.ts",
      }),
    ).toBe(false);
    expect(
      isSandyManagedWorkspacePath({
        dataDir: windowsDataDir,
        path: "C:\\Users\\me\\code\\repo",
      }),
    ).toBe(false);
  });

  it("does not treat a sibling prefix as a managed root", () => {
    expect(
      isSandyManagedWorkspacePath({
        dataDir,
        path: `${dataDir}/worktrees-backup/env_abc`,
      }),
    ).toBe(false);
  });
});
