import { hostToolchain, execPortableFile } from "@sandy/process-utils";
import semverCompare from "semver/functions/compare.js";
import semverValid from "semver/functions/valid.js";

const CLI_PROBE_TIMEOUT_MS = 5_000;
const INSTALLATION_CHECK_TIMEOUT_MS = 15_000;

export async function resolveExecutablePath(
  command: string,
): Promise<string | null> {
  return hostToolchain.resolve(command);
}

export async function commandOutput(
  command: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execPortableFile(command, [...args], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: INSTALLATION_CHECK_TIMEOUT_MS,
    });
    return `${stdout}\n${stderr}`.trim();
  } catch {
    return null;
  }
}

export function versionFrom(value: string | null): string | null {
  const candidate = value?.match(/\bv?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/u)?.[1];
  return candidate !== undefined && semverValid(candidate) !== null
    ? candidate
    : null;
}

export async function readCliVersion(command: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execPortableFile(command, ["--version"], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: CLI_PROBE_TIMEOUT_MS,
    });
    return versionFrom(`${stdout}\n${stderr}`);
  } catch {
    return null;
  }
}

export function compareVersions(left: string, right: string): number {
  return semverCompare(left, right);
}

export function formatCommand(
  command: string,
  args: readonly string[],
): string {
  return [command, ...args]
    .map((part) =>
      /^[A-Za-z0-9_./:@+-]+$/u.test(part)
        ? part
        : `'${part.replace(/'/gu, "'\\''")}'`,
    )
    .join(" ");
}

export function clampPercent(value: number): number {
  return Math.min(
    100,
    Math.max(0, Math.round(Number.isFinite(value) ? value : 0)),
  );
}
