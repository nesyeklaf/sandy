import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentPlatform,
  installDir,
  runtimeBinaryPath,
  verifyInstalled,
  type RuntimePlatform,
  type RuntimeRelease,
} from "./installer.js";
import { resolveRuntime } from "./runtime-pin.js";

const platform = currentPlatform() as RuntimePlatform;
const version = "1.0.0-test";
const content = `#!/bin/sh\necho "dev-browser ${version}"\n`;
const digest = createHash("sha256").update(content).digest("hex");
const release: RuntimeRelease = {
  package: "dev-browser",
  version,
  artifacts: { [platform]: digest },
};
const dirs: string[] = [];
const signal = new AbortController().signal;

async function dataDir() {
  const dir = await mkdtemp(join(tmpdir(), "sandy-dev-browser-runtime-"));
  dirs.push(dir);
  return dir;
}

async function seed(
  dir: string,
  overrides: { binary?: string; sha256?: string } = {},
) {
  const root = installDir(dir, release);
  const binary = join(root, runtimeBinaryPath(release));
  await mkdir(join(binary, ".."), { recursive: true });
  await writeFile(binary, overrides.binary ?? content, { mode: 0o755 });
  await chmod(binary, 0o755);
  await writeFile(
    join(root, "verified.json"),
    JSON.stringify({
      package: release.package,
      version,
      platform,
      sha256: overrides.sha256 ?? digest,
      binary: runtimeBinaryPath(release),
      installedAt: 1,
    }),
  );
  return binary;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("installed runtime", () => {
  it("uses a verified runtime without any package tool or network", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "no Windows runtime");
    const dir = await dataDir();
    const binary = await seed(dir);
    const resolved = await resolveRuntime({ dataDir: dir, signal, release });
    expect(resolved).toEqual({ binary, version, source: "release" });
  });

  it("names the expected path, version and sha256 when nothing is installed", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "no Windows runtime");
    const dir = await dataDir();
    const failure = await resolveRuntime({
      dataDir: dir,
      signal,
      release,
    }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(installDir(dir, release));
    expect(message).toContain(`dev-browser@${version}`);
    expect(message).toContain(digest);
    expect(message).toContain("does not download");
  });

  it("refuses a binary whose digest differs from the pin", async ({ skip }) => {
    skip(process.platform === "win32", "no Windows runtime");
    const dir = await dataDir();
    await seed(dir, { binary: "#!/bin/sh\necho tampered\n" });
    expect(await verifyInstalled(release, dir, platform)).toBeNull();
    await expect(
      resolveRuntime({ dataDir: dir, signal, release }),
    ).rejects.toThrow(digest);
  });

  it("refuses a verified.json recorded for another digest", async ({
    skip,
  }) => {
    skip(process.platform === "win32", "no Windows runtime");
    const dir = await dataDir();
    await seed(dir, { sha256: "0".repeat(64) });
    expect(await verifyInstalled(release, dir, platform)).toBeNull();
  });

  it("refuses a platform without a recorded digest", async ({ skip }) => {
    skip(process.platform === "win32", "no Windows runtime");
    const dir = await dataDir();
    expect(
      await verifyInstalled({ ...release, artifacts: {} }, dir, platform),
    ).toBeNull();
    await expect(
      resolveRuntime({
        dataDir: dir,
        signal,
        release: { ...release, artifacts: {} },
      }),
    ).rejects.toThrow("no verified release artifact");
  });
});
