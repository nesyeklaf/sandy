import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDataDirSkillsRootPath } from "@sandy/config/skill-storage-paths";
import {
  EMPTY_PROVIDER_NATIVE_ROOTS,
  EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
  providerNativeRootsAreEmpty,
  type ProviderNativeRoots,
} from "@sandy/domain";
import type {
  DiscoveredSkill,
  HostDaemonOnlineRpcResult,
  SkillRootKind,
} from "@sandy/host-daemon-contract";
import {
  CommandDispatchError,
  type CommandOf,
  ExpectedCommandDispatchError,
} from "../command-dispatch-support.js";
import {
  type CommandScanRoot,
  discoverSkills,
  SKILL_FILE_NAME,
  type SkillScanRoot,
} from "../command-discovery.js";
import {
  type DeclaredScanRootResolution,
  resolveDeclaredScanRoots,
} from "./list-commands.js";
import { writeHostFile } from "./file-write.js";
import { isPathWithinDirectory } from "@sandy/process-utils";
import { isBundledProviderSkillPath } from "@sandy/skill-index";

type SkillRootResolution = DeclaredScanRootResolution;

const SHARED_SKILLS_PROVIDER_ID = "sandy-shared";

function createSandySkillScanRoot(
  rootPath: string,
  rootKind: Extract<SkillRootKind, `sandy-${string}`>,
): SkillScanRoot {
  return {
    rootPath,
    ...(rootKind === "sandy-project"
      ? { boundaryPath: path.dirname(path.dirname(rootPath)) }
      : {}),
    shape: "skill",
    namePrefix: "",
    source: "skill",
    origin: rootKind === "sandy-project" ? "project" : "user",
    identitySeed: rootKind,
    rootKind,
  };
}

function resolveSandySkillScanRoots(
  resolution: SkillRootResolution,
): SkillScanRoot[] {
  const roots: SkillScanRoot[] = [];
  if (
    resolution.cwd !== null &&
    resolution.providerId !== SHARED_SKILLS_PROVIDER_ID
  ) {
    roots.push(
      createSandySkillScanRoot(
        path.join(resolution.cwd, ".sandy", "skills"),
        "sandy-project",
      ),
    );
  }
  return roots;
}

function classifySkillRoot(
  root: CommandScanRoot,
  resolution: SkillRootResolution,
): Pick<SkillScanRoot, "identitySeed" | "rootKind"> | null {
  if (root.source !== "skill") {
    return null;
  }
  if (root.namePrefix !== "") {
    const rootPath = "rootPath" in root ? root.rootPath : root.filePath;
    return {
      identitySeed: `plugin:${resolution.providerId}:${root.namePrefix}:${rootPath}`,
      rootKind: "plugin",
    };
  }
  if (root.skillIdentitySeed === undefined) {
    return null;
  }
  const shared = resolution.providerId === SHARED_SKILLS_PROVIDER_ID;
  return {
    identitySeed: root.skillIdentitySeed,
    rootKind: shared
      ? root.origin === "project"
        ? "shared-project"
        : "shared-user"
      : root.origin === "project"
        ? "provider-project"
        : "provider-user",
  };
}

export async function resolveSkillScanRoots(
  resolution: SkillRootResolution,
): Promise<SkillScanRoot[]> {
  const skillRoots = resolveSandySkillScanRoots(resolution);
  const providerRoots = await resolveDeclaredScanRoots(resolution);
  for (const root of providerRoots) {
    const classification = classifySkillRoot(root, resolution);
    if (classification === null) {
      continue;
    }
    skillRoots.push({ ...root, ...classification });
  }
  return skillRoots;
}

export async function listSharedSkills(args: {
  cwd: string;
  roots: ProviderNativeRoots;
}): Promise<DiscoveredSkill[]> {
  if (providerNativeRootsAreEmpty(args.roots)) {
    return [];
  }
  const roots = await resolveSkillScanRoots({
    cwd: args.cwd,
    homeDir: os.homedir(),
    providerId: SHARED_SKILLS_PROVIDER_ID,
    nativeRoots: {
      skills: args.roots,
      commands: EMPTY_PROVIDER_NATIVE_ROOTS,
      resolved: EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
    },
  });
  return discoverSkills({ roots });
}

export async function listHostSkills(
  command: CommandOf<"host.list_skills">,
  _options: { dataDir: string },
): Promise<HostDaemonOnlineRpcResult<"host.list_skills">> {
  if (command.cwd !== null && !path.isAbsolute(command.cwd)) {
    throw new CommandDispatchError("invalid_path", "cwd must be absolute");
  }
  const roots = await resolveSkillScanRoots({
    cwd: command.cwd,
    homeDir: os.homedir(),
    providerId: command.providerId,
    nativeRoots: command.nativeRoots,
  });
  const skills = await discoverSkills({ roots });
  return { skills };
}

function isSafeSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    name === path.basename(name) &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function resolveDeletableSkillRoot(
  args: {
    scope: CommandOf<"host.delete_skill">["scope"];
    cwd: string | null;
    rootPath: string | null;
  },
  dataDir: string,
): string {
  if (args.scope === "sandy-user") {
    return resolveDataDirSkillsRootPath(dataDir);
  }
  if (args.scope === "sandy-project") {
    const cwd = args.cwd;
    if (cwd === null) {
      throw new CommandDispatchError(
        "invalid_path",
        "cwd is required for a sandy-project skill",
      );
    }
    if (!path.isAbsolute(cwd)) {
      throw new CommandDispatchError("invalid_path", "cwd must be absolute");
    }
    return path.join(cwd, ".sandy", "skills");
  }
  if (args.rootPath === null || !path.isAbsolute(args.rootPath)) {
    throw new CommandDispatchError(
      "invalid_path",
      "rootPath must be absolute for a provider skill",
    );
  }
  return args.rootPath;
}

async function realpathOrNull(targetPath: string): Promise<string | null> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return null;
  }
}

export async function deleteHostSkill(
  command: CommandOf<"host.delete_skill">,
  options: { dataDir: string },
): Promise<HostDaemonOnlineRpcResult<"host.delete_skill">> {
  if (!isSafeSkillName(command.name)) {
    throw new CommandDispatchError(
      "invalid_skill_name",
      "Skill name must be a single path segment",
    );
  }
  const root = resolveDeletableSkillRoot(
    {
      scope: command.scope,
      cwd: command.cwd,
      rootPath: command.rootPath,
    },
    options.dataDir,
  );
  const skillDirPath = path.join(root, command.name);

  const realRoot = await realpathOrNull(root);
  const realTarget = await realpathOrNull(skillDirPath);
  if (realRoot === null || realTarget === null) {
    throw new ExpectedCommandDispatchError(
      "skill_not_found",
      `Skill "${command.name}" not found`,
    );
  }
  if (realTarget !== path.join(realRoot, command.name)) {
    throw new CommandDispatchError(
      "skill_outside_root",
      "Refusing to delete a skill that resolves outside its skill root",
    );
  }

  const targetStat = await fs.stat(realTarget).catch(() => null);
  if (targetStat === null || !targetStat.isDirectory()) {
    throw new ExpectedCommandDispatchError(
      "skill_not_found",
      `Skill "${command.name}" not found`,
    );
  }
  const skillFileStat = await fs
    .stat(path.join(realTarget, SKILL_FILE_NAME))
    .catch(() => null);
  if (skillFileStat === null || !skillFileStat.isFile()) {
    throw new CommandDispatchError(
      "not_a_skill",
      `"${command.name}" is not a skill directory`,
    );
  }

  await fs.rm(realTarget, { recursive: true, force: false });
  return { deletedPath: realTarget };
}

interface ResolvedSkillFile {
  skillDirPath: string;
  skillFilePath: string;
}

async function resolveConfinedSkillFile(
  realSkillDirPath: string,
  name: string,
): Promise<ResolvedSkillFile> {
  const realSkillFile = await realpathOrNull(
    path.join(realSkillDirPath, SKILL_FILE_NAME),
  );
  if (realSkillFile === null) {
    throw new ExpectedCommandDispatchError(
      "skill_not_found",
      `Skill "${name}" not found`,
    );
  }
  if (
    realSkillFile === realSkillDirPath ||
    !isPathWithinDirectory(realSkillDirPath, realSkillFile)
  ) {
    throw new CommandDispatchError(
      "skill_outside_root",
      `Refusing to edit "${name}": its SKILL.md resolves outside the skill directory`,
    );
  }
  return { skillDirPath: realSkillDirPath, skillFilePath: realSkillFile };
}

async function resolveSandySkillFile(
  command: CommandOf<"host.write_skill"> & {
    scope: "sandy-user" | "sandy-project";
  },
  dataDir: string,
): Promise<ResolvedSkillFile> {
  const sandyRoot = resolveDeletableSkillRoot(
    { scope: command.scope, cwd: command.cwd, rootPath: null },
    dataDir,
  );
  const realRoot = await realpathOrNull(sandyRoot);
  const realTarget = await realpathOrNull(path.join(sandyRoot, command.name));
  if (realRoot === null || realTarget === null) {
    throw new ExpectedCommandDispatchError(
      "skill_not_found",
      `Skill "${command.name}" not found`,
    );
  }
  if (realTarget !== path.join(realRoot, command.name)) {
    throw new CommandDispatchError(
      "skill_outside_root",
      "Refusing to edit a skill that resolves outside its sandy root",
    );
  }
  return resolveConfinedSkillFile(realTarget, command.name);
}

async function resolveLinkedSkillFile(
  command: CommandOf<"host.write_skill">,
  dataDir: string,
): Promise<ResolvedSkillFile> {
  const rootPath = command.rootPath;
  if (rootPath === null || !path.isAbsolute(rootPath)) {
    throw new CommandDispatchError(
      "invalid_path",
      "rootPath must be absolute for a provider or shared skill",
    );
  }
  const realSkillDir = await realpathOrNull(path.join(rootPath, command.name));
  if (realSkillDir === null) {
    throw new ExpectedCommandDispatchError(
      "skill_not_found",
      `Skill "${command.name}" not found`,
    );
  }
  const resolved = await resolveConfinedSkillFile(realSkillDir, command.name);
  const realDataDir = await realpathOrNull(dataDir);
  if (
    realDataDir !== null &&
    isPathWithinDirectory(realDataDir, resolved.skillFilePath)
  ) {
    throw new CommandDispatchError(
      "skill_not_writable",
      `Skill "${command.name}" is installed and managed by sandy and cannot be edited`,
    );
  }
  if (isBundledProviderSkillPath(resolved.skillFilePath)) {
    throw new CommandDispatchError(
      "skill_not_writable",
      `Skill "${command.name}" is bundled with its provider and cannot be edited`,
    );
  }
  return resolved;
}

export async function writeHostSkill(
  command: CommandOf<"host.write_skill">,
  options: { dataDir: string },
): Promise<HostDaemonOnlineRpcResult<"host.write_skill">> {
  if (!isSafeSkillName(command.name)) {
    throw new CommandDispatchError(
      "invalid_skill_name",
      "Skill name must be a single path segment",
    );
  }
  const { scope } = command;
  const { skillDirPath, skillFilePath } =
    scope === "sandy-user" || scope === "sandy-project"
      ? await resolveSandySkillFile({ ...command, scope }, options.dataDir)
      : await resolveLinkedSkillFile(command, options.dataDir);
  const skillFileStat = await fs.stat(skillFilePath).catch(() => null);
  if (skillFileStat === null || !skillFileStat.isFile()) {
    throw new ExpectedCommandDispatchError(
      "skill_not_found",
      `Skill "${command.name}" not found`,
    );
  }
  const segments = skillRelativeSegments(command.relativePath);
  const isSkillFile = segments.length === 1 && segments[0] === SKILL_FILE_NAME;
  const targetPath = isSkillFile
    ? skillFilePath
    : path.join(skillDirPath, ...segments);
  const result = await writeHostFile({
    type: "host.write_file",
    path: targetPath,
    rootPath: skillDirPath,
    content: command.content,
    contentEncoding: "utf8",
    createParents: !isSkillFile && command.expectedSha256 === null,
    expectedSha256: command.expectedSha256,
  });
  if (result.outcome === "conflict") {
    return result;
  }
  return {
    outcome: "written",
    filePath: targetPath,
    sha256: result.sha256,
  };
}

function skillRelativeSegments(relativePath: string): string[] {
  const segments = relativePath.split("/");
  if (
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    throw new CommandDispatchError(
      "invalid_path",
      "relativePath must be a plain path inside the skill folder",
    );
  }
  return segments;
}

function createSkillRoot(command: CommandOf<"host.create_skill">): string {
  if (command.scope === "sandy-project") {
    if (command.cwd === null || !path.isAbsolute(command.cwd)) {
      throw new CommandDispatchError("invalid_path", "cwd must be absolute");
    }
    return path.join(command.cwd, ".sandy", "skills");
  }
  if (command.userRoot === null) {
    throw new CommandDispatchError(
      "invalid_path",
      "userRoot is required for a shared-user skill",
    );
  }
  return path.resolve(os.homedir(), command.userRoot);
}

export async function createHostSkill(
  command: CommandOf<"host.create_skill">,
): Promise<HostDaemonOnlineRpcResult<"host.create_skill">> {
  if (!isSafeSkillName(command.name)) {
    throw new CommandDispatchError(
      "invalid_skill_name",
      "Skill name must be a single path segment",
    );
  }
  const root = createSkillRoot(command);
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  const skillDirPath = path.join(realRoot, command.name);
  try {
    await fs.mkdir(skillDirPath);
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) {
      return { outcome: "conflict", currentSha256: null };
    }
    throw error;
  }
  const skillFilePath = path.join(skillDirPath, SKILL_FILE_NAME);
  const result = await writeHostFile({
    type: "host.write_file",
    path: skillFilePath,
    rootPath: skillDirPath,
    content: command.content,
    contentEncoding: "utf8",
    createParents: false,
    expectedSha256: null,
  }).catch(async (error: unknown) => {
    await fs.rm(skillDirPath, { recursive: true, force: true });
    throw error;
  });
  if (result.outcome === "conflict") {
    return result;
  }
  return { outcome: "written", filePath: skillFilePath, sha256: result.sha256 };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
