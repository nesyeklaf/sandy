import { firstPerIdentity, skillRegistrationId } from "@sandy/skill-index";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDataDirSkillsRootPath } from "@sandy/config/skill-storage-paths";
import { getAppSettings } from "@sandy/db";
import type { SandySkillSourceId } from "@sandy/domain";
import { replaceFile } from "@sandy/file-transfer";
import type { DiscoveredSkill, SkillRootKind } from "@sandy/host-daemon-contract";
import type {
  SkillDuplicate,
  SkillDuplicateRelation,
  SkillProvider,
  SkillRegistration,
  SkillScope,
  SkillSummary,
} from "@sandy/server-contract";
import { editableSkillScopeSchema } from "@sandy/server-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import {
  remapDaemonFileRouteError,
  requireDaemonFileContentResult,
} from "../hosts/daemon-file-response.js";
import type { AppDeps } from "../../types.js";
import {
  callHostOnlineRpcForWork,
  callHostRetryableOnlineRpc,
} from "../hosts/online-rpc.js";
import type { ProjectCommandWorkspace as CommandWorkspace } from "../projects/project-workspace.js";
import { resolveServerOwnedSkillCatalogEntries } from "./injected-skills.js";
import { resolveSkillCatalog } from "./skill-catalog.js";
import { hostPathDirname, resolveSharedSkills } from "./shared-skills.js";
import {
  DEFAULT_PATH_LIST_EXCLUDE_NAMES,
  SKILL_PATH_LIST_INCLUDE_HIDDEN,
} from "../../routes/path-list-policy.js";
import {
  providerHasNativeRootSurface,
  scanProviderNativeRoots,
} from "../providers/native-roots.js";

export type IndexedSkillRegistration = SkillRegistration & {
  realPath: string;
  contentSha256: string | null;
};

const SKILL_FILE_NAME = "SKILL.md";
const SERVER_SKILL_FILE_LIMIT = 200;
const SERVER_SKILL_CONTENT_LIMIT_BYTES = 25 * 1024 * 1024;

const SKILL_SCOPE_ORDER: readonly SkillScope[] = [
  "sandy-project",
  "sandy-user",
  "sandy-builtin",
  "shared-project",
  "shared-user",
  "provider-project",
  "provider-user",
  "plugin",
];

function hostPathBasename(filePath: string): string {
  return /^[a-zA-Z]:[\\/]/u.test(filePath)
    ? path.win32.basename(filePath)
    : path.posix.basename(filePath);
}

function hostPathJoin(rootPath: string, segments: readonly string[]): string {
  return /^[a-zA-Z]:[\\/]/u.test(rootPath)
    ? path.win32.join(rootPath, ...segments)
    : path.posix.join(rootPath, ...segments);
}

function isBundledProviderSkill(filePath: string): boolean {
  return /(^|[\\/])\.system([\\/]|$)/u.test(filePath);
}

interface MappedScope {
  scope: SkillScope;
  provider: SkillProvider | null;
  manageable: boolean;
}

export function mapSkillScope(
  provider: SkillProvider,
  rootKind: SkillRootKind,
  filePath: string,
): MappedScope {
  switch (rootKind) {
    case "sandy-project":
      return { scope: "sandy-project", provider: null, manageable: true };
    case "sandy-data-dir":
      return { scope: "sandy-user", provider: null, manageable: true };
    case "sandy-builtin":
      return { scope: "sandy-builtin", provider: null, manageable: false };
    case "provider-project":
      return { scope: "provider-project", provider, manageable: true };
    case "provider-user":
      return {
        scope: "provider-user",
        provider,
        manageable: !isBundledProviderSkill(filePath),
      };
    case "shared-project":
      return { scope: "shared-project", provider: null, manageable: false };
    case "shared-user":
      return { scope: "shared-user", provider: null, manageable: false };
    case "plugin":
      return { scope: "plugin", provider, manageable: false };
  }
}

interface ProviderSkillDiscovery {
  provider: SkillProvider;
  skills: DiscoveredSkill[];
}

function compareSkillSummaries(
  left: SkillRegistration,
  right: SkillRegistration,
): number {
  const scopeDelta =
    SKILL_SCOPE_ORDER.indexOf(left.scope) -
    SKILL_SCOPE_ORDER.indexOf(right.scope);
  if (scopeDelta !== 0) {
    return scopeDelta;
  }
  const providerDelta = (left.provider ?? "").localeCompare(
    right.provider ?? "",
  );
  if (providerDelta !== 0) {
    return providerDelta;
  }
  const nameDelta = left.name.localeCompare(right.name);
  if (nameDelta !== 0) {
    return nameDelta;
  }
  return left.filePath.localeCompare(right.filePath);
}

export function assembleSkillList(
  perProvider: readonly ProviderSkillDiscovery[],
): SkillRegistration[] {
  const registrations: SkillRegistration[] = [];
  for (const { provider, skills } of perProvider) {
    for (const skill of skills) {
      const mapped = mapSkillScope(provider, skill.rootKind, skill.filePath);
      registrations.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        provider: mapped.provider,
        scope: mapped.scope,
        pluginId:
          skill.rootKind === "plugin"
            ? (skill.name.split(":", 1)[0] ?? skill.name)
            : null,
        filePath: skill.filePath,
        manageable: mapped.manageable && !skill.linked,
      });
    }
  }
  return firstPerIdentity(registrations, (skill) => skill.id).sort(
    compareSkillSummaries,
  );
}

async function listServerOwnedSkills(
  deps: AppDeps,
): Promise<SkillRegistration[]> {
  return (
    await resolveServerOwnedSkillCatalogEntries({
      builtinSkillsRootPath: null,
      dataDir: deps.config.dataDir,
      logger: deps.logger,
      skillTreeRegistry: deps.skillTreeRegistry,
    })
  )
    .map(({ runtimeSource }): SkillRegistration | null => {
      if (runtimeSource.kind !== "tree") return null;
      const rootPath = path.join(
        resolveDataDirSkillsRootPath(deps.config.dataDir),
        runtimeSource.name,
      );
      const logicalPath = `${runtimeSource.name}/${runtimeSource.entryPath}`;
      return {
        id: skillRegistrationId("sandy-data-dir", logicalPath),
        name: runtimeSource.name,
        description: runtimeSource.description,
        provider: null,
        scope: "sandy-user",
        pluginId: null,
        filePath: path.join(rootPath, runtimeSource.entryPath),
        manageable: true,
      };
    })
    .filter((skill): skill is SkillRegistration => skill !== null)
    .sort(compareSkillSummaries);
}

async function listSandyPluginSkills(deps: AppDeps): Promise<SkillRegistration[]> {
  return (await resolveSkillCatalog(deps))
    .map(({ provenance, runtimeSource }): SkillRegistration | null => {
      if (provenance.kind !== "plugin" || runtimeSource.kind !== "tree") {
        return null;
      }
      const rootPath = deps.skillTreeRegistry.resolve(runtimeSource.treeHash);
      if (rootPath === undefined) return null;
      const logicalPath = `${runtimeSource.name}/${runtimeSource.entryPath}`;
      return {
        id: skillRegistrationId(
          `sandy-plugin:${provenance.pluginId}`,
          logicalPath,
        ),
        name: runtimeSource.name,
        description: runtimeSource.description,
        provider: null,
        scope: "plugin",
        pluginId: provenance.pluginId,
        filePath: path.join(rootPath, runtimeSource.entryPath),
        manageable: false,
      };
    })
    .filter((skill): skill is SkillRegistration => skill !== null)
    .sort(compareSkillSummaries);
}

async function projectSkillIndex(
  deps: AppDeps,
  args: { workspace: CommandWorkspace },
): Promise<{
  registrations: IndexedSkillRegistration[];
  entries: SkillSummary[];
}> {
  const skillProviders = deps.providerRegistry
    .list()
    .filter(providerHasNativeRootSurface);
  const [perProvider, sharedSkills] = await Promise.all([
    Promise.all(
      skillProviders.map(
        async (registration): Promise<ProviderSkillDiscovery> => {
          const result = await scanProviderNativeRoots(deps, {
            type: "host.list_skills",
            registration,
            hostId: args.workspace.hostId,
            cwd: args.workspace.cwd,
          });
          return { provider: registration.info.id, skills: result.skills };
        },
      ),
    ),
    resolveSharedSkills(deps, {
      hostId: args.workspace.hostId,
      cwd: args.workspace.cwd,
    }),
  ]);
  const serverSkills = [
    ...(await listServerOwnedSkills(deps)),
    ...(await listSandyPluginSkills(deps)),
  ];
  const identities = new Map(sharedSkills.identities);
  for (const { skills } of perProvider) {
    for (const skill of skills)
      identities.set(skill.id, {
        contentSha256: skill.contentSha256,
        realPath: skill.realPath,
      });
  }
  for (const skill of serverSkills) {
    if (skill.manageable) {
      const directory = path.dirname(skill.filePath);
      const stats = await Promise.all(
        [path.dirname(directory), directory, skill.filePath].map((entry) =>
          fs.lstat(entry).catch(() => null),
        ),
      );
      skill.manageable = stats.every(
        (stat) => stat !== null && !stat.isSymbolicLink(),
      );
    }
    const bytes = await fs.readFile(skill.filePath).catch(() => null);
    const realPath = await fs.realpath(skill.filePath).catch(() => null);
    if (bytes !== null && realPath !== null)
      identities.set(skill.id, {
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
        realPath,
      });
  }
  const disabledSources = new Set(getAppSettings(deps.db).disabledSkillSources);
  const registrations = [
    ...assembleSkillList(perProvider),
    ...sharedSkills.summaries,
    ...serverSkills,
  ]
    .filter((skill) => {
      const source = sandySkillSourceOf(skill);
      return source === null || !disabledSources.has(source);
    })
    .sort(
      (left, right) =>
        Number(left.provider !== null) - Number(right.provider !== null) ||
        Number(left.scope.endsWith("project")) -
          Number(right.scope.endsWith("project")) ||
        compareSkillSummaries(left, right),
    )
    .map((skill) => ({
      ...skill,
      realPath: identities.get(skill.id)?.realPath ?? skill.filePath,
      contentSha256: identities.get(skill.id)?.contentSha256 ?? null,
    }));
  return { registrations, entries: summarizeSkillRegistrations(registrations) };
}

export function sandySkillSourceOf(
  skill: Pick<SkillRegistration, "scope" | "provider">,
): SandySkillSourceId | null {
  switch (skill.scope) {
    case "sandy-user":
      return "sandy-user";
    case "sandy-project":
      return "sandy-project";
    case "shared-user":
    case "shared-project":
      return "shared";
    case "plugin":
      return skill.provider === null ? "sandy-plugins" : null;
    default:
      return null;
  }
}

function skillContentIdentity(skill: IndexedSkillRegistration): string {
  return `${skill.name}\0${skill.contentSha256 ?? skill.realPath}`;
}

function toSkillRegistration({
  realPath: _realPath,
  contentSha256: _contentSha256,
  ...registration
}: IndexedSkillRegistration): SkillRegistration {
  return registration;
}

function toSkillDuplicate(
  skill: IndexedSkillRegistration,
  relation: SkillDuplicateRelation,
): SkillDuplicate {
  return {
    id: skill.id,
    scope: skill.scope,
    provider: skill.provider,
    pluginId: skill.pluginId,
    filePath: skill.filePath,
    relation,
  };
}

export function summarizeSkillRegistrations(
  registrations: readonly IndexedSkillRegistration[],
): SkillSummary[] {
  const groups = new Map<string, IndexedSkillRegistration[]>();
  const keysByName = new Map<string, string[]>();
  for (const skill of registrations) {
    const key = skillContentIdentity(skill);
    const group = groups.get(key);
    if (group !== undefined) {
      group.push(skill);
      continue;
    }
    groups.set(key, [skill]);
    keysByName.set(skill.name, [...(keysByName.get(skill.name) ?? []), key]);
  }
  const summaries: SkillSummary[] = [];
  for (const [key, group] of groups) {
    const [entry, ...copies] = group;
    if (entry === undefined) continue;
    const sameName = (keysByName.get(entry.name) ?? [])
      .filter((candidate) => candidate !== key)
      .flatMap((candidate) => groups.get(candidate) ?? []);
    summaries.push({
      ...toSkillRegistration(entry),
      providers: [
        ...new Set(
          group.flatMap((skill) =>
            skill.provider === null ? [] : [skill.provider],
          ),
        ),
      ].sort(),
      duplicates: otherLocations(entry, [
        ...copies.map((skill) =>
          toSkillDuplicate(
            skill,
            skill.realPath === entry.realPath ? "same-file" : "same-content",
          ),
        ),
        ...sameName.map((skill) => toSkillDuplicate(skill, "same-name")),
      ]),
    });
  }
  return summaries.sort(compareSkillSummaries);
}

function otherLocations(
  entry: IndexedSkillRegistration,
  duplicates: readonly SkillDuplicate[],
): SkillDuplicate[] {
  const seen = new Set([entry.filePath]);
  return duplicates.filter((duplicate) => {
    if (seen.has(duplicate.filePath)) return false;
    seen.add(duplicate.filePath);
    return true;
  });
}

export async function listProjectSkills(
  deps: AppDeps,
  args: { workspace: CommandWorkspace },
): Promise<SkillSummary[]> {
  return (await projectSkillIndex(deps, args)).entries;
}

function isServerOwnedSkill(deps: AppDeps, skill: SkillRegistration): boolean {
  const skillDirectoryPath = path.dirname(skill.filePath);
  if (
    skill.scope === "plugin" &&
    skill.provider === null &&
    skill.pluginId !== null
  ) {
    return true;
  }
  if (skill.scope === "sandy-user") {
    return (
      path.dirname(skillDirectoryPath) ===
      resolveDataDirSkillsRootPath(deps.config.dataDir)
    );
  }
  return (
    skill.scope === "sandy-builtin" &&
    path.dirname(skillDirectoryPath) === deps.config.builtinSkillsRootPath
  );
}

function validateServerSkillRelativePath(relativePath: string): string[] {
  if (
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new ApiError(400, "invalid_path", "Path must be relative");
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    throw new ApiError(404, "not_found", "Skill file not found");
  }
  return segments;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function resolveServerSkillFile(
  skill: SkillRegistration,
  relativePath: string,
): Promise<string> {
  const segments = validateServerSkillRelativePath(relativePath);
  const rootPath = path.dirname(skill.filePath);
  const candidatePath = path.join(rootPath, ...segments);
  const [realRootPath, realCandidatePath, candidateStat] = await Promise.all([
    fs.realpath(rootPath).catch(() => null),
    fs.realpath(candidatePath).catch(() => null),
    fs.lstat(candidatePath).catch(() => null),
  ]);
  if (
    realRootPath === null ||
    realCandidatePath === null ||
    candidateStat === null ||
    !candidateStat.isFile() ||
    candidateStat.isSymbolicLink() ||
    !isPathWithinRoot(realCandidatePath, realRootPath)
  ) {
    throw new ApiError(404, "not_found", "Skill file not found");
  }
  return realCandidatePath;
}

async function listServerSkillFiles(
  skill: SkillRegistration,
): Promise<{ files: string[]; truncated: boolean }> {
  const rootPath = path.dirname(skill.filePath);
  const files: string[] = [];
  let truncated = false;
  async function walk(currentPath: string): Promise<void> {
    const entries = await fs
      .readdir(currentPath, { withFileTypes: true })
      .catch(() => null);
    if (entries === null) return;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= SERVER_SKILL_FILE_LIMIT) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        if (truncated) return;
      } else if (entry.isFile()) {
        files.push(
          path.relative(rootPath, entryPath).split(path.sep).join("/"),
        );
      }
    }
  }
  await walk(rootPath);
  if (!files.includes(SKILL_FILE_NAME)) files.push(SKILL_FILE_NAME);
  files.sort((left, right) => {
    if (left === SKILL_FILE_NAME) return -1;
    if (right === SKILL_FILE_NAME) return 1;
    return left.localeCompare(right);
  });
  return { files, truncated };
}

async function resolveProjectSkill(
  deps: AppDeps,
  args: {
    skillId: string;
    workspace: CommandWorkspace;
  },
): Promise<IndexedSkillRegistration> {
  const index = await projectSkillIndex(deps, { workspace: args.workspace });
  const match = index.registrations.find((skill) => skill.id === args.skillId);
  if (!match) {
    throw new ApiError(404, "not_found", "Skill not found");
  }
  return match;
}

export async function listProjectSkillFiles(
  deps: AppDeps,
  args: {
    skillId: string;
    workspace: CommandWorkspace;
  },
): Promise<{ files: string[]; truncated: boolean }> {
  const skill = await resolveProjectSkill(deps, args);
  if (isServerOwnedSkill(deps, skill)) {
    return listServerSkillFiles(skill);
  }
  const rootPath = hostPathDirname(skill.filePath);
  const result = await callHostRetryableOnlineRpc(deps, {
    hostId: args.workspace.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.list_files",
      followRootSymlink: true,
      path: rootPath,
      limit: 200,
      includeHidden: SKILL_PATH_LIST_INCLUDE_HIDDEN,
      respectGitIgnore: false,
      excludeNames: [...DEFAULT_PATH_LIST_EXCLUDE_NAMES],
    },
  });
  const files = [
    ...new Set([SKILL_FILE_NAME, ...result.files.map((file) => file.path)]),
  ].sort((left, right) => {
    if (left === "SKILL.md") return -1;
    if (right === "SKILL.md") return 1;
    return left.localeCompare(right);
  });
  return { files, truncated: result.truncated };
}

export async function readProjectSkill(
  deps: AppDeps,
  args: {
    skillId: string;
    path: string;
    workspace: CommandWorkspace;
  },
): Promise<{ content: string; revision: string }> {
  const skill = await resolveProjectSkill(deps, args);
  if (isServerOwnedSkill(deps, skill)) {
    const filePath =
      args.path === SKILL_FILE_NAME
        ? skill.realPath
        : await resolveServerSkillFile(skill, args.path);
    const stat = await fs.stat(filePath);
    if (stat.size > SERVER_SKILL_CONTENT_LIMIT_BYTES) {
      throw new ApiError(413, "file_too_large", "Skill file is too large");
    }
    const contents = await fs.readFile(filePath);
    return {
      content: contents.toString("utf8"),
      revision: createHash("sha256").update(contents).digest("hex"),
    };
  }
  const rootPath = hostPathDirname(
    args.path === SKILL_FILE_NAME ? skill.realPath : skill.filePath,
  );
  const result = await callHostRetryableOnlineRpc(deps, {
    hostId: args.workspace.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.read_file",
      path:
        args.path === SKILL_FILE_NAME
          ? skill.realPath
          : hostPathJoin(rootPath, validateServerSkillRelativePath(args.path)),
      rootPath,
      followRootSymlink: true,
    },
  }).catch(remapDaemonFileRouteError);
  const content = requireDaemonFileContentResult(result);
  return {
    content:
      content.contentEncoding === "utf8"
        ? content.content
        : Buffer.from(content.content, "base64").toString("utf8"),
    revision: content.sha256,
  };
}

export async function writeProjectSkill(
  deps: AppDeps,
  args: {
    skillId: string;
    content: string;
    revision: string;
    workspace: CommandWorkspace;
  },
): Promise<{ filePath: string; revision: string }> {
  const skill = await resolveProjectSkill(deps, args);
  const editableScope = editableSkillScopeSchema.safeParse(skill.scope);
  if (!skill.manageable || !editableScope.success) {
    throw new ApiError(
      403,
      "forbidden",
      "Bundled skills cannot be edited in sandy",
    );
  }
  if (editableScope.data === "sandy-project" && args.workspace.cwd === null) {
    throw new ApiError(
      409,
      "invalid_request",
      "No workspace resolved for this project's skills",
    );
  }
  if (editableScope.data === "sandy-user" && isServerOwnedSkill(deps, skill)) {
    const skillFilePath = await resolveServerSkillFile(skill, SKILL_FILE_NAME);
    const result = await replaceFile({
      contents: Buffer.from(args.content, "utf8"),
      expectedSha256: args.revision,
      path: skillFilePath,
    });
    if (result.outcome === "conflict") {
      throw new ApiError(409, "conflict", "Skill changed before it was saved");
    }
    return { filePath: skillFilePath, revision: result.sha256 };
  }
  if (editableScope.data !== "sandy-user" && editableScope.data !== "sandy-project") {
    const result = await callHostOnlineRpcForWork(deps, {
      hostId: args.workspace.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.write_file",
        path: skill.filePath,
        rootPath: hostPathDirname(skill.filePath),
        content: args.content,
        contentEncoding: "utf8",
        createParents: false,
        expectedSha256: args.revision,
      },
    });
    if (result.outcome !== "written") {
      throw new ApiError(409, "conflict", "Skill changed before it was saved");
    }
    return { filePath: skill.filePath, revision: result.sha256 };
  }
  const result = await callHostOnlineRpcForWork(deps, {
    hostId: args.workspace.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.write_skill",
      scope: editableScope.data,
      name: skill.name,
      cwd: args.workspace.cwd,
      content: args.content,
      expectedSha256: args.revision,
    },
  });
  if (result.outcome === "conflict") {
    throw new ApiError(409, "conflict", "Skill changed before it was saved");
  }
  return { filePath: result.filePath, revision: result.sha256 };
}

export async function deleteProjectSkill(
  deps: AppDeps,
  args: {
    skillId: string;
    workspace: CommandWorkspace;
  },
): Promise<string> {
  const skill = await resolveProjectSkill(deps, args);
  const editableScope = editableSkillScopeSchema.safeParse(skill.scope);
  if (!skill.manageable || !editableScope.success) {
    throw new ApiError(
      403,
      "forbidden",
      "Bundled skills cannot be deleted in sandy",
    );
  }
  if (editableScope.data === "sandy-project" && args.workspace.cwd === null) {
    throw new ApiError(
      409,
      "invalid_request",
      "No workspace resolved for this project's skills",
    );
  }
  if (editableScope.data === "sandy-user" && isServerOwnedSkill(deps, skill)) {
    const skillsRootPath = resolveDataDirSkillsRootPath(deps.config.dataDir);
    const skillDirectoryPath = path.dirname(skill.filePath);
    const [realRootPath, realSkillPath] = await Promise.all([
      fs.realpath(skillsRootPath).catch(() => null),
      fs.realpath(skillDirectoryPath).catch(() => null),
    ]);
    if (
      realRootPath === null ||
      realSkillPath === null ||
      realSkillPath !==
        path.join(realRootPath, path.basename(skillDirectoryPath))
    ) {
      throw new ApiError(404, "not_found", "Skill not found");
    }
    const skillFileStat = await fs
      .lstat(path.join(realSkillPath, SKILL_FILE_NAME))
      .catch(() => null);
    if (
      skillFileStat === null ||
      !skillFileStat.isFile() ||
      skillFileStat.isSymbolicLink()
    ) {
      throw new ApiError(404, "not_found", "Skill not found");
    }
    await fs.rm(realSkillPath, { recursive: true, force: false });
    return realSkillPath;
  }
  let daemonName = skill.name;
  let rootPath: string | null = null;
  if (editableScope.data !== "sandy-user" && editableScope.data !== "sandy-project") {
    const skillDirPath = hostPathDirname(skill.filePath);
    daemonName = hostPathBasename(skillDirPath);
    rootPath = hostPathDirname(skillDirPath);
  }
  const result = await callHostOnlineRpcForWork(deps, {
    hostId: args.workspace.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.delete_skill",
      scope: editableScope.data,
      name: daemonName,
      cwd: args.workspace.cwd,
      rootPath,
    },
  });
  return result.deletedPath;
}
