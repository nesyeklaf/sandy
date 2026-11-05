// pi side of sandy-delegate: enforces a delegated child's tool allowlist in its pi session.
//
// A pi session is a delegate when SANDY gave its thread the tool "sandy_delegate_brief" (listed in the
// JSON tool list at PI_SANDY_TOOLS_FILE, written by SANDY's pi bridge). Without that marker this
// extension registers nothing. With it the gate starts "pending" (deny all) until a policy from the
// PolicySource is applied, then allows only what decide() allows. The tool_call gate is the
// enforcement. The model is also offered only the policy's tools: before_agent_start sets the run's
// selected tools (which wins over tools other extensions re-add there), and turn_start narrows again
// before each later request. The offered set stays the same, so no tool change lands in the transcript.
// In SANDY the policy comes from the plugin CLI (`sandy work delegate policy`), and the applied policy is
// acknowledged with `sandy work delegate ack`, which unlocks the child's brief. Every turn is acked, with a
// policy (and nonce) fetched for that turn: the plugin stops a child whose turn has no ack, also when
// SANDY resumes it in a new pi session.
import { readFileSync } from "node:fs";
import { decide, parsePolicy, policyHash, type GateState, type Policy } from "../../../sandy/work/delegate/shared/policy.ts";
import { sandyCli, workCliArgs, type RunSandy } from "../sandy-cli.ts";

export const DELEGATE_MARKER_TOOL = "sandy_delegate_brief";

export interface PolicySource {
  load(): Promise<Policy>;
  // Called once the loaded policy is applied to the gate, with the pi session id and the session's turn
  // counter (1 = first turn).
  acknowledge?(policy: Policy, piSessionId: string, turn: number): Promise<void>;
}

type ToolCallEvent = { toolName: string; parentToolCallId?: string };
type ToolCallResult = { block: true; reason: string } | undefined;

// True when the SANDY tool list names the marker tool. A set but unreadable or malformed list counts
// as a delegate: the gate then denies until a policy is applied (fail closed).
export function hasDelegateMarker(toolsFile: string | undefined): boolean {
  if (!toolsFile) return false;
  try {
    const tools: unknown = JSON.parse(readFileSync(toolsFile, "utf8"));
    if (!Array.isArray(tools)) return true;
    // Every entry must be an object with a non-empty string name; anything else is malformed.
    const wellFormed = tools.every((tool) => typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string" && (tool as { name: string }).name !== "");
    if (!wellFormed) return true;
    return tools.some((tool) => (tool as { name: string }).name === DELEGATE_MARKER_TOOL);
  } catch {
    return true;
  }
}

// Reads the policy from a JSON file. Selected by SANDY_DELEGATE_POLICY_FILE; used by tests. A real delegate
// gets its policy from cliPolicySource: the plugin's issuePolicy answer (policy, hash, nonce) via `sandy work delegate policy`.
export function filePolicySource(path: string): PolicySource {
  return { load: async () => parsePolicy(JSON.parse(readFileSync(path, "utf8"))) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls the plugin CLI, retrying a thrown call (the plugin is unreachable, e.g. reloading) every
// retryMs until `deadline`; past it the last error is thrown.
async function runRetrying(run: RunSandy, args: string[], retryMs: number, deadline: number): Promise<string> {
  for (;;) {
    try {
      return await run(args);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(retryMs);
    }
  }
}

// Loads the policy of thread `threadId` from the plugin CLI. "pending" (the spawn is not bound in the
// ledger yet) and a thrown CLI call are retried every retryMs until pendingTimeoutMs; "denied" yields
// the deny-all policy the server sends, and a malformed answer throws at once. The server's nonce and
// hash are kept for the ack of exactly that policy; a thrown ack call is retried the same way.
export function cliPolicySource(threadId: string, options: { run?: RunSandy; retryMs?: number; pendingTimeoutMs?: number } = {}): PolicySource {
  const run = options.run ?? sandyCli();
  const retryMs = options.retryMs ?? 1_000;
  const pendingTimeoutMs = options.pendingTimeoutMs ?? 30_000;
  let issued: { hash: string; nonce: string } | null = null;
  return {
    async load() {
      issued = null;
      const deadline = Date.now() + pendingTimeoutMs;
      for (;;) {
        const answer = JSON.parse(await runRetrying(run, workCliArgs("delegate", "policy", "--thread", threadId), retryMs, deadline)) as { status?: unknown; policy?: unknown; policyHash?: unknown; nonce?: unknown };
        if (answer.status === "pending") {
          if (Date.now() >= deadline) throw new Error("sandy-delegate: policy still pending");
          await sleep(retryMs);
          continue;
        }
        // A denial is deny-all no matter what policy the answer carries.
        if (answer.status === "denied") return { delegationId: "none", snapshotHash: "deny-all", allowTools: [], transportTools: [] };
        const policy = parsePolicy(answer.policy);
        if (answer.status !== "ok" || typeof answer.nonce !== "string" || answer.policyHash !== policyHash(policy)) {
          throw new Error("sandy-delegate: malformed policy answer");
        }
        issued = { hash: answer.policyHash, nonce: answer.nonce };
        return policy;
      }
    },
    async acknowledge(policy, piSessionId, turn) {
      if (issued === null || policyHash(policy) !== issued.hash) return;
      const { hash, nonce } = issued;
      issued = null;
      const args = workCliArgs("delegate", "ack", "--thread", threadId, "--delegation", policy.delegationId, "--hash", hash, "--nonce", nonce, "--session", piSessionId, "--turn", String(turn));
      await runRetrying(run, args, retryMs, Date.now() + pendingTimeoutMs);
    },
  };
}

// The tool_call handler: blocks what decide() denies, and blocks when deciding fails.
export function toolCallGate(state: () => GateState): (event: ToolCallEvent) => ToolCallResult {
  return (event) => {
    try {
      const decision = decide(state(), { toolName: event.toolName, parentToolCallId: event.parentToolCallId });
      return decision.allow ? undefined : { block: true, reason: decision.reason };
    } catch (error) {
      return { block: true, reason: `sandy-delegate: gate failed, call blocked: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

const PI_SUBAGENTS_BLOCK_REASON = "pi-subagents is not used in SANDY threads. Delegate with sandy_delegate (agents: sandy work delegate agents list); pi-subagents stays only in a pi TUI outside SANDY.";
// The pi-subagents tools, bare or as an MCP alias ("mcp__<server>__<name>").
const PI_SUBAGENTS_TOOL = /^(?:mcp__.+?__)?(?:subagents_enable|subagent|subagent_supervisor)$/;

// The tool_call handler that keeps pi-subagents out of SANDY threads; SANDY delegates through sandy_delegate.
export function piSubagentsGate(event: ToolCallEvent): ToolCallResult {
  return PI_SUBAGENTS_TOOL.test(event.toolName) ? { block: true, reason: PI_SUBAGENTS_BLOCK_REASON } : undefined;
}

// Registers piSubagentsGate in a SANDY thread (the SANDY tool list is set, delegate child or not); outside SANDY nothing changes.
export function installPiSubagentsBlock(pi: any, toolsFile: string | undefined): void {
  if (!toolsFile) return;
  pi.on("tool_call", piSubagentsGate);
}

export function installDelegateGate(pi: any, options: { delegate: boolean; policySource?: PolicySource }): void {
  if (!options.delegate) return;
  const source = options.policySource;
  let state: Policy | "pending" = "pending";
  let piSessionId = "";
  // Turns started in this pi session; the ack of a turn carries its number.
  let turn = 0;
  // The first turn's policy, loaded from session start on.
  let prefetched: Promise<Policy | null> | undefined;

  // Narrows the active tools to the applied policy and returns that set (null while pending); skips
  // setActiveTools when nothing changed, since every change is recorded in the transcript before the
  // next request.
  const applyActiveTools = (): string[] | null => {
    if (state === "pending") return null;
    const wanted = [...new Set([...state.allowTools, ...state.transportTools])];
    const known = typeof pi.getAllTools === "function" ? new Set((pi.getAllTools() as { name: string }[]).map((tool) => tool.name)) : null;
    const next = known === null ? wanted : wanted.filter((name) => known.has(name));
    const current: string[] | null = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : null;
    if (current !== null && current.length === next.length && next.every((name) => current.includes(name))) return next;
    pi.setActiveTools(next);
    return next;
  };

  const sessionIdOf = (ctx: any): string => String(ctx?.sessionManager?.getSessionId?.() || process.env.PI_SESSION_ID || "unknown");
  const loadPolicy = async (): Promise<Policy | null> => {
    try {
      return parsePolicy(await source!.load());
    } catch {
      return null;
    }
  };

  pi.on("tool_call", toolCallGate(() => state));

  pi.on("session_start", (_event: unknown, ctx: any) => {
    state = "pending";
    turn = 0;
    piSessionId = sessionIdOf(ctx);
    prefetched = source ? loadPolicy() : undefined;
  });

  // Every turn applies a policy loaded for it and acks it with the turn number. A failed load keeps the
  // gate as it is (pending in a new session, the earlier policy otherwise) and sends no ack, so the
  // plugin stops the child; a failed ack leaves the policy applied.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (source) {
      turn += 1;
      if (piSessionId === "") piSessionId = sessionIdOf(ctx);
      const policy = turn === 1 && prefetched !== undefined ? await prefetched : await loadPolicy();
      prefetched = undefined;
      if (policy !== null) {
        state = policy;
        try {
          await source.acknowledge?.(policy, piSessionId, turn);
        } catch {
          // The gate is already restrictive; the plugin stops a child whose turn has no ack.
        }
      }
    }
    const next = applyActiveTools();
    // pi declares the first request's tools from the run's systemPromptOptions.selectedTools: an edit
    // there wins over setActiveTools calls of later handlers (pi-goal-x re-adds its goal tools).
    // A new array, so pi sees the edit.
    if (next !== null && event?.systemPromptOptions) event.systemPromptOptions.selectedTools = [...next];
  });

  // Backstop for tools activated during a run; turn_start fires before every request but the first.
  pi.on("turn_start", () => applyActiveTools());
}

// SANDY_DELEGATE_POLICY_FILE (tests) wins over the CLI source; a delegate without either stays pending.
export default function sandyDelegate(pi: any): void {
  const policyFile = process.env.SANDY_DELEGATE_POLICY_FILE;
  const threadId = process.env.SANDY_THREAD_ID;
  installDelegateGate(pi, {
    delegate: hasDelegateMarker(process.env.PI_SANDY_TOOLS_FILE),
    policySource: policyFile ? filePolicySource(policyFile) : threadId ? cliPolicySource(threadId) : undefined,
  });
  installPiSubagentsBlock(pi, process.env.PI_SANDY_TOOLS_FILE);
}
