// When each turn ran, which tools it waited on, and when it waited on you.
// sandy records a start and an end for every turn, every item inside one, and
// every question the agent asks you; this reads them into rows. Pure.

/** The events this module reads, listed alongside the usage events. */
export const TIMING_EVENTS = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "system/interaction/lifecycle",
] as const;

/**
 * Items that are the model working rather than a tool it waits on. A turn's
 * time outside tools and waits is the model's.
 */
const MODEL_ITEMS = new Set(["reasoning", "agentMessage", "userMessage", "plan"]);

/** Labels are kept for grouping slow commands, not for reading in full. */
const MAX_LABEL = 300;

export interface TimingEventLike {
  createdAt: number;
  type: string;
  scope?: { kind: string; turnId?: string } | null;
  data: unknown;
}

export interface TurnTime {
  turnId: string;
  startedAt: number | null;
  completedAt: number | null;
}

export interface ItemTime {
  itemId: string;
  turnId: string | null;
  kind: string;
  /** The command for a shell command, the tool's name for a tool call, the title otherwise. */
  label: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface WaitTime {
  interactionId: string;
  turnId: string | null;
  kind: string;
  startedAt: number;
  resolvedAt: number | null;
}

export interface TimingRows {
  turns: TurnTime[];
  items: ItemTime[];
  waits: WaitTime[];
}

interface ItemPayload {
  item?: {
    id?: string;
    type?: string;
    command?: string | string[];
    tool?: string;
    label?: string;
    background?: boolean;
    presentation?: { title?: string };
  };
}

interface InteractionPayload {
  interaction?: { id?: string; status?: string; payload?: { kind?: string } };
}

const RESOLVED = new Set(["resolved", "cancelled", "canceled", "expired", "failed"]);

function labelOf(item: NonNullable<ItemPayload["item"]>): string | null {
  const raw =
    item.type === "commandExecution"
      ? Array.isArray(item.command)
        ? item.command.join(" ")
        : item.command
      : item.type === "toolCall"
        ? item.tool
        : (item.presentation?.title ?? item.label);
  return typeof raw === "string" && raw !== "" ? raw.slice(0, MAX_LABEL) : null;
}

export function timingRowsOf(events: readonly TimingEventLike[]): TimingRows {
  const turns: TurnTime[] = [];
  const items: ItemTime[] = [];
  const waits: WaitTime[] = [];
  for (const event of events) {
    const turnId = event.scope?.turnId ?? null;
    if (event.type === "turn/started" || event.type === "turn/completed") {
      if (turnId === null) continue;
      const started = event.type === "turn/started";
      turns.push({ turnId, startedAt: started ? event.createdAt : null, completedAt: started ? null : event.createdAt });
    } else if (event.type === "item/started" || event.type === "item/completed") {
      const item = (event.data as ItemPayload | null)?.item;
      if (item?.id === undefined || item.type === undefined) continue;
      // A background task or subagent runs alongside the turn rather than holding it up.
      if (MODEL_ITEMS.has(item.type) || item.type === "backgroundTask" || item.background === true) continue;
      const started = event.type === "item/started";
      items.push({
        itemId: item.id,
        turnId,
        kind: item.type,
        label: labelOf(item),
        startedAt: started ? event.createdAt : null,
        completedAt: started ? null : event.createdAt,
      });
    } else if (event.type === "system/interaction/lifecycle") {
      const interaction = (event.data as InteractionPayload | null)?.interaction;
      if (interaction?.id === undefined) continue;
      waits.push({
        interactionId: interaction.id,
        turnId,
        kind: interaction.payload?.kind ?? "unknown",
        startedAt: event.createdAt,
        resolvedAt: RESOLVED.has(interaction.status ?? "") ? event.createdAt : null,
      });
    }
  }
  return { turns, items, waits };
}

export function isEmpty(rows: TimingRows): boolean {
  return rows.turns.length === 0 && rows.items.length === 0 && rows.waits.length === 0;
}

/** Where one turn's time went, in milliseconds. */
export interface TurnSplit {
  /** Thinking and writing: the turn's time outside tools and waits. */
  model: number;
  /** Waiting on shell commands, tool calls, and file reads. */
  tools: number;
  /** Waiting on you to answer a question. */
  waiting: number;
}

type Span = [number, number];

/** Total length of the spans, counting overlaps once. */
function covered(spans: readonly Span[]): number {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [start, stop] of sorted) {
    if (stop <= end) continue;
    total += stop - Math.max(start, end);
    end = stop;
  }
  return total;
}

interface TurnSpans {
  bounds: Map<string, Span>;
  /** Each turn's tool spans, clipped to the turn, with the item's kind. */
  tools: Map<string, Array<{ kind: string; span: Span }>>;
  waits: Map<string, Span[]>;
}

/**
 * Spans are clipped to the turn, and a tool still open when the turn ended
 * counts to its end.
 */
function turnSpans(timings: TimingRows): TurnSpans {
  const bounds = new Map(
    timings.turns
      .filter((turn) => turn.startedAt !== null && turn.completedAt !== null && turn.completedAt >= turn.startedAt)
      .map((turn) => [turn.turnId, [turn.startedAt!, turn.completedAt!] as Span]),
  );
  const clip = (turnId: string | null, start: number | null, end: number | null): Span | null => {
    if (turnId === null || start === null) return null;
    const turn = bounds.get(turnId);
    if (turn === undefined) return null;
    const clipped: Span = [Math.max(start, turn[0]), Math.min(end ?? turn[1], turn[1])];
    return clipped[1] > clipped[0] ? clipped : null;
  };
  const tools = new Map<string, Array<{ kind: string; span: Span }>>();
  const waits = new Map<string, Span[]>();
  for (const item of timings.items) {
    const span = clip(item.turnId, item.startedAt, item.completedAt);
    if (span !== null) tools.set(item.turnId!, [...(tools.get(item.turnId!) ?? []), { kind: item.kind, span }]);
  }
  for (const wait of timings.waits) {
    const span = clip(wait.turnId, wait.startedAt, wait.resolvedAt);
    if (span !== null) waits.set(wait.turnId!, [...(waits.get(wait.turnId!) ?? []), span]);
  }
  return { bounds, tools, waits };
}

function splitOf([start, end]: Span, tools: ReadonlyArray<{ span: Span }>, waits: readonly Span[]): TurnSplit {
  const waiting = covered(waits);
  const busy = covered([...tools.map((tool) => tool.span), ...waits]);
  return { model: Math.max(0, end - start - busy), tools: busy - waiting, waiting };
}

/**
 * Each finished turn's split into model, tools, and waiting on you. Asking
 * you a question is itself a tool call, so time covered by both a question
 * and a tool counts as waiting.
 */
export function turnSplits(timings: TimingRows): Map<string, TurnSplit> {
  const { bounds, tools, waits } = turnSpans(timings);
  const splits = new Map<string, TurnSplit>();
  for (const [turnId, span] of bounds) {
    splits.set(turnId, splitOf(span, tools.get(turnId) ?? [], waits.get(turnId) ?? []));
  }
  return splits;
}

/** Turn lengths the breakdown groups by: under 1 minute, 1 to 5, 5 to 15, and longer. */
export const LENGTH_EDGES = [60_000, 300_000, 900_000] as const;

export interface TimeBreakdown {
  turns: number;
  split: TurnSplit;
  /**
   * Time in each kind of tool, outside waits on you, and how many there were.
   * Tools of different kinds can run at once, so these can add up to more
   * than the split's tools.
   */
  kinds: Array<{ kind: string; ms: number; count: number }>;
  /** Questions the agent asked you. */
  questions: number;
  /** Turns by length, one entry per LENGTH_EDGES bucket and one past the last. */
  lengths: Array<{ turns: number; split: TurnSplit }>;
}

const addSplit = (a: TurnSplit, b: TurnSplit): TurnSplit => ({
  model: a.model + b.model,
  tools: a.tools + b.tools,
  waiting: a.waiting + b.waiting,
});

const NO_TIME: TurnSplit = { model: 0, tools: 0, waiting: 0 };

/** Where the finished turns' time went, in total, by kind of tool, and by turn length. */
export function timeBreakdown(timings: TimingRows): TimeBreakdown {
  const { bounds, tools, waits } = turnSpans(timings);
  let split = NO_TIME;
  let questions = 0;
  const kinds = new Map<string, { ms: number; count: number }>();
  const lengths = [...LENGTH_EDGES, Infinity].map(() => ({ turns: 0, split: NO_TIME }));
  for (const [turnId, span] of bounds) {
    const turnTools = tools.get(turnId) ?? [];
    const turnWaits = waits.get(turnId) ?? [];
    const turnSplit = splitOf(span, turnTools, turnWaits);
    split = addSplit(split, turnSplit);
    questions += turnWaits.length;
    const length = lengths[[...LENGTH_EDGES, Infinity].findIndex((edge) => span[1] - span[0] < edge)]!;
    length.turns += 1;
    length.split = addSplit(length.split, turnSplit);
    const waited = covered(turnWaits);
    for (const kind of new Set(turnTools.map((tool) => tool.kind))) {
      const spans = turnTools.filter((tool) => tool.kind === kind).map((tool) => tool.span);
      const entry = kinds.get(kind) ?? { ms: 0, count: 0 };
      entry.ms += covered([...spans, ...turnWaits]) - waited;
      entry.count += spans.length;
      kinds.set(kind, entry);
    }
  }
  return {
    turns: bounds.size,
    split,
    kinds: [...kinds].map(([kind, entry]) => ({ kind, ...entry })).sort((a, b) => b.ms - a.ms),
    questions,
    lengths,
  };
}
