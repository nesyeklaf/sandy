import type { Anchor } from "./anchors-contract";

/** A mark the user has started and not saved yet; at most one at a time. */
export interface AnchorDraft {
  threadId: string;
  messageId: string;
  seq: number | null;
  quote: string;
  /** "explain" asks a model; it is never stored unless saved as a note. */
  kind: Anchor["kind"] | "explain";
}

let current: AnchorDraft | null = null;
const listeners = new Set<() => void>();

export function openAnchorDraft(draft: AnchorDraft): void {
  current = draft;
  for (const listener of listeners) listener();
}

export function closeAnchorDraft(): void {
  if (current === null) return;
  current = null;
  for (const listener of listeners) listener();
}

export function subscribeAnchorDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentAnchorDraft(): AnchorDraft | null {
  return current;
}
