import type { Anchor } from "./anchors-contract";

/** Marks per session, shared by every message card and the rail (separate React roots). */
const EMPTY: readonly Anchor[] = [];
const byThread = new Map<string, readonly Anchor[]>();
const listeners = new Set<() => void>();

export function setAnchors(threadId: string, next: readonly Anchor[]): void {
  byThread.set(threadId, next);
  for (const listener of listeners) listener();
}

export function getAnchors(threadId: string): readonly Anchor[] {
  return byThread.get(threadId) ?? EMPTY;
}

export function subscribeAnchors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
