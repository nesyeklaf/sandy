import { z } from "zod";
import { delimiter } from "node:path";
import { defaultFeatureFlags } from "@sandy/domain";
import { DEFAULTS } from "./defaults.js";
import { CLI_LAUNCHER_ENV_NAME } from "./cli-command.js";
import { defineEnvVar, type EnvVarParseArgs } from "./env.js";
import {
  APP_SURFACE_ENV_NAME,
  APP_SURFACE_WEB,
  formatAppSurfaceValues,
  parseAppSurface,
  type AppSurface,
} from "./app-surface.js";
import { validateLogLevel } from "./log-level.js";
import { validateOptionalUrl, validateRequiredUrl } from "./public-url.js";
import { parseServerBindAddressesOnThisHost } from "./bind-addresses.js";
import { parsePortValue } from "./runtime.js";
import { toOptionalString } from "./strings.js";

function parseBooleanEnvValue(args: EnvVarParseArgs): boolean {
  const normalizedValue = args.value.trim().toLowerCase();
  if (
    normalizedValue === "true" ||
    normalizedValue === "1" ||
    normalizedValue === "yes" ||
    normalizedValue === "y"
  ) {
    return true;
  }
  if (
    normalizedValue === "false" ||
    normalizedValue === "0" ||
    normalizedValue === "no" ||
    normalizedValue === "n"
  ) {
    return false;
  }

  throw new Error(`${args.name} must be a boolean`);
}

function parseAppSurfaceEnvValue(args: EnvVarParseArgs): AppSurface {
  const parsed = parseAppSurface(args.value);
  if (parsed !== undefined) {
    return parsed;
  }
  throw new Error(`${args.name} must be one of ${formatAppSurfaceValues()}`);
}

function parseOptionalPortEnvValue(args: EnvVarParseArgs): number | undefined {
  if (args.value === "0") {
    return undefined;
  }

  return parsePortValue({
    name: args.name,
    rawPort: args.value,
  });
}

function parseOptionalTrimmedStringEnvValue(
  args: EnvVarParseArgs,
): string | undefined {
  return toOptionalString(args.value);
}

function parseStringEnvValue(args: EnvVarParseArgs): string {
  return args.value;
}

function parsePathListEnvValue(args: EnvVarParseArgs): string[] {
  return args.value
    .split(delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseNonEmptyStringEnvValue(args: EnvVarParseArgs): string {
  if (args.value.length === 0) {
    throw new Error(`${args.name} must not be empty`);
  }

  return args.value;
}

function parsePortEnvValue(args: EnvVarParseArgs): number {
  return parsePortValue({
    name: args.name,
    rawPort: args.value,
  });
}

function parseServerBindHostEnvValue(args: EnvVarParseArgs): string[] {
  return parseServerBindAddressesOnThisHost(args.value);
}

function parsePositiveIntegerEnvValue(args: EnvVarParseArgs): number {
  const parsed = Number(args.value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${args.name} must be a positive integer`);
  }
  return parsed;
}

function parseRequiredUrlEnvValue(args: EnvVarParseArgs): string {
  return validateRequiredUrl(args.name, args.value);
}

function parseOptionalUrlEnvValue(args: EnvVarParseArgs): string {
  return validateOptionalUrl(args.name, args.value);
}

function parseLogLevelValue(args: EnvVarParseArgs): string {
  return validateLogLevel(args.value);
}

export const SANDY_LOG_LEVEL_ENV = defineEnvVar<string>({
  description: "Log level: trace, debug, info, warn, error, fatal",
  name: "SANDY_LOG_LEVEL",
  parse: parseLogLevelValue,
});

function parseOtlpEndpointValue(args: EnvVarParseArgs): string | null {
  const endpoint = validateOptionalUrl(args.name, args.value);
  if (endpoint === "") {
    return null;
  }
  const protocol = new URL(endpoint).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`${args.name} must be an http or https URL`);
  }
  return endpoint.replace(/\/+$/u, "");
}

export const SANDY_OTLP_ENDPOINT_ENV = defineEnvVar<string | null>({
  description:
    "Base URL of an OTLP/HTTP receiver, such as http://127.0.0.1:4318. When set, the server and host daemon export logs, traces, and metrics there. Unset or empty: nothing is exported.",
  name: "SANDY_OTLP_ENDPOINT",
  parse: parseOtlpEndpointValue,
});

export const SANDY_SERVER_PORT_ENV = defineEnvVar<number>({
  description: "HTTP port for the server",
  name: "SANDY_SERVER_PORT",
  parse: parsePortEnvValue,
});

export const SANDY_SERVER_BIND_HOST_ENV = defineEnvVar<string[]>({
  description:
    "Additional tailnet or WireGuard addresses the server listens on besides 127.0.0.1",
  name: "SANDY_SERVER_BIND_HOST",
  parse: parseServerBindHostEnvValue,
});

export const SANDY_HOST_DAEMON_PORT_ENV = defineEnvVar<number>({
  description: "Port the host daemon listens on for local API requests",
  name: "SANDY_HOST_DAEMON_PORT",
  parse: parsePortEnvValue,
});

export const SANDY_SERVER_URL_ENV = defineEnvVar<string>({
  description: "URL of the sandy server",
  name: "SANDY_SERVER_URL",
  parse: parseRequiredUrlEnvValue,
});

export const SANDY_APP_VERSION_ENV = defineEnvVar<string>({
  description:
    "Version of the running sandy-app package. The sandy-app launcher sets this from packages/sandy-app/package.json; defaults to a sentinel for dev/source runs.",
  name: "SANDY_APP_VERSION",
  parse: parseNonEmptyStringEnvValue,
});

export const SANDY_SERVER_LAUNCH_ID_ENV = defineEnvVar<string>({
  description:
    "Internal per-spawn identity the sandy-app launcher hands its server child. The server echoes it on /health so the launcher can tell its own child apart from another sandy server that already owns the port.",
  name: "SANDY_SERVER_LAUNCH_ID",
  parse: parseNonEmptyStringEnvValue,
});

export const SANDY_CLI_LAUNCHER_ENV = defineEnvVar<string>({
  description:
    "Internal path the sandy-app launcher hands its server child: the sandy command launcher it wrote in the data directory for this install. The server offers to put the sandy command on PATH only when it is set.",
  name: CLI_LAUNCHER_ENV_NAME,
  parse: parseNonEmptyStringEnvValue,
});

export const SANDY_APP_SURFACE_ENV = defineEnvVar<AppSurface>({
  description: "Internal launcher marker. Set by sandy-app and desktop launchers.",
  name: APP_SURFACE_ENV_NAME,
  parse: parseAppSurfaceEnvValue,
});

export const SANDY_APP_URL_ENV = defineEnvVar<string>({
  description:
    "Human-facing app/server base URL used for generated links, allowed browser origins, and the allowed DNS hostname for incoming requests. Does not control which host or port the server binds to.",
  name: "SANDY_APP_URL",
  parse: parseOptionalUrlEnvValue,
});

export const SANDY_EXTERNAL_URL_ENV = defineEnvVar<string>({
  description:
    "Internet-facing HTTPS base URL used for generated public links. Does not control which host or port the server binds to.",
  name: "SANDY_EXTERNAL_URL",
  parse: parseOptionalUrlEnvValue,
});

export const SANDY_PERF_DIAGNOSTICS_ENV = defineEnvVar<boolean>({
  description:
    "Permit server performance diagnostics when the performanceDiagnostics experiment is on. Requires restart.",
  name: "SANDY_PERF_DIAGNOSTICS",
  parse: parseBooleanEnvValue,
});

export const SANDY_SKIP_ONBOARDING_ENV = defineEnvVar<boolean>({
  description:
    "Mark first-run setup as completed at server startup so the setup screen is skipped. Settings can still replay it.",
  name: "SANDY_SKIP_ONBOARDING",
  parse: parseBooleanEnvValue,
});

export const SANDY_FF_PLACEHOLDER_ENV = defineEnvVar<boolean>({
  description:
    "Permanent placeholder feature flag. Non-functional keep-alive so the flag system has at least one entry; do not gate behavior on it.",
  name: "SANDY_FF_PLACEHOLDER",
  parse: parseBooleanEnvValue,
});

export const SANDY_FF_TIMELINE_WINDOW_EVENT_BUDGET_ENV = defineEnvVar<number>({
  description:
    "Max events one thread-timeline window may span. Raise far above the default to restore unbounded windows.",
  name: "SANDY_FF_TIMELINE_WINDOW_EVENT_BUDGET",
  parse: parsePositiveIntegerEnvValue,
});

export const SANDY_DEV_APP_HOST_ENV = defineEnvVar<string>({
  description:
    "Development-only Vite bind host override for apps/app. Defaults to 127.0.0.1 when unset.",
  name: "SANDY_DEV_APP_HOST",
  parse: parseStringEnvValue,
});

export const SANDY_DEV_APP_PORT_ENV = defineEnvVar<number | undefined>({
  description: "Development-only Vite port for apps/app.",
  name: "SANDY_DEV_APP_PORT",
  parse: parseOptionalPortEnvValue,
});

export const SANDY_CLI_DIR_ENV = defineEnvVar<string | undefined>({
  description:
    "Directory containing the sandy CLI executable to inject into runtime shells",
  name: "SANDY_CLI_DIR",
  parse: parseOptionalTrimmedStringEnvValue,
});

export const SANDY_INHERITED_SKILLS_ROOTS_ENV = defineEnvVar<string[]>({
  description:
    "Development-only path list of lower-priority inherited sandy skill roots",
  name: "SANDY_INHERITED_SKILLS_ROOTS",
  parse: parsePathListEnvValue,
});

export const SANDY_BRIDGE_DIR_ENV = defineEnvVar<string | undefined>({
  description:
    "Directory containing provider bridge bundles for the host daemon runtime",
  name: "SANDY_BRIDGE_DIR",
  parse: parseOptionalTrimmedStringEnvValue,
});

export const SANDY_SERVER_HEADERS_ENV = defineEnvVar<Record<string, string>>({
  description: "Private JSON headers attached to machine server requests",
  name: "SANDY_SERVER_HEADERS",
  parse: ({ value }) => {
    try {
      return z.record(z.string(), z.string()).parse(JSON.parse(value));
    } catch {
      throw new Error(
        "SANDY_SERVER_HEADERS must be a JSON object with string values",
      );
    }
  },
});

export const SANDY_HOST_ENROLL_KEY_ENV = defineEnvVar<string | undefined>({
  description:
    "One-time enrollment token used to bootstrap a host daemon with the sandy server",
  name: "SANDY_HOST_ENROLL_KEY",
  parse: parseOptionalTrimmedStringEnvValue,
});

export const SANDY_HOST_DAEMON_AUTO_UPDATE_ENV = defineEnvVar<boolean>({
  description:
    "Allow a remote host daemon to install the exact sandy-app package served by its server on a newer protocol mismatch",
  name: "SANDY_HOST_DAEMON_AUTO_UPDATE",
  parse: parseBooleanEnvValue,
});

export const SANDY_HOST_DAEMON_SUPERVISED_ENV = defineEnvVar<boolean>({
  description:
    "Set by sandy-app host-daemon --supervise so a daemon that relaunches itself after a server move keeps its launcher restarting it",
  name: "SANDY_HOST_DAEMON_SUPERVISED",
  parse: parseBooleanEnvValue,
});

export const SANDY_HOST_ID_ENV = defineEnvVar<string | undefined>({
  description:
    "Preferred host ID to persist for the daemon instead of generating one locally",
  name: "SANDY_HOST_ID",
  parse: parseOptionalTrimmedStringEnvValue,
});

export const DEFAULT_SANDY_APP_VERSION = DEFAULTS.appVersion;
export const DEFAULT_SANDY_APP_SURFACE = APP_SURFACE_WEB;
export const DEFAULT_SANDY_APP_URL = "";
export const DEFAULT_SANDY_SERVER_BIND_HOST: string[] = [];
export const DEFAULT_SANDY_EXTERNAL_URL = "";
export const DEFAULT_SANDY_DEV_APP_HOST = "";
export const DEFAULT_SANDY_FF_PLACEHOLDER = defaultFeatureFlags.placeholder;
export const DEFAULT_SANDY_FF_TIMELINE_WINDOW_EVENT_BUDGET =
  defaultFeatureFlags.timelineWindowEventBudget;
