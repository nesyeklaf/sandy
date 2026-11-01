import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  experimental_execHostFile as execHostFile,
  experimental_hostToolchain as hostToolchain,
} from "@sandy-sdk/plugin-sdk/process";
import { z } from "zod";
import { resolvePiLaunch } from "./bridge/rpc-child.js";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const RESOLVE_TIMEOUT_MS = 10_000;
const RESOLVE_MAX_BUFFER = 16 * 1024 * 1024;

const RESOLVER_SCRIPT = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [pkgDir, agentDir, workspace] = process.argv.slice(1);
const m = await import(pathToFileURL(join(pkgDir, "dist/index.js")).href);
const cwd = workspace || agentDir;
const settingsManager = m.SettingsManager.create(cwd, agentDir, { projectTrusted: Boolean(workspace) });
const packageManager = new m.DefaultPackageManager({ cwd, agentDir, settingsManager });
const resolved = await packageManager.resolve(async () => "skip");
process.stdout.write(JSON.stringify(resolved.skills.map((skill) => ({
  path: skill.path,
  enabled: skill.enabled,
  scope: skill.metadata.scope,
  origin: skill.metadata.origin,
  source: skill.metadata.source,
}))));
`;

const resolvedSkillsSchema = z.array(
  z.object({
    path: z.string().min(1),
    enabled: z.boolean(),
    scope: z.string(),
    origin: z.string(),
    source: z.string(),
  }),
);

const packageManifestSchema = z.object({ name: z.string() });

export interface PiPackageSkillRoot {
  path: string;
  origin: "user" | "project";
}

export interface PiPackageSkillsArgs {
  cwd: string | null;
  homeDir: string;
  agentDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

function readPackageName(directory: string): string | null {
  try {
    return packageManifestSchema.parse(
      JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")),
    ).name;
  } catch {
    return null;
  }
}

function findPackageDirFrom(start: string): string | null {
  let directory = path.dirname(start);
  for (;;) {
    if (readPackageName(directory) === PI_PACKAGE_NAME) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

const WRAPPER_SCRIPT_MAX_BYTES = 64 * 1024;

function findPackageDirInWrapperScript(file: string): string | null {
  let contents: string;
  try {
    const buffer = readFileSync(file);
    if (buffer.length > WRAPPER_SCRIPT_MAX_BYTES || buffer.includes(0)) {
      return null;
    }
    contents = buffer.toString("utf8");
  } catch {
    return null;
  }
  for (const match of contents.matchAll(
    /(?:\/|[A-Za-z]:[\\/])[^\s"'\\]*?\/@earendil-works\/pi-coding-agent(?=\/)/gu,
  )) {
    if (readPackageName(match[0]) === PI_PACKAGE_NAME) return match[0];
  }
  return null;
}

function windowsShimPackageDir(executable: string): string | null {
  if (path.basename(executable).toLowerCase() !== "pi.cmd") return null;
  const prefix = path.dirname(executable);
  const root =
    path.basename(prefix).toLowerCase() === ".bin" &&
    path.basename(path.dirname(prefix)).toLowerCase() === "node_modules"
      ? path.dirname(prefix)
      : path.join(prefix, "node_modules");
  const candidate = path.join(root, ...PI_PACKAGE_NAME.split("/"));
  return readPackageName(candidate) === PI_PACKAGE_NAME ? candidate : null;
}

function locatePiPackageDir(
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
): string {
  const launch = resolvePiLaunch(env);
  const executable = hostToolchain.resolve(launch.command, { env, cwd });
  const candidates = [
    ...(executable === null ? [] : [executable]),
    ...launch.args.filter((arg) => existsSync(arg)),
  ];
  for (const candidate of candidates) {
    const shimDir = windowsShimPackageDir(candidate);
    if (shimDir !== null) return realpathSync(shimDir);
    const real = realpathSync(candidate);
    const found =
      findPackageDirFrom(real) ?? findPackageDirInWrapperScript(real);
    if (found !== null) return realpathSync(found);
  }
  throw new Error(
    `could not locate the ${PI_PACKAGE_NAME} package from \`${launch.command}\``,
  );
}

export async function resolvePiPackageSkillRoots(
  args: PiPackageSkillsArgs,
): Promise<PiPackageSkillRoot[]> {
  const env: NodeJS.ProcessEnv = {
    ...args.env,
    HOME: args.homeDir,
    USERPROFILE: args.homeDir,
    PI_CODING_AGENT_DIR: args.agentDir,
  };
  const cwd = args.cwd ?? undefined;
  const packageDir = locatePiPackageDir(env, cwd);
  const node = hostToolchain.resolve("node", { env, cwd }) ?? "node";
  const { stdout } = await execHostFile(
    node,
    [
      "--input-type=module",
      "-e",
      RESOLVER_SCRIPT,
      packageDir,
      args.agentDir,
      args.cwd ?? "",
    ],
    {
      env,
      cwd,
      timeout: RESOLVE_TIMEOUT_MS,
      maxBuffer: RESOLVE_MAX_BUFFER,
    },
  );
  const skills = resolvedSkillsSchema.parse(JSON.parse(stdout));
  const roots = new Map<string, PiPackageSkillRoot>();
  for (const skill of skills) {
    if (
      !skill.enabled ||
      skill.origin !== "package" ||
      path.basename(skill.path) !== "SKILL.md"
    ) {
      continue;
    }
    const rootPath = path.dirname(skill.path);
    if (!roots.has(rootPath)) {
      roots.set(rootPath, {
        path: rootPath,
        origin: skill.scope === "project" ? "project" : "user",
      });
    }
  }
  return [...roots.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
