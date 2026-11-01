// sandy-plugin-chief-of-staff: a backlog runner. Each backlog item gets a
// worker thread; one chief-of-staff thread answers their routine questions;
// the few real decisions wait for the user in the panel.
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import { CHANGED_CHANNEL, rpcContract, type Item, type Question } from "./contract";
import { statusLabel } from "./core/brief";
import { Engine, ToolError, type ChiefExecution, type Role, type ThreadPort } from "./core/engine";
import { CHIEF_TOOL_INSTRUCTIONS, WORKER_TOOL_INSTRUCTIONS, oneLine } from "./core/prompts";
import { MIGRATIONS, Store } from "./core/store";

export { rpcContract };

const WORKER_TOOLS = ["cos_ask", "cos_report"];
const CHIEF_TOOLS = ["cos_answer", "cos_escalate", "cos_close_item"];
const BUSY = new Set(["active", "pending", "starting", "stopping"]);
const TICK_MS = 60_000;
const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"];
const CHIEF_DEFAULTS: ChiefExecution = {
  providerId: "pi",
  model: "openai-codex/gpt-5.6-luna",
  reasoningLevel: "medium",
};

export default async function plugin(sandy: SandyPluginApi) {
  const settingsHandle = sandy.settings.define({
    maxConcurrent: {
      type: "number",
      label: "Parallel worker threads",
      description: "How many backlog items run at the same time.",
      default: 3,
    },
    maxNudges: {
      type: "number",
      label: "Nudges before asking you",
      description:
        "How often the chief of staff may nudge a stopped worker before the item comes to you.",
      default: 3,
    },
    chiefProvider: {
      type: "string",
      label: "Chief of staff provider",
      description: "Provider id of the chief thread, as in `sandy provider list`. Takes effect for the next chief thread.",
      default: CHIEF_DEFAULTS.providerId,
    },
    chiefModel: {
      type: "string",
      label: "Chief of staff model",
      description: "Model id of the chief thread, as in `sandy provider models <provider>`.",
      default: CHIEF_DEFAULTS.model,
    },
    chiefReasoning: {
      type: "select",
      label: "Chief of staff reasoning level",
      description: "Reasoning effort of the chief thread. The model must support the level.",
      options: REASONING_LEVELS,
      default: CHIEF_DEFAULTS.reasoningLevel,
    },
  });
  let settings = normalize(await settingsHandle.get());
  settingsHandle.onChange((next) => {
    settings = normalize(next);
  });

  const db = sandy.storage.database();
  sandy.storage.migrate(db, MIGRATIONS);
  const store = new Store(db);

  const threads: ThreadPort = {
    async spawn({ projectId, title, prompt, metadata, execution }) {
      const thread = await sandy.sdk.threads.spawn({
        projectId,
        ...execution,
        environment: { type: "project-default" },
        title,
        prompt,
        pluginMetadata: metadata,
      });
      return thread.id;
    },
    async send(threadId, text) {
      await sandy.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      });
    },
    async stop(threadId) {
      await sandy.sdk.threads.stop({ threadId });
    },
    async retry(threadId) {
      await sandy.sdk.threads.retry({ threadId });
    },
    async status(threadId) {
      try {
        const thread = await sandy.sdk.threads.get({ threadId });
        if (thread.archivedAt !== null || thread.deletedAt !== null) return "gone";
        return BUSY.has(thread.status) ? "busy" : "idle";
      } catch {
        return "gone";
      }
    },
  };

  const engine = new Engine(store, threads, {
    settings: () => settings,
    notify: () => sandy.realtime.publish(CHANGED_CHANNEL, { at: Date.now() }),
    warn: (message) => sandy.log.warn(message),
  });

  // Agent tools. configure() exposes them only to threads this plugin spawned.

  const toolResult = async (run: () => Promise<string>) => {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof ToolError) return { content: [{ type: "text" as const, text: cause.message }], isError: true };
      throw cause;
    }
  };

  sandy.agents.registerTool({
    name: "cos_ask",
    description:
      "Ask the chief of staff a question about your backlog item. Use it for decisions and missing information. End your turn afterwards; the answer arrives as a new message.",
    instructions: WORKER_TOOL_INSTRUCTIONS,
    presentation: { label: { pending: "Asking the chief of staff", completed: "Asked the chief of staff" } },
    parameters: z.object({
      question: z.string().min(1).max(4000).describe("The question, answerable on its own."),
      context: z.string().max(8000).optional().describe("What you know and tried; what depends on the answer."),
      options: z.array(z.string().max(500)).max(8).optional().describe("Concrete options you see, best first."),
    }),
    execute: (input, { threadId }) => toolResult(() => engine.workerAsk(threadId, input)),
  });

  sandy.agents.registerTool({
    name: "cos_report",
    description:
      "Report progress on your backlog item to the chief of staff, or mark it done with a short summary of the outcome.",
    presentation: { label: { pending: "Reporting to the chief of staff", completed: "Reported to the chief of staff" } },
    parameters: z.object({
      status: z.enum(["progress", "done"]),
      summary: z.string().min(1).max(4000),
    }),
    execute: (input, { threadId }) => toolResult(() => engine.workerReport(threadId, input)),
  });

  sandy.agents.registerTool({
    name: "cos_answer",
    description: "Answer a worker's question or check-in. The answer goes straight to the worker thread.",
    instructions: CHIEF_TOOL_INSTRUCTIONS,
    presentation: { label: { pending: "Answering a worker", completed: "Answered a worker" } },
    parameters: z.object({
      questionId: z.number().int(),
      answer: z.string().min(1).max(8000).describe("A clear decision or instruction the worker can act on."),
    }),
    execute: (input, { threadId }) => toolResult(() => engine.chiefAnswer(threadId, input)),
  });

  sandy.agents.registerTool({
    name: "cos_escalate",
    description: "Hand a question to the user because only they can decide it.",
    presentation: { label: { pending: "Escalating to the user", completed: "Escalated to the user" } },
    parameters: z.object({
      questionId: z.number().int(),
      why: z.string().min(1).max(2000).describe("Why this needs the user, in one or two sentences."),
      options: z.array(z.string().max(500)).max(6).optional().describe("Short choices the user can pick."),
      recommendation: z.string().max(2000).optional().describe("What you would choose and why."),
    }),
    execute: (input, { threadId }) => toolResult(() => engine.chiefEscalate(threadId, input)),
  });

  sandy.agents.registerTool({
    name: "cos_close_item",
    description: "Mark a backlog item done when its worker clearly finished but did not report it.",
    presentation: { label: { pending: "Closing a backlog item", completed: "Closed a backlog item" } },
    parameters: z.object({
      itemId: z.number().int(),
      summary: z.string().min(1).max(4000),
    }),
    execute: (input, { threadId }) => toolResult(() => engine.chiefClose(threadId, input)),
  });

  sandy.agents.configure((context) => {
    const role = context.pluginMetadata.role as Role | undefined;
    if (role === "worker") return { tools: WORKER_TOOLS, skills: [] };
    if (role === "chief") return { tools: CHIEF_TOOLS, skills: [] };
    return { tools: [], skills: [] };
  });

  // Thread events drive the loop; unrelated threads fall through the lookups.

  const swallow = (what: string) => (cause: unknown) =>
    sandy.log.error(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  sandy.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    engine.onIdle(thread.id, lastAssistantText).catch(swallow("thread.idle")),
  );
  sandy.events.on("thread.active", ({ thread }) => engine.onActive(thread.id).catch(swallow("thread.active")));
  sandy.events.on("thread.failed", ({ thread, error }) =>
    engine.onFailed(thread.id, error).catch(swallow("thread.failed")),
  );
  sandy.events.on("interaction.pending", ({ thread }) =>
    engine.onInteraction(thread.id).catch(swallow("interaction.pending")),
  );
  sandy.events.on("thread.deleted", ({ thread }) => engine.onGone(thread.id).catch(swallow("thread.deleted")));
  sandy.events.on("thread.archived", ({ thread }) => engine.onGone(thread.id).catch(swallow("thread.archived")));

  // RPC for the panel.

  sandy.rpc.register(rpcContract, {
    overview: () => engine.overview(),
    projects: async () => {
      const projects = await sandy.sdk.projects.list();
      return projects.map((project) => ({ id: project.id, name: project.name }));
    },
    add_backlog: async ({ text, projectId }) => ({ added: await engine.addBacklog(text, projectId) }),
    decide: async ({ questionId, answer }) => {
      await engine.decide(questionId, answer);
      return { ok: true as const };
    },
    item_action: async ({ itemId, action }) => {
      await engine.itemAction(itemId, action);
      return { ok: true as const };
    },
    set_paused: async ({ paused }) => {
      await engine.setPaused(paused);
      return { ok: true as const };
    },
    set_guidance: async ({ text }) => {
      await engine.setGuidance(text);
      return { ok: true as const };
    },
    brief: () => ({ markdown: engine.brief() }),
  });

  registerCli(sandy, engine);

  sandy.background.service("reconcile", {
    async start(signal) {
      while (!signal.aborted) {
        await engine.tick().catch(swallow("tick"));
        await sleep(TICK_MS, signal);
      }
    },
  });
}

function normalize(raw: {
  maxConcurrent: number;
  maxNudges: number;
  chiefProvider: string;
  chiefModel: string;
  chiefReasoning: string;
}) {
  const text = (value: string, fallback: string) => value.trim() || fallback;
  const clamp = (value: number, min: number, max: number, fallback: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  return {
    maxConcurrent: clamp(raw.maxConcurrent, 1, 20, 3),
    maxNudges: clamp(raw.maxNudges, 0, 20, 3),
    chief: {
      providerId: text(raw.chiefProvider, CHIEF_DEFAULTS.providerId),
      model: text(raw.chiefModel, CHIEF_DEFAULTS.model),
      reasoningLevel: REASONING_LEVELS.includes(raw.chiefReasoning) ? raw.chiefReasoning : CHIEF_DEFAULTS.reasoningLevel,
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const USAGE = [
  "Usage:",
  "  sandy chief-of-staff brief                      Progress briefing and open decisions",
  "  sandy chief-of-staff list [--json]              Backlog items and their state",
  "  sandy chief-of-staff decisions [--json]         Questions waiting on you",
  "  sandy chief-of-staff add <project-id> <text>    Add backlog items (one per line)",
  "  sandy chief-of-staff decide <question-id> <answer>",
  "  sandy chief-of-staff pause | resume",
].join("\n");

function registerCli(sandy: SandyPluginApi, engine: Engine) {
  const formatItem = (item: Item) =>
    `#${item.id}  ${statusLabel(item.status).padEnd(20)} ${item.title}` +
    (item.threadId ? `  (${item.threadId})` : "");
  const formatDecision = (q: Question) =>
    `Q${q.id}  #${q.itemId} ${q.itemTitle}\n    ${oneLine(q.question, 200)}` +
    (q.recommendation ? `\n    Recommendation: ${oneLine(q.recommendation, 200)}` : "") +
    (q.options.length > 0 ? `\n    Options: ${q.options.join(" | ")}` : "");

  sandy.cli.register({
    name: "chief-of-staff",
    summary: "Run your backlog through agent threads with a chief of staff",
    commands: [
      { name: "brief", summary: "Progress briefing and open decisions", usage: "sandy chief-of-staff brief" },
      { name: "list", summary: "List backlog items", usage: "sandy chief-of-staff list [--json]" },
      { name: "decisions", summary: "Questions waiting on you", usage: "sandy chief-of-staff decisions [--json]" },
      { name: "add", summary: "Add backlog items, one per line", usage: "sandy chief-of-staff add <project-id> <text>" },
      { name: "decide", summary: "Answer a question waiting on you", usage: "sandy chief-of-staff decide <question-id> <answer>" },
      { name: "pause", summary: "Stop starting new items", usage: "sandy chief-of-staff pause" },
      { name: "resume", summary: "Start queued items again", usage: "sandy chief-of-staff resume" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const ok = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: USAGE };
          case "brief": {
            const markdown = engine.brief();
            return ok({ markdown }, markdown);
          }
          case "list": {
            const { items } = engine.overview();
            return ok(items, items.length === 0 ? "The backlog is empty." : items.map(formatItem).join("\n"));
          }
          case "decisions": {
            const { decisions } = engine.overview();
            return ok(decisions, decisions.length === 0 ? "Nothing waits on you." : decisions.map(formatDecision).join("\n"));
          }
          case "add": {
            const [projectId, ...rest] = args;
            const text = rest.join(" ").replace(/\\n/g, "\n").trim();
            if (projectId === undefined || text === "") break;
            const added = await engine.addBacklog(text, projectId);
            return ok(added, added.map(formatItem).join("\n"));
          }
          case "decide": {
            const [id, ...rest] = args;
            const answer = rest.join(" ").trim();
            if (id === undefined || !/^\d+$/.test(id.replace(/^Q/i, "")) || answer === "") break;
            await engine.decide(Number(id.replace(/^Q/i, "")), answer);
            return ok({ ok: true }, `Sent your decision on Q${id.replace(/^Q/i, "")}.`);
          }
          case "pause":
          case "resume":
            await engine.setPaused(command === "pause");
            return ok({ paused: command === "pause" }, command === "pause" ? "Paused." : "Resumed.");
        }
      } catch (cause) {
        return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
      }
      return { exitCode: 1, stderr: USAGE };
    },
  });
}

