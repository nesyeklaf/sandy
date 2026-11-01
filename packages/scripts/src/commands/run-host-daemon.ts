import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SANDY_PROD_HOST_DAEMON_PORT,
  resolvePortFromEnv,
  resolveRuntimeDataDir,
  resolveRuntimeMode,
  type SandyRuntimeMode,
} from "@sandy/config/runtime";
import { loadServerUrlValue } from "@sandy/config/server-url";
import {
  HOST_AUTH_FILE_NAME,
  HOST_ID_FILE_NAME,
  hostDaemonEnrollKeyResponseSchema,
  type HostDaemonEnrollKeyRequest,
} from "@sandy/host-daemon-contract";
import { loadHostDaemonEntrypointConfig } from "@sandy/config/host-daemon-entrypoint";
import type { HostDaemonRuntimeEnvironment } from "../lib/host-daemon-runtime.js";
import { toHostDaemonProcessEnv } from "../lib/host-daemon-runtime.js";
import { resolveDevHostDaemonPort } from "../lib/dev-restart-utils.js";
import { pathExists } from "../lib/legacy-dev-data-migration.js";
import { runScriptProcess } from "../lib/process-helpers.js";
import { repoRoot, runMainIfEntrypoint } from "../lib/script-entry.js";
import { waitForServerHealth } from "../lib/wait-for-server-health.js";

interface HostDaemonProcessCommand {
  args: string[];
  command: string;
}

interface CreateAutoJoinRequestArgs {
  requestedHostId: string | null;
}

interface ResolveHostDaemonPortArgs {
  mode: SandyRuntimeMode;
  requiresExplicitPort: boolean;
}

function resolveHostDaemonPort(args: ResolveHostDaemonPortArgs): number {
  if (
    args.requiresExplicitPort &&
    process.env.SANDY_HOST_DAEMON_PORT === undefined
  ) {
    throw new Error(
      "SANDY_HOST_DAEMON_PORT is required when running a dev extra-host daemon without SANDY_DATA_DIR. Set it to a port distinct from pnpm dev's host daemon port.",
    );
  }

  return resolvePortFromEnv({
    defaultPort:
      args.mode === "dev"
        ? resolveDevHostDaemonPort()
        : SANDY_PROD_HOST_DAEMON_PORT,
    env: process.env,
    name: "SANDY_HOST_DAEMON_PORT",
  });
}

function ensureDevOverridePair(mode: SandyRuntimeMode): void {
  if (mode !== "dev") {
    return;
  }

  const hasDataDirOverride = process.env.SANDY_DATA_DIR !== undefined;
  const hasServerUrlOverride = process.env.SANDY_SERVER_URL !== undefined;
  if (hasDataDirOverride !== hasServerUrlOverride) {
    throw new Error(
      "Dev host-daemon overrides must set both SANDY_DATA_DIR and SANDY_SERVER_URL, or neither.",
    );
  }
}

export function resolveHostDaemonRuntimeEnvironment(
  mode: SandyRuntimeMode,
): HostDaemonRuntimeEnvironment {
  ensureDevOverridePair(mode);
  const usesDefaultDevExtraHost =
    mode === "dev" && process.env.SANDY_DATA_DIR === undefined;
  const devDataDirSuffix = usesDefaultDevExtraHost ? "extra-host" : undefined;
  const dataDir = resolveRuntimeDataDir({
    env: process.env,
    homeDir: homedir(),
    mode,
    repoRoot: mode === "dev" ? repoRoot : undefined,
  });
  const hostDaemonEntrypointConfig = loadHostDaemonEntrypointConfig();
  return {
    ...hostDaemonEntrypointConfig,
    SANDY_DATA_DIR:
      devDataDirSuffix === undefined
        ? dataDir
        : join(dataDir, devDataDirSuffix),
    SANDY_HOST_DAEMON_PORT: String(
      resolveHostDaemonPort({
        mode,
        requiresExplicitPort: usesDefaultDevExtraHost,
      }),
    ),
    SANDY_SERVER_URL: loadServerUrlValue({
      env: process.env,
      homeDir: homedir(),
      mode,
      repoRoot,
    }),
    NODE_ENV: mode === "dev" ? "development" : "production",
  };
}

export function resolveHostDaemonProcessCommand(
  mode: SandyRuntimeMode,
): HostDaemonProcessCommand {
  if (mode === "dev") {
    return {
      args: [
        "--conditions=source",
        "--import",
        "tsx",
        "apps/host-daemon/src/index.ts",
      ],
      command: process.execPath,
    };
  }

  return {
    args: ["apps/host-daemon/dist/index.js"],
    command: process.execPath,
  };
}

async function readPersistedHostId(dataDir: string): Promise<string | null> {
  try {
    const value = (
      await readFile(join(dataDir, HOST_ID_FILE_NAME), "utf8")
    ).trim();
    return value.length > 0 ? value : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function createAutoJoinRequest(
  args: CreateAutoJoinRequestArgs,
): HostDaemonEnrollKeyRequest {
  const request: HostDaemonEnrollKeyRequest = {};
  if (args.requestedHostId !== null) {
    request.hostId = args.requestedHostId;
  }
  return request;
}

export async function maybeAddAutoJoinEnv(
  env: HostDaemonRuntimeEnvironment,
  autoJoin: boolean,
): Promise<HostDaemonRuntimeEnvironment> {
  if (!autoJoin || env.SANDY_HOST_ENROLL_KEY) {
    return env;
  }

  if (await pathExists(join(env.SANDY_DATA_DIR, HOST_AUTH_FILE_NAME))) {
    return env;
  }

  await waitForServerHealth(env.SANDY_SERVER_URL);
  const requestedHostId =
    env.SANDY_HOST_ID?.trim() || (await readPersistedHostId(env.SANDY_DATA_DIR));

  const response = await fetch(
    `${env.SANDY_SERVER_URL}/internal/hosts/enroll-key`,
    {
      body: JSON.stringify(createAutoJoinRequest({ requestedHostId })),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    },
  );

  if (response.status !== 201) {
    const detail = await response.text();
    throw new Error(
      `Failed to request host enroll key: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
    );
  }

  const enrollKeyResponse = hostDaemonEnrollKeyResponseSchema.parse(
    await response.json(),
  );
  if (requestedHostId && enrollKeyResponse.hostId !== requestedHostId) {
    throw new Error(
      `Enroll key response host ID ${enrollKeyResponse.hostId} does not match persisted host ID ${requestedHostId}`,
    );
  }

  return {
    ...env,
    SANDY_HOST_ENROLL_KEY: enrollKeyResponse.enrollKey,
    SANDY_HOST_ID: enrollKeyResponse.hostId,
  };
}

async function main(): Promise<void> {
  const mode = resolveRuntimeMode();
  const autoJoin = process.argv.includes("--auto-join");
  const env = await maybeAddAutoJoinEnv(
    resolveHostDaemonRuntimeEnvironment(mode),
    autoJoin,
  );
  const daemonProcessCommand = resolveHostDaemonProcessCommand(mode);
  process.exitCode = await runScriptProcess({
    args: daemonProcessCommand.args,
    command: daemonProcessCommand.command,
    cwd: repoRoot,
    env: toHostDaemonProcessEnv(env),
    stdio: "inherit",
  });
}

runMainIfEntrypoint(import.meta.url, main);
