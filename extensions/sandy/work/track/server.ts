// sandy-plugin-track: a stage machine for the main agent session (design: docs/design-v2.md). Each stage visit is a
// lease held by one driver: the agent (stage_* tools, with the ticket the pi track-guard injects) or an autopilot
// (sandy work track drive, launched by this plugin with /autopilot --lease <ticket>). run.ts holds every rule;
// operations.ts commits; effects.ts launches, tells, checks and asks. The run lives in sandy.storage.kv per thread;
// every commit rewrites the policy file on the thread's host (host.ts), which the guard enforces on each tool call.
import type { SandyPluginApi, JsonValue, PluginAgentToolResult } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import { hostContract, rpcContract, RUN_CHANGED } from "./contract.ts";
import { hostContract as goalsContract } from "../goals/contract.ts";
import { clip, parseMachine, type Machine } from "./machine.ts";
import { createExecutor, type Executor } from "./effects.ts";
import { createOperations, type Committed } from "./operations.ts";
import { desired, policyFor, statusText, type AskForm, type Command, type Driver, type GoalVerdict, type LeaseUsage, type Reply, type Run, type StartSource } from "./run.ts";

export { rpcContract };

const TEMPLATE_FILE = "stages.json";
const APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Expiry resolution: launch grace and heartbeat deadlines are checked this often. */
const TICK_MS = 15_000;
const KEY_PREFIX = "run:";
/**
 * Starts the one line of a tool result the track guard reads the agent's new ticket from: the terminal line, only
 * in results whose own transition minted an agent lease (POLICY.md). Every other occurrence is removed from results.
 */
const TICKET_MARKER = "⟦track-ticket⟧";

const decisionSchema = z.object({ approved: z.boolean(), note: z.string().max(2000).optional() });
const usageSchema = z
  .object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number(), messages: z.number() })
  .strict();
const ticketParam = z.string().max(200).optional().describe("Lease ticket. The track guard fills it in; leave it out.");
const usageParam = usageSchema.optional().describe("Token usage of this lease. The track guard fills it in; leave it out.");

type Target = { projectId: string; environmentId: string; hostId: string; path: string | null };

export default async function plugin(sandy: SandyPluginApi) {
  const host = sandy.hosts.experimental_client({ contract: hostContract });
  const goalsHost = sandy.hosts.experimental_client({ contract: goalsContract });
  const key = (threadId: string) => KEY_PREFIX + threadId;
  const policyErrors = new Map<string, string>();
  // contributeInstructions is synchronous, so runs are mirrored in memory; the mirror also lists the threads to tick.
  const mirror = new Map<string, Run>();
  const legacyActive = new Set<string>();
  for (const k of await sandy.storage.kv.list(KEY_PREFIX)) {
    const stored = await sandy.storage.kv.get<{ version?: unknown; status?: unknown }>(k);
    if (stored && stored.version === 2) mirror.set(k.slice(KEY_PREFIX.length), stored as unknown as Run);
    else if (stored && stored.status === "active") legacyActive.add(k.slice(KEY_PREFIX.length));
  }

  async function load(threadId: string): Promise<Run | null> {
    const stored = await sandy.storage.kv.get<{ version?: unknown }>(key(threadId));
    // A v1 run (no version 2) is not continued: v2 starts over in this thread.
    return stored && stored.version === 2 ? (stored as unknown as Run) : null;
  }

  async function resolveTarget(threadId: string): Promise<Target> {
    const thread = await sandy.sdk.threads.get({ threadId });
    const environmentId = (thread as { environmentId: string | null }).environmentId;
    if (!environmentId) throw new Error("this thread has no environment, so the guard cannot run on its host");
    const env = await sandy.sdk.environments.get({ environmentId });
    return { projectId: thread.projectId, environmentId, hostId: env.hostId, path: env.path };
  }

  async function writePolicyFile(threadId: string, policy: ReturnType<typeof policyFor>): Promise<void> {
    try {
      const target = await resolveTarget(threadId);
      const result = await host.call("writePolicy", { threadId, policy }, { hostId: target.hostId });
      if (!result.written) throw new Error(`the host has a newer policy than rev ${policy.rev}`);
      policyErrors.delete(threadId);
    } catch (error) {
      policyErrors.set(threadId, message(error));
      throw error;
    }
  }

  // Goal link (loose): a run remembers the goal focused when it started; a goal rule reads that goal's auditor verdict.
  // Reading fails soft: a thread without pi/work goals simply has none.
  async function readGoalLink(threadId: string, goalId?: string) {
    try {
      const target = await resolveTarget(threadId);
      return await goalsHost.call("goalLink", { threadId, cwd: target.path ?? "", ...(goalId ? { goalId } : {}) }, { hostId: target.hostId });
    } catch (error) {
      sandy.log.warn(`track: ${threadId}: reading the goal link failed: ${message(error)}`);
      return null;
    }
  }
  async function focusedGoal(threadId: string): Promise<{ goalId?: string }> {
    const link = await readGoalLink(threadId);
    return link?.focusedId ? { goalId: link.focusedId } : {};
  }
  /** The verdict for an advance, only when the run serves a goal and the gate towards some edge has a goal rule. */
  async function goalVerdict(threadId: string): Promise<{ goal?: GoalVerdict }> {
    const run = await load(threadId);
    if (!run?.goalId || run.state.kind !== "active") return {};
    const stage = run.machine.stages.find((s) => s.id === (run.state as { lease: { stage: string } }).lease.stage);
    const rules = [...(stage?.gate ?? []), ...(stage?.next ?? []).flatMap((e) => e.gate ?? [])];
    if (!rules.some((r) => r.type === "goal")) return {};
    const link = await readGoalLink(threadId, run.goalId);
    return link?.goalId ? { goal: { goalId: link.goalId, verdict: link.verdict, at: link.at } } : {};
  }

  async function loadTemplate(threadId: string, skill: string): Promise<Machine> {
    const target = await resolveTarget(threadId);
    const ws = { projectId: target.projectId, environmentId: target.environmentId };
    const { skills } = await sandy.sdk.skills.list(ws);
    const matches = skills.filter((s) => s.name === skill);
    if (matches.length === 0) throw new Error(`no skill named "${skill}" in this thread's workspace`);
    for (const match of matches) {
      const { files } = await sandy.sdk.skills.listFiles({ ...ws, skillId: match.id });
      if (!files.includes(TEMPLATE_FILE)) continue;
      const { content } = await sandy.sdk.skills.getContent({ ...ws, skillId: match.id, path: TEMPLATE_FILE });
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch (error) {
        throw new Error(`${match.filePath.replace(/SKILL\.md$/, TEMPLATE_FILE)} is not JSON: ${String(error)}`);
      }
      const parsed = parseMachine(raw);
      if (!parsed.ok) throw new Error(`${skill}/${TEMPLATE_FILE} is invalid: ${parsed.error}`);
      return parsed.machine;
    }
    throw new Error(`skill "${skill}" ships no ${TEMPLATE_FILE}. Build an ad-hoc track with stage_start({machine}) instead (needs the owner's approval).`);
  }

  async function startSource(threadId: string, input: { skill?: string; machine?: unknown }): Promise<StartSource> {
    if (input.machine !== undefined) return { kind: "adhoc", machine: input.machine };
    if (input.skill) return { kind: "skill", skill: input.skill, machine: await loadTemplate(threadId, input.skill) };
    throw new Error("Pass skill (its stages.json) or machine (an ad-hoc track).");
  }

  // ---- effects --------------------------------------------------------------------------------------------------

  function interaction(threadId: string, form: AskForm) {
    const decided = (value: JsonValue) => {
      const decision = decisionSchema.safeParse(value);
      const approved = decision.success && decision.data.approved;
      const what = form.rendererId === "track-approval" ? "track" : form.rendererId === "force-proposal" ? "force proposal" : "gate";
      return { title: clip(`${approved ? "Approved" : "Rejected"} ${what}: ${form.title}`, 80), ...(decision.success && decision.data.note ? { detail: decision.data.note } : {}) };
    };
    return {
      threadId,
      rendererId: form.rendererId,
      title: form.title,
      payload: form.payload as JsonValue,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      presentation: { label: { pending: clip(`Waiting for the owner: ${form.title}`, 80), completed: "Reviewed by the owner" }, icon: { glyph: "Milestone" } },
      describeSubmission: decided,
    };
  }

  const boot = crypto.randomUUID();
  let executor: Executor | null = null;
  const operations = createOperations({
    load,
    save: async (threadId, run) => {
      await sandy.storage.kv.set(key(threadId), run as unknown as JsonValue);
      mirror.set(threadId, run);
    },
    writePolicy: writePolicyFile,
    effects: (threadId, effects) => executor?.reconcile(threadId, effects),
    notify: (threadId) => sandy.realtime.publish(RUN_CHANGED, { threadId }),
    warn: (text) => sandy.log.warn(text),
    now: () => Date.now(),
    newRunId: () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    boot,
  });

  const ports = {
    async runCheck(threadId: string, input: { command: string; timeoutSec: number }, signal: AbortSignal) {
      const target = await resolveTarget(threadId);
      if (!target.path) throw new Error("the environment has no workspace path");
      const started = Date.now();
      const result = await host.call("runCheck", { ...input, cwd: target.path }, { hostId: target.hostId, signal, timeoutMs: (input.timeoutSec + 10) * 1000 });
      const durationMs = Date.now() - started;
      if (result.timedOut) return { exitCode: -1, durationMs, tail: `${result.output}\n[timed out after ${input.timeoutSec}s]` };
      return { exitCode: result.exitCode ?? -1, durationMs, tail: result.output };
    },
    async requestInput(threadId: string, form: AskForm, signal: AbortSignal) {
      const answer = await sandy.ui.requestInput(interaction(threadId, form), { signal });
      if (answer.outcome !== "submitted") return null;
      const decision = decisionSchema.safeParse(answer.value);
      return decision.success ? decision.data : null;
    },
    async send(threadId: string, text: string) {
      await sandy.sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: "start" });
    },
    writePolicy: (threadId: string, rev: number) => operations.writePolicy(threadId, rev),
    warn: (text: string) => sandy.log.warn(text),
  };

  /** A v1 run is not continued; its guard policy is cleared (ordered with commits), retried every tick until written. */
  async function clearLegacyPolicies(): Promise<void> {
    await Promise.all(
      [...legacyActive].map((threadId) =>
        operations.clearPolicy(threadId).then(
          () => legacyActive.delete(threadId),
          (error) => sandy.log.warn(`${threadId}: v1 policy not cleared, retrying: ${message(error)}`),
        ),
      ),
    );
  }

  /**
   * The threads the tick visits: active and proposed runs (deadlines), and every run whose stored obligations still
   * desire an effect (an unwritten policy, an untold finish, a pendingTell, also of an aborted run), so an effect whose
   * port call failed is started again.
   */
  function liveThreads(): string[] {
    return [...mirror].filter(([, run]) => run.state.kind === "active" || run.state.kind === "proposed" || desired(run).length > 0).map(([threadId]) => threadId);
  }

  sandy.background.service("track-effects", {
    async start(signal) {
      executor = createExecutor(ports, (threadId, command) => operations.dispatch(threadId, command), boot);
      // A v1 run is not continued; its guard policy is cleared so the guard stops enforcing it.
      await clearLegacyPolicies();
      await operations.recover([...mirror.keys()]);
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, TICK_MS);
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        });
        if (signal.aborted) break;
        await clearLegacyPolicies();
        await operations.tick(liveThreads());
      }
      executor.dispose();
      executor = null;
    },
  });

  // ---- agent tools ----------------------------------------------------------------------------------------------

  /**
   * The tool result: what happened and the stage as this command left it. A result whose transition minted an agent
   * lease ends with the ticket line the guard reads; the ticket comes from that reply, never from a reload.
   */
  function toolText(threadId: string, committed: Committed, done: string): PluginAgentToolResult {
    const { reply, run } = committed;
    // Graft 3: a change whose guard policy is unwritten is no success and hands out no ticket; the agent hears by message.
    if (committed.unpublished !== undefined)
      return { content: [{ type: "text", text: `Committed as rev ${run?.rev ?? 0}, but the guard policy could not be written (${withoutMarker(committed.unpublished)}). Do not repeat the call: the plugin retries and sends you a message once the policy is written.` }], isError: true };
    const result = toolBody(threadId, reply, run, done);
    const minted = reply.kind === "started" || reply.kind === "entered" ? reply.station : null;
    const ticketLine = minted?.driver.kind === "agent" ? `\n\n${TICKET_MARKER} ${minted.ticket}` : "";
    if (typeof result === "string") return withoutMarker(result) + ticketLine;
    return { ...result, content: result.content.map((c) => (c.type === "text" ? { ...c, text: withoutMarker(c.text) } : c)) };
  }

  function toolBody(threadId: string, reply: Reply, run: Run | null, done: string): PluginAgentToolResult {
    const warning = policyErrors.has(threadId) && run && run.publishedRev < run.rev ? `\n\nWarning: the guard policy could not be written (${policyErrors.get(threadId)}); the plugin retries.` : "";
    const lease = run?.state.kind === "active" ? run.state.lease : null;
    const status = statusText(run);
    const failed = (head: string): PluginAgentToolResult => ({ content: [{ type: "text", text: `${head}\n\n${status}${warning}` }], isError: true });
    switch (reply.kind) {
      case "refused":
        return failed(reply.reasons.join("\n"));
      case "busy":
        return failed(`Wait: ${reply.work.kind === "gate" ? "the gate is being judged" : reply.work.kind === "run" ? `"${reply.work.label}" is running` : "your force proposal waits for the owner"}. The result arrives as a message.`);
      case "publishing":
        return failed("The guard policy of the last change is not written yet. Retry in a moment.");
      case "stale":
        return failed(`Your lease ticket is not current (${reply.reason}).`);
      case "closed":
        return failed("Your lease of this stage has ended; the stage below is current.");
      case "none":
        return status;
      case "proposed":
        return "Proposed. The owner approves the track in the composer; the answer arrives as a message.";
      case "pending":
        return `${done} The result arrives as a message; do not repeat the call meanwhile.\n\n${status}${warning}`;
      case "finished":
        return "Track finished.";
      default: {
        const handOff = lease?.driver.kind === "autopilot" ? "\n\nThis stage is driven by an autopilot. End your turn now; the plugin launches it." : "";
        return `${done}\n\n${status}${handOff}${warning}`;
      }
    }
  }

  const leaseCommand = async (threadId: string, ticket: string | undefined, command: Command): Promise<Committed> =>
    ticket ? operations.commit(threadId, command) : { run: await load(threadId), reply: { kind: "refused", reasons: ["This call carries no lease ticket. The track guard (pi/track-guard) adds it; without the guard the agent cannot drive a stage."] } };

  sandy.agents.registerTool({
    name: "stage_start",
    description:
      "Start a track for this session. Pass skill to load the skill's stages.json template, or machine to propose an ad-hoc track (the owner must approve it). Only one track runs per thread.",
    instructions: [
      "Track: when a skill ships a stages.json (or the owner asks for a track), call stage_start({skill}) before following it.",
      "While a track is active, a guard blocks tools the current stage does not allow. Work stage by stage: stage_status shows the stage, its inputs, required outputs, gate and branches;",
      "stage_submit records outputs and evidence; stage_advance({to}) checks the gate and moves on. If a gate blocks for a reason you cannot fix, stage_propose_force asks the owner to switch stages.",
      "Never try to work around the guard; if a block is wrong, say so and ask the owner.",
    ].join(" "),
    presentation: { label: { pending: "Starting track", completed: "Started track" }, icon: { glyph: "Milestone" } },
    parameters: z.object({
      skill: z.string().min(1).optional().describe("Skill name whose stages.json is the template"),
      machine: z
        .unknown()
        .optional()
        .describe(
          "Ad-hoc track: {id, title, description?, start?, allow?, stages:[{id, title, description?, inputs?:['stage.output'], outputs?:[{name, description?, optional?}], allow?:{skills?, edits?, subagents?:[{agent?, model?}], denyTools?}, gate?:[{type:'outputs'}|{type:'user', prompt?}|{type:'check', command, label?, timeoutSec?}|{type:'evidence', name, description?, ran?}|{type:'goal', label?, optional?: true}], next?:[{to, when?, gate?}]}]}",
        ),
      note: z.string().max(2000).optional().describe("Why this track, shown to the owner with an ad-hoc track"),
    }),
    async execute({ skill, machine, note }, { threadId }) {
      let source: StartSource;
      try {
        source = await startSource(threadId, { skill, machine });
      } catch (error) {
        return { content: [{ type: "text", text: message(error) }], isError: true };
      }
      return toolText(threadId, await operations.commit(threadId, { by: "agent", op: "start", source, ...(note ? { note } : {}), ...(await focusedGoal(threadId)) }), "Started.");
    },
  });

  sandy.agents.registerTool({
    name: "stage_status",
    description: "Show the active track: current stage, who drives it, inputs, outputs, gate, allowed tools, branches and the stage's last visit.",
    presentation: { label: { pending: "Reading stage", completed: "Read stage" }, icon: { glyph: "Milestone" }, suppress: true },
    parameters: z.object({}),
    async execute(_params, { threadId }) {
      return toolText(threadId, { reply: { kind: "none" }, run: await load(threadId) }, "");
    },
  });

  sandy.agents.registerTool({
    name: "stage_submit",
    description: "Record outputs and/or evidence for the CURRENT stage visit. Values replace earlier ones with the same name.",
    presentation: { label: { pending: "Submitting stage output", completed: "Submitted stage output" }, icon: { glyph: "Milestone" } },
    parameters: z.object({
      outputs: z.record(z.string(), z.string()).optional().describe("output name -> value (text, a path, a summary)"),
      evidence: z.record(z.string(), z.string()).optional().describe("evidence name -> what you ran or observed, with the result"),
      ticket: ticketParam,
      usage: usageParam,
    }),
    async execute({ outputs, evidence, ticket, usage }, { threadId }) {
      const committed = await leaseCommand(threadId, ticket, { by: "agent", op: "submit", ticket: ticket ?? "", outputs, evidence, ...(usage ? { usage } : {}) });
      return toolText(threadId, committed, "Recorded.");
    },
  });

  sandy.agents.registerTool({
    name: "stage_advance",
    description:
      "Check the current stage's gate and move to the next stage. Pass to when the stage branches; omit it on a final stage to finish the track. Checks and the owner's approval run in the background; the result arrives as a message.",
    presentation: { label: { pending: "Checking gate", completed: "Checked gate" }, icon: { glyph: "Milestone" } },
    parameters: z.object({
      to: z.string().optional().describe("Next stage id (required when the stage branches)"),
      note: z.string().max(2000).optional().describe("Why this branch / what was done, shown to the owner"),
      ticket: ticketParam,
      usage: usageParam,
    }),
    async execute({ to, note, ticket, usage }, { threadId }) {
      const committed = await leaseCommand(threadId, ticket, { by: "agent", op: "advance", ticket: ticket ?? "", ...(to ? { to } : {}), ...(note ? { note } : {}), ...(usage ? { usage } : {}), ...(ticket ? await goalVerdict(threadId) : {}) });
      return toolText(threadId, committed, committed.reply.kind === "pending" ? "The gate is being checked." : "Gate passed.");
    },
  });

  sandy.agents.registerTool({
    name: "stage_propose_force",
    description:
      "Ask the owner to switch the track to another stage when the current gate is blocked by something you cannot unblock. Explain the blocker in reason. The answer arrives as a message.",
    presentation: { label: { pending: "Proposing a stage switch", completed: "Proposed a stage switch" }, icon: { glyph: "Milestone" } },
    parameters: z.object({
      to: z.string().min(1).describe("Stage id to switch to"),
      reason: z.string().min(1).max(500).describe("What blocks the gate and why it cannot be unblocked"),
      ticket: ticketParam,
    }),
    async execute({ to, reason, ticket }, { threadId }) {
      return toolText(threadId, await leaseCommand(threadId, ticket, { by: "agent", op: "proposeForce", ticket: ticket ?? "", to, reason }), "Asked the owner.");
    },
  });

  // Inside sandy/work one configure selects every part's tools; without this entry SANDY would not offer the
  // stage tools or the track skill at all (a plugin without configure gets everything it registers).
  sandy.agents.configure(() => ({ tools: ["stage_start", "stage_status", "stage_submit", "stage_advance", "stage_propose_force"], skills: ["track"] }));

  sandy.agents.contributeInstructions(({ threadId }) => {
    const run = mirror.get(threadId);
    if (!run || run.state.kind !== "active") return null;
    const lease = run.state.lease;
    const stage = run.machine.stages.find((s) => s.id === lease.stage);
    return `A track "${run.machine.title}" is active in this thread, current stage "${stage?.title ?? lease.stage}". Call stage_status before you continue.`;
  });

  // ---- owner RPC (Stages tab) -----------------------------------------------------------------------------------

  const ownerResult = (reply: Reply) =>
    reply.kind === "refused" ? { ok: false, message: reply.reasons.join("\n") } : reply.kind === "none" ? { ok: false, message: "No track in this thread." } : { ok: true };

  sandy.rpc.register(rpcContract, {
    state: async ({ threadId }) => ({ run: (await load(threadId)) as unknown as JsonValue, policyError: policyErrors.get(threadId) ?? null }),
    setPaused: async ({ threadId, paused }) => ownerResult(await operations.dispatch(threadId, { by: "owner", op: "setPaused", paused })),
    force: async ({ threadId, to, note }) => ownerResult(await operations.dispatch(threadId, { by: "owner", op: "force", to, ...(note ? { note } : {}) })),
    setDriver: async ({ threadId, scope, stage, choice }) =>
      ownerResult(await operations.dispatch(threadId, { by: "owner", op: "setDriver", scope, ...(stage ? { stage } : {}), choice: choice as Driver | "default" })),
    abort: async ({ threadId, reason }) => ownerResult(await operations.dispatch(threadId, { by: "owner", op: "abort", ...(reason ? { reason } : {}) })),
  });

  // ---- CLI ------------------------------------------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  sandy work track status [--thread <id>] [--json]   the thread's track (default: the calling thread)",
    "  sandy work track validate <stages.json>            check a template against the schema",
    "  sandy work track drive <command> [--thread <id>]   an autopilot's lease commands, JSON replies:",
    "    start --skill <name> | --machine <json> [--note <text>] [--autopilot <name> [--args <text>]]",
    "    status [--lease <ticket|grant>]            the current station; with the grant it renews the claim",
    "    claim --ticket <ticket> --invocation <id>  takes the launched lease; replies the grant",
    "    submit --grant <grant> [--outputs <json>] [--evidence <json>] [--usage <json>]",
    "    run --grant <grant> --label <name> --command <text> [--timeout <sec>]   records ran evidence <name>",
    "    advance --grant <grant> [--to <stage>] [--note <text>] [--usage <json>]",
    "    propose-force --grant <grant> --to <stage> --reason <text>",
    "    release --grant <grant> --reason <text> [--usage <json>]   hands the stage to the agent",
    "  sandy work track usage --ticket <ticket> --usage <json> [--thread <id>]   the track guard's late, read-only token report of a lease",
    "  pending replies settle in the background: poll status --lease <grant> for the outcome.",
  ].join("\n");

  function flag(args: string[], name: string): string | undefined {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    return value;
  }

  function required(args: string[], name: string): string {
    const value = flag(args, name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  }

  function jsonFlag<T>(args: string[], name: string, schema: z.ZodType<T>): T | undefined {
    const raw = flag(args, name);
    if (raw === undefined) return undefined;
    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`--${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return parsed.data;
  }

  const strings = z.record(z.string(), z.string());

  /**
   * The CLI reply of a mutating driver command. Graft 3: a commit whose guard policy is unwritten is no success; its
   * ticket, grant or work id is not handed out, and the command must not be repeated (it is committed; the plugin
   * retries the write, then launches or tells as usual). status is a read and keeps its reply.
   */
  type DriveReply = Reply | { kind: "unpublished"; rev: number; error: string };
  const committed = async (threadId: string, command: Command): Promise<DriveReply> => {
    const out = await operations.commit(threadId, command);
    return out.unpublished === undefined ? out.reply : { kind: "unpublished", rev: out.run?.rev ?? 0, error: out.unpublished };
  };

  async function drive(threadId: string, command: string | undefined, args: string[]): Promise<DriveReply> {
    const grant = () => required(args, "grant");
    const usageArg = () => jsonFlag(args, "usage", usageSchema) as LeaseUsage | undefined;
    switch (command) {
      case "start": {
        const machineJson = flag(args, "machine");
        let machine: unknown;
        if (machineJson !== undefined) {
          try {
            machine = JSON.parse(machineJson);
          } catch (error) {
            throw new Error(`--machine must be the track's JSON (not a path): ${message(error)}`);
          }
        }
        const source = await startSource(threadId, { skill: flag(args, "skill"), machine });
        const name = flag(args, "autopilot");
        const note = flag(args, "note");
        const autopilotArgs = flag(args, "args");
        return committed(threadId, { by: "driver", op: "start", source, ...(note ? { note } : {}), ...(await focusedGoal(threadId)), ...(name ? { autopilot: { name, ...(autopilotArgs ? { args: autopilotArgs } : {}) } } : {}) });
      }
      case "status": {
        const lease = flag(args, "lease");
        return operations.dispatch(threadId, { by: "driver", op: "status", ...(lease ? { lease } : {}) });
      }
      case "claim":
        return committed(threadId, { by: "driver", op: "claim", ticket: required(args, "ticket"), invocation: required(args, "invocation") });
      case "submit":
        return committed(threadId, { by: "driver", op: "submit", grant: grant(), outputs: jsonFlag(args, "outputs", strings), evidence: jsonFlag(args, "evidence", strings), ...(flag(args, "usage") ? { usage: usageArg() } : {}) });
      case "run": {
        const timeout = flag(args, "timeout");
        return committed(threadId, { by: "driver", op: "run", grant: grant(), label: required(args, "label"), command: required(args, "command"), ...(timeout ? { timeoutSec: Number(timeout) } : {}) });
      }
      case "advance": {
        const to = flag(args, "to");
        const note = flag(args, "note");
        return committed(threadId, { by: "driver", op: "advance", grant: grant(), ...(to ? { to } : {}), ...(note ? { note } : {}), ...(flag(args, "usage") ? { usage: usageArg() } : {}), ...(await goalVerdict(threadId)) });
      }
      case "propose-force":
        return committed(threadId, { by: "driver", op: "proposeForce", grant: grant(), to: required(args, "to"), reason: required(args, "reason") });
      case "release":
        return committed(threadId, { by: "driver", op: "release", grant: grant(), reason: required(args, "reason"), ...(flag(args, "usage") ? { usage: usageArg() } : {}) });
      default:
        throw new Error(`unknown drive command ${command ?? "(none)"}`);
    }
  }

  sandy.cli.register({
    name: "track",
    summary: "Inspect tracks, validate stages.json templates, drive a stage lease",
    commands: [
      { name: "status", summary: "Show a thread's track", usage: "sandy work track status [--thread <id>] [--json]" },
      { name: "validate", summary: "Validate a stages.json template", usage: "sandy work track validate <stages.json>" },
      { name: "drive", summary: "Lease commands for an autopilot (JSON replies)", usage: "sandy work track drive <start|status|claim|submit|run|advance|propose-force|release> ..." },
      { name: "usage", summary: "Report a lease's measured token usage (the track guard calls it)", usage: "sandy work track usage --ticket <ticket> --usage <json> [--thread <id>]" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const args = argv.filter((a) => a !== "--json");
      const [command, ...rest] = args;
      if (command === "status" || command === "drive" || command === "usage") {
        let threadId: string | undefined;
        try {
          threadId = flag(rest, "thread") ?? ctx.threadId;
        } catch (error) {
          return { exitCode: 1, stderr: message(error) };
        }
        if (!threadId) return { exitCode: 1, stderr: "Pass --thread <id> (no calling thread)." };
        if (command === "status") {
          const run = await load(threadId);
          if (json) return { exitCode: 0, stdout: JSON.stringify({ run, policyError: policyErrors.get(threadId) ?? null }) };
          return { exitCode: 0, stdout: statusText(run) };
        }
        if (command === "usage") {
          try {
            const ticket = required(rest, "ticket");
            const report = jsonFlag(rest, "usage", usageSchema);
            if (report === undefined) throw new Error("--usage is required");
            const reply = await committed(threadId, { by: "meter", op: "usage", ticket, usage: report });
            return { exitCode: 0, stdout: JSON.stringify(reply, null, json ? undefined : 2) };
          } catch (error) {
            return { exitCode: 1, stderr: `${message(error)}\n\n${usage}` };
          }
        }
        try {
          const reply = await drive(threadId, rest[0], rest.slice(1));
          return { exitCode: 0, stdout: JSON.stringify(reply, null, json ? undefined : 2) };
        } catch (error) {
          return { exitCode: 1, stderr: `${message(error)}\n\n${usage}` };
        }
      }
      if (command === "validate" && rest[0]) {
        const { readFile } = await import("node:fs/promises");
        const { resolve } = await import("node:path");
        let raw: unknown;
        try {
          raw = JSON.parse(await readFile(resolve(ctx.cwd ?? process.cwd(), rest[0]), "utf8"));
        } catch (error) {
          return { exitCode: 1, stderr: `Cannot read ${rest[0]}: ${String(error)}` };
        }
        const parsed = parseMachine(raw);
        return parsed.ok ? { exitCode: 0, stdout: `OK: "${parsed.machine.title}", ${parsed.machine.stages.length} stages` } : { exitCode: 1, stderr: parsed.error };
      }
      if (command === undefined || command === "help" || command === "--help") return { exitCode: 0, stdout: usage };
      return { exitCode: 1, stderr: usage };
    },
  });

}

/** Text with every TICKET_MARKER removed, also ones that removing an inner one would form. */
function withoutMarker(text: string): string {
  let out = text;
  while (out.includes(TICKET_MARKER)) out = out.replaceAll(TICKET_MARKER, "");
  return out;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
