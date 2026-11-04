export const PANEL_LIST_TTL_MS = 2_000;

type Entry<T> = { result: Promise<T>; settledAt: number | null };

export interface PanelListCache<T> {
  get(threadId: string): Promise<T>;
  invalidate(threadId: string): void;
}

export function createPanelListCache<T>(load: (threadId: string) => Promise<T>, ttlMs = PANEL_LIST_TTL_MS, now: () => number = Date.now): PanelListCache<T> {
  const entries = new Map<string, Entry<T>>();
  return {
    get(threadId) {
      const current = entries.get(threadId);
      if (current !== undefined && (current.settledAt === null || now() - current.settledAt < ttlMs)) return current.result;
      const entry: Entry<T> = { result: load(threadId), settledAt: null };
      entries.set(threadId, entry);
      entry.result.then(
        () => {
          entry.settledAt = now();
        },
        () => {
          if (entries.get(threadId) === entry) entries.delete(threadId);
        },
      );
      return entry.result;
    },
    invalidate(threadId) {
      entries.delete(threadId);
    },
  };
}
