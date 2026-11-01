import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SANDY_APP_VERSION_FALLBACK = "0.0.0-dev";
const PARENT_LOOKUP_MAX_DEPTH = 8;

interface ResolveSandyAppVersionArgs {
  env: NodeJS.ProcessEnv;
  fromDir: string;
}

interface SandyAppPackageJson {
  name: string;
  version: string;
}

function isSandyAppPackageJson(value: unknown): value is SandyAppPackageJson {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "version" in value &&
    typeof value.version === "string" &&
    value.version.length > 0
  );
}

function readSandyAppVersionAt(packageJsonPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (!isSandyAppPackageJson(parsed) || parsed.name !== "sandy-app") {
      return null;
    }
    return parsed.version;
  } catch {
    return null;
  }
}

function trimEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSandyAppVersion(args: ResolveSandyAppVersionArgs): string {
  const envValue = trimEnvValue(args.env.SANDY_APP_VERSION);
  if (envValue !== undefined) {
    return envValue;
  }

  let currentDir = resolve(args.fromDir);
  for (let depth = 0; depth < PARENT_LOOKUP_MAX_DEPTH; depth += 1) {
    const candidatePath = join(currentDir, "package.json");
    const candidateVersion = readSandyAppVersionAt(candidatePath);
    if (candidateVersion !== null) {
      return candidateVersion;
    }
    const workspaceCandidatePath = join(
      currentDir,
      "packages",
      "sandy-app",
      "package.json",
    );
    const workspaceCandidateVersion = readSandyAppVersionAt(
      workspaceCandidatePath,
    );
    if (workspaceCandidateVersion !== null) {
      return workspaceCandidateVersion;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return SANDY_APP_VERSION_FALLBACK;
}

export function resolveSandyCliVersion(): string {
  return resolveSandyAppVersion({
    env: process.env,
    fromDir: dirname(fileURLToPath(import.meta.url)),
  });
}
