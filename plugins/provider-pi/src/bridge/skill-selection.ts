import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  experimental_skillSelectionSchema as skillSelectionSchema,
  type ExperimentalSkillSelection as SkillSelection,
} from "@sandy-sdk/plugin-sdk/provider-bridge";
import { experimental_hostToolchain as hostToolchain } from "@sandy-sdk/plugin-sdk/process";
import { z } from "zod";
import { locatePiPackageDir } from "../pi-package-skills.js";
import { resolvePiProcessLaunch } from "./rpc-child.js";
import { PI_SDK_RPC_WORKER_SOURCE } from "./sdk-rpc-worker.js";

const manifestSchema = z.object({ version: z.string() });

const MINIMUM_PI_SDK_VERSION = "1.5.1";

function isAtLeastMinimumPiSdk(version: string): boolean {
  const parse = (value: string) =>
    /^(\d+)\.(\d+)\.(\d+)/u.exec(value)?.slice(1, 4).map(Number) ?? null;
  const installed = parse(version);
  const minimum = parse(MINIMUM_PI_SDK_VERSION);
  if (installed === null || minimum === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (installed[index] !== minimum[index])
      return installed[index] > minimum[index];
  }
  return true;
}

function packageContains(packageDir: string, file: string): boolean {
  try {
    const path = relative(packageDir, realpathSync(file));
    return (
      path !== ".." &&
      !path.startsWith("../") &&
      !path.startsWith("..\\") &&
      !isAbsolute(path)
    );
  } catch {
    return false;
  }
}

function resolveSdkRuntime(
  launchEnv: NodeJS.ProcessEnv,
  childEnv: NodeJS.ProcessEnv,
  cwd: string,
  packageDir: string,
) {
  const env = { ...childEnv };
  const launch = resolvePiProcessLaunch(launchEnv, env, cwd);
  const executable = hostToolchain.resolve(launch.command, { env, cwd });
  if (!executable) throw new Error("Cannot resolve the configured Pi launcher");
  const runtime = /^(node|bun)(\.exe)?$/iu.test(basename(executable));
  let command: string;
  let runtimeArgs: string[] = [];
  let cliArgs: string[];
  if (runtime) {
    const entry = launch.args.findIndex((arg) =>
      packageContains(packageDir, resolve(cwd, arg)),
    );
    if (entry < 0)
      throw new Error(
        "Cannot locate the Pi CLI entry in the configured runtime arguments",
      );
    command = executable;
    runtimeArgs = launch.args.slice(0, entry);
    cliArgs = launch.args.slice(entry + 1);
  } else {
    const real = realpathSync(executable);
    const managed = readFileSync(real, "utf8");
    if (!packageContains(packageDir, real)) {
      const installRoot = join(dirname(dirname(real)), "install");
      if (
        !packageContains(installRoot, packageDir) ||
        !managed.includes("PI_MANAGED_INSTALL_ROOT") ||
        !managed.includes("pi_node_bin=")
      ) {
        throw new Error(
          "Cannot preserve this Pi wrapper runtime; configure SANDY_PI_BRIDGE_COMMAND as Node or Bun and SANDY_PI_BRIDGE_ARGS with the Pi CLI entry",
        );
      }
      const home = env.HOME;
      const dataHome =
        env.XDG_DATA_HOME ?? (home ? join(home, ".local", "share") : undefined);
      const managedBin = dataHome
        ? join(dataHome, "pi-node", "current", "bin")
        : undefined;
      if (managedBin && existsSync(join(managedBin, "node"))) {
        env.PATH = managedBin + (env.PATH ? ":" + env.PATH : "");
      }
      env.PI_MANAGED_INSTALL_ROOT = installRoot;
    } else if (!managed.startsWith("#!/usr/bin/env node")) {
      throw new Error("Cannot preserve the configured Pi executable runtime");
    }
    command = hostToolchain.resolve("node", { env, cwd }) ?? "node";
    cliArgs = launch.args;
  }
  const version = execFileSync(
    command,
    [...runtimeArgs, "-p", "process.versions.node"],
    {
      cwd,
      env,
      timeout: 3000,
      encoding: "utf8",
      windowsHide: true,
    },
  ).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (
    !match ||
    Number(match[1]) < 22 ||
    (Number(match[1]) === 22 && Number(match[2]) < 19)
  ) {
    throw new Error(
      "The Pi SDK worker requires a runtime compatible with Node >=22.19.0; found " +
        version,
    );
  }
  return { command, runtimeArgs, cliArgs, env };
}

export function preparePiSdkRpcLaunch(args: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  launchEnv: NodeJS.ProcessEnv;
  cliArgs: readonly string[];
  selection: SkillSelection;
  scratchPrefix: string;
}): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  files: string[];
} | null {
  const selection = skillSelectionSchema.parse(args.selection);
  let packageDir: string;
  let runtime: ReturnType<typeof resolveSdkRuntime>;
  try {
    packageDir = locatePiPackageDir(args.launchEnv, args.cwd);
    const { version } = manifestSchema.parse(
      JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")),
    );
    if (!isAtLeastMinimumPiSdk(version)) {
      throw new Error(
        "requires Pi " +
          MINIMUM_PI_SDK_VERSION +
          " or later; installed: " +
          version,
      );
    }
    runtime = resolveSdkRuntime(args.launchEnv, args.env, args.cwd, packageDir);
  } catch (error) {
    if (selection.mode === "inherit") return null;
    throw new Error("Cannot apply Sandy Pi skill selection: " + String(error), {
      cause: error,
    });
  }
  const workerPath = args.scratchPrefix + ".mjs";
  const bootstrapPath = args.scratchPrefix + ".json";
  try {
    writeFileSync(workerPath, PI_SDK_RPC_WORKER_SOURCE, { mode: 0o600 });
    writeFileSync(
      bootstrapPath,
      JSON.stringify({
        version: 1,
        packageDir,
        args: [...runtime.cliArgs, ...args.cliArgs],
        selection,
      }),
      { mode: 0o600 },
    );
  } catch (error) {
    for (const file of [workerPath, bootstrapPath])
      rmSync(file, { force: true });
    throw error;
  }
  return {
    command: runtime.command,
    args: [...runtime.runtimeArgs, workerPath, bootstrapPath],
    env: runtime.env,
    files: [workerPath, bootstrapPath],
  };
}
