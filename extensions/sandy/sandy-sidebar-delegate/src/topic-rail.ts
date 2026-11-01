import type { TopicEntry } from "./topic-layout";

/** The entry whose range holds seq, or null. */
export function entryAt(entries: readonly TopicEntry[], seq: number | null): TopicEntry | null {
  if (seq === null) return null;
  return entries.find((entry) => entry.fromSeq <= seq && seq <= entry.toSeq) ?? null;
}

/**
 * The topic one step before (-1) or after (+1) the position, wrapping around.
 * Between two topics the step goes to the nearest one in that direction.
 */
export function stepEntry(entries: readonly TopicEntry[], seq: number | null, delta: -1 | 1): TopicEntry | null {
  if (entries.length === 0) return null;
  const here = entryAt(entries, seq);
  if (here) {
    const index = entries.indexOf(here);
    return entries[(index + delta + entries.length) % entries.length] ?? null;
  }
  if (seq === null) return (delta === 1 ? entries[0] : entries[entries.length - 1]) ?? null;
  const next =
    delta === 1
      ? entries.find((entry) => entry.fromSeq > seq)
      : [...entries].reverse().find((entry) => entry.toSeq < seq);
  return next ?? (delta === 1 ? entries[0] : entries[entries.length - 1]) ?? null;
}
