type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = boolean | JsonObject;

interface ExplicitModelSelection {
  provider: string;
  model: string;
  reasoningLevel: string;
}

export interface WorkflowAgentOptions {
  selection: ExplicitModelSelection | null;
  outputSchema: JsonSchema | null;
  title: string | null;
  phase: string | null;
  /** Keep the worker thread after this call, so a later call can continue it; the call returns {value, session}. */
  keep?: boolean;
  /** Continue this kept worker thread of the same run instead of spawning one; the call returns {value, session}. */
  session?: string | null;
  /** Send the prompt verbatim, without the workflow header and result instructions, so a slash command runs. */
  raw?: boolean;
  /** End the call only on a value the worker reports (`sandy work workflows-plus result`), not at a turn end: a code flow
   * that runs its own model turns goes idle between them. */
  report?: boolean;
  /** The worker writes: it runs in its own managed worktree on the origin's branch instead of the origin's
   * environment (the default, a reader). */
  writes?: boolean;
  /** With writes: the writer's managed worktree is in this project (id or name) instead of on the origin's branch,
   * so an origin without a git checkout, such as a personal thread, can run writers. */
  project?: string;
  /** With project: the worktree's base branch; default the project's default branch. */
  baseBranch?: string;
}

interface WorkflowPhase {
  title: string;
  detail: string | null;
}

interface WorkflowMetadata {
  name: string;
  description: string;
  inputSchema: JsonSchema | null;
  outputSchema: JsonSchema | null;
  phases: WorkflowPhase[];
}

export interface ParsedWorkflow {
  metadata: WorkflowMetadata;
  body: string;
}

export interface WorkflowRuntimeLimits {
  memoryLimitBytes: number;
  maxStackBytes: number;
  synchronousDeadlineMs: number;
  maxAgentCalls: number;
  maxConcurrentAgents: number;
}

type WorkflowDepth = 0 | 1;

export type WorkflowReference =
  | string
  | { name: string }
  | { script: string }
  | { scriptPath: string };

export interface WorkflowBudgetSnapshot {
  [key: string]: JsonValue;
  agentCalls: number;
  activeAgents: number;
  queuedAgents: number;
  maxAgentCalls: number;
  maxConcurrentAgents: number;
  totalTokens: null;
}

export interface WorkflowExecutionScheduler {
  readonly limits: Readonly<WorkflowRuntimeLimits>;
  budget(): WorkflowBudgetSnapshot;
}

export interface NestedWorkflowContext {
  signal: AbortSignal;
  limits: Readonly<WorkflowRuntimeLimits>;
  scheduler: WorkflowExecutionScheduler;
  depth: 1;
}

export interface WorkflowCapabilities {
  agent(
    prompt: string,
    options: WorkflowAgentOptions,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  workflow?(
    nameOrRef: WorkflowReference,
    args: JsonValue,
    context: NestedWorkflowContext,
  ): Promise<JsonValue>;
  log(message: string): void;
  phase(title: string): void;
}

export interface ExecuteWorkflowScriptArgs {
  args: JsonValue;
  body: string;
  capabilities: WorkflowCapabilities;
  limits?: Partial<WorkflowRuntimeLimits>;
  signal?: AbortSignal;
  depth?: WorkflowDepth;
  scheduler?: WorkflowExecutionScheduler;
}
