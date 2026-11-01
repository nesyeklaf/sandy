// Which message led to which usage. Pure: the inputs are sandy's turn events and
// conversation outline, already fetched, and the ledger's rows.
//
// The ledger's rows carry no turn id, and sandy deletes the usage events that
// had one. sandy keeps every turn's start and end, though, so a row belongs to
// the latest turn that started at or before it was recorded.
import { addTokens, ZERO_TOKENS, type Tokens } from "./breakdown.js";

export interface TurnEvent {
  turnId: string;
  at: number;
}

export interface OutlineItem {
  id: string;
  role: "user" | "assistant";
  preview: string;
  attachmentSummary?: { fileCount: number; imageCount: number } | null;
}

export interface UsagePoint extends Tokens {
  at: number;
}

export interface TurnDetail extends Tokens {
  turnId: string | null;
  startedAt: number;
  /** Null while the turn is still running. */
  endedAt: number | null;
  /** When its usage was recorded; the last row's time when there were several. */
  usageAt: number;
  /** The start of the message that began the turn, or null when sandy has none. */
  prompt: string | null;
}

/** sandy's assistant outline ids name their turn: `...|turn:<id>|...`. */
function turnIdOfOutline(id: string): string | null {
  return /\|turn:([^|]+)\|/.exec(id)?.[1] ?? null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The message's text, or what it attached when it has none: "1 image". */
function messageLabel(item: OutlineItem): string | null {
  const text = item.preview.trim();
  if (text !== "") return text;
  const summary = item.attachmentSummary;
  if (summary === null || summary === undefined) return null;
  const parts = [
    summary.imageCount > 0 ? plural(summary.imageCount, "image") : null,
    summary.fileCount > 0 ? plural(summary.fileCount, "file") : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" and ");
}

/**
 * Each turn's opening message. The outline lists your message, then the
 * assistant's items for the turn it started, so a turn takes the last user
 * preview before its first assistant item.
 */
export function promptsByTurn(items: readonly OutlineItem[]): Map<string, string> {
  const prompts = new Map<string, string>();
  let pending: string | null = null;
  for (const item of items) {
    if (item.role === "user") {
      pending = messageLabel(item);
      continue;
    }
    const turnId = turnIdOfOutline(item.id);
    if (turnId === null || prompts.has(turnId)) continue;
    if (pending !== null) prompts.set(turnId, pending);
    pending = null;
  }
  return prompts;
}

/**
 * Every usage row assigned to a turn, one entry per turn that used tokens,
 * oldest first. Rows recorded before the first known turn start are grouped
 * into one entry with no turn id.
 */
export function attributeUsage(
  rows: readonly UsagePoint[],
  started: readonly TurnEvent[],
  completed: readonly TurnEvent[],
  prompts: ReadonlyMap<string, string>,
): TurnDetail[] {
  const turns = [...started].sort((a, b) => a.at - b.at);
  const ends = new Map(completed.map((event) => [event.turnId, event.at]));
  const byTurn = new Map<string, TurnDetail>();
  let orphan: TurnDetail | null = null;

  for (const row of [...rows].sort((a, b) => a.at - b.at)) {
    let owner: TurnEvent | undefined;
    for (const turn of turns) {
      if (turn.at > row.at) break;
      owner = turn;
    }
    const tokens = { input: row.input, cacheRead: row.cacheRead, output: row.output };
    if (owner === undefined) {
      orphan ??= { turnId: null, startedAt: row.at, endedAt: row.at, usageAt: row.at, prompt: null, ...ZERO_TOKENS };
      Object.assign(orphan, addTokens(orphan, tokens), { usageAt: row.at, endedAt: row.at });
      continue;
    }
    const detail = byTurn.get(owner.turnId) ?? {
      turnId: owner.turnId,
      startedAt: owner.at,
      endedAt: ends.get(owner.turnId) ?? null,
      usageAt: row.at,
      prompt: prompts.get(owner.turnId) ?? null,
      ...ZERO_TOKENS,
    };
    Object.assign(detail, addTokens(detail, tokens), { usageAt: row.at });
    byTurn.set(owner.turnId, detail);
  }

  const details = [...byTurn.values()];
  if (orphan !== null) details.unshift(orphan);
  return details.sort((a, b) => a.startedAt - b.startedAt);
}
