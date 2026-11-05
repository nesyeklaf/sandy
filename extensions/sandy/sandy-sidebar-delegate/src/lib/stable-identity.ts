import { useCallback, useRef } from "react";

export function shareArray<T>(previous: readonly T[], next: readonly T[]): readonly T[] {
  if (previous === next) return previous;
  if (previous.length !== next.length) return next;
  return previous.every((item, index) => item === next[index]) ? previous : next;
}

/** The previous map when every key holds an equal array, else a map that still reuses each equal array. */
export function shareArrayMap<K, T>(
  previous: ReadonlyMap<K, readonly T[]>,
  next: ReadonlyMap<K, readonly T[]>,
): ReadonlyMap<K, readonly T[]> {
  if (previous === next) return previous;
  let sameEntries = previous.size === next.size;
  const shared = new Map<K, readonly T[]>();
  for (const [key, items] of next) {
    const previousItems = previous.get(key);
    const sharedItems = previousItems === undefined ? items : shareArray(previousItems, items);
    if (sharedItems !== previousItems) sameEntries = false;
    shared.set(key, sharedItems);
  }
  return sameEntries ? previous : shared;
}

/** Keeps the identity of the last value that share() judged equal to the current one. */
export function useSharedValue<T>(next: T, share: (previous: T, next: T) => T): T {
  const ref = useRef(next);
  const shared = share(ref.current, next);
  ref.current = shared;
  return shared;
}

/** A function whose identity never changes and which always calls the latest callback. */
export function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const ref = useRef(callback);
  ref.current = callback;
  return useCallback((...args: Args) => ref.current(...args), []);
}
