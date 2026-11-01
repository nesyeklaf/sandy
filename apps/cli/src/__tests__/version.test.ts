import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSandyAppVersion } from "../version.js";

describe("resolveSandyAppVersion", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sandy-cli-version-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("trims whitespace around SANDY_APP_VERSION", () => {
    expect(
      resolveSandyAppVersion({
        env: { SANDY_APP_VERSION: "  4.5.6  " },
        fromDir: tempRoot,
      }),
    ).toBe("4.5.6");
  });

  it("reads the sandy-app package.json adjacent to the binary", async () => {
    const packageRoot = join(tempRoot, "package-root");
    const binDir = join(packageRoot, "host-daemon", "dist");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "sandy-app", version: "0.0.7" }),
    );
    expect(
      resolveSandyAppVersion({
        env: {},
        fromDir: binDir,
      }),
    ).toBe("0.0.7");
  });

  it("ignores adjacent package.json files that are not sandy-app", async () => {
    const repoRoot = join(tempRoot, "repo");
    const cliDistDir = join(repoRoot, "apps", "cli", "dist");
    await mkdir(cliDistDir, { recursive: true });
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({ name: "sandy", version: "0.0.0", private: true }),
    );
    await writeFile(
      join(repoRoot, "apps", "cli", "package.json"),
      JSON.stringify({ name: "@sandy/cli", version: "0.0.1" }),
    );
    const sandyAppDir = join(repoRoot, "packages", "sandy-app");
    await mkdir(sandyAppDir, { recursive: true });
    await writeFile(
      join(sandyAppDir, "package.json"),
      JSON.stringify({ name: "sandy-app", version: "0.1.2" }),
    );
    expect(
      resolveSandyAppVersion({
        env: {},
        fromDir: cliDistDir,
      }),
    ).toBe("0.1.2");
  });

  it("falls back to the dev sentinel when no sandy-app package.json is found", () => {
    expect(
      resolveSandyAppVersion({
        env: {},
        fromDir: tempRoot,
      }),
    ).toBe("0.0.0-dev");
  });
});
