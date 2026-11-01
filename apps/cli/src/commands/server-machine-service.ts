import {
  execHostFileCallback as execFile,
  spawnHostProcess as spawn,
} from "@sandy/process-utils";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  sandyAppRuntimeVerifyTokens,
  clearOwnSandyAppRuntimeFile,
  readSandyAppRuntimeFile,
} from "@sandy/config/app-runtime-file";
import {
  formatSandyAppConfigPath,
  parseSandyAppManagedConfig,
} from "@sandy/config/sandy-app-managed-config";
import { waitForProcessExit } from "@sandy/config/child-process-exit";
import {
  findMachineServiceFile,
  MACHINE_INSTALLER_ENV_NAME,
} from "@sandy/config/machine-service";
import { stopVerifiedProcess } from "@sandy/config/verified-process-stop";
import { readServerMovedFile } from "@sandy/server-archive";

const NODE_REQUIREMENT = "Node.js 22.19 or newer";
const NODE_VERSION_TIMEOUT_MS = 10_000;
const RUNTIME_STOP_TIMEOUT_MS = 15_000;
const RUNTIME_STOP_KILL_TIMEOUT_MS = 3_000;
const INSTALL_COMMAND =
  "npx -y --package sandy-app sandy server install-machine-service";

export interface InstallMachineServiceArgs {
  confirm(message: string): Promise<boolean>;
  dataDir: string;
  installerOutput: "stderr" | "stdout";
  report(line: string): void;
}

export interface InstallMachineServiceResult {
  dataDir: string;
  serverUrl: string;
  serviceFile: string | null;
  toHostName: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertMachineIdentity(dataDir: string): Promise<void> {
  if (!(await pathExists(join(dataDir, "auth.json")))) {
    throw new Error(
      `${dataDir} has no machine credentials (auth.json), so there is no machine to keep connected.`,
    );
  }
  const configPath = formatSandyAppConfigPath(dataDir);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    throw new Error(
      `${dataDir} has no server address (${configPath} is missing).`,
    );
  }
  if (parseSandyAppManagedConfig(JSON.parse(text)).serverUrl === undefined) {
    throw new Error(`${configPath} has no server address.`);
  }
}

async function resolveInstallerPath(): Promise<string> {
  const installerPath = process.env[MACHINE_INSTALLER_ENV_NAME]?.trim() ?? "";
  if (installerPath.length === 0 || !(await pathExists(installerPath))) {
    throw new Error(
      `This sandy installation doesn't include the machine installer. Run ${INSTALL_COMMAND} instead.`,
    );
  }
  return installerPath;
}

function readPathNodeVersion(): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "node",
      ["-p", "process.versions.node"],
      { timeout: NODE_VERSION_TIMEOUT_MS },
      (error, stdout) => {
        resolvePromise(error === null ? stdout.trim() : null);
      },
    );
  });
}

function supportsServiceNode(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

async function assertServiceNode(): Promise<void> {
  const version = await readPathNodeVersion();
  if (version === null) {
    throw new Error(
      `The background service runs sandy with the node on your PATH, and none was found. Install ${NODE_REQUIREMENT}, then run this command again.`,
    );
  }
  if (!supportsServiceNode(version)) {
    throw new Error(
      `The background service runs sandy with the node on your PATH, which is Node.js ${version}. Install ${NODE_REQUIREMENT}, then run this command again.`,
    );
  }
}

async function stopLocalSandy(
  dataDir: string,
  report: (line: string) => void,
): Promise<void> {
  const runtime = await readSandyAppRuntimeFile(dataDir);
  if (runtime === null) {
    return;
  }
  const result = await stopVerifiedProcess({
    killTimeoutMs: RUNTIME_STOP_KILL_TIMEOUT_MS,
    pid: runtime.pid,
    signal: "SIGTERM",
    startedAt: runtime.startedAt,
    timeoutMs: RUNTIME_STOP_TIMEOUT_MS,
    verifyTokens: sandyAppRuntimeVerifyTokens(runtime.entryPath),
  });
  if (result.kind === "unverified") {
    throw new Error(
      `sandy on this computer is recorded as pid ${String(runtime.pid)}, but that process doesn't look like it, so it was left alone. Quit the sandy desktop app or stop sandy, then run this command again.`,
    );
  }
  if (result.kind === "still-running") {
    throw new Error(
      `sandy (pid ${String(runtime.pid)}) did not stop, even after SIGKILL.`,
    );
  }
  await clearOwnSandyAppRuntimeFile({ dataDir, pid: runtime.pid });
  if (result.kind === "stopped") {
    report(`Stopped sandy on this computer (pid ${String(runtime.pid)}).`);
  }
}

async function runInstaller(args: {
  dataDir: string;
  installerPath: string;
  output: InstallMachineServiceArgs["installerOutput"];
}): Promise<boolean> {
  const installer = spawn(
    "sh",
    [args.installerPath, "--adopt", "--data-dir", args.dataDir],
    { stdio: ["ignore", args.output === "stderr" ? 2 : "inherit", "inherit"] },
  );
  const exit = await waitForProcessExit(installer);
  return exit.code === 0;
}

export function formatMachineServiceRemoval(serviceFile: string): string {
  return serviceFile.endsWith(".plist")
    ? `launchctl bootout gui/$(id -u) '${serviceFile}' && rm '${serviceFile}'`
    : `systemctl --user disable --now ${basename(serviceFile)} && rm '${serviceFile}'`;
}

export function findLocalMachineServiceFile(
  dataDir: string,
): Promise<string | null> {
  return findMachineServiceFile({
    dataDir,
    homeDir: homedir(),
    platform: process.platform,
  });
}

export async function installMachineService(
  args: InstallMachineServiceArgs,
): Promise<InstallMachineServiceResult | null> {
  const { dataDir } = args;
  const lock = await readServerMovedFile(dataDir);
  if (lock === null) {
    throw new Error(
      `${dataDir} is not locked by a server move. This command keeps a computer connected as a machine after its sandy server moved to another machine.`,
    );
  }
  if (process.platform === "win32") {
    throw new Error(
      "sandy cannot install the background machine service on Windows. It is available on macOS and Linux.",
    );
  }
  await assertMachineIdentity(dataDir);
  const installerPath = await resolveInstallerPath();
  await assertServiceNode();
  if (
    !(await args.confirm(
      `Stop sandy on this computer and install a background service that keeps it connected to ${lock.toHostName}?`,
    ))
  ) {
    return null;
  }
  await stopLocalSandy(dataDir, args.report);
  if (
    !(await runInstaller({
      dataDir,
      installerPath,
      output: args.installerOutput,
    }))
  ) {
    throw new Error(
      "The background service install failed; see the installer output above. Until it succeeds, this computer stays connected only while the sandy desktop app or npx sandy-app runs, so start one of them to reconnect it now.",
    );
  }
  return {
    dataDir,
    serverUrl: lock.serverUrl,
    serviceFile: await findLocalMachineServiceFile(dataDir),
    toHostName: lock.toHostName,
  };
}
