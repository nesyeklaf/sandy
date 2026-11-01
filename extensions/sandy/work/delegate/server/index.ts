// Plugin entry of sandy/delegate (server side): settings, the ledger DB, the agent tools (sandy_delegate and
// its control tools for parents; sandy_delegate_brief, sandy_ask_parent and sandy_question_answer for delegates), the
// answerQuestion RPC, the configure hook that marks delegates, the brief watchdog (a background service
// sweeping the ledger), and the `sandy work delegate` CLI (list and agents for people; policy, ack and debug are hidden
// and used by the pi extension and the live tests).
import { cliCommand, defineCli, PluginCliError, type SandyPluginApi, type PluginCliContext } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "../contract.ts";
import { answerQuestionByRpc, askParent, sweepQuestions, takeQuestionAnswer } from "./ask.ts";
import { BIND_DELAY_KEY, createSandyHosts } from "./sandy-host.ts";
import { agentsCommands } from "./agents-cli.ts";
import { seedBuiltinAgents, THINKING_LEVELS } from "./catalog.ts";
import { drainAfterSweep, sendParameters, sendToDelegation, stopDelegations, stopParameters } from "./control.ts";
import { delegate } from "./launch.ts";
import { formatDelegationTable, listDelegations } from "./list.ts";
import { migrations } from "./migrations.ts";
import { sleepUnlessAborted } from "./sleep.ts";
import { createPanelHost, panelAckFailures, panelList, panelMerge, panelSend, panelSetHidden, panelStop, panelWriterDetails, authorizePanel, promptAudit } from "./panel.ts";
import { enrichDelegations, statusFor } from "./status.ts";
import { waitCeilingMs, waitFields, waitForDelegation } from "./wait.ts";
import { ASK_TOOL, BRIEF_TOOL, DELEGATE_TOOL, QUESTION_ANSWER_TOOL, SEND_TOOL, STATUS_TOOL, STOP_TOOL, WAIT_TOOL, briefToolsLine, deliverBrief, delegateToolsFor, issuePolicy, metadataDelegationId, recordAck } from "./protocol.ts";
import { DEFAULT_SETTINGS, SETTING_DESCRIPTORS } from "./settings.ts";
import { sweepWatchdog, watchdogTickMs, watchdogWindowMs } from "./watchdog.ts";
import { admitWorker, attachWorker, releaseWorker, sweepWorkers } from "./workers.ts";
import { createWorkersLink, type WorkersLink } from "../../workers-link.ts";

const delegateParameters = z.object({
  agent: z.string().min(1).describe("Catalog agent name, e.g. scout or implementer-low."),
  task: z.string().min(1).describe("The task for the child. It is delivered to the child only after its tool policy is applied."),
  title: z.string().min(1).max(120).optional().describe("Thread title of the child."),
  model: z.string().min(1).optional().describe("Model override; must be one the agent allows."),
  thinking: z.enum(THINKING_LEVELS).optional().describe("Thinking level override."),
  clientRequestId: z.string().min(1).max(200).optional().describe("Idempotency key: a retry with the same key and input returns the same delegation."),
  project: z.string().min(1).optional().describe("Writers only: run in a managed worktree of this project (id or name) instead of on this thread's branch, e.g. from a personal or non-git thread."),
  baseBranch: z.string().min(1).optional().describe("With project: the worktree's base branch; default the project's default branch."),
  mode: z.enum(["async", "wait"]).default("async").describe("async: return once the child is spawned; the parent is woken when it finishes. wait: block until the child's turn finishes and return its final message, or return waitTimedOut after the wait ceiling (continue with sandy_delegate_wait)."),
});

const waitParameters = z.object({
  delegationId: z.string().min(1).describe("Delegation id returned by sandy_delegate; it must have been started by this thread."),
});

const statusParameters = z.object({
  delegationId: z.string().min(1).optional().describe("Delegation id returned by sandy_delegate; omit for all delegations this thread started (newest 50)."),
});

const askParameters = z.object({
  question: z.string().min(1).max(4_000).describe("The question for the person or agent that started you. Ask one thing, with the context needed to answer it."),
  options: z.array(z.string().min(1).max(200)).max(8).optional().describe("Suggested answers to pick from; a free answer stays possible."),
});

const questionAnswerParameters = z.object({
  questionId: z.string().min(1).describe("The question id named in the message that the answer is ready."),
});

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export default async function plugin(sandy: SandyPluginApi, workers: WorkersLink = createWorkersLink()) {
  const settings = sandy.settings.define(SETTING_DESCRIPTORS);
  const db = sandy.storage.database();
  sandy.storage.migrate(db, migrations);
  seedBuiltinAgents(db);

  const { launchHost: host, watchdogHost, waitHost, controlHost, statusHost } = createSandyHosts(sandy, workers);

  // Worker slots for the workflows part (server/workers.ts), called in process through the link.
  workers.delegate = {
    async admit(input) {
      const result = await admitWorker(db, watchdogHost, input, await settings.get());
      if (result.ok) sandy.log.info(`worker slot ${result.reservationId} (${result.state}) for run ${input.runId} call ${input.callId}`);
      return result;
    },
    attach: (input) => attachWorker(db, watchdogHost, input),
    release: async (input) => releaseWorker(db, input),
  };

  // The watchdog sweep. It reads the window from the settings on every pass and keeps no state of its
  // own, so a reload or restart continues from the ledger. The first completed pass of this process is
  // the startup reconciliation of every reservation.
  sandy.background.service("watchdog", {
    async start(signal) {
      let startup = true;
      while (!signal.aborted) {
        let windowMs = watchdogWindowMs(DEFAULT_SETTINGS);
        try {
          const current = await settings.get();
          windowMs = watchdogWindowMs(current);
          const firstPass = startup;
          const report = await sweepWatchdog(db, watchdogHost, windowMs, Date.now(), {
            startup,
            afterSweep: async (swept) => {
              const questions = await sweepQuestions(db, controlHost, current, { startup: firstPass });
              swept.failures.push(...questions.failures);
              for (const questionId of questions.reasked) sandy.log.info(`watchdog: question ${questionId} re-asked (its form was gone)`);
              for (const questionId of questions.pointers) sandy.log.info(`watchdog: question ${questionId}: answer pointer queued again`);
              for (const questionId of questions.expired) sandy.log.info(`watchdog: question ${questionId} expired`);
              for (const questionId of questions.cancelled) sandy.log.info(`watchdog: question ${questionId} cancelled, its delegation ended`);
              const workers = await sweepWorkers(db, watchdogHost, windowMs, Date.now(), { startup: firstPass });
              swept.failures.push(...workers.failures);
              for (const { reservationId, threadId } of workers.attached) sandy.log.info(`watchdog: worker reservation ${reservationId} attached to ${threadId}`);
              for (const reservationId of workers.released) sandy.log.info(`watchdog: worker reservation ${reservationId} released, no thread`);
              for (const reservationId of workers.idled) sandy.log.info(`watchdog: worker ${reservationId} idle, slot freed`);
              await drainAfterSweep(db, controlHost, current, swept);
            },
          });
          if (startup) sandy.log.info("watchdog: startup reconciliation done");
          startup = false;
          for (const row of report.refused) sandy.log.warn(`watchdog: ${row.delegationId} (child ${row.childThreadId}) refused, no ack within ${windowMs} ms`);
          for (const row of report.unmarked) sandy.log.warn(`watchdog: ${row.delegationId} (child ${row.childThreadId}) refused, its turn started without the delegate marker`);
          for (const { delegation, turn } of report.turnUnacked) sandy.log.warn(`watchdog: ${delegation.delegationId} (child ${delegation.childThreadId}) refused, its turn (turn/started seq ${turn.seq}) had no ack within ${windowMs} ms`);
          for (const entry of report.bound) sandy.log.info(`watchdog: reservation ${entry.delegationId} bound to ${entry.childThreadId}`);
          for (const delegationId of report.released) sandy.log.info(`watchdog: reservation ${delegationId} released, no thread found`);
          for (const entry of report.kept) sandy.log.warn(`watchdog: reservation ${entry.delegationId} kept: ${entry.reason}`);
          for (const threadId of report.stopped) sandy.log.info(`watchdog: stopped ${threadId}`);
          for (const row of report.deleted) sandy.log.warn(`watchdog: ${row.delegationId} ended, SANDY no longer has its child ${row.childThreadId}`);
          for (const threadId of report.restored) sandy.log.info(`watchdog: parent notifications of ${threadId} set back to auto (no wait of this process)`);
          for (const failure of report.failures) sandy.log.error(`watchdog: ${failure.subject}: ${failure.error}`);
        } catch (error) {
          sandy.log.error(`watchdog sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await sleepUnlessAborted(watchdogTickMs(windowMs), signal);
      }
    },
  });

  sandy.agents.registerTool({
    name: DELEGATE_TOOL,
    description: "Start a delegated child agent from the sandy-delegate catalog as a hidden child thread of this thread. Readers run in this thread's checkout, writers in their own managed worktree on this thread's branch, or in the project you name. The child runs on pi with the agent's tool allowlist enforced.",
    parameters: delegateParameters,
    async execute(params, ctx) {
      const current = await settings.get();
      const result = await delegate(db, host, ctx.threadId, params, current);
      if (!result.ok) return { content: [{ type: "text", text: json({ ok: false, ...result.refusal }) }], isError: true };
      if (params.mode !== "wait" || result.launched.threadId === null) return json({ ok: true, ...result.launched });
      const outcome = await waitForDelegation(db, waitHost, {
        callerThreadId: ctx.threadId, delegationId: result.launched.delegationId, ceilingMs: waitCeilingMs(current), signal: ctx.signal,
        notificationsAlreadyOff: !result.launched.reused,
      });
      if (outcome.kind === "refused") return { content: [{ type: "text", text: json({ ok: false, ...outcome.refusal }) }], isError: true };
      return json({ ok: true, ...result.launched, ...waitFields(outcome) });
    },
  });

  sandy.agents.registerTool({
    name: WAIT_TOOL,
    description: "Keep waiting for a delegated child you started with sandy_delegate, for at most the wait ceiling per call. Returns the child's final message and status when its turn has finished, or waitTimedOut:true; call it again to continue. Only the thread that started the delegation may wait on it.",
    parameters: waitParameters,
    async execute(params, ctx) {
      const outcome = await waitForDelegation(db, waitHost, {
        callerThreadId: ctx.threadId, delegationId: params.delegationId, ceilingMs: waitCeilingMs(await settings.get()), signal: ctx.signal,
      });
      if (outcome.kind === "refused") return { content: [{ type: "text", text: json({ ok: false, ...outcome.refusal }) }], isError: true };
      const { delegation } = outcome;
      return json({ ok: true, delegationId: delegation.delegationId, threadId: delegation.childThreadId, agent: delegation.agent, agentVersion: delegation.agentVersion, ...waitFields(outcome) });
    },
  });

  sandy.agents.registerTool({
    name: SEND_TOOL,
    description: "Send a message to a child you started with sandy_delegate. steer reaches its running turn; queue lands after the turn. An idle child is re-admitted first; if all slots of this thread are taken the message waits and is delivered when one frees (status queued). Only the thread that started the delegation may send.",
    parameters: sendParameters,
    async execute(params, ctx) {
      const result = await sendToDelegation(db, controlHost, await settings.get(), { callerThreadId: ctx.threadId, ...params });
      if (!result.ok) return { content: [{ type: "text", text: json({ ok: false, ...result.refusal }) }], isError: true };
      return json(result);
    },
  });

  sandy.agents.registerTool({
    name: STOP_TOOL,
    description: "Stop one child you started with sandy_delegate (delegationId) or all of them (all:true). Its slot is held until the stop is confirmed. Stopping this thread itself never stops its children. Only the thread that started a delegation may stop it.",
    parameters: stopParameters,
    async execute(params, ctx) {
      if ((params.delegationId === undefined) === (params.all === undefined)) {
        return { content: [{ type: "text", text: json({ ok: false, code: "bad_arguments", message: "pass exactly one of delegationId or all:true" }) }], isError: true };
      }
      const result = await stopDelegations(db, controlHost, await settings.get(), { callerThreadId: ctx.threadId, ...params });
      if (!result.ok) return { content: [{ type: "text", text: json({ ok: false, ...result.refusal }) }], isError: true };
      return json(result);
    },
  });

  sandy.agents.registerTool({
    name: STATUS_TOOL,
    description: "Show the live status of delegated children you started with sandy_delegate: status, SANDY thread status, model, thinking, tokens (total and context, null when unknown), run time, last activity, stale flag and the provider's error. Pass a delegationId for one, or none for all of yours. Only the thread that started a delegation may query it.",
    parameters: statusParameters,
    async execute(params, ctx) {
      const result = await statusFor(db, statusHost, ctx.threadId, params.delegationId);
      if (!result.ok) return { content: [{ type: "text", text: json({ ok: false, ...result.refusal }) }], isError: true };
      return json({ ok: true, staleAfterMs: result.staleAfterMs, truncated: result.truncated, delegations: result.delegations });
    },
  });

  sandy.agents.registerTool({
    name: BRIEF_TOOL,
    description: "Return your role and task as a sandy-delegate child. Call it first; it answers once, later calls say it was already delivered.",
    instructions: `You are a sandy-delegate child thread: call ${BRIEF_TOOL} first, it returns your role and task.`,
    parameters: z.object({}),
    execute(_params, ctx) {
      const brief = deliverBrief(db, ctx.threadId);
      if (!brief.ok) return { content: [{ type: "text", text: `${brief.code}: ${brief.message}` }], isError: true };
      return [`# Role (${brief.agent})`, brief.body, "", `# Tools`, briefToolsLine(brief.tools), "", `# Task${brief.title ? ` (${brief.title})` : ""}`, brief.task].join("\n");
    },
  });

  sandy.agents.registerTool({
    name: ASK_TOOL,
    description: "Ask the person or agent that started you a question and wait for the answer. One question at a time. The answer comes back as this call's result (or, after an interruption, as a message telling you to call sandy_question_answer). Ask only when you cannot continue sensibly without the answer.",
    parameters: askParameters,
    async execute(params, ctx) {
      const outcome = await askParent(db, controlHost, await settings.get(), { childThreadId: ctx.threadId, question: params.question, options: params.options, signal: ctx.signal });
      switch (outcome.kind) {
        case "refused":
          return { content: [{ type: "text", text: `${outcome.code}: ${outcome.message}` }], isError: true };
        case "answer":
          return outcome.alreadyDelivered
            ? `answer to question ${outcome.questionId} (already delivered): ${outcome.answer}`
            : `answer to question ${outcome.questionId}: ${outcome.answer}`;
        case "ended":
          return outcome.message;
        case "still_open":
          return `question ${outcome.questionId} still open, the answer will follow as a message`;
        case "aborted":
          return { content: [{ type: "text", text: `question ${outcome.questionId}: the call was aborted` }], isError: true };
      }
    },
  });

  sandy.agents.registerTool({
    name: QUESTION_ANSWER_TOOL,
    description: "Take the answer to your question once a message says it is ready. Returns it once; a repeat call says it was already delivered.",
    parameters: questionAnswerParameters,
    execute(params, ctx) {
      const outcome = takeQuestionAnswer(db, ctx.threadId, params.questionId);
      if (!outcome.ok) return { content: [{ type: "text", text: `${outcome.code}: ${outcome.message}` }], isError: true };
      return outcome.alreadyDelivered
        ? `already delivered: answer to question ${outcome.questionId}: ${outcome.answer}`
        : `answer to question ${outcome.questionId}: ${outcome.answer}`;
    },
  });

  // The Delegates panel (app.tsx): the owner's answer to a child's open question, and the panel's view and
  // controls (server/panel.ts). A plugin caller has no owner identity and is refused; the parent agent uses
  // the sandy_delegate_* tools. Accepted residual: "client" also covers agents and CLI callers, SANDY gives no
  // owner identity for a client; this refuses plugin callers only, and the panel methods act only on the
  // named thread's own delegations.
  const panelHost = createPanelHost(sandy);
  const clientOnly = (method: string, kind: string) => {
    if (kind !== "client") throw new Error(`${method} is for the owner's client only`);
  };
  const refused = <T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> => {
    if (!outcome.ok) throw new Error((outcome as unknown as { refusal: { message: string } }).refusal.message);
    return outcome as Extract<T, { ok: true }>;
  };
  sandy.rpc.register(rpcContract, {
    async answerQuestion({ delegationId, questionId, answer }, context) {
      clientOnly("answerQuestion", context.experimental_caller.kind);
      const outcome = await answerQuestionByRpc(db, controlHost, await settings.get(), { delegationId, questionId, answer });
      if (!outcome.ok) throw new Error(outcome.message);
      return { questionId: outcome.questionId, delivery: outcome.delivery };
    },
    async listDelegates({ threadId }, context) {
      clientOnly("listDelegates", context.experimental_caller.kind);
      return panelList(db, statusHost, panelHost, threadId);
    },
    async promptAudit({ threadId, delegationId }, context) {
      clientOnly("promptAudit", context.experimental_caller.kind);
      return promptAudit(db, refused(authorizePanel(db, threadId, delegationId)).row);
    },
    async sendToDelegate({ threadId, delegationId, message, mode }, context) {
      clientOnly("sendToDelegate", context.experimental_caller.kind);
      const sent = refused(await panelSend(db, controlHost, await settings.get(), threadId, { delegationId, message, mode }));
      const detail = sent.status === "delivered" ? `delivered (${sent.sandyDelivery}${sent.readmitted ? ", readmitted" : ""})` : sent.status === "queued" ? sent.message : `answered question ${sent.questionId} (${sent.delivery})`;
      return { status: sent.status, delegationId: sent.delegationId, detail };
    },
    async stopDelegates({ threadId, delegationId }, context) {
      clientOnly("stopDelegates", context.experimental_caller.kind);
      const stopped = refused(await panelStop(db, controlHost, await settings.get(), threadId, delegationId === undefined ? { all: true } : { delegationId }));
      return {
        stopped: stopped.stopped.map(({ delegationId: id, state, stopConfirmed, error }) => ({ delegationId: id, state, stopConfirmed, ...(error === undefined ? {} : { error }) })),
        skipped: stopped.skipped,
      };
    },
    async ackFailures({ threadId, delegationId }, context) {
      clientOnly("ackFailures", context.experimental_caller.kind);
      return { acknowledged: refused(await panelAckFailures(db, statusHost, threadId, delegationId)).acknowledged };
    },
    async setDelegateHidden({ threadId, delegationId, hidden }, context) {
      clientOnly("setDelegateHidden", context.experimental_caller.kind);
      return { hidden: refused(await panelSetHidden(db, panelHost, threadId, delegationId, hidden)).hidden };
    },
    async writerDetails({ threadId, delegationId }, context) {
      clientOnly("writerDetails", context.experimental_caller.kind);
      return refused(await panelWriterDetails(db, panelHost, threadId, delegationId)).details;
    },
    async mergeDelegate({ threadId, delegationId }, context) {
      clientOnly("mergeDelegate", context.experimental_caller.kind);
      const merged = refused(await panelMerge(db, statusHost, panelHost, threadId, delegationId));
      sandy.log.info(`panel merge of ${delegationId} in ${threadId}: ${merged.result.status}`);
      return merged.result;
    },
  });

  // A failing lookup still marks a thread whose metadata names a delegation: the marker only restricts.
  sandy.agents.configure((context) => {
    try {
      return { tools: delegateToolsFor(db, context.thread.id, context.pluginMetadata), skills: [] };
    } catch (error) {
      sandy.log.error(`configure failed for ${context.thread.id}: ${error instanceof Error ? error.message : String(error)}`);
      return { tools: metadataDelegationId(context.pluginMetadata) === null ? [] : [BRIEF_TOOL, ASK_TOOL, QUESTION_ANSWER_TOOL], skills: [] };
    }
  });

  // The calling thread of a hidden command: the CLI context's thread, or --thread when the context has none.
  const callingThread = (ctx: PluginCliContext, thread: string | undefined): string => {
    if (ctx.threadId && thread && ctx.threadId !== thread) throw new PluginCliError("--thread differs from the calling thread", { code: "thread_mismatch" });
    const threadId = ctx.threadId ?? thread;
    if (!threadId) throw new PluginCliError("no calling thread", { code: "no_thread", hint: "Pass --thread \"$SANDY_THREAD_ID\"." });
    return threadId;
  };

  sandy.cli.register(defineCli({
    name: "delegate",
    summary: "Inspect sandy-delegate child threads",
    commands: {
      list: cliCommand({
        summary: "List delegations, newest first",
        options: {
          parent: { type: "string", description: "Only delegations of this parent thread id" },
          limit: { type: "integer", min: 1, max: 500, default: 50, description: "Rows to show (1-500)" },
          json: { type: "boolean", description: "Emit JSON" },
        },
        async run(input) {
          const entries = await enrichDelegations(db, statusHost, listDelegations(db, { parentThreadId: input.options.parent, limit: input.options.limit }));
          return { exitCode: 0, stdout: input.options.json ? json(entries) + "\n" : formatDelegationTable(entries) };
        },
      }),
      ...agentsCommands(db),
      policy: cliCommand({
        summary: "Print the tool policy and a fresh ack nonce for the calling delegate thread (JSON)",
        hidden: true,
        options: { thread: { type: "string", description: "Calling thread id when the CLI context has none" } },
        async run(input, ctx) {
          const threadId = callingThread(ctx, input.options.thread);
          const metadata = await sandy.sdk.threads.getPluginMetadata({ threadId });
          return { exitCode: 0, stdout: json(issuePolicy(db, threadId, metadata, Date.now(), await settings.get())) + "\n" };
        },
      }),
      ack: cliCommand({
        summary: "Acknowledge an applied policy by echoing its hash and nonce (JSON)",
        hidden: true,
        options: {
          delegation: { type: "string", required: true, description: "Delegation id of the policy" },
          hash: { type: "string", required: true, description: "Policy hash" },
          nonce: { type: "string", required: true, description: "Nonce issued with the policy" },
          session: { type: "string", required: true, description: "pi session id" },
          turn: { type: "integer", required: true, min: 1, max: Number.MAX_SAFE_INTEGER, description: "Turn counter of the pi session (1 = first turn)" },
          thread: { type: "string", description: "Calling thread id when the CLI context has none" },
        },
        async run(input, ctx) {
          const threadId = callingThread(ctx, input.options.thread);
          const current = await settings.get();
          const result = recordAck(db, {
            threadId, delegationId: input.options.delegation, policyHash: input.options.hash, nonce: input.options.nonce, piSessionId: input.options.session, turn: input.options.turn,
          }, watchdogWindowMs(current), Date.now(), current);
          if (!result.ok) throw new PluginCliError(result.message, { code: result.code });
          return { exitCode: 0, stdout: json({ ok: true, delegationId: result.delegation.delegationId, state: result.delegation.state }) + "\n" };
        },
      }),
      "debug bind-delay": cliCommand({
        summary: "Test hook: wait this many ms between spawn and ledger bind (0 turns it off)",
        hidden: true,
        positionals: [{ name: "ms", description: "Delay in milliseconds, 0-60000", required: true }],
        async run(input) {
          const ms = Number(input.positionals.ms);
          if (!Number.isInteger(ms) || ms < 0 || ms > 60_000) throw new PluginCliError("ms must be an integer 0-60000", { code: "invalid_delay" });
          if (ms === 0) await sandy.storage.kv.delete(BIND_DELAY_KEY);
          else await sandy.storage.kv.set(BIND_DELAY_KEY, ms);
          return { exitCode: 0, stdout: `bind delay ${ms} ms\n` };
        },
      }),
    },
  }));
}
