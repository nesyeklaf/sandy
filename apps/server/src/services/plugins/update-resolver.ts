import semver from "semver";
import { PLUGIN_SDK_VERSION } from "@sandy/domain";
import {
  DEFAULT_GIT_REF,
  gitSemverTagName,
  gitSemverTagVersion,
  isCommitSha,
  runInstallCommand,
} from "./install-sources.js";
import {
  isPluginSdkRangeSatisfied,
  pluginSdkRangeProblem,
} from "./sdk-compat.js";

export type GitRefKind = "branch" | "tag" | "commit";

export interface CompatibilityProblem {
  engine: "sandy" | "sandyPluginSdk";
  required: string;
  actual: string;
  message: string;
}

export interface PluginResolvedUpdateVersion {
  version: string;
  label: string;
  display: string;
}

interface ResolutionFlags {
  devMode?: true;
  blocked?: {
    version: PluginResolvedUpdateVersion;
    reasons: CompatibilityProblem[];
  };
  packagedBuildProblems?: CompatibilityProblem[];
}

export type PluginUpdateResolution =
  | ({
      outcome: "current";
      current: PluginResolvedUpdateVersion;
    } & ResolutionFlags)
  | ({
      outcome: "update-available";
      current: PluginResolvedUpdateVersion;
      candidate: PluginResolvedUpdateVersion;
      candidateGitTag?: string;
    } & ResolutionFlags)
  | ({
      outcome: "pinned";
      current: PluginResolvedUpdateVersion;
    } & ResolutionFlags)
  | ({
      outcome: "incompatible";
      current?: PluginResolvedUpdateVersion;
      newest: PluginResolvedUpdateVersion;
      reasons: CompatibilityProblem[];
    } & ResolutionFlags)
  | ({ outcome: "unavailable"; detail: string } & ResolutionFlags);

function requestedRangeIncludesPrerelease(spec: string): boolean {
  const range = new semver.Range(spec);
  return range.set.some((comparators) =>
    comparators.some((comparator) => {
      const version: unknown = comparator.semver;
      return version instanceof semver.SemVer && version.prerelease.length > 0;
    }),
  );
}

export function evaluateCompatibility(args: {
  sandyRange: string | undefined;
  sdkRange: string | undefined;
  appVersion: string;
}): {
  effective: CompatibilityProblem[];
  packaged: CompatibilityProblem[];
  devMode: boolean;
} {
  const appVersion = semver.coerce(args.appVersion);
  if (!appVersion) {
    throw new Error(`cannot parse running sandy version "${args.appVersion}"`);
  }
  const devMode = appVersion.version === "0.0.0";
  const sandyProblems: CompatibilityProblem[] = [];
  if (args.sandyRange !== undefined) {
    if (semver.validRange(args.sandyRange) === null) {
      sandyProblems.push({
        engine: "sandy",
        required: args.sandyRange,
        actual: appVersion.version,
        message: `declares invalid engines.sandy range ${JSON.stringify(args.sandyRange)}`,
      });
    } else if (!semver.satisfies(appVersion, args.sandyRange)) {
      sandyProblems.push({
        engine: "sandy",
        required: args.sandyRange,
        actual: appVersion.version,
        message: `requires sandy ${args.sandyRange}, running sandy is ${appVersion.version}`,
      });
    }
  }
  const sdkProblems: CompatibilityProblem[] = [];
  if (args.sdkRange !== undefined) {
    if (semver.validRange(args.sdkRange) === null) {
      sdkProblems.push({
        engine: "sandyPluginSdk",
        required: args.sdkRange,
        actual: PLUGIN_SDK_VERSION,
        message: `declares invalid engines.sandyPluginSdk range ${JSON.stringify(args.sdkRange)}`,
      });
    } else if (!isPluginSdkRangeSatisfied(args.sdkRange)) {
      sdkProblems.push({
        engine: "sandyPluginSdk",
        required: args.sdkRange,
        actual: PLUGIN_SDK_VERSION,
        message: pluginSdkRangeProblem(args.sdkRange),
      });
    }
  }
  return {
    effective: devMode ? sdkProblems : [...sandyProblems, ...sdkProblems],
    packaged: sandyProblems,
    devMode,
  };
}

function parseLsRemote(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const [commit, ref, extra] = line.trim().split(/\s+/);
    if (extra !== undefined || commit === undefined || ref === undefined) {
      throw new Error(
        `malformed git ls-remote output: ${JSON.stringify(line)}`,
      );
    }
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error(
        `git ls-remote returned invalid object id ${JSON.stringify(commit)}`,
      );
    }
    refs.set(ref, commit.toLowerCase());
  }
  return refs;
}

export async function resolveGitRef(args: {
  url: string;
  ref: string;
}): Promise<
  | { outcome: "resolved"; refKind: GitRefKind; commit: string }
  | { outcome: "unavailable"; detail: string }
> {
  if (isCommitSha(args.ref)) {
    return {
      outcome: "resolved",
      refKind: "commit",
      commit: args.ref.toLowerCase(),
    };
  }
  if (args.ref === DEFAULT_GIT_REF) {
    const output = await runInstallCommand(
      "git",
      ["ls-remote", args.url, DEFAULT_GIT_REF],
      { notFoundHint: GIT_NOT_FOUND_HINT },
    );
    const commit = parseLsRemote(output).get(DEFAULT_GIT_REF);
    return commit === undefined
      ? {
          outcome: "unavailable",
          detail: `git default branch was not found in ${args.url}`,
        }
      : { outcome: "resolved", refKind: "branch", commit };
  }
  const output = await runInstallCommand(
    "git",
    [
      "ls-remote",
      args.url,
      `refs/tags/${args.ref}`,
      `refs/tags/${args.ref}^{}`,
      `refs/heads/${args.ref}`,
    ],
    { notFoundHint: GIT_NOT_FOUND_HINT },
  );
  const refs = parseLsRemote(output);
  const tag =
    refs.get(`refs/tags/${args.ref}^{}`) ?? refs.get(`refs/tags/${args.ref}`);
  if (tag !== undefined) {
    return { outcome: "resolved", refKind: "tag", commit: tag };
  }
  const branch = refs.get(`refs/heads/${args.ref}`);
  if (branch !== undefined) {
    return { outcome: "resolved", refKind: "branch", commit: branch };
  }
  return {
    outcome: "unavailable",
    detail: `git ref "${args.ref}" was not found in ${args.url}`,
  };
}

export function gitResolvedVersion(args: {
  url: string;
  ref: string;
  tagPrefix: string;
  commit: string;
}): PluginResolvedUpdateVersion {
  return {
    version: args.commit,
    label:
      gitSemverTagVersion(args.ref, args.tagPrefix) ?? args.commit.slice(0, 7),
    display: `${args.url}@${args.ref} (${args.commit.slice(0, 12)})`,
  };
}

export interface GitSemverTag {
  tag: string;
  version: string;
  commit: string;
}

const MAX_LS_REMOTE_TAG_BYTES = 8 * 1024 * 1024;

const GIT_NOT_FOUND_HINT =
  '"git" was not found on PATH — git plugin updates require git';

export async function listGitSemverTags(args: {
  url: string;
  tagPrefix: string;
}): Promise<GitSemverTag[]> {
  const output = await runInstallCommand(
    "git",
    [
      "ls-remote",
      "--tags",
      args.url,
      `refs/tags/${args.tagPrefix}v*`,
      `refs/tags/${args.tagPrefix}v*^{}`,
    ],
    {
      notFoundHint: GIT_NOT_FOUND_HINT,
      maxStdoutBytes: MAX_LS_REMOTE_TAG_BYTES,
    },
  );
  const refs = parseLsRemote(output);
  const tags: GitSemverTag[] = [];
  for (const [ref, commit] of refs) {
    if (!ref.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
    const tag = ref.slice("refs/tags/".length);
    const version = gitSemverTagVersion(tag, args.tagPrefix);
    if (version === null) continue;
    tags.push({ tag, version, commit: refs.get(`${ref}^{}`) ?? commit });
  }
  return tags.sort((left, right) =>
    semver.rcompare(left.version, right.version),
  );
}

export function selectGitSemverTag(args: {
  tags: readonly GitSemverTag[];
  range: string;
}): GitSemverTag | null {
  return satisfyingGitSemverTags(args)[0] ?? null;
}

function satisfyingGitSemverTags(args: {
  tags: readonly GitSemverTag[];
  range: string;
}): GitSemverTag[] {
  const permitsPrerelease = requestedRangeIncludesPrerelease(args.range);
  return args.tags
    .filter((tag) => semver.satisfies(tag.version, args.range))
    .filter(
      (tag) => permitsPrerelease || semver.prerelease(tag.version) === null,
    )
    .sort((left, right) => semver.rcompare(left.version, right.version));
}

function movedGitTagDetail(args: {
  url: string;
  tag: string;
  recordedCommit: string;
  currentCommit: string;
}): string | null {
  if (args.currentCommit === args.recordedCommit) return null;
  return (
    `security check failed: git tag "${args.tag}" in ${args.url} moved from ` +
    `${args.recordedCommit} to ${args.currentCommit}; sandy will not re-resolve a ` +
    `tag that changed. Remove the plugin and install it again to accept the new commit`
  );
}

type GitUpdateIntent =
  | { kind: "ref"; ref: string; refKind: GitRefKind }
  | {
      kind: "range";
      range: string;
      tagPrefix: string;
      resolvedTag: string;
    };

export type GitCandidateProbeResult =
  | {
      outcome: "compatible";
      devMode: boolean;
      packagedBuildProblems: CompatibilityProblem[];
    }
  | {
      outcome: "incompatible";
      reasons: CompatibilityProblem[];
      devMode: boolean;
    }
  | { outcome: "invalid"; detail: string };

export type GitCandidateProbe = (
  candidate: GitSemverTag,
) => Promise<GitCandidateProbeResult>;

const MAX_GIT_CANDIDATE_PROBES = 10;

async function resolveGitRangeUpdate(args: {
  url: string;
  intent: Extract<GitUpdateIntent, { kind: "range" }>;
  current: PluginResolvedUpdateVersion;
  currentCommit: string;
  probeCandidate: GitCandidateProbe;
}): Promise<PluginUpdateResolution> {
  const tags = await listGitSemverTags({
    url: args.url,
    tagPrefix: args.intent.tagPrefix,
  });
  const recorded = tags.find((tag) => tag.tag === args.intent.resolvedTag);
  if (recorded === undefined) {
    return {
      outcome: "unavailable",
      detail:
        `security check failed: recorded git tag "${args.intent.resolvedTag}" no longer exists in ${args.url}; ` +
        "sandy will not re-resolve a missing release tag. Restore the tag, or remove and install the plugin again",
    };
  }
  const moved = movedGitTagDetail({
    url: args.url,
    tag: recorded.tag,
    recordedCommit: args.currentCommit,
    currentCommit: recorded.commit,
  });
  if (moved !== null) return { outcome: "unavailable", detail: moved };
  const candidates = satisfyingGitSemverTags({
    tags,
    range: args.intent.range,
  });
  if (candidates.length === 0) {
    return {
      outcome: "unavailable",
      detail: `no tag of ${args.url} matches ${args.intent.range} (looking for tags named "${gitSemverTagName(args.intent.tagPrefix, "X.Y.Z")}")`,
    };
  }
  let blocked: ResolutionFlags["blocked"] | undefined;
  let invalidDetail: string | undefined;
  let probes = 0;
  for (const candidate of candidates) {
    const version = gitResolvedVersion({
      url: args.url,
      ref: candidate.tag,
      tagPrefix: args.intent.tagPrefix,
      commit: candidate.commit,
    });
    if (candidate.commit === args.currentCommit) {
      return {
        outcome: "current",
        current: args.current,
        ...(blocked ? { blocked } : {}),
      };
    }
    if (probes >= MAX_GIT_CANDIDATE_PROBES) {
      return {
        outcome: "unavailable",
        detail: `no release of ${args.url} matching ${args.intent.range} runs on this sandy within the newest ${MAX_GIT_CANDIDATE_PROBES} releases`,
      };
    }
    probes += 1;
    const probed = await args.probeCandidate(candidate);
    if (probed.outcome === "invalid") {
      invalidDetail ??= probed.detail;
      continue;
    }
    if (probed.outcome === "incompatible") {
      blocked ??= { version, reasons: probed.reasons };
      continue;
    }
    return {
      outcome: "update-available",
      current: args.current,
      candidate: version,
      candidateGitTag: candidate.tag,
      ...(blocked ? { blocked } : {}),
      ...(probed.devMode ? { devMode: true } : {}),
      ...(probed.packagedBuildProblems.length > 0
        ? { packagedBuildProblems: probed.packagedBuildProblems }
        : {}),
    };
  }
  if (blocked !== undefined) {
    return {
      outcome: "incompatible",
      current: args.current,
      newest: blocked.version,
      reasons: blocked.reasons,
    };
  }
  return {
    outcome: "unavailable",
    detail:
      invalidDetail ??
      `no tag of ${args.url} matches ${args.intent.range} (looking for tags named "${gitSemverTagName(args.intent.tagPrefix, "X.Y.Z")}")`,
  };
}

export async function resolveGitUpdate(args: {
  url: string;
  intent: GitUpdateIntent;
  currentCommit: string;
  probeCandidate: GitCandidateProbe;
}): Promise<PluginUpdateResolution> {
  const current = gitResolvedVersion({
    url: args.url,
    ref:
      args.intent.kind === "range" ? args.intent.resolvedTag : args.intent.ref,
    tagPrefix: args.intent.kind === "range" ? args.intent.tagPrefix : "",
    commit: args.currentCommit,
  });
  if (args.intent.kind === "range") {
    return resolveGitRangeUpdate({
      url: args.url,
      intent: args.intent,
      current,
      currentCommit: args.currentCommit,
      probeCandidate: args.probeCandidate,
    });
  }
  if (args.intent.refKind === "commit") return { outcome: "pinned", current };
  const resolved = await resolveGitRef({ url: args.url, ref: args.intent.ref });
  if (resolved.outcome === "unavailable") return resolved;
  if (args.intent.refKind === "tag") {
    const moved = movedGitTagDetail({
      url: args.url,
      tag: args.intent.ref,
      recordedCommit: args.currentCommit,
      currentCommit: resolved.commit,
    });
    return moved === null
      ? { outcome: "pinned", current }
      : { outcome: "unavailable", detail: moved };
  }
  const candidate = gitResolvedVersion({
    url: args.url,
    ref: args.intent.ref,
    tagPrefix: "",
    commit: resolved.commit,
  });
  if (resolved.commit === args.currentCommit) {
    return { outcome: "current", current };
  }
  return { outcome: "update-available", current, candidate };
}

export async function resolveGitRange(args: {
  url: string;
  range: string;
  tagPrefix: string;
  probeCandidate: GitCandidateProbe;
}): Promise<
  | { outcome: "resolved"; tag: string; version: string; commit: string }
  | { outcome: "unavailable"; detail: string }
> {
  const tags = await listGitSemverTags({
    url: args.url,
    tagPrefix: args.tagPrefix,
  });
  const candidates = satisfyingGitSemverTags({ tags, range: args.range });
  if (candidates.length === 0) {
    return {
      outcome: "unavailable",
      detail: `no tag of ${args.url} matches ${args.range} (looking for tags named "${gitSemverTagName(args.tagPrefix, "X.Y.Z")}")`,
    };
  }
  let firstProblem: string | undefined;
  let probes = 0;
  for (const candidate of candidates) {
    if (probes >= MAX_GIT_CANDIDATE_PROBES) {
      return {
        outcome: "unavailable",
        detail: `no release of ${args.url} matching ${args.range} runs on this sandy within the newest ${MAX_GIT_CANDIDATE_PROBES} releases`,
      };
    }
    probes += 1;
    const probed = await args.probeCandidate(candidate);
    if (probed.outcome === "compatible") {
      return { outcome: "resolved", ...candidate };
    }
    firstProblem ??=
      probed.outcome === "invalid" ? probed.detail : probed.reasons[0]?.message;
  }
  return {
    outcome: "unavailable",
    detail:
      firstProblem ??
      `no release of ${args.url} matching ${args.range} runs on this sandy`,
  };
}
