import { PLUGIN_STORAGE_KEYS } from "./storage-keys";
import type { ThreadLifecycleRow } from "../lifecycle";

const MAX_CACHED_LIFECYCLE_ROWS = 500;
export const MAX_CHILD_EXPANSION = 100;

function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22;
  }
  if (error instanceof Error) {
    return error.name === "QuotaExceededError";
  }
  return false;
}

export function safeSetItem(key: string, value: string, storage: "local" | "session" = "local"): boolean {
  let target: Storage;
  try {
    target = storage === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return false;
  }
  try {
    target.setItem(key, value);
    return true;
  } catch (error) {
    if (!isQuotaExceededError(error)) return false;

    // Retry after each eviction so higher-priority preferences survive as
    // soon as removing a lower-priority cache frees enough space.
    for (const candidate of PLUGIN_STORAGE_KEYS) {
      if (candidate === key) continue;
      try {
        target.removeItem(candidate);
      } catch {
        continue;
      }
      try {
        target.setItem(key, value);
        return true;
      } catch (retryError) {
        if (!isQuotaExceededError(retryError)) return false;
      }
    }

    // The value still does not fit. Clear its old cache entry to leave room
    // for sandy core, without ever removing keys owned by core or other plugins.
    try {
      target.removeItem(key);
    } catch {
      // Storage can become unavailable while recovering from quota pressure.
    }
    return false;
  }
}

function lifecycleRecency(row: ThreadLifecycleRow): number {
  let max = row.parkedAt ?? 0;
  if (typeof row.snoozedUntil === "number" && Number.isFinite(row.snoozedUntil)) {
    max = Math.max(max, row.snoozedUntil);
  }
  if (typeof row.settledAt === "number" && Number.isFinite(row.settledAt)) {
    max = Math.max(max, row.settledAt);
  }
  if (typeof row.snoozedAt === "number" && Number.isFinite(row.snoozedAt)) {
    max = Math.max(max, row.snoozedAt);
  }
  return max;
}

export function pruneLifecycleRows(rows: readonly ThreadLifecycleRow[]): ThreadLifecycleRow[] {
  if (rows.length <= MAX_CACHED_LIFECYCLE_ROWS) return [...rows];
  return [...rows].sort((a, b) => lifecycleRecency(b) - lifecycleRecency(a)).slice(0, MAX_CACHED_LIFECYCLE_ROWS);
}

export function pruneChildExpansion(ids: readonly string[]): string[] {
  if (ids.length <= MAX_CHILD_EXPANSION) return [...ids];
  // Keep most recently added (last N in insertion order).
  return [...ids].slice(-MAX_CHILD_EXPANSION);
}
