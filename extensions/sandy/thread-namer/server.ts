// sandy-plugin-thread-namer — backend entry.
//
// Names threads with an agent: automatically once a thread's first turn has
// finished, and on demand from the button this plugin adds to the thread
// header. The naming run itself happens in a throwaway hidden thread so the
// conversation being named is left untouched.
import { defineRpcContract, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import {
  REASONING_LEVELS,
  stripModelBrandPrefix,
  type AgentSelection,
  type ModelChoice,
  type ReasoningLevel,
} from "./lib/models";
import {
  isNameable,
  shouldAutoRename,
  type NamingMode,
  type NamingRecord,
  type ThreadFacts,
} from "./lib/policy";
import {
  DEFAULT_INSTRUCTION,
  buildNamingPrompt,
  cleanTitle,
  type OutlineItem,
} from "./lib/title";

export { DEFAULT_INSTRUCTION };

/** kv key holding the chosen agent; absent means the thread's own agent. */
const SELECTION_KEY = "agent-selection";

/** kv key holding the last discovered model catalogue. */
const CATALOG_KEY = "model-catalog";

/** kv prefix under which a name this plugin wrote is remembered. */
const RECORD_PREFIX = "named:";

/** Realtime channel telling open pickers that the catalogue moved. */
const CATALOG_CHANNEL = "catalog";

/** Realtime channel announcing a thread's new name. */
const RENAMED_CHANNEL = "renamed";

/** How long a stored catalogue is served before it is refreshed. */
const CATALOG_TTL_MS = 10 * 60_000;

const MODE_OPTIONS: Record<string, NamingMode> = {
  "Name a thread once, after its first reply": "once",
  "Keep the name up to date as the thread grows": "always",
  "Never name threads automatically": "off",
};
const DEFAULT_MODE_OPTION = "Name a thread once, after its first reply";

const LENGTH_OPTIONS: Record<string, number> = {
  "Short — up to 32 characters": 32,
  "Medium — up to 48 characters": 48,
  "Long — up to 72 characters": 72,
};
const DEFAULT_LENGTH_OPTION = "Medium — up to 48 characters";

const TIMEOUT_OPTIONS: Record<string, number> = {
  "30 seconds": 30_000,
  "1 minute": 60_000,
  "2 minutes": 120_000,
};
const DEFAULT_TIMEOUT_OPTION = "1 minute";

type PermissionMode = "auto" | "accept-edits" | "full";

/** Least to most privileged; the first one a provider supports is used. */
const PERMISSION_MODE_PREFERENCE: readonly PermissionMode[] = [
  "auto",
  "accept-edits",
  "full",
];

const reasoningLevelSchema = z.enum(REASONING_LEVELS);

function isReasoningLevel(value: string | null | undefined): value is ReasoningLevel {
  return reasoningLevelSchema.safeParse(value).success;
}

const agentSelectionSchema: z.ZodType<AgentSelection, AgentSelection> = z.object(
  {
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: reasoningLevelSchema.nullable(),
  },
);

const modelChoiceSchema: z.ZodType<ModelChoice, ModelChoice> = z.object({
  providerId: z.string(),
  providerName: z.string(),
  model: z.string(),
  label: z.string(),
  description: z.string(),
  reasoning: z.array(
    z.object({ level: reasoningLevelSchema, description: z.string() }),
  ),
  defaultReasoningLevel: reasoningLevelSchema,
  extra: z.boolean(),
});

export const rpcContract = defineRpcContract({
  /** Name a thread now, whatever the automatic mode is set to. */
  rename: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.union([
      z.object({ ok: z.literal(true), title: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  catalog: {
    input: z.object({ refresh: z.boolean() }).strict(),
    output: z.object({
      selection: agentSelectionSchema.nullable(),
      choices: z.array(modelChoiceSchema),
      /** Agents that reported no catalogue, by display name. */
      unavailable: z.array(z.string()),
      /** Agents still being asked, by display name. */
      pending: z.array(z.string()),
      discovering: z.boolean(),
    }),
  },
  selectAgent: {
    input: z.object({ selection: agentSelectionSchema.nullable() }).strict(),
    output: z.object({ selection: agentSelectionSchema.nullable() }),
  },
});

/** Answer of the `rename` method: the new title, or why there is none. */
export type RenameResult =
  | { ok: true; title: string }
  | { ok: false; error: string };

/** Where and with which agent a naming run should happen. */
interface NamingTarget {
  projectId: string;
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  environmentId: string | null;
}

export default function plugin(sandy: SandyPluginApi) {
  const settings = sandy.settings.define({
    mode: {
      type: "select",
      label: "Automatic naming",
      description:
        "When threads are named on their own. A name you typed yourself is never overwritten.",
      options: Object.keys(MODE_OPTIONS),
      default: DEFAULT_MODE_OPTION,
    },
    length: {
      type: "select",
      label: "Name length",
      description: "How long a generated name may be.",
      options: Object.keys(LENGTH_OPTIONS),
      default: DEFAULT_LENGTH_OPTION,
    },
    instruction: {
      type: "string",
      label: "Naming instruction",
      description:
        "Instruction sent to the agent together with the conversation. Clear it to restore the built-in instruction.",
      default: DEFAULT_INSTRUCTION,
    },
    timeout: {
      type: "select",
      label: "Timeout",
      description: "How long to wait for the agent before giving up.",
      options: Object.keys(TIMEOUT_OPTIONS),
      default: DEFAULT_TIMEOUT_OPTION,
    },
  });

  const catalog = createCatalogCache(sandy);
  /** Threads being named right now, so two triggers cannot race on one name. */
  const inFlight = new Set<string>();

  /**
   * Name one thread and write the title back.
   *
   * `force` skips the eagerness rules — it is what the header button and the
   * CLI do — but not the rules about which threads may be named at all.
   */
  async function nameThread(
    threadId: string,
    force: boolean,
  ): Promise<RenameResult> {
    if (inFlight.has(threadId)) {
      return { ok: false, error: "This thread is already being named." };
    }
    inFlight.add(threadId);
    try {
      const { mode, length, instruction, timeout } = await settings.get();
      const namingMode = MODE_OPTIONS[mode] ?? "once";
      const maxChars = LENGTH_OPTIONS[length] ?? LENGTH_OPTIONS[DEFAULT_LENGTH_OPTION]!;
      const timeoutMs =
        TIMEOUT_OPTIONS[timeout] ?? TIMEOUT_OPTIONS[DEFAULT_TIMEOUT_OPTION]!;

      const thread = await sandy.sdk.threads.get({ threadId });
      const facts = toFacts(thread);

      const outline = await sandy.sdk.threads
        .conversationOutline({ threadId })
        .catch(() => ({ items: [], maxSeq: 0 }));

      const record =
        (await sandy.storage.kv.get<NamingRecord>(`${RECORD_PREFIX}${threadId}`)) ??
        null;
      const decision = force
        ? isNameable(facts, sandy.pluginId)
        : shouldAutoRename(
            facts,
            record,
            namingMode,
            sandy.pluginId,
            outline.maxSeq,
          );
      if (!decision.rename) {
        return { ok: false, error: `Not naming this thread: ${decision.reason}.` };
      }

      const items: OutlineItem[] = outline.items.map((item) => ({
        role: item.role,
        preview: item.preview,
      }));
      if (items.every((item) => item.preview.trim() === "")) {
        return { ok: false, error: "This thread has nothing to name yet." };
      }

      const selection =
        (await sandy.storage.kv.get<AgentSelection>(SELECTION_KEY)) ?? null;
      const target = await resolveTarget(sandy, thread, selection);
      const prompt = buildNamingPrompt(
        instruction.trim() || DEFAULT_INSTRUCTION,
        items,
        maxChars,
      );

      const output = await runNamingThread(sandy, target, prompt, timeoutMs);
      const title = cleanTitle(output ?? "", maxChars);
      if (title === "") {
        return { ok: false, error: "The agent returned an empty name." };
      }

      await sandy.sdk.threads.update({ threadId, title });
      await sandy.storage.kv.set(`${RECORD_PREFIX}${threadId}`, {
        title,
        at: Date.now(),
        maxSeq: outline.maxSeq,
      });
      sandy.realtime.publish(RENAMED_CHANNEL, { threadId, title });
      sandy.log.info(`named ${threadId}: ${title}`);
      return { ok: true, title };
    } catch (error) {
      const message = describeError(error);
      sandy.log.warn(`could not name ${threadId}: ${message}`);
      return { ok: false, error: message };
    } finally {
      inFlight.delete(threadId);
    }
  }

  sandy.rpc.register(rpcContract, {
    rename: ({ threadId }) => nameThread(threadId, true),

    async catalog({ refresh }) {
      const snapshot = await catalog.read(refresh);
      return {
        selection:
          (await sandy.storage.kv.get<AgentSelection>(SELECTION_KEY)) ?? null,
        ...snapshot,
      };
    },

    async selectAgent({ selection }) {
      if (selection === null) {
        await sandy.storage.kv.delete(SELECTION_KEY);
      } else {
        await sandy.storage.kv.set(SELECTION_KEY, selection);
      }
      return { selection };
    },
  });

  // A thread reaches `idle` when its turn is over, which is the first moment
  // there is a conversation worth naming. Handlers are fire-and-forget, so the
  // naming run never delays the thread it names.
  sandy.events.on("thread.idle", ({ thread }) => {
    // The naming worker is a thread too, so it reaches idle as well. Rule the
    // obvious cases out from the payload rather than reading state back for
    // every turn in sandy; `nameThread` re-checks against fresh state anyway.
    const nameable = isNameable(toFacts(thread), sandy.pluginId);
    if (!nameable.rename) return;
    void nameThread(thread.id, false).then((result) => {
      if (!result.ok) sandy.log.debug(`${thread.id}: ${result.error}`);
    });
  });

  // A deleted thread's remembered name is dead weight in kv.
  sandy.events.on("thread.deleted", ({ thread }) => {
    void sandy.storage.kv.delete(`${RECORD_PREFIX}${thread.id}`).catch(() => {});
  });

  sandy.cli.register({
    name: "thread-namer",
    summary: "Name sandy threads with an agent",
    commands: [
      {
        name: "rename",
        summary:
          "Name a thread now, ignoring the automatic-naming setting. Defaults to the calling thread.",
        usage: "sandy thread-namer rename [<threadId>]",
      },
      {
        name: "status",
        summary: "Show how naming is configured and which agent it uses.",
        usage: "sandy thread-namer status",
      },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      if (command === "rename") {
        const threadId = rest[0] ?? ctx.threadId;
        if (threadId === undefined) {
          return {
            exitCode: 2,
            stderr:
              "No thread to name. Pass a thread id: sandy thread-namer rename <threadId>\n",
          };
        }
        const result = await nameThread(threadId, true);
        return result.ok
          ? { exitCode: 0, stdout: `${result.title}\n` }
          : { exitCode: 1, stderr: `${result.error}\n` };
      }

      if (command === "status" || command === undefined) {
        const { mode, length, timeout } = await settings.get();
        const selection =
          (await sandy.storage.kv.get<AgentSelection>(SELECTION_KEY)) ?? null;
        const agent =
          selection === null
            ? "the thread's own agent"
            : `${selection.providerId} / ${selection.model}${
                selection.reasoningLevel === null
                  ? ""
                  : ` (${selection.reasoningLevel})`
              }`;
        return {
          exitCode: 0,
          stdout: [
            `Automatic naming: ${mode}`,
            `Name length:      ${length}`,
            `Timeout:          ${timeout}`,
            `Agent:            ${agent}`,
            "",
          ].join("\n"),
        };
      }

      return {
        exitCode: 2,
        stderr: `Unknown command "${command}". Try: rename, status\n`,
      };
    },
  });
}

/** The thread fields the naming rules look at. */
function toFacts(thread: {
  title: string | null;
  visibility: "visible" | "hidden";
  parentThreadId: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  originPluginId: string | null;
}): ThreadFacts {
  return {
    title: thread.title,
    visibility: thread.visibility,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
    originPluginId: thread.originPluginId,
  };
}

/**
 * Resolve the agent a naming run uses: the picked one, or — by default — the
 * model and harness the named thread's own prompts run on.
 */
async function resolveTarget(
  sandy: SandyPluginApi,
  thread: { id: string; projectId: string; environmentId: string | null; providerId: string },
  selection: AgentSelection | null,
): Promise<NamingTarget> {
  const base = { projectId: thread.projectId, environmentId: thread.environmentId };
  if (selection !== null) {
    return {
      ...base,
      providerId: selection.providerId,
      model: selection.model,
      ...(selection.reasoningLevel === null
        ? {}
        : { reasoningLevel: selection.reasoningLevel }),
    };
  }

  // The thread's resolved execution options are what its prompts last ran
  // with — the "same model and harness" default.
  const execution = await sandy.sdk.threads
    .defaultExecutionOptions({ threadId: thread.id })
    .catch(() => null);
  return {
    ...base,
    providerId: thread.providerId,
    ...(execution === null
      ? {}
      : {
          model: execution.model,
          ...(isReasoningLevel(execution.reasoningLevel)
            ? { reasoningLevel: execution.reasoningLevel }
            : {}),
        }),
  };
}

/**
 * The most restrictive permission mode the target agent supports. Naming a
 * thread needs no tools at all, and providers reject a mode they do not
 * implement, so the mode is narrowed per provider instead of hardcoded.
 */
async function restrictedPermissionMode(
  sandy: SandyPluginApi,
  providerId: string | undefined,
): Promise<PermissionMode | null> {
  if (providerId === undefined) return null;
  const providers = await sandy.sdk.providers.list().catch(() => []);
  const supported = providers.find((provider) => provider.id === providerId)
    ?.capabilities.permissionModes;
  if (supported === undefined) return null;
  return (
    PERMISSION_MODE_PREFERENCE.find((mode) => supported.includes(mode)) ?? null
  );
}

/**
 * Run the naming prompt in a hidden thread and return its answer. The thread is
 * stopped and dropped on every path so naming never leaves an agent runtime or
 * a stray thread behind.
 */
async function runNamingThread(
  sandy: SandyPluginApi,
  target: NamingTarget,
  prompt: string,
  timeoutMs: number,
): Promise<string | null> {
  const permissionMode = await restrictedPermissionMode(sandy, target.providerId);
  const worker = await sandy.sdk.threads.spawn({
    projectId: target.projectId,
    // Reuse the named thread's environment: a name needs no worktree of its own.
    environment:
      target.environmentId === null
        ? { type: "project-default" }
        : { type: "reuse", environmentId: target.environmentId },
    prompt,
    title: "Name thread",
    visibility: "hidden",
    ...(target.providerId ? { providerId: target.providerId } : {}),
    ...(target.model ? { model: target.model } : {}),
    ...(target.reasoningLevel ? { reasoningLevel: target.reasoningLevel } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    // Without provenance the server drops a requested provider/model and
    // re-derives both from the project defaults.
    executionInputSources: {
      ...(target.providerId ? { providerId: "explicit" as const } : {}),
      ...(target.model ? { model: "explicit" as const } : {}),
      ...(target.reasoningLevel ? { reasoningLevel: "explicit" as const } : {}),
      ...(permissionMode ? { permissionMode: "explicit" as const } : {}),
    },
  });

  try {
    // `turn/completed` is matched from the thread's first event, so this is
    // safe whether the turn finishes before or after the wait starts.
    let completed;
    try {
      completed = await sandy.sdk.threads.wait({
        threadId: worker.id,
        event: "turn/completed",
        timeoutMs,
      });
    } catch (error) {
      const state = await sandy.sdk.threads
        .get({ threadId: worker.id })
        .catch(() => null);
      throw state?.status === "error"
        ? new Error("The agent stopped with an error.")
        : new Error(
            `The agent did not answer within ${Math.round(timeoutMs / 1000)}s (${describeError(error)}).`,
          );
    }

    // The turn can complete without answering — a provider that fails or is
    // interrupted says so here, and its message beats an empty answer.
    const event = "event" in completed ? completed.event : null;
    if (event?.type === "turn/completed" && event.data.status !== "completed") {
      const detail = event.data.error?.message;
      throw new Error(
        detail !== undefined
          ? `The agent failed: ${detail}`
          : event.data.status === "interrupted"
            ? "The agent was interrupted."
            : "The agent stopped without answering.",
      );
    }

    const { output } = await sandy.sdk.threads.output({ threadId: worker.id });
    return output;
  } finally {
    // Release the agent runtime first, then drop the throwaway thread so a
    // busy day of naming does not leave a trail of hidden threads behind.
    await sandy.sdk.threads
      .stop({ threadId: worker.id })
      .catch((error: unknown) =>
        sandy.log.warn(`could not stop ${worker.id}: ${describeError(error)}`),
      );
    await sandy.sdk.threads
      .delete({ threadId: worker.id, childThreadsConfirmed: true })
      .catch(async (error: unknown) => {
        sandy.log.warn(`could not delete ${worker.id}: ${describeError(error)}`);
        await sandy.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
      });
  }
}

/** What the picker knows right now; also what is cached between reloads. */
interface CatalogSnapshot {
  choices: ModelChoice[];
  unavailable: string[];
  pending: string[];
  at: number;
}

/**
 * The model catalogue, cached and filled in as it arrives.
 *
 * Asking an agent for its models can mean launching its CLI, so: the last
 * catalogue is kept in kv and served immediately, a stale one is refreshed in
 * the background, and every partial result is published so the picker fills in
 * while discovery is still running.
 */
function createCatalogCache(sandy: SandyPluginApi) {
  let snapshot: CatalogSnapshot | null = null;
  let discovery: Promise<void> | null = null;
  /** Readers waiting for the next snapshot, so a cold read can answer early. */
  let waiting: (() => void)[] = [];

  function wake() {
    const woken = waiting;
    waiting = [];
    for (const resolve of woken) resolve();
  }

  async function publish(next: CatalogSnapshot) {
    snapshot = next;
    wake();
    try {
      await sandy.storage.kv.set(CATALOG_KEY, next);
      sandy.realtime.publish(CATALOG_CHANNEL, { pending: next.pending.length });
    } catch (error) {
      // A reload can invalidate the api handle mid-discovery, and the kv row
      // is only a cache: keep the in-memory snapshot and move on.
      sandy.log.debug(`could not store the catalogue: ${describeError(error)}`);
    }
  }

  function discover(): Promise<void> {
    discovery ??= runDiscovery(sandy, () => snapshot, publish).finally(() => {
      discovery = null;
      wake();
    });
    return discovery;
  }

  return {
    async read(
      refresh: boolean,
    ): Promise<Omit<CatalogSnapshot, "at"> & { discovering: boolean }> {
      snapshot ??= (await sandy.storage.kv.get<CatalogSnapshot>(CATALOG_KEY)) ?? null;
      const stale =
        snapshot === null || Date.now() - snapshot.at > CATALOG_TTL_MS;
      if (refresh || stale) {
        const round = discover();
        round.catch((error: unknown) =>
          sandy.log.warn(`model discovery failed: ${describeError(error)}`),
        );
        // With nothing cached, answer as soon as discovery knows which agents
        // it is asking; their models then arrive over the realtime channel.
        if (snapshot === null) {
          await Promise.race([
            new Promise<void>((resolve) => waiting.push(resolve)),
            round,
          ]);
        }
      }
      if (snapshot === null) {
        throw new Error("No agent reported any models.");
      }
      return {
        choices: snapshot.choices,
        unavailable: snapshot.unavailable,
        pending: snapshot.pending,
        discovering: discovery !== null,
      };
    },
  };
}

/**
 * Ask every signed-in agent for its models in parallel, publishing after each
 * answer. A catalogue that is already on screen is kept until the round
 * finishes, so a background refresh never blanks the list.
 */
async function runDiscovery(
  sandy: SandyPluginApi,
  current: () => CatalogSnapshot | null,
  publish: (next: CatalogSnapshot) => Promise<void>,
): Promise<void> {
  const providers = (await sandy.sdk.providers.list()).filter(
    (provider) => provider.available,
  );
  const previous = current()?.choices ?? [];
  const answered = new Map<string, ModelChoice[]>();
  const unavailable: string[] = [];
  let pending = providers.map((provider) => provider.displayName);

  const publishRound = () => {
    const collected = providers.flatMap(
      (provider) => answered.get(provider.id) ?? [],
    );
    return publish({
      choices: previous.length > 0 && pending.length > 0 ? previous : collected,
      unavailable: [...unavailable],
      pending: [...pending],
      at: Date.now(),
    });
  };

  await publishRound();
  await Promise.all(
    providers.map(async (provider) => {
      const choices = await providerChoices(sandy, provider);
      if (choices === null) unavailable.push(provider.displayName);
      else answered.set(provider.id, choices);
      pending = pending.filter((name) => name !== provider.displayName);
      await publishRound();
    }),
  );
}

/** One agent's models, or null when it has no catalogue to report. */
async function providerChoices(
  sandy: SandyPluginApi,
  provider: { id: string; displayName: string },
): Promise<ModelChoice[] | null> {
  let options;
  try {
    options = await sandy.sdk.providers.models({ providerId: provider.id });
  } catch (error) {
    sandy.log.debug(`no models for ${provider.id}: ${describeError(error)}`);
    return null;
  }
  // An agent whose CLI is missing or unauthenticated reports its failure
  // instead of a catalogue; name it rather than dropping it silently.
  if (options.modelLoadError !== null) return null;

  const toChoice = (
    entry: {
      model: string;
      displayName: string;
      description: string;
      supportedReasoningEfforts: readonly {
        reasoningEffort: string;
        description: string;
      }[];
      defaultReasoningEffort: string;
    },
    extra: boolean,
  ): ModelChoice => ({
    providerId: provider.id,
    providerName: provider.displayName,
    model: entry.model,
    label: stripModelBrandPrefix(entry.displayName, provider.id),
    // Descriptions are one-liners in the picker, and the whole catalogue has
    // to fit the 256KB kv row.
    description: entry.description.slice(0, 160),
    // Efforts this plugin has no label for are left out of the picker.
    reasoning: entry.supportedReasoningEfforts.flatMap((effort) =>
      isReasoningLevel(effort.reasoningEffort)
        ? [{ level: effort.reasoningEffort, description: effort.description.slice(0, 120) }]
        : [],
    ),
    defaultReasoningLevel: isReasoningLevel(entry.defaultReasoningEffort)
      ? entry.defaultReasoningEffort
      : "medium",
    extra,
  });
  const choices = options.models.map((entry) => toChoice(entry, false));
  for (const entry of options.selectedOnlyModels) {
    if (options.models.some((listed) => listed.model === entry.model)) continue;
    choices.push(toChoice(entry, true));
  }
  return choices;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
