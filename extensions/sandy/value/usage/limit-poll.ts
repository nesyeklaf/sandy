// How the limits poller reads several hosts: each connected host is asked on
// its own, because a provider is checked from the machine it runs on, and an
// account that works from one host can be throttled from another. The same
// account answered by two hosts is kept once.
import type { LimitSample } from "./limits.js";

const MIN = 60_000;

/** Turn-triggered readings come at most this often. */
export const MIN_TURN_GAP_MS = 2 * MIN;
const BACKOFF_START_MS = 2 * MIN;
const BACKOFF_MAX_MS = 30 * MIN;

/** The same window of the same account, however many hosts reported it. */
function windowId(sample: LimitSample): string {
  return [sample.providerId, sample.accountKey ?? "", sample.label, sample.model ?? ""].join("\u0000");
}

/** Samples of all hosts in one list; the first host to report a window wins. */
export function mergeSamples(perHost: ReadonlyArray<readonly LimitSample[]>): LimitSample[] {
  const seen = new Set<string>();
  const merged: LimitSample[] = [];
  for (const samples of perHost) {
    for (const sample of samples) {
      const id = windowId(sample);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(sample);
    }
  }
  return merged;
}

/** True when any provider in a usage response answered with something other than ok. */
export function hasProviderErrors(response: unknown): boolean {
  if (response === null || typeof response !== "object") return false;
  return Object.values(response as Record<string, unknown>).some(
    (entry) => (entry as { status?: unknown } | null)?.status === "error",
  );
}

/**
 * Per host, how long a failed check keeps the extra (turn-triggered) readings
 * away: 2, 4, 8 ... up to 30 minutes. The scheduled reading ignores it, so a
 * host is never silent for more than one poll interval.
 */
export function createBackoff() {
  const hosts = new Map<string, { failures: number; retryAt: number }>();
  return {
    ready(hostId: string, now: number): boolean {
      return now >= (hosts.get(hostId)?.retryAt ?? 0);
    },
    failed(hostId: string, now: number): void {
      const failures = (hosts.get(hostId)?.failures ?? 0) + 1;
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (failures - 1));
      hosts.set(hostId, { failures, retryAt: now + wait });
    },
    succeeded(hostId: string): void {
      hosts.delete(hostId);
    },
  };
}
