import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSandyAppArtifactService,
  defaultCommandRunner,
  resolveSandyAppPackage,
  type SandyAppArtifactCommandRunner,
} from "../../src/services/install/sandy-app-artifact.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const ARTIFACT_LIFECYCLE_TIMEOUT_MS = 15_000;
const MODES = ["repo-src", "repo-dist", "packaged"] as const;
const packageJson = {
  name: "sandy-app",
  version: "1.2.3-test",
  type: "module",
  os: ["darwin", "linux"],
  engines: { node: ">=22.19.0" },
  dependencies: {
    "@parcel/watcher": "2.5.6",
    "fs-native-extensions": "1.5.0",
    "node-pty": "1.2.0-beta.15",
    pino: "10.4.0",
    "pino-opentelemetry-transport": "4.0.2",
    "pino-pretty": "13.0.0",
    "pino-roll": "4.0.0",
  },
  bin: {
    sandy: "dist/sandy.js",
    "sandy-app": "dist/sandy-app.js",
    "sandy-host-daemon": "dist/sandy-host-daemon.js",
  },
  files: ["dist", "host-daemon", "README.md"],
};

type Mode = (typeof MODES)[number];

function isRepoMode(mode: Mode): boolean {
  return mode !== "packaged";
}

async function writeHostPackage(root: string, readme: string): Promise<void> {
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "host-daemon/dist/sandy-chunks"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify(packageJson));
  await writeFile(join(root, "dist/sandy-app.js"), "#!/usr/bin/env node\n");
  await writeFile(
    join(root, "dist/sandy-host-daemon.js"),
    "#!/usr/bin/env node\n",
  );
  await writeFile(join(root, "dist/sandy.js"), "#!/usr/bin/env node\n");
  await writeFile(join(root, "README.md"), readme);
  for (const fileName of [
    "sandy",
    "sandy.cmd",
    "sandy-parcel-watcher-child.mjs",
    "sandy-plugin-host-worker.mjs",
    "sandy-provider-bridge-worker.mjs",
    "daemon-bundle.mjs",
  ]) {
    await writeFile(join(root, "host-daemon/dist", fileName), fileName);
  }
  await writeFile(
    join(root, "host-daemon/dist/sandy-chunks/chunk-TEST.js"),
    "export {};\n",
  );
}

async function fixture(mode: Mode) {
  const root = await mkdtemp(join(tmpdir(), `sandy-artifact-${mode}-`));
  roots.push(root);
  const packageRoot = isRepoMode(mode) ? join(root, "packages/sandy-app") : root;
  const serverEntry =
    mode === "repo-src"
      ? join(root, "apps/server/src/server.ts")
      : mode === "repo-dist"
        ? join(root, "apps/server/dist/server.js")
        : join(root, "server/dist/server.js");
  await mkdir(dirname(serverEntry), { recursive: true });
  await writeFile(serverEntry, "");
  await writeHostPackage(packageRoot, "fixture\n");
  await writeFile(join(packageRoot, "private.txt"), "must not ship\n");

  const refreshHostPackage = async (): Promise<void> => {
    if (!isRepoMode(mode)) return;
    await writeHostPackage(
      join(packageRoot, "host-package"),
      await readFile(join(packageRoot, "README.md"), "utf8"),
    );
  };
  await refreshHostPackage();
  return { packageRoot, refreshHostPackage, root, serverEntry };
}

async function setTreeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await setTreeReadOnly(path);
    } else {
      await chmod(path, 0o444);
    }
  }
  await chmod(directory, 0o555);
}

async function restoreTreeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await restoreTreeWritable(join(directory, entry.name));
    }
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await restoreTreeWritable(root).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }),
  );
});

describe("sandy-app artifact service (desktop packaging)", () => {
  it(
    "packs the runtime when Electron Builder omits the README",
    async () => {
      const test = await fixture("packaged");
      await rm(join(test.packageRoot, "README.md"));
      const service = createSandyAppArtifactService({
        dataDir: join(test.root, "data"),
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
      });

      await expect(service.getVersion()).resolves.toBe("1.2.3-test");
      const artifact = await service.getArtifact();
      const listing = (
        await execFileAsync("tar", ["-tzf", artifact.path])
      ).stdout.split(/\r?\n/u);
      expect(listing).toEqual(
        expect.arrayContaining([
          "package/package.json",
          "package/dist/sandy-app.js",
          "package/dist/sandy-host-daemon.js",
          "package/dist/sandy.js",
          "package/host-daemon/dist/sandy",
          "package/host-daemon/dist/sandy.cmd",
          "package/host-daemon/dist/sandy-chunks/chunk-TEST.js",
          "package/host-daemon/dist/sandy-parcel-watcher-child.mjs",
          "package/host-daemon/dist/sandy-plugin-host-worker.mjs",
          "package/host-daemon/dist/sandy-provider-bridge-worker.mjs",
          "package/host-daemon/dist/daemon-bundle.mjs",
        ]),
      );
      expect(listing).not.toContain("package/README.md");
      expect(listing).not.toContain("package/private.txt");
      expect(artifact.size).toBeGreaterThan(0);
      await expect(service.getArtifact()).resolves.toEqual(artifact);
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "packs with the bundled npm when the server has no npm on PATH",
    async () => {
      const test = await fixture("packaged");
      const service = createSandyAppArtifactService({
        dataDir: join(test.root, "data"),
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
      });

      const originalPath = process.env.PATH;
      process.env.PATH = "";
      let artifact;
      try {
        artifact = await service.getArtifact();
      } finally {
        process.env.PATH = originalPath;
      }

      expect(artifact.size).toBeGreaterThan(0);
      expect(
        (await execFileAsync("tar", ["-tzf", artifact.path])).stdout.split(
          /\r?\n/u,
        ),
      ).toContain("package/host-daemon/dist/daemon-bundle.mjs");
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );

  it.skipIf(
    process.platform === "win32" ||
      (typeof process.getuid === "function" && process.getuid() === 0),
  )(
    "serves the tarball and removes its temporary copy from a read-only install",
    async () => {
      const test = await fixture("packaged");
      const dataDir = join(test.root, "data");
      const nested = join(
        test.packageRoot,
        "host-daemon/dist/sandy-chunks/nested",
      );
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, "deep.js"), "export {};\n");
      await setTreeReadOnly(join(test.packageRoot, "host-daemon"));
      const service = createSandyAppArtifactService({
        dataDir,
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
      });

      const artifact = await service.getArtifact();

      expect(artifact.size).toBeGreaterThan(0);
      expect(
        (await execFileAsync("tar", ["-tzf", artifact.path])).stdout.split(
          /\r?\n/u,
        ),
      ).toContain("package/host-daemon/dist/sandy-chunks/nested/deep.js");
      expect(
        (await readdir(join(dataDir, "install-cache"))).filter((name) =>
          name.startsWith("host-package-"),
        ),
      ).toEqual([]);
      expect(
        (await stat(join(test.packageRoot, "host-daemon/dist/sandy-chunks")))
          .mode & 0o222,
      ).toBe(0);
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );

  it("rejects missing runtime files even when the README is absent", async () => {
    const test = await fixture("packaged");
    const runtimePath = join(
      test.packageRoot,
      "host-daemon/dist/daemon-bundle.mjs",
    );
    await rm(join(test.packageRoot, "README.md"));
    await rm(runtimePath);
    const service = createSandyAppArtifactService({
      dataDir: join(test.root, "data"),
      serverEntryUrl: pathToFileURL(test.serverEntry).href,
    });

    await expect(service.getArtifact()).rejects.toMatchObject({
      code: "ENOENT",
      path: runtimePath,
    });
  });

  it("propagates README copy failures other than a missing file", async () => {
    const test = await fixture("packaged");
    const readmePath = join(test.packageRoot, "README.md");
    await rm(readmePath);
    await mkdir(readmePath);
    const service = createSandyAppArtifactService({
      dataDir: join(test.root, "data"),
      serverEntryUrl: pathToFileURL(test.serverEntry).href,
    });

    await expect(service.getArtifact()).rejects.toMatchObject({
      code: expect.stringMatching(
        process.platform === "win32" ? /^EPERM$/u : /^(EISDIR|ENOTSUP)$/u,
      ),
      path: readmePath,
    });
  });
});

describe.each(MODES)("sandy-app artifact service (%s)", (mode) => {
  it(
    "packs only the enrolled host runtime as an exact-version npm package",
    async () => {
      const test = await fixture(mode);
      const calls: Array<{
        command: string;
        args: readonly string[];
        cwd: string;
      }> = [];
      const runner: SandyAppArtifactCommandRunner = async (command, args, cwd) => {
        calls.push({ command, args, cwd });
        if (command === "pnpm") {
          await test.refreshHostPackage();
          return "built";
        }
        return defaultCommandRunner(command, args, cwd);
      };
      const resolved = await resolveSandyAppPackage(
        pathToFileURL(test.serverEntry).href,
      );
      expect(resolved.root).toBe(test.packageRoot);
      expect(resolved.layout).toBe(isRepoMode(mode) ? "repo" : "packaged");
      const service = createSandyAppArtifactService({
        dataDir: join(test.root, "data"),
        commandRunner: runner,
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
      });

      const artifact = await service.getArtifact();
      await expect(service.getVersion()).resolves.toBe("1.2.3-test");
      const listing = (
        await execFileAsync("tar", ["-tzf", artifact.path])
      ).stdout.split(/\r?\n/u);
      expect(listing).toContain("package/package.json");
      expect(listing).toContain("package/dist/sandy-app.js");
      expect(listing).toContain("package/dist/sandy.js");
      expect(listing).toContain("package/host-daemon/dist/daemon-bundle.mjs");
      expect(listing).toContain("package/host-daemon/dist/sandy");
      expect(listing).not.toContain("package/private.txt");
      expect(listing.some((entry) => entry.startsWith("package/app/"))).toBe(
        false,
      );
      expect(listing.some((entry) => entry.startsWith("package/server/"))).toBe(
        false,
      );
      const packedPackageJson = JSON.parse(
        (
          await execFileAsync("tar", [
            "-xOzf",
            artifact.path,
            "package/package.json",
          ])
        ).stdout,
      );
      expect(packedPackageJson).toMatchObject({
        name: "sandy-app",
        version: "1.2.3-test",
        os: isRepoMode(mode)
          ? ["darwin", "linux"]
          : ["darwin", "linux", "win32"],
        bin: {
          sandy: "dist/sandy.js",
          "sandy-app": "dist/sandy-app.js",
          "sandy-host-daemon": "dist/sandy-host-daemon.js",
        },
      });
      expect(Object.keys(packedPackageJson.dependencies).sort()).toEqual([
        "@parcel/watcher",
        "fs-native-extensions",
        "node-pty",
        "pino",
        "pino-opentelemetry-transport",
        "pino-pretty",
        "pino-roll",
      ]);
      expect(artifact.digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(artifact.path).toContain(artifact.digest);
      expect(artifact.size).toBeGreaterThan(0);
      expect(calls.filter((call) => call.command === "pnpm")).toHaveLength(
        isRepoMode(mode) ? 1 : 0,
      );
      await expect(service.getArtifact()).resolves.toEqual(artifact);
      expect(calls.filter((call) => call.command === "npm")).toHaveLength(1);
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "content-addresses rebuilds when package contents change",
    async () => {
      const test = await fixture(mode);
      const calls: Array<{ command: string }> = [];
      const runner: SandyAppArtifactCommandRunner = async (command, args, cwd) => {
        calls.push({ command });
        if (command === "pnpm") {
          await test.refreshHostPackage();
          return "built";
        }
        return defaultCommandRunner(command, args, cwd);
      };
      const options = {
        dataDir: join(test.root, "data"),
        commandRunner: runner,
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
        protocolVersion: 51,
      };

      const first = await createSandyAppArtifactService(options).getArtifact();
      await writeFile(join(test.packageRoot, "README.md"), "updated\n");
      const second = await createSandyAppArtifactService(options).getArtifact();

      expect(second.path).not.toBe(first.path);
      expect(second.digest).not.toBe(first.digest);
      expect(
        (
          await execFileAsync("tar", [
            "-xOzf",
            second.path,
            "package/README.md",
          ])
        ).stdout,
      ).toBe("updated\n");
      expect(calls.filter((call) => call.command === "npm")).toHaveLength(2);
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "separates protocol cache keys without changing identical content digests",
    async () => {
      const test = await fixture(mode);
      const runner: SandyAppArtifactCommandRunner = async (command, args, cwd) => {
        if (command === "pnpm") {
          await test.refreshHostPackage();
          return "built";
        }
        return defaultCommandRunner(command, args, cwd);
      };
      const baseOptions = {
        dataDir: join(test.root, "data"),
        commandRunner: runner,
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
      };

      const first = await createSandyAppArtifactService({
        ...baseOptions,
        protocolVersion: 51,
      }).getArtifact();
      const second = await createSandyAppArtifactService({
        ...baseOptions,
        protocolVersion: 52,
      }).getArtifact();

      expect(second.path).not.toBe(first.path);
      expect(second.digest).toBe(first.digest);
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "keeps the previous content-addressed artifact when a rebuild fails",
    async () => {
      const test = await fixture(mode);
      let failNextPack = false;
      const runner: SandyAppArtifactCommandRunner = async (command, args, cwd) => {
        if (command === "pnpm") {
          await test.refreshHostPackage();
          return "built";
        }
        if (failNextPack) throw new Error("npm pack exploded");
        return defaultCommandRunner(command, args, cwd);
      };
      const options = {
        dataDir: join(test.root, "data"),
        commandRunner: runner,
        serverEntryUrl: pathToFileURL(test.serverEntry).href,
        protocolVersion: 51,
      };

      const first = await createSandyAppArtifactService(options).getArtifact();
      failNextPack = true;
      await writeFile(join(test.packageRoot, "README.md"), "updated\n");
      const service = createSandyAppArtifactService(options);
      await expect(service.getArtifact()).rejects.toThrow("npm pack exploded");
      expect(
        (await execFileAsync("tar", ["-xOzf", first.path, "package/README.md"]))
          .stdout,
      ).toBe("fixture\n");

      failNextPack = false;
      const second = await service.getArtifact();
      expect(second.path).not.toBe(first.path);
      expect(
        (
          await execFileAsync("tar", [
            "-xOzf",
            second.path,
            "package/README.md",
          ])
        ).stdout,
      ).toBe("updated\n");
    },
    ARTIFACT_LIFECYCLE_TIMEOUT_MS,
  );
});
