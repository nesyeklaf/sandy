import { experimental_isSkillNameEnabled } from "@sandy-sdk/plugin-sdk/provider-bridge";

export const PI_SDK_RPC_WORKER_SOURCE =
  String.raw`
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const bootstrapPath = process.argv[2];
const bootstrap = JSON.parse(readFileSync(bootstrapPath, "utf8"));
unlinkSync(bootstrapPath);
if (bootstrap.version !== 1 || typeof bootstrap.packageDir !== "string" ||
    !Array.isArray(bootstrap.args) || !bootstrap.args.every(arg => typeof arg === "string") ||
    !bootstrap.selection || !["inherit", "disable", "allow-only"].includes(bootstrap.selection.mode) ||
    (bootstrap.selection.mode !== "inherit" &&
      (!Array.isArray(bootstrap.selection.names) || !bootstrap.selection.names.every(name => typeof name === "string")))) {
  throw new Error("Invalid Sandy Pi SDK bootstrap");
}
const { packageDir, args, selection } = bootstrap;
Object.freeze(selection.names);
Object.freeze(selection);
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== "1.5.1") {
  throw new Error("Sandy Pi skill selection requires the tested Pi 1.5.1 SDK adapter");
}
const load = relative => import(pathToFileURL(join(packageDir, "dist", relative)).href);
const sdk = await load("index.js");
for (const name of ["DefaultResourceLoader", "createAgentSessionServices",
  "createAgentSessionFromServices", "createAgentSessionRuntime", "runRpcMode",
  "parseArgs", "resolveCliModel", "resolveModelScopeWithDiagnostics"]) {
  if (typeof sdk[name] !== "function") throw new Error("Incompatible Pi SDK: missing " + name);
}
const { resolveProjectTrusted } = await load("core/project-trust.js");
const { createProjectTrustContext } = await load("cli/project-trust.js");
const { createSessionManager } = await load("main.js");
const { runMigrations } = await load("migrations.js");
const { ENV_SESSION_DIR } = await load("config.js");
const { builtInExtensions } = await load("extensions/index.js");
const { applyHttpProxySettings, configureHttpDispatcher } = await load("core/http-dispatcher.js");
const { takeOverStdout } = await load("core/output-guard.js");
const { isLocalPath, resolvePath, normalizePath } = await load("utils/paths.js");
const { setThemeJsonValidator, stopThemeWatcher } = await load("modes/interactive/theme/theme.js");
const { validateThemeJson } = await load("modes/interactive/theme/theme-schema.js");
for (const fn of [resolveProjectTrusted, createProjectTrustContext, createSessionManager, runMigrations,
  applyHttpProxySettings, configureHttpDispatcher, takeOverStdout, setThemeJsonValidator]) {
  if (typeof fn !== "function") throw new Error("Incompatible native Pi RPC bootstrap");
}
const report = diagnostic => process.stderr.write(diagnostic.type + ": " + diagnostic.message + "\n");
const parsed = sdk.parseArgs(args);
for (const diagnostic of parsed.diagnostics) report(diagnostic);
if (parsed.diagnostics.some(diagnostic => diagnostic.type === "error")) {
  throw new Error("Invalid Pi RPC arguments");
}
const offline = parsed.offline || ["1", "true", "yes"].includes(process.env.PI_OFFLINE?.toLowerCase());
if (offline) {
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
}
if (parsed.mode !== "rpc") throw new Error("Sandy SDK worker only supports RPC mode");
if (parsed.fileArgs.length) throw new Error("@file arguments are not supported in RPC mode");
const sessionConflicts = [
  parsed.session ? "--session" : undefined,
  parsed.continue ? "--continue" : undefined,
  parsed.resume ? "--resume" : undefined,
].filter(Boolean);
if (parsed.fork) {
  const conflicts = [...sessionConflicts, ...(parsed.noSession ? ["--no-session"] : [])];
  if (conflicts.length) throw new Error("--fork cannot be combined with " + conflicts.join(", "));
}
if (parsed.sessionId !== undefined && sessionConflicts.length) {
  throw new Error("--session-id cannot be combined with " + sessionConflicts.join(", "));
}
if (parsed.provider && !parsed.model) throw new Error("--provider requires --model");
takeOverStdout();
setThemeJsonValidator(validateThemeJson);
const cwd = process.cwd();
const agentDir = sdk.getAgentDir();
const bootstrapSettings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
applyHttpProxySettings(bootstrapSettings.getGlobalSettings().httpProxy);
configureHttpDispatcher();
runMigrations(cwd);
const startupSettings = sdk.SettingsManager.create(cwd, agentDir);
const sessionDir = parsed.sessionDir ? normalizePath(parsed.sessionDir) :
  process.env[ENV_SESSION_DIR] ?? startupSettings.getSessionDir();
const sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettings);
const trustStore = new sdk.ProjectTrustStore(agentDir);
const trustByCwd = new Map();
const absolutePaths = paths => paths?.map(value => isLocalPath(value) ? resolvePath(value, cwd) : value);
const extensionPaths = absolutePaths(parsed.extensions);
const skillPaths = absolutePaths(parsed.skills);
const promptPaths = absolutePaths(parsed.promptTemplates);
const themePaths = absolutePaths(parsed.themes);
const isSkillNameEnabled = ` +
  experimental_isSkillNameEnabled.toString() +
  String.raw`;
const skillsOverride = current => ({
  ...current,
  skills: current.skills.filter(skill => isSkillNameEnabled(selection, skill.name)),
});
const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent, projectTrustContext }) => {
  const cached = trustByCwd.get(cwd);
  const needsTrust = sdk.hasTrustRequiringProjectResources(cwd);
  const resolveTrust = parsed.projectTrustOverride === undefined && cached === undefined && needsTrust;
  const projectTrusted = resolveTrust ? false :
    (cached ?? parsed.projectTrustOverride ?? trustStore.get(cwd) ?? !needsTrust);
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted });
  const diagnostics = [];
  const services = await sdk.createAgentSessionServices({
    cwd, agentDir, settingsManager,
    modelRuntimeSignal: AbortSignal.timeout(15000),
    extensionFlagValues: parsed.unknownFlags,
    resourceLoaderReloadOptions: resolveTrust ? {
      resolveProjectTrust: async ({ extensionsResult }) => {
        const trusted = await resolveProjectTrusted({
          cwd, trustStore, trustOverride: parsed.projectTrustOverride,
          defaultProjectTrust: startupSettings.getDefaultProjectTrust(),
          extensionsResult,
          projectTrustContext: projectTrustContext ?? createProjectTrustContext({
            cwd, mode: "rpc", settingsManager: startupSettings, hasUI: false,
          }),
          onExtensionError: message => diagnostics.push({ type: "warning", message }),
        });
        trustByCwd.set(cwd, trusted);
        return trusted;
      },
    } : undefined,
    resourceLoaderOptions: {
      additionalExtensionPaths: extensionPaths,
      additionalSkillPaths: skillPaths,
      additionalPromptTemplatePaths: promptPaths,
      additionalThemePaths: themePaths,
      noExtensions: parsed.noExtensions,
      disabledBuiltinExtensions: parsed.noMcp ? ["mcp"] : undefined,
      noSkills: parsed.noSkills,
      noPromptTemplates: parsed.noPromptTemplates,
      noThemes: parsed.noThemes,
      noContextFiles: parsed.noContextFiles,
      systemPrompt: parsed.systemPrompt,
      appendSystemPrompt: parsed.appendSystemPrompt,
      extensionFactories: builtInExtensions,
      skillsOverride,
    },
  });
  diagnostics.push(...services.diagnostics);
  const extensions = services.resourceLoader.getExtensions();
  for (const { path, error } of extensions.errors)
    diagnostics.push({ type: "error", message: "Failed to load extension " + path + ": " + error });
  for (const { path, warning } of extensions.warnings ?? [])
    diagnostics.push({ type: "warning", message: "Extension " + path + ": " + warning });
  const settings = services.settingsManager;
  const patterns = parsed.models ?? settings.getEnabledModels();
  const scope = patterns?.length
    ? await sdk.resolveModelScopeWithDiagnostics(patterns, services.modelRuntime, { signal: AbortSignal.timeout(15000) })
    : { scopedModels: [], diagnostics: [] };
  diagnostics.push(...scope.diagnostics);
  const scopedModels = scope.scopedModels;
  let model;
  let thinkingLevel = parsed.thinking;
  if (parsed.model) {
    const resolved = sdk.resolveCliModel({
      cliProvider: parsed.provider, cliModel: parsed.model, cliThinking: parsed.thinking,
      inlineApiKey: Boolean(parsed.apiKey), modelRuntime: services.modelRuntime,
    });
    if (resolved.error) throw new Error(resolved.error);
    if (resolved.warning) diagnostics.push({ type: "warning", message: resolved.warning });
    model = resolved.model;
    thinkingLevel ??= resolved.thinkingLevel;
  }
  if (!model && scopedModels.length && !sessionManager.buildSessionContext().messages.length) {
    const preferred = scopedModels.find(entry =>
      entry.model.provider === settings.getDefaultProvider() && entry.model.id === settings.getDefaultModel());
    const initial = preferred ?? scopedModels[0];
    model = initial.model;
    thinkingLevel ??= initial.thinkingLevel;
  }
  if (parsed.apiKey) {
    if (!model) throw new Error("--api-key requires a model");
    await services.modelRuntime.setRuntimeApiKey(model.provider, parsed.apiKey);
  }
  const created = await sdk.createAgentSessionFromServices({
    services, sessionManager, sessionStartEvent, model, thinkingLevel, scopedModels,
    tools: parsed.tools, excludeTools: parsed.excludeTools,
    noTools: parsed.noTools ? "all" : parsed.noBuiltinTools ? "builtin" : undefined,
  });
  if (created.session.model && thinkingLevel !== undefined)
    created.session.setThinkingLevel(created.session.thinkingLevel);
  return { ...created, services, diagnostics };
};
const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
  cwd: sessionManager.getCwd(), agentDir, sessionManager,
});
for (const diagnostic of runtime.diagnostics) report(diagnostic);
if (runtime.diagnostics.some(diagnostic => diagnostic.type === "error")) {
  await runtime.dispose();
  throw new Error("Pi SDK resource initialization failed");
}
if (!runtime.session.model) {
  await runtime.dispose();
  throw new Error("Pi has no authenticated model provider available");
}
const settings = runtime.services.settingsManager;
applyHttpProxySettings(settings.getGlobalSettings().httpProxy);
configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
sdk.initTheme(settings.getTheme(), false);
if (!offline) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  void runtime.services.modelRuntime.refresh({ signal: controller.signal })
    .catch(error => process.stderr.write("Pi model refresh: " + String(error) + "\n"))
    .finally(() => clearTimeout(timeout));
}
try {
  await sdk.runRpcMode(runtime);
} finally {
  await runtime.dispose();
  stopThemeWatcher();
}
`;
