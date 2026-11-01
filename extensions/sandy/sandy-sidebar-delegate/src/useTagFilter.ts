import { useSyncExternalStore } from "react";
import { NO_FILTER } from "./tag-filter";

type Filter = typeof NO_FILTER;

let current: Filter = NO_FILTER;
const listeners = new Set<() => void>();

/** The filter is shared by the filter bar and the list, and lives for the page's lifetime. */
export function setTagFilter(next: Partial<Filter>): void {
  current = { ...current, ...next };
  for (const listener of listeners) listener();
}

export function useTagFilter(): Filter {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => NO_FILTER,
  );
}
