import type { Turn } from "./topic-turns";
import type { TopicSegment } from "./topics-contract";

export interface TopicSuggestion {
  fromSeq: number;
  toSeq: number;
  title: string;
  tags: string[];
}

/** A saved topic or an AI suggestion, ready to draw. */
export interface TopicEntry {
  key: string;
  /** Null for a suggestion that is not saved yet. */
  id: string | null;
  fromSeq: number;
  toSeq: number;
  title: string;
  tags: string[];
  suggested: boolean;
  hue: number;
}

/** Same word, same color: a stable hue from 0 to 359. */
export function hueOf(text: string): number {
  let hash = 7;
  for (const char of text.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

const overlaps = (a: { fromSeq: number; toSeq: number }, b: { fromSeq: number; toSeq: number }) =>
  a.fromSeq <= b.toSeq && a.toSeq >= b.fromSeq;

/** Saved topics first; a suggestion that overlaps a saved topic is dropped. Sorted by start. */
export function buildEntries(segments: readonly TopicSegment[], suggestions: readonly TopicSuggestion[]): TopicEntry[] {
  const saved: TopicEntry[] = segments.map((s) => ({
    key: s.id,
    id: s.id,
    fromSeq: s.fromSeq,
    toSeq: s.toSeq,
    title: s.title,
    tags: s.tags,
    suggested: false,
    hue: hueOf(s.title),
  }));
  const proposed: TopicEntry[] = suggestions
    .filter((s) => !saved.some((entry) => overlaps(entry, s)))
    .map((s) => ({
      key: `suggest-${s.fromSeq}-${s.toSeq}`,
      id: null,
      fromSeq: s.fromSeq,
      toSeq: s.toSeq,
      title: s.title,
      tags: s.tags,
      suggested: true,
      hue: hueOf(s.title),
    }));
  return [...saved, ...proposed].sort((a, b) => a.fromSeq - b.fromSeq);
}

export interface TurnSlot {
  index: number;
  turn: Turn;
  /** The topic this turn belongs to, if any. */
  owner: TopicEntry | null;
  /** Topics whose first message lies in this turn. */
  starts: TopicEntry[];
}

export function layoutTurns(turns: readonly Turn[], entries: readonly TopicEntry[]): TurnSlot[] {
  return turns.map((turn, index) => ({
    index,
    turn,
    owner: entries.find((entry) => overlaps(entry, turn)) ?? null,
    starts: entries.filter((entry) => entry.fromSeq >= turn.fromSeq && entry.fromSeq <= turn.toSeq),
  }));
}

export interface MapRun {
  owner: TopicEntry | null;
  /** Tokens of the run, at least 1, so a short topic stays visible. */
  weight: number;
  firstSeq: number;
}

/** Consecutive turns of the same topic (or of none) as one bar segment. */
export function mapRuns(slots: readonly TurnSlot[]): MapRun[] {
  const runs: MapRun[] = [];
  for (const slot of slots) {
    const weight = Math.max(
      1,
      [slot.turn.user, ...slot.turn.agents].reduce((sum, m) => sum + (m?.tokens ?? 0), 0),
    );
    const last = runs[runs.length - 1];
    if (last && last.owner?.key === slot.owner?.key) last.weight += weight;
    else runs.push({ owner: slot.owner, weight, firstSeq: slot.turn.fromSeq });
  }
  return runs;
}

/** Index range of the turns between two turn indexes, whatever their order. */
export function turnRange(turns: readonly Turn[], a: number, b: number): { from: number; to: number } | null {
  const first = turns[Math.min(a, b)];
  const last = turns[Math.max(a, b)];
  return first && last ? { from: first.fromSeq, to: last.toSeq } : null;
}

export function clipTitle(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
