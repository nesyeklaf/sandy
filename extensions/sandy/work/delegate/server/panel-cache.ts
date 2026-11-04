export const PANEL_LIST_TTL_MS = 2_000;
export const PANEL_LIST_MAX_ENTRIES = 64;

type Entry<T> = { result: Promise<T>; settledAt: number | null };

export interface PanelListCache<T> {
  get(threadId: string): Promise<T>;
  invalidate(threadId: string): void;
}

export function createPanelListCache<T>(load: (threadId: string) => Promise<T>, ttlMs = PANEL_LIST_TTL_MS, now: () => number = Date.now, maxEntries = PANEL_LIST_MAX_ENTRIES): PanelListCache<T> {
  const entries = new Map<string, Entry<T>>();
  const makeRoom = () => {
    for (const [key, entry] of entries) if (entry.settledAt !== null && now() - entry.settledAt >= ttlMs) entries.delete(key);
    for (const [key, entry] of entries) {
      if (entries.size < maxEntries) return;
      if (entry.settledAt !== null) entries.delete(key);
    }
  };
  return {
    get(threadId) {
      const current = entries.get(threadId);
      if (current !== undefined && (current.settledAt === null || now() - current.settledAt < ttlMs)) return current.result;
      entries.delete(threadId);
      makeRoom();
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
