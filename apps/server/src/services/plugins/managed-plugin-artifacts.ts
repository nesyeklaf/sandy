import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  createPluginArtifact,
  getInstalledPlugin,
  getPluginArtifactByResolution,
  listPluginArtifactsAtOrUnderPath,
  listPluginArtifactsUnderPath,
  setPluginArtifactGitCheckoutRoot,
  setPluginArtifactValidation,
  type InstalledPluginRow,
  type PluginArtifactRow,
  type PluginExactResolution,
  type PluginGitSelector,
  type PluginProvenance,
  type PluginSourceIntent,
} from "@sandy/db";
import {
  buildPluginApp,
  buildPluginHost,
  buildPluginServer,
} from "@sandy/plugin-build";
import { installGitDependencies } from "./git-plugin-dependencies.js";
import { getPluginBuildToolchain } from "./build-toolchain.js";
import { validatePluginArtifactMeta } from "./app-bundle.js";
import type {
  InstalledPlugin,
  PluginSourceSelection,
} from "@sandy/server-contract";
import { resolveSelectedSubdirectory } from "./collection-manifest.js";
import {
  gitArtifactCacheDir,
  hashInstallDir,
  nestedPluginRoots,
  parsePluginSource,
  pluginRootDir,
  promoteGitPluginArtifact,
  realPathInside,
  runInstallCommand,
} from "./install-sources.js";
import { readPluginManifest, type PluginManifest } from "./manifest.js";
import type { PluginServiceDeps } from "./plugin-service-internal.js";
import { logPluginBuildWarnings } from "./plugin-log.js";
import {
  evaluateCompatibility,
  resolveGitRange,
  resolveGitRef,
  type CompatibilityProblem,
  type GitCandidateProbeResult,
  type GitSemverTag,
} from "./update-resolver.js";

export interface InstallRegistrationIdentity {
  provenance: PluginProvenance;
  sourceIntent: PluginSourceIntent;
}

export interface RegisterInstalledArgs extends InstallRegistrationIdentity {
  rootDir: string;
  source: string;
  exactResolution: PluginExactResolution;
  refuseEngineMismatch: boolean;
  validated: boolean;
  activeArtifactId?: string;
  preparedManifest?: PluginManifest;
  beforePersist?: () => Promise<void>;
}

export interface InstallContext {
  provenance: PluginProvenance;
  expectedPluginId?: string;
  expectedGitCommit?: string;
}

interface ActivateManagedUpdateArgs {
  row: InstalledPluginRow;
  rootDir: string;
  manifest: PluginManifest;
  source: string;
  sourceIntent: PluginSourceIntent;
  exactResolution: PluginExactResolution;
  artifactId: string;
  beforePersist?: () => Promise<void>;
}

interface ManagedPluginArtifactsContext {
  deps: PluginServiceDeps;
  withArtifactLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  sourceKind: (source: string) => "path" | "git" | "builtin";
  checkEngineRange: (manifest: PluginManifest) => string | undefined;
  checkPluginSdkRange: (manifest: PluginManifest) => string | undefined;
  isPackagedBuiltinEntry: (args: {
    kind: "path" | "git" | "builtin";
    manifest: PluginManifest;
    rootDir: string;
    artifact: "app" | "server" | "host";
  }) => boolean;
  registerInstalled: (args: RegisterInstalledArgs) => Promise<InstalledPlugin>;
  assertInstallRegistrationAvailable: (
    existing: InstalledPluginRow | undefined,
    identity: InstallRegistrationIdentity,
    pluginId: string,
  ) => void;
  refuseBuiltinShadow: (pluginId: string) => void;
  activateManagedUpdate: (args: ActivateManagedUpdateArgs) => Promise<void>;
}

async function cloneGitCommit(
  url: string,
  stagingDir: string,
  commit: string,
  notFoundHint?: string,
): Promise<void> {
  await runInstallCommand("git", ["clone", "--quiet", url, stagingDir], {
    notFoundHint,
  });
  await runInstallCommand("git", [
    "-C",
    stagingDir,
    "checkout",
    "--quiet",
    "--detach",
    commit,
  ]);
  const checkedOutCommit = await runInstallCommand("git", [
    "-C",
    stagingDir,
    "rev-parse",
    "HEAD",
  ]);
  if (!checkedOutCommit.startsWith(commit)) {
    throw new Error(
      `git resolved ${commit}, but checked out ${checkedOutCommit}`,
    );
  }
  await rm(join(stagingDir, ".git"), { recursive: true, force: true });
}

export function createManagedPluginArtifacts(
  context: ManagedPluginArtifactsContext,
) {
  const {
    deps,
    withArtifactLock,
    sourceKind,
    checkEngineRange,
    checkPluginSdkRange,
    isPackagedBuiltinEntry,
    registerInstalled,
    assertInstallRegistrationAvailable,
    refuseBuiltinShadow,
    activateManagedUpdate,
  } = context;
  const directInstallContext: InstallContext = {
    provenance: { kind: "direct" },
  };

  function assertExpectedPluginId(
    context: InstallContext,
    manifestId: string,
    source: string,
  ): void {
    if (
      context.expectedPluginId !== undefined &&
      context.expectedPluginId !== manifestId
    ) {
      throw new Error(
        `install refused: ${source} declares plugin id "${manifestId}" but the catalog entry expects "${context.expectedPluginId}"`,
      );
    }
  }

  async function validateManifestOnly(args: {
    rootDir: string;
    source: string;
    refuseEngineMismatch: boolean;
  }): Promise<PluginManifest> {
    const manifest = await readPluginManifest(args.rootDir);
    if (args.refuseEngineMismatch) {
      const engineProblem =
        checkEngineRange(manifest) ?? checkPluginSdkRange(manifest);
      if (engineProblem) {
        throw new Error(
          `install refused: plugin "${manifest.id}" ${engineProblem}`,
        );
      }
    }
    return manifest;
  }

  async function validateInstallDir(args: {
    rootDir: string;
    source: string;
    refuseEngineMismatch: boolean;
  }): Promise<PluginManifest> {
    const manifest = await validateManifestOnly(args);
    const kind = sourceKind(args.source);
    const managed = kind === "git";
    if (kind === "git") {
      await installGitDependencies(args.rootDir);
    }
    if (manifest.appEntry !== undefined) {
      if (
        !isPackagedBuiltinEntry({
          kind,
          manifest,
          rootDir: args.rootDir,
          artifact: "app",
        })
      ) {
        let app: Awaited<ReturnType<typeof buildPluginApp>>;
        try {
          app = await buildPluginApp(
            args.rootDir,
            deps.appVersion,
            await getPluginBuildToolchain(deps),
          );
        } catch (error) {
          throw new Error(
            `install failed: frontend bundle build for "${manifest.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        logPluginBuildWarnings({
          dataDir: deps.dataDir,
          logger: deps.logger,
          pluginId: manifest.id,
          warnings: app.migrationWarnings,
        });
      }
    }
    if (kind === "git") {
      let server: Awaited<ReturnType<typeof buildPluginServer>>;
      try {
        server = await buildPluginServer(
          args.rootDir,
          deps.appVersion,
          await getPluginBuildToolchain(deps),
        );
      } catch (error) {
        throw new Error(
          `install failed: server bundle build for "${manifest.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      logPluginBuildWarnings({
        dataDir: deps.dataDir,
        logger: deps.logger,
        pluginId: manifest.id,
        warnings: server.migrationWarnings,
      });
      if (manifest.hostEntry !== undefined) {
        try {
          await buildPluginHost(
            args.rootDir,
            deps.appVersion,
            await getPluginBuildToolchain(deps),
          );
        } catch (error) {
          throw new Error(
            `install failed: host bundle build for "${manifest.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    async function validateArtifact(
      artifact: "server" | "app" | "host",
      required: boolean,
    ): Promise<void> {
      const metaPath = join(args.rootDir, "dist", `${artifact}.meta.json`);
      let raw: string;
      try {
        raw = await readFile(metaPath, "utf8");
      } catch {
        if (required) {
          throw new Error(
            `install refused: ${artifact} artifact for plugin "${manifest.id}" is missing dist/${artifact}.meta.json`,
          );
        }
        return;
      }
      const problem = validatePluginArtifactMeta({
        artifact,
        raw,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
      });
      if (problem !== null) {
        throw new Error(`install refused: ${problem}`);
      }
    }

    if (managed) {
      await validateArtifact("server", kind === "git");
      if (manifest.appEntry !== undefined) {
        await validateArtifact("app", false);
      }
      if (manifest.hostEntry !== undefined) {
        await validateArtifact("host", true);
      }
    }
    return manifest;
  }

  async function reusableArtifact(
    existing: PluginArtifactRow | undefined,
    hashRoot: string,
  ): Promise<PluginArtifactRow | undefined> {
    if (
      (existing?.validationResult !== "valid" &&
        existing?.validationResult !== "pending") ||
      existing.contentHash === null ||
      (await hashInstallDir(hashRoot).catch(() => null)) !==
        existing.contentHash
    ) {
      return undefined;
    }
    if (existing.validationResult === "pending") {
      setPluginArtifactValidation(deps.db, existing.id, {
        contentHash: existing.contentHash,
        validationResult: "valid",
        validatedAt: Date.now(),
      });
    }
    return existing;
  }

  function markArtifactValid(artifactId: string, contentHash: string): void {
    if (
      !setPluginArtifactValidation(deps.db, artifactId, {
        contentHash,
        validationResult: "valid",
        validatedAt: Date.now(),
      })
    ) {
      throw new Error(`plugin artifact disappeared: ${artifactId}`);
    }
  }

  function ownedOrCreatedArtifact(args: {
    owned: PluginArtifactRow | undefined;
    create: Parameters<typeof createPluginArtifact>[1] & {
      contentHash: string;
    };
    resetExisting: boolean;
  }): PluginArtifactRow {
    if (args.owned === undefined) {
      return createPluginArtifact(deps.db, args.create);
    }
    if (args.resetExisting) {
      if (args.create.gitCheckoutRoot !== null) {
        setPluginArtifactGitCheckoutRoot(
          deps.db,
          args.owned.id,
          args.create.gitCheckoutRoot,
        );
      }
      setPluginArtifactValidation(deps.db, args.owned.id, {
        contentHash: args.create.contentHash,
        validationResult: "pending",
        validatedAt: null,
      });
    }
    return args.owned;
  }

  function preservedNestedRoots(root: string): string[] {
    return nestedPluginRoots(
      root,
      listPluginArtifactsUnderPath(deps.db, root, sep).map(
        (artifact) => artifact.path,
      ),
    );
  }

  async function refreshAncestorArtifactHashes(args: {
    checkoutRoot: string;
    changedRoot: string;
    changedArtifactId: string;
  }): Promise<void> {
    const artifacts = listPluginArtifactsAtOrUnderPath(
      deps.db,
      args.checkoutRoot,
      sep,
    );
    for (const artifact of artifacts) {
      if (artifact.id === args.changedArtifactId) continue;
      const pathFromArtifact = relative(artifact.path, args.changedRoot);
      if (
        pathFromArtifact.length === 0 ||
        pathFromArtifact === ".." ||
        pathFromArtifact.startsWith(`..${sep}`)
      ) {
        continue;
      }
      const contentHash = await hashInstallDir(artifact.path);
      if (
        !setPluginArtifactValidation(
          deps.db,
          artifact.id,
          artifact.validationResult === "pending"
            ? { contentHash, validationResult: "pending", validatedAt: null }
            : {
                contentHash,
                validationResult: "valid",
                validatedAt: artifact.validatedAt ?? Date.now(),
              },
        )
      ) {
        throw new Error(`plugin artifact disappeared: ${artifact.id}`);
      }
    }
  }

  async function resolveGitSelector(
    parsed: Extract<ReturnType<typeof parsePluginSource>, { kind: "git" }>,
    source: string,
    selection: PluginSourceSelection,
    context: InstallContext,
  ): Promise<{ selector: PluginGitSelector; commit: string }> {
    const { selector } = parsed;
    if (selector.kind !== "range") {
      const literal = await resolveGitRef({
        url: parsed.url,
        ref: selector.ref,
      });
      if (selector.kind === "ref") {
        if (literal.outcome === "unavailable") {
          throw new Error(`install failed: ${literal.detail}`);
        }
        return {
          selector: {
            kind: "ref",
            ref: selector.ref,
            refKind: literal.refKind,
          },
          commit: literal.commit,
        };
      }
      if (literal.outcome === "resolved") {
        throw new Error(
          `install refused: "${selector.ref}" is both a semver range and a ${literal.refKind} of ${parsed.url}. ` +
            `Install \`git:${parsed.url}@ref:${selector.ref}\` for the ${literal.refKind}, or ` +
            `\`git:${parsed.url}@semver:${selector.range}\` to resolve the range over release tags`,
        );
      }
    }
    return resolveGitRangeSelector({
      url: parsed.url,
      range: selector.range,
      tagPrefix: selector.kind === "range" ? selector.tagPrefix : "",
      probeCandidate: (candidate) =>
        probeGitInstallCandidate({
          parsed,
          source,
          selection,
          context,
          candidate,
        }),
    });
  }

  async function probeGitInstallCandidate(args: {
    parsed: Extract<ReturnType<typeof parsePluginSource>, { kind: "git" }>;
    source: string;
    selection: PluginSourceSelection;
    context: InstallContext;
    candidate: GitSemverTag;
  }): Promise<GitCandidateProbeResult> {
    const targetDir = gitArtifactCacheDir(
      deps.dataDir,
      args.parsed.cachePath,
      args.candidate.commit,
    );
    const stagingDir = `${targetDir}.install-probe-${randomUUID()}`;
    await mkdir(dirname(stagingDir), { recursive: true });
    try {
      deps.onArtifactMaterialize?.({ path: targetDir });
      await cloneGitCommit(args.parsed.url, stagingDir, args.candidate.commit);
      const subdirectory = await resolveSelectedSubdirectory({
        checkoutDir: stagingDir,
        selection: args.selection,
        sourceLabel: args.source,
      });
      const root = pluginRootDir(stagingDir, subdirectory);
      const realRoot = await realPathInside(
        stagingDir,
        root,
        "git plugin subdirectory",
        subdirectory === null,
      );
      const manifest = await readPluginManifest(realRoot);
      assertExpectedPluginId(args.context, manifest.id, args.source);
      const compatibility = evaluateCompatibility({
        sandyRange: manifest.sandyEngineRange,
        sdkRange: manifest.sandyPluginSdkRange,
        appVersion: deps.appVersion,
      });
      return compatibility.effective.length > 0
        ? {
            outcome: "incompatible",
            reasons: compatibility.effective,
            devMode: compatibility.devMode,
          }
        : {
            outcome: "compatible",
            devMode: compatibility.devMode,
            packagedBuildProblems: compatibility.packaged,
          };
    } catch (error) {
      return {
        outcome: "invalid",
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  async function resolveGitRangeSelector(args: {
    url: string;
    range: string;
    tagPrefix: string;
    probeCandidate: (
      candidate: GitSemverTag,
    ) => Promise<GitCandidateProbeResult>;
  }): Promise<{ selector: PluginGitSelector; commit: string }> {
    const resolved = await resolveGitRange(args);
    if (resolved.outcome === "unavailable") {
      throw new Error(`install failed: ${resolved.detail}`);
    }
    return {
      selector: {
        kind: "range",
        range: args.range,
        tagPrefix: args.tagPrefix,
        resolvedTag: resolved.tag,
      },
      commit: resolved.commit,
    };
  }

  async function installGitSource(
    parsed: Extract<ReturnType<typeof parsePluginSource>, { kind: "git" }>,
    source: string,
    selection: PluginSourceSelection,
    context: InstallContext = directInstallContext,
  ): Promise<InstalledPlugin> {
    const resolution = await resolveGitSelector(
      parsed,
      source,
      selection,
      context,
    );
    const resolvedCommit = resolution.commit;
    if (
      context.expectedGitCommit !== undefined &&
      resolvedCommit !== context.expectedGitCommit
    ) {
      throw new Error(
        `install refused: the git source changed after confirmation; expected ${context.expectedGitCommit}, resolved ${resolvedCommit}`,
      );
    }
    const resolvedSelector = resolution.selector;
    function identityFor(
      subdirectory: string | null,
    ): InstallRegistrationIdentity {
      return {
        provenance: context.provenance,
        sourceIntent: {
          kind: "git",
          url: parsed.url,
          subdirectory,
          selector: resolvedSelector,
        },
      };
    }
    const targetDir = gitArtifactCacheDir(
      deps.dataDir,
      parsed.cachePath,
      resolvedCommit,
    );
    return withArtifactLock(targetDir, async () => {
      const stagingDir = `${targetDir}.staging`;
      await rm(stagingDir, { recursive: true, force: true });
      const cachedSubdirectory = await resolveSelectedSubdirectory({
        checkoutDir: targetDir,
        selection,
        sourceLabel: source,
      }).catch(() => undefined);
      const cachedRegistrationIdentity =
        cachedSubdirectory === undefined
          ? null
          : identityFor(cachedSubdirectory);
      const targetRoot =
        cachedSubdirectory === undefined
          ? targetDir
          : pluginRootDir(targetDir, cachedSubdirectory);
      const cachedRealRoot =
        cachedSubdirectory === undefined
          ? null
          : await realPathInside(
              targetDir,
              targetRoot,
              "git plugin subdirectory",
              cachedSubdirectory === null,
            ).catch(() => null);
      const cachedManifest =
        cachedRealRoot === null
          ? null
          : await readPluginManifest(cachedRealRoot).catch(() => null);
      if (cachedManifest !== null && cachedRegistrationIdentity !== null) {
        assertExpectedPluginId(context, cachedManifest.id, source);
        assertInstallRegistrationAvailable(
          getInstalledPlugin(deps.db, cachedManifest.id),
          cachedRegistrationIdentity,
          cachedManifest.id,
        );
      }
      const existingArtifact =
        cachedManifest === null
          ? undefined
          : getPluginArtifactByResolution(deps.db, {
              sourceKind: "git",
              pluginId: cachedManifest.id,
              path: targetRoot,
              commit: resolvedCommit,
            });
      if (cachedRegistrationIdentity !== null) {
        const reusable = await reusableArtifact(existingArtifact, targetRoot);
        if (reusable !== undefined) {
          return registerInstalled({
            rootDir: targetRoot,
            source,
            ...cachedRegistrationIdentity,
            exactResolution: { kind: "git", commit: resolvedCommit },
            refuseEngineMismatch: true,
            validated: true,
            activeArtifactId: reusable.id,
          });
        }
      }
      await mkdir(dirname(targetDir), { recursive: true });
      try {
        deps.onArtifactMaterialize?.({ path: targetDir });
        await cloneGitCommit(
          parsed.url,
          stagingDir,
          resolvedCommit,
          '"git" was not found on PATH — git: plugin installs require git',
        );
        const stagedSubdirectory = await resolveSelectedSubdirectory({
          checkoutDir: stagingDir,
          selection,
          sourceLabel: source,
        });
        const stagedRegistrationIdentity = identityFor(stagedSubdirectory);
        const stagedTargetRoot = pluginRootDir(targetDir, stagedSubdirectory);
        const stagedRealRoot = await realPathInside(
          stagingDir,
          pluginRootDir(stagingDir, stagedSubdirectory),
          "git plugin subdirectory",
          stagedSubdirectory === null,
        );
        const stagedManifest = await readPluginManifest(stagedRealRoot);
        assertExpectedPluginId(context, stagedManifest.id, source);
        assertInstallRegistrationAvailable(
          getInstalledPlugin(deps.db, stagedManifest.id),
          stagedRegistrationIdentity,
          stagedManifest.id,
        );
        refuseBuiltinShadow(stagedManifest.id);
        await validateInstallDir({
          rootDir: stagedRealRoot,
          source,
          refuseEngineMismatch: true,
        });
        const contentHash = await hashInstallDir(stagedRealRoot);
        const artifact = ownedOrCreatedArtifact({
          owned: getPluginArtifactByResolution(deps.db, {
            sourceKind: "git",
            pluginId: stagedManifest.id,
            path: stagedTargetRoot,
            commit: resolvedCommit,
          }),
          create: {
            id: randomUUID(),
            pluginId: stagedManifest.id,
            sourceKind: "git",
            npmResolvedVersion: null,
            gitResolvedCommit: resolvedCommit,
            gitCheckoutRoot: targetDir,
            path: stagedTargetRoot,
            integrity: null,
            contentHash,
            validationResult: "pending",
            validatedAt: null,
          },
          resetExisting: true,
        });
        return registerInstalled({
          rootDir: stagedTargetRoot,
          source,
          ...stagedRegistrationIdentity,
          exactResolution: { kind: "git", commit: resolvedCommit },
          refuseEngineMismatch: true,
          validated: true,
          activeArtifactId: artifact.id,
          preparedManifest: stagedManifest,
          beforePersist: async () => {
            const promotedHash = await promoteGitPluginArtifact({
              stagingDir,
              targetDir,
              subdirectory: stagedSubdirectory,
              contentHash,
              preserveNestedRoots: preservedNestedRoots(stagedTargetRoot),
            });
            await refreshAncestorArtifactHashes({
              checkoutRoot: targetDir,
              changedRoot: stagedTargetRoot,
              changedArtifactId: artifact.id,
            });
            await deps.afterArtifactPromoted?.({
              pluginId: stagedManifest.id,
              artifactId: artifact.id,
              path: stagedTargetRoot,
            });
            markArtifactValid(artifact.id, promotedHash);
          },
        });
      } catch (error) {
        await rm(stagingDir, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async function stageGitCandidate(args: {
    row: InstalledPluginRow;
    commit: string;
    promote: boolean;
    activationSelector?: PluginGitSelector;
    artifactLocked?: boolean;
  }): Promise<
    | {
        outcome: "valid";
        manifest: PluginManifest;
        devMode: boolean;
        packagedBuildProblems: CompatibilityProblem[];
        rootDir: string | null;
        artifactId: string | null;
      }
    | {
        outcome: "incompatible";
        manifest: PluginManifest;
        devMode: boolean;
        reasons: CompatibilityProblem[];
      }
    | { outcome: "invalid"; detail: string }
  > {
    if (args.row.sourceGitUrl === null) {
      throw new Error(
        `plugin "${args.row.id}" has corrupt normalized git state`,
      );
    }
    const url = args.row.sourceGitUrl;
    const cacheSource = parsePluginSource(`git:${url}@${args.commit}`);
    if (cacheSource.kind !== "git") {
      throw new Error(`plugin "${args.row.id}" has corrupt git source`);
    }
    const targetDir = gitArtifactCacheDir(
      deps.dataDir,
      cacheSource.cachePath,
      args.commit,
    );
    const targetRoot = pluginRootDir(targetDir, args.row.sourceGitSubdirectory);
    if (args.promote && !args.artifactLocked) {
      return withArtifactLock(targetDir, () =>
        stageGitCandidate({ ...args, artifactLocked: true }),
      );
    }
    const existingArtifact = getPluginArtifactByResolution(deps.db, {
      sourceKind: "git",
      pluginId: args.row.id,
      path: targetRoot,
      commit: args.commit,
    });
    if (
      args.promote &&
      (existingArtifact?.validationResult === "valid" ||
        existingArtifact?.validationResult === "pending") &&
      existingArtifact.contentHash !== null &&
      (await hashInstallDir(targetRoot).catch(() => null)) ===
        existingArtifact.contentHash
    ) {
      const targetRealRoot = await realPathInside(
        targetDir,
        targetRoot,
        "git plugin subdirectory",
        args.row.sourceGitSubdirectory === null,
      );
      const manifest = await readPluginManifest(targetRealRoot);
      const compatibility = evaluateCompatibility({
        sandyRange: manifest.sandyEngineRange,
        sdkRange: manifest.sandyPluginSdkRange,
        appVersion: deps.appVersion,
      });
      if (args.activationSelector === undefined) {
        throw new Error(`plugin "${args.row.id}" update lacks git intent`);
      }
      if (existingArtifact.validationResult === "pending") {
        setPluginArtifactValidation(deps.db, existingArtifact.id, {
          contentHash: existingArtifact.contentHash,
          validationResult: "valid",
          validatedAt: Date.now(),
        });
      }
      await activateManagedUpdate({
        row: args.row,
        rootDir: targetRoot,
        manifest,
        source: args.row.source,
        sourceIntent: {
          kind: "git",
          url,
          subdirectory: args.row.sourceGitSubdirectory,
          selector: args.activationSelector,
        },
        exactResolution: { kind: "git", commit: args.commit },
        artifactId: existingArtifact.id,
      });
      return {
        outcome: "valid",
        manifest,
        devMode: compatibility.devMode,
        packagedBuildProblems: compatibility.packaged,
        rootDir: targetRoot,
        artifactId: existingArtifact.id,
      };
    }
    const stagingDir = args.promote
      ? `${targetDir}.staging`
      : `${targetDir}.update-staging-${randomUUID()}`;
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(dirname(stagingDir), { recursive: true });
    try {
      deps.onArtifactMaterialize?.({ path: targetRoot });
      await cloneGitCommit(
        url,
        stagingDir,
        args.commit,
        '"git" was not found on PATH — git plugin updates require git',
      );
      const pluginRoot = pluginRootDir(
        stagingDir,
        args.row.sourceGitSubdirectory,
      );
      let realPluginRoot: string;
      try {
        realPluginRoot = await realPathInside(
          stagingDir,
          pluginRoot,
          "git plugin subdirectory",
          args.row.sourceGitSubdirectory === null,
        );
      } catch (error) {
        return {
          outcome: "invalid",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      let manifest: PluginManifest;
      try {
        manifest = await readPluginManifest(realPluginRoot);
      } catch (error) {
        return {
          outcome: "invalid",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (manifest.id !== args.row.id) {
        return {
          outcome: "invalid",
          detail: `candidate manifest id changed from "${args.row.id}" to "${manifest.id}"`,
        };
      }
      const compatibility = evaluateCompatibility({
        sandyRange: manifest.sandyEngineRange,
        sdkRange: manifest.sandyPluginSdkRange,
        appVersion: deps.appVersion,
      });
      if (compatibility.effective.length > 0) {
        return {
          outcome: "incompatible",
          manifest,
          devMode: compatibility.devMode,
          reasons: compatibility.effective,
        };
      }
      try {
        await (args.promote ? validateInstallDir : validateManifestOnly)({
          rootDir: realPluginRoot,
          source: args.row.source,
          refuseEngineMismatch: true,
        });
      } catch (error) {
        return {
          outcome: "invalid",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      let artifactId: string | null = null;
      if (args.promote) {
        if (args.activationSelector === undefined) {
          throw new Error(`plugin "${args.row.id}" update lacks git intent`);
        }
        const activationSelector = args.activationSelector;
        const contentHash = await hashInstallDir(realPluginRoot);
        const artifact = ownedOrCreatedArtifact({
          owned: existingArtifact,
          create: {
            id: randomUUID(),
            pluginId: args.row.id,
            sourceKind: "git",
            npmResolvedVersion: null,
            gitResolvedCommit: args.commit,
            gitCheckoutRoot: targetDir,
            path: targetRoot,
            integrity: null,
            contentHash,
            validationResult: "pending",
            validatedAt: null,
          },
          resetExisting: true,
        });
        await activateManagedUpdate({
          row: args.row,
          rootDir: targetRoot,
          manifest,
          source: args.row.source,
          sourceIntent: {
            kind: "git",
            url,
            subdirectory: args.row.sourceGitSubdirectory,
            selector: activationSelector,
          },
          exactResolution: { kind: "git", commit: args.commit },
          artifactId: artifact.id,
          beforePersist: async () => {
            const promotedHash = await promoteGitPluginArtifact({
              stagingDir,
              targetDir,
              subdirectory: args.row.sourceGitSubdirectory,
              contentHash,
              preserveNestedRoots: preservedNestedRoots(targetRoot),
            });
            await refreshAncestorArtifactHashes({
              checkoutRoot: targetDir,
              changedRoot: targetRoot,
              changedArtifactId: artifact.id,
            });
            await deps.afterArtifactPromoted?.({
              pluginId: args.row.id,
              artifactId: artifact.id,
              path: targetRoot,
            });
            markArtifactValid(artifact.id, promotedHash);
          },
        });
        artifactId = artifact.id;
      }
      return {
        outcome: "valid",
        manifest,
        devMode: compatibility.devMode,
        packagedBuildProblems: compatibility.packaged,
        rootDir: args.promote ? targetRoot : null,
        artifactId,
      };
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  return {
    installGitSource,
    stageGitCandidate,
    validateInstallDir,
  };
}
