import {
  execHostFile,
  hostToolchain,
  omitNpmScriptPolicyEnv,
} from "@sandy/process-utils";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@sandy/host-daemon-contract";

const execFileAsync = execHostFile;
const HOST_DEPENDENCIES = [
  "@parcel/watcher",
  "fs-native-extensions",
  "node-pty",
  "pino",
  "pino-opentelemetry-transport",
  "pino-pretty",
  "pino-roll",
] as const;
const HOST_DAEMON_FILES = [
  "sandy",
  "sandy.cmd",
  "sandy-parcel-watcher-child.mjs",
  "sandy-plugin-host-worker.mjs",
  "sandy-provider-bridge-worker.mjs",
  "daemon-bundle.mjs",
] as const;

export interface SandyAppArtifact {
  digest: string;
  path: string;
  size: number;
}

export interface SandyAppArtifactService {
  getArtifact(): Promise<SandyAppArtifact>;
  getVersion(): Promise<string>;
}

export interface SandyAppArtifactCommandRunner {
  (command: string, args: readonly string[], cwd: string): Promise<string>;
}

interface CreateSandyAppArtifactServiceOptions {
  dataDir: string;
  commandRunner?: SandyAppArtifactCommandRunner;
  protocolVersion?: number;
  serverEntryUrl: string;
}

interface SandyAppPackageJson {
  dependencies: Record<string, string>;
  engines: { node: string };
  name: "sandy-app";
  os: string[];
  version: string;
}

export async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const npmCliPath = command === "npm" ? hostToolchain.bundledNpmCli() : null;
  const result = await execFileAsync(
    npmCliPath === null ? command : process.execPath,
    npmCliPath === null ? [...args] : [npmCliPath, ...args],
    {
      cwd,
      env: omitNpmScriptPolicyEnv(process.env),
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return result.stdout;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

async function readSandyAppPackageJson(
  packageRoot: string,
): Promise<SandyAppPackageJson> {
  const parsed: unknown = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("name" in parsed) ||
    parsed.name !== "sandy-app" ||
    !("version" in parsed) ||
    typeof parsed.version !== "string" ||
    !("dependencies" in parsed) ||
    !isStringRecord(parsed.dependencies) ||
    !("engines" in parsed) ||
    parsed.engines === null ||
    typeof parsed.engines !== "object" ||
    !("node" in parsed.engines) ||
    typeof parsed.engines.node !== "string" ||
    !("os" in parsed) ||
    !Array.isArray(parsed.os) ||
    !parsed.os.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`Expected a sandy-app package at ${packageRoot}`);
  }
  return {
    dependencies: parsed.dependencies,
    engines: { node: parsed.engines.node },
    name: parsed.name,
    os: parsed.os,
    version: parsed.version,
  };
}

interface ResolvedSandyAppPackage {
  layout: "packaged" | "repo";
  packageJson: SandyAppPackageJson;
  root: string;
}

export async function resolveSandyAppPackage(
  serverEntryUrl: string,
): Promise<ResolvedSandyAppPackage> {
  const serverEntryDir = dirname(fileURLToPath(serverEntryUrl));
  const candidates: readonly { layout: "packaged" | "repo"; root: string }[] = [
    { layout: "packaged", root: resolve(serverEntryDir, "../..") },
    {
      layout: "repo",
      root: resolve(serverEntryDir, "../../../packages/sandy-app"),
    },
  ];
  for (const candidate of candidates) {
    try {
      const packageJson = await readSandyAppPackageJson(candidate.root);
      return { ...candidate, packageJson };
    } catch {}
  }
  throw new Error(
    `Unable to locate the sandy-app package from ${serverEntryDir}; tried ${candidates
      .map((candidate) => candidate.root)
      .join(", ")}`,
  );
}

function hostPackageJson(packageJson: SandyAppPackageJson): object {
  const dependencies = Object.fromEntries(
    HOST_DEPENDENCIES.map((name) => {
      const version = packageJson.dependencies[name];
      if (version === undefined) {
        throw new Error(`sandy-app is missing host dependency ${name}`);
      }
      return [name, version];
    }),
  );
  return {
    name: packageJson.name,
    version: packageJson.version,
    description: "sandy enrolled host runtime",
    type: "module",
    os: [...new Set([...packageJson.os, "win32"])],
    bin: {
      sandy: "dist/sandy.js",
      "sandy-app": "dist/sandy-app.js",
      "sandy-host-daemon": "dist/sandy-host-daemon.js",
    },
    files: ["dist", "host-daemon", "README.md"],
    engines: packageJson.engines,
    dependencies,
  };
}

async function makeDirectoriesOwnerWritable(directory: string): Promise<void> {
  await chmod(directory, (await stat(directory)).mode | 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await makeDirectoriesOwnerWritable(join(directory, entry.name));
    }
  }
}

async function materializePackagedHostPackage(
  packageRoot: string,
  packageJson: SandyAppPackageJson,
  cacheDir: string,
): Promise<string> {
  const hostPackageRoot = await mkdtemp(join(cacheDir, "host-package-"));
  const distDir = join(hostPackageRoot, "dist");
  const hostDaemonSource = join(packageRoot, "host-daemon", "dist");
  const hostDaemonTarget = join(hostPackageRoot, "host-daemon", "dist");
  await mkdir(hostDaemonTarget, { recursive: true });
  await mkdir(distDir, { recursive: true });
  for (const fileName of ["sandy-app.js", "sandy-host-daemon.js", "sandy.js"]) {
    await copyFile(
      join(packageRoot, "dist", fileName),
      join(distDir, fileName),
    );
    await chmod(join(distDir, fileName), 0o755);
  }
  for (const fileName of HOST_DAEMON_FILES) {
    await copyFile(
      join(hostDaemonSource, fileName),
      join(hostDaemonTarget, fileName),
    );
  }
  await chmod(join(hostDaemonTarget, "sandy"), 0o755);
  await cp(
    join(hostDaemonSource, "sandy-chunks"),
    join(hostDaemonTarget, "sandy-chunks"),
    { recursive: true },
  );
  await makeDirectoriesOwnerWritable(join(hostDaemonTarget, "sandy-chunks"));
  try {
    await copyFile(
      join(packageRoot, "README.md"),
      join(hostPackageRoot, "README.md"),
    );
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  await writeFile(
    join(hostPackageRoot, "package.json"),
    `${JSON.stringify(hostPackageJson(packageJson), null, 2)}\n`,
  );
  return hostPackageRoot;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createSandyAppArtifactService(
  options: CreateSandyAppArtifactServiceOptions,
): SandyAppArtifactService {
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const cacheDir = join(options.dataDir, "install-cache");
  const protocolVersion =
    options.protocolVersion ?? HOST_DAEMON_PROTOCOL_VERSION;
  let resolvedPackagePromise: Promise<ResolvedSandyAppPackage> | undefined;
  let artifactPromise: Promise<SandyAppArtifact> | undefined;

  function getResolvedPackage(): Promise<ResolvedSandyAppPackage> {
    resolvedPackagePromise ??= resolveSandyAppPackage(options.serverEntryUrl);
    return resolvedPackagePromise;
  }

  async function buildArtifact(): Promise<SandyAppArtifact> {
    const resolved = await getResolvedPackage();
    const { packageJson, root: packageRoot } = resolved;
    await mkdir(cacheDir, { recursive: true });
    let temporaryHostPackageRoot: string | undefined;
    let hostPackageRoot: string;
    if (resolved.layout === "repo") {
      const repoRoot = resolve(packageRoot, "../..");
      await commandRunner(
        "pnpm",
        ["exec", "turbo", "run", "build:host", "--filter=sandy-app"],
        repoRoot,
      );
      hostPackageRoot = join(packageRoot, "host-package");
    } else {
      temporaryHostPackageRoot = await materializePackagedHostPackage(
        packageRoot,
        packageJson,
        cacheDir,
      );
      hostPackageRoot = temporaryHostPackageRoot;
    }

    try {
      const stdout = await commandRunner(
        "npm",
        ["pack", "--pack-destination", cacheDir],
        hostPackageRoot,
      );
      const packedName = stdout.trim().split(/\r?\n/u).at(-1);
      if (!packedName) {
        throw new Error("npm pack did not report a tarball name");
      }
      const packedPath = join(cacheDir, packedName);
      const bytes = await readFile(packedPath);
      const digest = sha256(bytes);
      const artifactPath = join(
        cacheDir,
        `sandy-app-host-${packageJson.version}-protocol-${protocolVersion}-${digest}.tgz`,
      );
      await rename(packedPath, artifactPath);
      const artifactStats = await stat(artifactPath);
      return { digest, path: artifactPath, size: artifactStats.size };
    } finally {
      if (temporaryHostPackageRoot !== undefined) {
        await rm(temporaryHostPackageRoot, { force: true, recursive: true });
      }
    }
  }

  return {
    getArtifact(): Promise<SandyAppArtifact> {
      artifactPromise ??= buildArtifact().catch((error: unknown) => {
        artifactPromise = undefined;
        throw error;
      });
      return artifactPromise;
    },
    async getVersion(): Promise<string> {
      return (await getResolvedPackage()).packageJson.version;
    },
  };
}
