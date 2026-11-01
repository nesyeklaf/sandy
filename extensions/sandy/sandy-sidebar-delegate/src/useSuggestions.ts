import { useSyncExternalStore } from "react";
import type { TopicSuggestion } from "./topic-layout";

/**
 * AI suggestions per session, shared by the Topics tab and the rail brackets,
 * which render in separate React roots of the same bundle.
 */
const EMPTY: readonly TopicSuggestion[] = [];
const byThread = new Map<string, readonly TopicSuggestion[]>();
const listeners = new Set<() => void>();

export function setSuggestions(threadId: string, next: readonly TopicSuggestion[]): void {
  if (next.length === 0) byThread.delete(threadId);
  else byThread.set(threadId, next);
  for (const listener of listeners) listener();
}

export function getSuggestions(threadId: string): readonly TopicSuggestion[] {
  return byThread.get(threadId) ?? EMPTY;
}

export function useSuggestions(threadId: string): readonly TopicSuggestion[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getSuggestions(threadId),
  );
}
