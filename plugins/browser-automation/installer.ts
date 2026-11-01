import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const runtimePlatforms = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
] as const;
export type RuntimePlatform = (typeof runtimePlatforms)[number];
const platformSchema = z.enum(runtimePlatforms);

export interface RuntimeRelease {
  readonly package: string;
  readonly version: string;
  readonly artifacts: Readonly<Partial<Record<RuntimePlatform, string>>>;
}

export interface InstalledRuntime {
  readonly binary: string;
  readonly version: string;
  readonly sha256: string;
}

export function currentPlatform(): RuntimePlatform | null {
  const parsed = platformSchema.safeParse(
    `${process.platform}-${process.arch}`,
  );
  return parsed.success ? parsed.data : null;
}

const verifiedSchema = z
  .object({
    package: z.string(),
    version: z.string(),
    platform: platformSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    binary: z.string(),
    installedAt: z.number().int(),
  })
  .strict();

export function installRoot(dataDir: string): string {
  return join(dataDir, "runtime", "npm");
}

export function installDir(dataDir: string, release: RuntimeRelease): string {
  return join(installRoot(dataDir), `${release.package}@${release.version}`);
}

export function runtimeBinaryPath(release: RuntimeRelease): string {
  return `node_modules/${release.package}/bin/${release.package}-bin`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyInstalled(
  release: RuntimeRelease,
  dataDir: string,
  platform: RuntimePlatform,
): Promise<InstalledRuntime | null> {
  const expected = release.artifacts[platform];
  if (expected === undefined) return null;
  const dir = installDir(dataDir, release);
  let record: z.infer<typeof verifiedSchema>;
  try {
    record = verifiedSchema.parse(
      JSON.parse(await readFile(join(dir, "verified.json"), "utf8")),
    );
  } catch {
    return null;
  }
  if (
    record.package !== release.package ||
    record.version !== release.version ||
    record.platform !== platform ||
    record.sha256 !== expected ||
    record.binary.split("/").some((part) => part === "..")
  )
    return null;
  const binary = join(dir, record.binary);
  try {
    await access(binary, constants.X_OK);
  } catch {
    return null;
  }
  if ((await sha256File(binary)) !== expected) return null;
  return { binary, version: release.version, sha256: expected };
}

export function missingRuntimeMessage(
  release: RuntimeRelease,
  dataDir: string,
  platform: RuntimePlatform,
): string {
  const expected = release.artifacts[platform];
  const dir = installDir(dataDir, release);
  if (expected === undefined)
    return `DevBrowser ${release.version} has no verified release artifact recorded for ${platform}; see the plugin README before using this host.`;
  return `DevBrowser runtime ${release.package}@${release.version} is not installed on this browser host, and sandy does not download it. Expected a verified runtime in ${dir}: verified.json for ${platform} and the binary ${join(dir, runtimeBinaryPath(release))} with sha256 ${expected}. Install it yourself outside sandy as described in the Browser Automation plugin README, then open the session again.`;
}
