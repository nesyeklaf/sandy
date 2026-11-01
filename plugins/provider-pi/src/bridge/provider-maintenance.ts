import { experimental_execHostFile } from "@sandy-sdk/plugin-sdk/process";
import {
  type ProviderHealthResult,
  type ProviderInstallationStatus,
  experimental_commandOutput as commandOutput,
  experimental_compareVersions as compareVersions,
  experimental_formatCommand as formatCommand,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_versionFrom as versionFrom,
} from "@sandy-sdk/plugin-sdk/provider-bridge";
import { resolvePiLaunch, resolvePiProcessLaunch } from "./rpc-child.js";

const execFileAsync = experimental_execHostFile;
export const PI_MINIMUM_SUPPORTED_VERSION = "0.84.0";
export const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const INSTALL_GATE_TTL_MS = 30_000;

type PiVersionProbe =
  | { version: string; failure: null }
  | { version: null; failure: string };

export async function probePiVersion(): Promise<PiVersionProbe> {
  const launch = resolvePiProcessLaunch(process.env);
  const display = formatCommand(launch.command, [...launch.args, "--version"]);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      launch.command,
      [...launch.args, "--version"],
      {
        timeout: VERSION_PROBE_TIMEOUT_MS,
      },
    ));
  } catch (error) {
    return {
      version: null,
      failure: `\`${display}\` ${describePiVersionProbeFailure(error)}`,
    };
  }
  const version = versionFrom(stdout);
  return version === null
    ? { version: null, failure: `\`${display}\` printed no version` }
    : { version, failure: null };
}

export function describePiVersionProbeFailure(error: unknown): string {
  const failed =
    error !== null && typeof error === "object"
      ? (error as { code?: unknown; killed?: unknown; signal?: unknown })
      : null;
  if (failed?.killed === true) {
    return `timed out after ${VERSION_PROBE_TIMEOUT_MS / 1000} s`;
  }
  if (typeof failed?.signal === "string") {
    return `was stopped by ${failed.signal} before it answered`;
  }
  if (failed?.code !== undefined && failed.code !== null) {
    return `exited with ${String(failed.code)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function getPiProviderInstallationStatus(): Promise<ProviderInstallationStatus> {
  const launch = resolvePiLaunch(process.env);
  const [resolvedExecutable, probe] = await Promise.all([
    resolveExecutablePath(launch.command),
    probePiVersion(),
  ]);
  const currentVersion = probe.version;
  const installed = resolvedExecutable !== null || currentVersion !== null;
  const versionUnsupported =
    installed &&
    currentVersion !== null &&
    compareVersions(currentVersion, PI_MINIMUM_SUPPORTED_VERSION) < 0;

  return {
    executableName: "pi",
    executablePath: resolvedExecutable,
    installed,
    currentVersion,
    minimumSupportedVersion: PI_MINIMUM_SUPPORTED_VERSION,
    versionUnsupported,
  };
}

export function piHealthResult(
  status:
    | "ready"
    | "not_installed"
    | "unauthenticated"
    | "unsupported_version"
    | "unknown",
  args: {
    installedVersion?: string | null;
    statusMessage?: string | null;
  } = {},
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: PI_MINIMUM_SUPPORTED_VERSION,
      loginCommand: "pi",
    },
  };
}

export type PiInstallGate =
  | { ok: true; installedVersion: string }
  | {
      ok: false;
      status: "not_installed" | "unsupported_version" | "unknown";
      statusMessage: string | null;
      result: ProviderHealthResult;
    };

const INSTALL_GUIDANCE = `Install ${PI_NPM_PACKAGE} ${PI_MINIMUM_SUPPORTED_VERSION} or newer`;

async function probePiInstallGate(): Promise<PiInstallGate> {
  const launch = resolvePiLaunch(process.env);
  if ((await resolveExecutablePath(launch.command)) === null) {
    return {
      ok: false,
      status: "not_installed",
      statusMessage: null,
      result: piHealthResult("not_installed"),
    };
  }
  const probe = await probePiVersion();
  if (probe.version === null) {
    const statusMessage = `Could not determine the pi version: ${probe.failure}. ${INSTALL_GUIDANCE}`;
    return {
      ok: false,
      status: "unknown",
      statusMessage,
      result: piHealthResult("unknown", { statusMessage }),
    };
  }
  const installedVersion = probe.version;
  if (compareVersions(installedVersion, PI_MINIMUM_SUPPORTED_VERSION) < 0) {
    const statusMessage = `Pi ${installedVersion} is older than the supported minimum ${PI_MINIMUM_SUPPORTED_VERSION}. ${INSTALL_GUIDANCE}`;
    return {
      ok: false,
      status: "unsupported_version",
      statusMessage,
      result: piHealthResult("unsupported_version", {
        installedVersion,
        statusMessage,
      }),
    };
  }
  return { ok: true, installedVersion };
}

const installGateMemo = new Map<
  string,
  { expiresAt: number; gate: Promise<PiInstallGate> }
>();

export function getPiInstallGate(): Promise<PiInstallGate> {
  const launch = resolvePiLaunch(process.env);
  const key = JSON.stringify([launch.command, launch.args]);
  const now = Date.now();
  const cached = installGateMemo.get(key);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.gate;
  }
  const gate = probePiInstallGate();
  installGateMemo.set(key, { expiresAt: now + INSTALL_GATE_TTL_MS, gate });
  gate.catch(() => {
    if (installGateMemo.get(key)?.gate === gate) installGateMemo.delete(key);
  });
  return gate;
}

export function resetPiInstallGateForTests(): void {
  installGateMemo.clear();
}
