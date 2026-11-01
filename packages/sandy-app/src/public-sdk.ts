import {
  SandyHttpError,
  SandyRequestTimeoutError,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
  createNodeSandySdk,
  type SandySdk as NodeSandySdk,
  type CreateNodeSandySdkArgs,
} from "@sandy/sdk/node";
import type {
  SandyRealtimeSubscribeArgs,
  SandyRealtimeSocket,
  SandyRealtimeSocketFactory,
  SandyRealtimeSocketMessageEvent,
  ThreadGetResult,
  ThreadStatusArgs,
} from "@sandy/sdk/node";

export {
  SandyHttpError,
  SandyRequestTimeoutError,
  ThreadWaitTimeoutError,
  ThreadWaitUnreachableError,
};
export type * from "@sandy/sdk/node";
export type {
  GitBranchSelection,
  JsonValue,
  PermissionMode,
  PromptInput,
  PromptTextMention,
  ReasoningLevel,
  ServiceTier,
  ThreadStatus,
} from "@sandy/sdk/node";
export type {
  CreateExecutionInputSources,
  EnvironmentArgs,
  ExistingThreadExecutionInputSources,
  UnmanagedBranchSpec,
  WorkspaceArgs,
} from "@sandy/sdk/node";
export type { CallerExecutionInputSource as ExecutionInputSource } from "@sandy/sdk/node";

export type SandySdkOptions = CreateNodeSandySdkArgs;
export type SandySdkRealtimeSubscribeArgs = SandyRealtimeSubscribeArgs;
export type SandySdkRealtimeSocket = SandyRealtimeSocket;
export type SandySdkRealtimeSocketFactory = SandyRealtimeSocketFactory;
export type SandySdkRealtimeSocketMessageEvent = SandyRealtimeSocketMessageEvent;
export type SandySdkStatusArea = NodeSandySdk["status"];
export type SandySdkSkillsArea = NodeSandySdk["skills"];
export type SandySdkTerminalsArea = NodeSandySdk["terminals"];
export type SandySdkThread = ThreadGetResult;
export type SandySdkThreadsArea = NodeSandySdk["threads"];
export type ThreadIdArgs = ThreadStatusArgs;
export type SandyHttpErrorConstructor = typeof SandyHttpError;
export type SandyRequestTimeoutErrorConstructor = typeof SandyRequestTimeoutError;
export type ThreadWaitTimeoutErrorConstructor = typeof ThreadWaitTimeoutError;
export type ThreadWaitUnreachableErrorConstructor =
  typeof ThreadWaitUnreachableError;

export class SandySdk implements NodeSandySdk {
  readonly environments: NodeSandySdk["environments"];
  readonly experimental_desktopBrowsers: NodeSandySdk["experimental_desktopBrowsers"];
  readonly experimental_promptHistory: NodeSandySdk["experimental_promptHistory"];
  readonly experimental_server: NodeSandySdk["experimental_server"];
  readonly files: NodeSandySdk["files"];
  readonly guide: NodeSandySdk["guide"];
  readonly hosts: NodeSandySdk["hosts"];
  readonly plugins: NodeSandySdk["plugins"];
  readonly projects: NodeSandySdk["projects"];
  readonly providers: NodeSandySdk["providers"];
  readonly skills: NodeSandySdk["skills"];
  readonly status: NodeSandySdk["status"];
  readonly system: NodeSandySdk["system"];
  readonly terminals: NodeSandySdk["terminals"];
  readonly theme: NodeSandySdk["theme"];
  readonly threadSections: NodeSandySdk["threadSections"];
  readonly threads: NodeSandySdk["threads"];
  readonly subscribe: NodeSandySdk["subscribe"];

  constructor(options: SandySdkOptions = {}) {
    const sdk = createNodeSandySdk(options);
    this.environments = sdk.environments;
    this.experimental_desktopBrowsers = sdk.experimental_desktopBrowsers;
    this.experimental_promptHistory = sdk.experimental_promptHistory;
    this.experimental_server = sdk.experimental_server;
    this.files = sdk.files;
    this.guide = sdk.guide;
    this.hosts = sdk.hosts;
    this.plugins = sdk.plugins;
    this.projects = sdk.projects;
    this.providers = sdk.providers;
    this.skills = sdk.skills;
    this.status = sdk.status;
    this.system = sdk.system;
    this.terminals = sdk.terminals;
    this.theme = sdk.theme;
    this.threadSections = sdk.threadSections;
    this.threads = sdk.threads;
    this.subscribe = sdk.subscribe;
  }
}

export function createSandySdk(options: SandySdkOptions = {}): SandySdk {
  return new SandySdk(options);
}
