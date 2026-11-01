// How big a thread's context is: the tokens every model call re-reads. sandy
// reports it many times a turn; a large one is what makes cache reads run away.

export const CONTEXT_EVENT = "thread/contextWindowUsage/updated";

/** The fields of a context window event this module reads. */
export interface ContextEventLike {
  id: string;
  createdAt: number;
  type: string;
  data: unknown;
}

export interface ContextRow {
  eventId: string;
  createdAt: number;
  usedTokens: number;
  /** The model's context window, when the provider reports it. */
  contextWindow: number | null;
  /** Where the provider compacts on its own, when it says. */
  autoCompactAt: number | null;
}

interface ContextPayload {
  contextWindowUsage?: {
    usedTokens?: number | null;
    modelContextWindow?: number | null;
    snapshot?: { autoCompactAtTokens?: number | null } | null;
  };
}

/**
 * The ledger row for one context event, or null when it carries no size.
 * Claude Code sends one with no size straight after compacting, before the
 * new size is known.
 */
export function contextRowOf(event: ContextEventLike): ContextRow | null {
  if (event.type !== CONTEXT_EVENT) return null;
  const usage = (event.data as ContextPayload | null)?.contextWindowUsage;
  const used = usage?.usedTokens;
  if (typeof used !== "number" || used < 0) return null;
  return {
    eventId: event.id,
    createdAt: event.createdAt,
    usedTokens: used,
    contextWindow: usage?.modelContextWindow ?? null,
    autoCompactAt: usage?.snapshot?.autoCompactAtTokens ?? null,
  };
}

/** Where a thread's context earns a warning, and where an error; null turns a level off. */
export interface ContextThresholds {
  warning: number | null;
  error: number | null;
}

export type ContextLevel = "warning" | "error";

/** How a context of `usedTokens` rates against the thresholds, or null below both. */
export function contextLevel(usedTokens: number, thresholds: ContextThresholds): ContextLevel | null {
  if (thresholds.error !== null && usedTokens >= thresholds.error) return "error";
  if (thresholds.warning !== null && usedTokens >= thresholds.warning) return "warning";
  return null;
}

/** How many of the contexts are past the warning but not the error, and how many are past the error. */
export function countLevels(contexts: Iterable<number>, thresholds: ContextThresholds): Record<ContextLevel, number> {
  const counts = { warning: 0, error: 0 };
  for (const usedTokens of contexts) {
    const level = contextLevel(usedTokens, thresholds);
    if (level !== null) counts[level] += 1;
  }
  return counts;
}

/** A setting's value as a token count, or null when it is off. */
export function parseThreshold(value: string): number | null {
  const match = /^\s*([\d.,_]+)\s*([km]?)\s*$/i.exec(value);
  if (match === null) return null;
  const number = Number(match[1]!.replace(/[,_]/g, ""));
  if (!Number.isFinite(number) || number <= 0) return null;
  const unit = match[2]!.toLowerCase();
  return Math.round(number * (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1));
}
