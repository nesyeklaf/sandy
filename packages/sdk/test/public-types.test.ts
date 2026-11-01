import { describe, expectTypeOf, it } from "vitest";
import type {
  SandyRealtime as RootSandyRealtime,
  SandySdk as RootSandySdk,
  SandyRealtimeConnectionEvent as RootRealtimeConnection,
  FileReadResult as RootFileRead,
  GuideRenderResult as RootGuideRender,
  HostGetResult as RootHostGet,
  PluginListResult as RootPluginList,
  PluginGetSourceResult as RootPluginGetSource,
  PluginApplyUpdateResult as RootPluginApplyUpdate,
  PluginCatalogStatusResult as RootPluginCatalogStatus,
  PermissionMode as RootPermissionMode,
  ProjectAttachmentUploadResult as RootProjectAttachmentUpload,
  ProjectFileContentResult as RootProjectFileContent,
  ProjectGetResult as RootProjectGet,
  ProjectWorkspaceRoutingArgs as RootProjectWorkspaceRoutingArgs,
  ProviderListArgs as RootProviderListArgs,
  ProviderListResult as RootProviderList,
  ProviderModelsArgs as RootProviderModelsArgs,
  StatusResult as RootStatus,
  TerminalCreateArgs as RootTerminalCreateArgs,
  TerminalListResult as RootTerminalListResult,
  ThemeCatalogResult as RootThemeCatalog,
  ThemeSetInput as RootThemeSetInput,
  ThreadSectionListResult as RootThreadSectionList,
  ThreadSpawnResult as RootThreadSpawn,
} from "@sandy/sdk";
import type {
  SandySdk as BrowserSandySdk,
  BrowserSandySdk as BrowserRuntimeSandySdk,
  SandyRealtimeConnectionEvent as BrowserRealtimeConnection,
  FileReadResult as BrowserFileRead,
  GuideRenderResult as BrowserGuideRender,
  HostGetResult as BrowserHostGet,
  PluginListResult as BrowserPluginList,
  PluginGetSourceResult as BrowserPluginGetSource,
  PluginApplyUpdateResult as BrowserPluginApplyUpdate,
  PluginCatalogStatusResult as BrowserPluginCatalogStatus,
  ProjectAttachmentUploadResult as BrowserProjectAttachmentUpload,
  ProjectFileContentResult as BrowserProjectFileContent,
  ProjectGetResult as BrowserProjectGet,
  ProjectWorkspaceRoutingArgs as BrowserProjectWorkspaceRoutingArgs,
  ProviderListArgs as BrowserProviderListArgs,
  ProviderListResult as BrowserProviderList,
  ProviderModelsArgs as BrowserProviderModelsArgs,
  StatusResult as BrowserStatus,
  TerminalCreateArgs as BrowserTerminalCreateArgs,
  TerminalListResult as BrowserTerminalListResult,
  ThemeCatalogResult as BrowserThemeCatalog,
  ThemeSetInput as BrowserThemeSetInput,
  ThreadSectionListResult as BrowserThreadSectionList,
  ThreadSpawnResult as BrowserThreadSpawn,
  createBrowserSandySdk,
} from "@sandy/sdk/browser";
import type {
  SandySdk as CoreSandySdk,
  SandyRealtimeConnectionEvent as CoreRealtimeConnection,
  FileReadResult as CoreFileRead,
  GuideRenderResult as CoreGuideRender,
  HostGetResult as CoreHostGet,
  PluginListResult as CorePluginList,
  PluginGetSourceResult as CorePluginGetSource,
  PluginApplyUpdateResult as CorePluginApplyUpdate,
  PluginCatalogStatusResult as CorePluginCatalogStatus,
  ProjectAttachmentUploadResult as CoreProjectAttachmentUpload,
  ProjectFileContentResult as CoreProjectFileContent,
  ProjectGetResult as CoreProjectGet,
  ProjectWorkspaceRoutingArgs as CoreProjectWorkspaceRoutingArgs,
  ProviderListArgs as CoreProviderListArgs,
  ProviderListResult as CoreProviderList,
  ProviderModelsArgs as CoreProviderModelsArgs,
  StatusResult as CoreStatus,
  TerminalCreateArgs as CoreTerminalCreateArgs,
  TerminalListResult as CoreTerminalListResult,
  ThemeCatalogResult as CoreThemeCatalog,
  ThemeSetInput as CoreThemeSetInput,
  ThreadSectionListResult as CoreThreadSectionList,
  ThreadSpawnResult as CoreThreadSpawn,
} from "@sandy/sdk/core";
import type {
  SandySdk as NodeSandySdk,
  SandyRealtimeConnectionEvent as NodeRealtimeConnection,
  FileReadResult as NodeFileRead,
  GuideRenderResult as NodeGuideRender,
  HostGetResult as NodeHostGet,
  PluginListResult as NodePluginList,
  PluginGetSourceResult as NodePluginGetSource,
  PluginApplyUpdateResult as NodePluginApplyUpdate,
  PluginCatalogStatusResult as NodePluginCatalogStatus,
  ProjectAttachmentUploadResult as NodeProjectAttachmentUpload,
  ProjectFileContentResult as NodeProjectFileContent,
  ProjectGetResult as NodeProjectGet,
  ProjectWorkspaceRoutingArgs as NodeProjectWorkspaceRoutingArgs,
  ProviderListArgs as NodeProviderListArgs,
  ProviderListResult as NodeProviderList,
  ProviderModelsArgs as NodeProviderModelsArgs,
  StatusResult as NodeStatus,
  TerminalCreateArgs as NodeTerminalCreateArgs,
  TerminalListResult as NodeTerminalListResult,
  ThemeCatalogResult as NodeThemeCatalog,
  ThemeSetInput as NodeThemeSetInput,
  ThreadSectionListResult as NodeThreadSectionList,
  ThreadSpawnResult as NodeThreadSpawn,
} from "@sandy/sdk/node";

interface RootSurface {
  fileRead: RootFileRead;
  guideRender: RootGuideRender;
  hostGet: RootHostGet;
  pluginList: RootPluginList;
  pluginGetSource: RootPluginGetSource;
  pluginApplyUpdate: RootPluginApplyUpdate;
  pluginCatalogStatus: RootPluginCatalogStatus;
  projectAttachmentUpload: RootProjectAttachmentUpload;
  projectFileContent: RootProjectFileContent;
  projectGet: RootProjectGet;
  projectWorkspaceRoutingArgs: RootProjectWorkspaceRoutingArgs;
  providerList: RootProviderList;
  providerListArgs: RootProviderListArgs;
  providerModelsArgs: RootProviderModelsArgs;
  realtimeConnection: RootRealtimeConnection;
  status: RootStatus;
  terminalCreateArgs: RootTerminalCreateArgs;
  terminalList: RootTerminalListResult;
  themeCatalog: RootThemeCatalog;
  themeSetInput: RootThemeSetInput;
  threadSectionList: RootThreadSectionList;
  threadSpawn: RootThreadSpawn;
}

interface BrowserSurface {
  fileRead: BrowserFileRead;
  guideRender: BrowserGuideRender;
  hostGet: BrowserHostGet;
  pluginList: BrowserPluginList;
  pluginGetSource: BrowserPluginGetSource;
  pluginApplyUpdate: BrowserPluginApplyUpdate;
  pluginCatalogStatus: BrowserPluginCatalogStatus;
  projectAttachmentUpload: BrowserProjectAttachmentUpload;
  projectFileContent: BrowserProjectFileContent;
  projectGet: BrowserProjectGet;
  projectWorkspaceRoutingArgs: BrowserProjectWorkspaceRoutingArgs;
  providerList: BrowserProviderList;
  providerListArgs: BrowserProviderListArgs;
  providerModelsArgs: BrowserProviderModelsArgs;
  realtimeConnection: BrowserRealtimeConnection;
  status: BrowserStatus;
  terminalCreateArgs: BrowserTerminalCreateArgs;
  terminalList: BrowserTerminalListResult;
  themeCatalog: BrowserThemeCatalog;
  themeSetInput: BrowserThemeSetInput;
  threadSectionList: BrowserThreadSectionList;
  threadSpawn: BrowserThreadSpawn;
}

interface CoreSurface {
  fileRead: CoreFileRead;
  guideRender: CoreGuideRender;
  hostGet: CoreHostGet;
  pluginList: CorePluginList;
  pluginGetSource: CorePluginGetSource;
  pluginApplyUpdate: CorePluginApplyUpdate;
  pluginCatalogStatus: CorePluginCatalogStatus;
  projectAttachmentUpload: CoreProjectAttachmentUpload;
  projectFileContent: CoreProjectFileContent;
  projectGet: CoreProjectGet;
  projectWorkspaceRoutingArgs: CoreProjectWorkspaceRoutingArgs;
  providerList: CoreProviderList;
  providerListArgs: CoreProviderListArgs;
  providerModelsArgs: CoreProviderModelsArgs;
  realtimeConnection: CoreRealtimeConnection;
  status: CoreStatus;
  terminalCreateArgs: CoreTerminalCreateArgs;
  terminalList: CoreTerminalListResult;
  themeCatalog: CoreThemeCatalog;
  themeSetInput: CoreThemeSetInput;
  threadSectionList: CoreThreadSectionList;
  threadSpawn: CoreThreadSpawn;
}

interface NodeSurface {
  fileRead: NodeFileRead;
  guideRender: NodeGuideRender;
  hostGet: NodeHostGet;
  pluginList: NodePluginList;
  pluginGetSource: NodePluginGetSource;
  pluginApplyUpdate: NodePluginApplyUpdate;
  pluginCatalogStatus: NodePluginCatalogStatus;
  projectAttachmentUpload: NodeProjectAttachmentUpload;
  projectFileContent: NodeProjectFileContent;
  projectGet: NodeProjectGet;
  projectWorkspaceRoutingArgs: NodeProjectWorkspaceRoutingArgs;
  providerList: NodeProviderList;
  providerListArgs: NodeProviderListArgs;
  providerModelsArgs: NodeProviderModelsArgs;
  realtimeConnection: NodeRealtimeConnection;
  status: NodeStatus;
  terminalCreateArgs: NodeTerminalCreateArgs;
  terminalList: NodeTerminalListResult;
  themeCatalog: NodeThemeCatalog;
  themeSetInput: NodeThemeSetInput;
  threadSectionList: NodeThreadSectionList;
  threadSpawn: NodeThreadSpawn;
}

type ExpectedSandySdkKey =
  | "experimental_desktopBrowsers"
  | "experimental_promptHistory"
  | "experimental_server"
  | "environments"
  | "files"
  | "guide"
  | "hosts"
  | "plugins"
  | "projects"
  | "providers"
  | "skills"
  | "status"
  | "subscribe"
  | "system"
  | "terminals"
  | "theme"
  | "threadSections"
  | "threads";

type ExpectedRealtimeKey = "subscribe";

type ExpectedEnvironmentsKey =
  | "experimental_cleanup"
  | "experimental_clearDiffViewed"
  | "experimental_diffViewed"
  | "experimental_markDiffViewed"
  | "archiveThreads"
  | "commit"
  | "delete"
  | "list"
  | "listProviders"
  | "get"
  | "paths"
  | "update";

type ExpectedFilesKey =
  | "createPreview"
  | "list"
  | "listPaths"
  | "mkdir"
  | "move"
  | "read"
  | "remove"
  | "write";

type ExpectedGuideKey = "render";

type ExpectedHostsKey =
  | "cloneDefaultPath"
  | "experimental_create"
  | "experimental_getEnrollmentCommand"
  | "experimental_reconnect"
  | "createJoinCode"
  | "delete"
  | "experimental_deleteOldServerCopy"
  | "directory"
  | "experimental_discoverRepos"
  | "get"
  | "list"
  | "experimental_listProviders"
  | "pathsExist"
  | "pickFolder"
  | "providerCliStatus"
  | "experimental_resume"
  | "experimental_retryCleanup"
  | "retryUpdate"
  | "experimental_suspend"
  | "experimental_reconcile"
  | "update";

type ExpectedPluginsKey =
  | "experimental_discoverRpc"
  | "experimental_getSafeMode"
  | "experimental_setSafeMode"
  | "experimental_pruneCache"
  | "applyUpdate"
  | "experimental_startUpdate"
  | "experimental_updateJobs"
  | "callRpc"
  | "catalog"
  | "checkUpdates"
  | "disable"
  | "enable"
  | "getSettings"
  | "getSource"
  | "install"
  | "installJobs"
  | "list"
  | "listUpdateResults"
  | "marketplaces"
  | "reload"
  | "remove"
  | "startInstall"
  | "token"
  | "updateSettings";

type ExpectedPluginCatalogKey =
  | "install"
  | "installPlan"
  | "search"
  | "startInstall"
  | "status";

type ExpectedPluginMarketplacesKey = "add" | "list" | "refresh" | "remove";

type ExpectedPluginInstallJobsKey = "cancel" | "get" | "list";

type ExpectedExperimentalPromptHistoryKey = "list";

type ExpectedProjectsKey =
  | "machineEnvironment"
  | "replaceMachineEnvironment"
  | "setMachineEnvironmentVariable"
  | "deleteMachineEnvironmentVariable"
  | "attachments"
  | "branches"
  | "commands"
  | "create"
  | "defaultExecutionOptions"
  | "delete"
  | "fileContent"
  | "files"
  | "get"
  | "list"
  | "paths"
  | "promptHistory"
  | "reorder"
  | "sidebarBootstrap"
  | "sources"
  | "update";

type ExpectedProjectSourcesKey = "add" | "delete" | "update";
type ExpectedProjectAttachmentsKey = "copy" | "read" | "upload";

type ExpectedProvidersKey = "catalog" | "list" | "models" | "setEnabled";

type ExpectedStatusKey = "get";

type ExpectedSystemKey =
  | "setMachineEnvironmentVariable"
  | "deleteMachineEnvironmentVariable"
  | "machineEnvironment"
  | "replaceMachineEnvironment"
  | "aiServices"
  | "attention"
  | "cliSkillsStatus"
  | "config"
  | "executionOptions"
  | "installCliSkills"
  | "experimental_cliCommand"
  | "experimental_installCliCommand"
  | "experimental_removeCliCommand"
  | "experimental_reportClientError"
  | "reloadConfig"
  | "setAiServiceSelection"
  | "testAiService"
  | "transcribeVoice"
  | "uiPreferences"
  | "updateExperiments"
  | "updateGeneralSettings"
  | "updateKeyboardSettings"
  | "providerStates"
  | "usageLimits";

type ExpectedSystemUiPreferencesKey = "list" | "reset" | "set";

type ExpectedThemeKey =
  | "catalog"
  | "experimental_check"
  | "experimental_create"
  | "get"
  | "resolve"
  | "set";

type ExpectedThreadSectionsKey = "create" | "delete" | "list" | "update";

type ExpectedThreadsKey =
  | "experimental_listAncestors"
  | "experimental_listDescendants"
  | "experimental_listCascade"
  | "experimental_listPluginMetadata"
  | "experimental_regenerateTitle"
  | "experimental_updateEnvironmentDirectory"
  | "getPluginMetadata"
  | "updatePluginMetadata"
  | "context"
  | "archive"
  | "archiveAll"
  | "cancelPlan"
  | "childSummary"
  | "clearContext"
  | "clearGoal"
  | "compact"
  | "conversationOutline"
  | "count"
  | "defaultExecutionOptions"
  | "delete"
  | "editMessage"
  | "events"
  | "fork"
  | "get"
  | "interactions"
  | "list"
  | "listRunning"
  | "markRead"
  | "markUnread"
  | "message"
  | "open"
  | "output"
  | "paneAction"
  | "pin"
  | "promptHistory"
  | "queue"
  | "queuedMessages"
  | "reorderPinned"
  | "resolveMentions"
  | "restoreEnvironment"
  | "retry"
  | "search"
  | "send"
  | "spawn"
  | "stop"
  | "storageFiles"
  | "storageLocation"
  | "storagePaths"
  | "tabs"
  | "timeline"
  | "timelineTurnSummaryDetails"
  | "unarchive"
  | "unpin"
  | "update"
  | "wait";

type ExpectedThreadEventsKey = "list" | "wait";
/**
 * The cross-thread queue area answers exactly one question — what is queued
 * right now — so it has exactly one method. A row's own operations (send-now,
 * edit, reorder, delete) live on `queuedMessages`.
 */
type ExpectedThreadQueueKey = "list";
type ExpectedThreadInteractionsKey =
  | "cancel"
  | "get"
  | "list"
  | "resolve"
  | "respond";
type ExpectedThreadQueuedMessagesKey =
  | "create"
  | "delete"
  | "experimental_holdForEdit"
  | "experimental_releaseEditHold"
  | "list"
  | "reorder"
  | "send"
  | "setGroupBoundary"
  | "update";
type ExpectedThreadTabsKey = "get" | "update";
type ExpectedTerminalsKey =
  | "close"
  | "create"
  | "get"
  | "input"
  | "list"
  | "output"
  | "rename"
  | "restart"
  | "resize";

describe("SDK public type entrypoints", () => {
  it("export the same transport-independent DTO surface", () => {
    expectTypeOf<BrowserSurface>().toEqualTypeOf<RootSurface>();
    expectTypeOf<CoreSurface>().toEqualTypeOf<RootSurface>();
    expectTypeOf<NodeSurface>().toEqualTypeOf<RootSurface>();
  });

  it("preserves the complete SDK surface at every entrypoint", () => {
    expectTypeOf<keyof RootSandySdk>().toEqualTypeOf<ExpectedSandySdkKey>();
    expectTypeOf<BrowserSandySdk>().toEqualTypeOf<RootSandySdk>();
    expectTypeOf<CoreSandySdk>().toEqualTypeOf<RootSandySdk>();
    expectTypeOf<NodeSandySdk>().toEqualTypeOf<RootSandySdk>();
  });

  it("keeps the local guide area off the browser SDK instance", () => {
    expectTypeOf<keyof BrowserRuntimeSandySdk>().toEqualTypeOf<
      Exclude<ExpectedSandySdkKey, "guide">
    >();
    expectTypeOf<
      ReturnType<typeof createBrowserSandySdk>
    >().toEqualTypeOf<BrowserRuntimeSandySdk>();
  });

  it("exports only the public permission presets", () => {
    expectTypeOf<RootPermissionMode>().toEqualTypeOf<
      "accept-edits" | "auto" | "full"
    >();
  });

  it("makes provider host selectors mutually exclusive", () => {
    expectTypeOf<{
      environmentId: string;
      hostId: string;
    }>().not.toMatchTypeOf<RootProviderListArgs>();
    expectTypeOf<{ hostId: string }>().toMatchTypeOf<RootProviderModelsArgs>();
    expectTypeOf<{
      environmentId: string;
    }>().toMatchTypeOf<RootProviderModelsArgs>();
  });

  it("makes project workspace selectors mutually exclusive", () => {
    expectTypeOf<{
      environmentId: string;
      hostId: string;
    }>().not.toMatchTypeOf<RootProjectWorkspaceRoutingArgs>();
    expectTypeOf<{
      hostId: string;
    }>().toMatchTypeOf<RootProjectWorkspaceRoutingArgs>();
    expectTypeOf<{
      environmentId: string;
    }>().toMatchTypeOf<RootProjectWorkspaceRoutingArgs>();
  });

  it("uses explicit mutually exclusive terminal scopes", () => {
    expectTypeOf<{
      cols: number;
      rows: number;
      scope: {
        kind: "thread";
        threadId: string;
        environmentId: string;
      };
    }>().not.toMatchTypeOf<RootTerminalCreateArgs>();
    expectTypeOf<{
      cols: number;
      rows: number;
      scope: { kind: "environment"; environmentId: string };
    }>().toMatchTypeOf<RootTerminalCreateArgs>();
    expectTypeOf<{
      cols: number;
      rows: number;
      scope: { kind: "host_path"; hostId: string; cwd: null };
    }>().toMatchTypeOf<RootTerminalCreateArgs>();
  });

  it("snapshots every SDK area and nested method group", () => {
    expectTypeOf<
      keyof RootSandyRealtime
    >().toEqualTypeOf<ExpectedRealtimeKey>();
    expectTypeOf<
      keyof RootSandySdk["environments"]
    >().toEqualTypeOf<ExpectedEnvironmentsKey>();
    expectTypeOf<
      keyof RootSandySdk["files"]
    >().toEqualTypeOf<ExpectedFilesKey>();
    expectTypeOf<
      keyof RootSandySdk["guide"]
    >().toEqualTypeOf<ExpectedGuideKey>();
    expectTypeOf<
      keyof RootSandySdk["hosts"]
    >().toEqualTypeOf<ExpectedHostsKey>();
    expectTypeOf<
      keyof RootSandySdk["plugins"]
    >().toEqualTypeOf<ExpectedPluginsKey>();
    expectTypeOf<
      keyof RootSandySdk["plugins"]["catalog"]
    >().toEqualTypeOf<ExpectedPluginCatalogKey>();
    expectTypeOf<
      keyof RootSandySdk["plugins"]["marketplaces"]
    >().toEqualTypeOf<ExpectedPluginMarketplacesKey>();
    expectTypeOf<
      keyof RootSandySdk["plugins"]["installJobs"]
    >().toEqualTypeOf<ExpectedPluginInstallJobsKey>();
    expectTypeOf<
      keyof RootSandySdk["projects"]
    >().toEqualTypeOf<ExpectedProjectsKey>();
    expectTypeOf<
      keyof RootSandySdk["projects"]["attachments"]
    >().toEqualTypeOf<ExpectedProjectAttachmentsKey>();
    expectTypeOf<
      keyof RootSandySdk["projects"]["sources"]
    >().toEqualTypeOf<ExpectedProjectSourcesKey>();
    expectTypeOf<
      keyof RootSandySdk["experimental_promptHistory"]
    >().toEqualTypeOf<ExpectedExperimentalPromptHistoryKey>();
    expectTypeOf<
      keyof RootSandySdk["providers"]
    >().toEqualTypeOf<ExpectedProvidersKey>();
    expectTypeOf<
      keyof RootSandySdk["status"]
    >().toEqualTypeOf<ExpectedStatusKey>();
    expectTypeOf<
      keyof RootSandySdk["system"]
    >().toEqualTypeOf<ExpectedSystemKey>();
    expectTypeOf<
      keyof RootSandySdk["system"]["uiPreferences"]
    >().toEqualTypeOf<ExpectedSystemUiPreferencesKey>();
    expectTypeOf<
      keyof RootSandySdk["terminals"]
    >().toEqualTypeOf<ExpectedTerminalsKey>();
    expectTypeOf<
      keyof RootSandySdk["theme"]
    >().toEqualTypeOf<ExpectedThemeKey>();
    expectTypeOf<
      keyof RootSandySdk["threadSections"]
    >().toEqualTypeOf<ExpectedThreadSectionsKey>();
    expectTypeOf<
      keyof RootSandySdk["threads"]
    >().toEqualTypeOf<ExpectedThreadsKey>();
    expectTypeOf<
      keyof RootSandySdk["threads"]["events"]
    >().toEqualTypeOf<ExpectedThreadEventsKey>();
    expectTypeOf<
      keyof RootSandySdk["threads"]["queue"]
    >().toEqualTypeOf<ExpectedThreadQueueKey>();
    expectTypeOf<
      keyof RootSandySdk["threads"]["interactions"]
    >().toEqualTypeOf<ExpectedThreadInteractionsKey>();
    expectTypeOf<
      keyof RootSandySdk["threads"]["queuedMessages"]
    >().toEqualTypeOf<ExpectedThreadQueuedMessagesKey>();
    expectTypeOf<
      keyof RootSandySdk["threads"]["tabs"]
    >().toEqualTypeOf<ExpectedThreadTabsKey>();
  });
});
