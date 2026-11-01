import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { splitBreakdown } from "./breakdown.js";
import { createStore, MIGRATIONS } from "./store.js";
import { createSync, TOKEN_USAGE_EVENT, type EventSource, type ThreadLike, type UsageEventLike } from "./sync.js";

function openStore() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return createStore(db);
}

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 24, 10);

const thread: ThreadLike = {
  id: "thr_widgets",
  title: "Add a CSV export",
  titleFallback: null,
  projectId: "prj_acme",
  providerId: "claude-code",
};

function usageEvent(seq: number, createdAt: number, last: number, total: number): UsageEventLike {
  return {
    id: `evt_${seq}`,
    seq,
    createdAt,
    type: TOKEN_USAGE_EVENT,
    data: {
      tokenUsage: {
        total: { totalTokens: total, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        last: {
          totalTokens: last,
          inputTokens: 10,
          cachedInputTokens: last - 110,
          cacheReadInputTokens: last - 200,
          cacheWriteInputTokens: 90,
          outputTokens: 100,
          reasoningOutputTokens: 0,
        },
      },
    },
  };
}

function fakeSource(events: UsageEventLike[], threads: ThreadLike[] = [thread]) {
  const calls: Array<number | null> = [];
  const source: EventSource = {
    async listUsage({ threadId, afterSeq, limit }) {
      calls.push(afterSeq);
      // sandy's event ids are unique across threads.
      return events
        .filter((event) => event.seq > (afterSeq ?? 0))
        .slice(0, limit)
        .map((event) => ({ ...event, id: `${threadId}_${event.id}` }));
    },
    async listThreads({ archived, offset, limit }) {
      return archived ? [] : threads.slice(offset, offset + limit);
    },
  };
  return { source, calls };
}

describe("splitBreakdown", () => {
  it("separates Claude Code's cache reads from its cache writes", () => {
    // Claude Code: inputTokens excludes cached input.
    expect(
      splitBreakdown({
        totalTokens: 41_659_242,
        inputTokens: 312,
        cachedInputTokens: 41_537_400,
        cacheReadInputTokens: 41_250_000,
        cacheWriteInputTokens: 287_400,
        outputTokens: 121_530,
        reasoningOutputTokens: 0,
      }),
    ).toEqual({ input: 287_712, cacheRead: 41_250_000, output: 121_530 });
  });

  it("takes the cached part out of Codex's input", () => {
    // Codex: inputTokens includes cachedInputTokens.
    expect(
      splitBreakdown({
        totalTokens: 38_822,
        inputTokens: 38_420,
        cachedInputTokens: 35_840,
        outputTokens: 402,
        reasoningOutputTokens: 96,
      }),
    ).toEqual({ input: 2_580, cacheRead: 35_840, output: 402 });
  });

  it("never reports a negative part", () => {
    expect(
      splitBreakdown({ totalTokens: 10, inputTokens: 0, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 0 }),
    ).toEqual({ input: 0, cacheRead: 0, output: 10 });
  });
});

describe("sync and store", () => {
  it("stamps each turn with the thread's host and model", async () => {
    const store = openStore();
    const { source } = fakeSource([usageEvent(5, T0, 1_000, 1_000)]);
    source.threadModel = async () => "gpt-6.1-sol";
    const sync = createSync(store, source);

    await sync.syncThread({ ...thread, environmentHostId: "host_seraphim" });

    expect(store.stamps(thread.id)).toEqual([
      { eventId: "thr_widgets_evt_5", model: "gpt-6.1-sol", hostId: "host_seraphim" },
    ]);
  });

  it("asks sandy for the host when the thread names none, and fills rows stored without one", async () => {
    const store = openStore();
    const { source } = fakeSource([usageEvent(5, T0, 1_000, 1_000)]);
    await createSync(store, source).syncThread(thread);
    expect(store.stamps(thread.id)[0]?.hostId).toBeNull();

    const later = fakeSource([usageEvent(5, T0, 1_000, 1_000), usageEvent(9, T0 + 1, 1, 1)]);
    later.source.threadHost = async () => "host_laptop";
    await createSync(store, later.source).syncThread({ ...thread, environmentId: "env_1" });

    expect(store.stamps(thread.id).map((row) => row.hostId)).toEqual(["host_laptop", "host_laptop"]);
  });

  it("records a turn without a host when sandy cannot name one", async () => {
    const store = openStore();
    const { source } = fakeSource([usageEvent(5, T0, 1_000, 1_000)]);
    source.threadHost = async () => {
      throw new Error("gone");
    };
    await createSync(store, source).syncThread(thread);
    expect(store.stamps(thread.id)[0]?.hostId).toBeNull();
  });

  it("records unknown model when sandy cannot resolve it", async () => {
    const store = openStore();
    const { source } = fakeSource([usageEvent(5, T0, 1_000, 1_000)]);
    source.threadModel = async () => {
      throw new Error("gone");
    };
    await createSync(store, source).syncThread(thread);

    expect(store.stamps(thread.id)).toEqual([{ eventId: "thr_widgets_evt_5", model: null, hostId: null }]);
  });

  it("records each turn once and resumes after the last event read", async () => {
    const store = openStore();
    const events = [usageEvent(5, T0, 1_000, 1_000), usageEvent(9, T0 + 60_000, 2_000, 3_000)];
    const { source, calls } = fakeSource(events);
    const sync = createSync(store, source);

    expect(await sync.syncThread(thread)).toBe(2);
    events.push(usageEvent(12, T0 + HOUR, 500, 3_500));
    expect(await sync.syncThread(thread)).toBe(1);

    expect(calls).toEqual([null, 9]);
    expect(store.threadTotal(thread.id)).toEqual({
      tokens: { input: 300, cacheRead: 2_900, output: 300 },
      total: 3_500,
      turns: 3,
      subagents: { count: 0, tokens: 0 },
    });
    expect(store.threadRows(thread.id, 2).map((turn) => turn.at)).toEqual([T0 + 60_000, T0 + HOUR]);
  });

  it("buckets usage by hour and ranks threads by what they used in the window", async () => {
    const store = openStore();
    const other: ThreadLike = { ...thread, id: "thr_gadgets", title: null, titleFallback: "Fix the flaky test" };
    await createSync(store, fakeSource([usageEvent(1, T0 + 5 * 60_000, 1_000, 1_000)]).source).syncThread(thread);
    await createSync(
      store,
      fakeSource([usageEvent(1, T0 + 10 * 60_000, 4_000, 4_000), usageEvent(2, T0 + HOUR + 1, 2_000, 6_000)]).source,
    ).syncThread(other);

    expect(store.hoursSince(T0).map(({ hour, input, cacheRead, output }) => [hour, input + cacheRead + output])).toEqual([
      [T0, 5_000],
      [T0 + HOUR, 2_000],
    ]);
    expect(store.threadsSince(T0 + HOUR).map((row) => [row.threadId, row.turns])).toEqual([["thr_gadgets", 1]]);
    expect(store.threadsSince(T0).map((row) => [row.threadId, row.title])).toEqual([
      ["thr_gadgets", "Fix the flaky test"],
      ["thr_widgets", "Add a CSV export"],
    ]);
  });

  it("counts a thread's running total when sandy pruned its earlier turns", async () => {
    const store = openStore();
    // Only the latest event survived; the provider's running total is higher.
    await createSync(store, fakeSource([usageEvent(300, T0, 2_000, 90_000)]).source).syncThread(thread);
    expect(store.threadTotal(thread.id).total).toBe(90_000);
  });

  it("runs one read per thread at a time and reads again for a request made during it", async () => {
    const store = openStore();
    const events = [usageEvent(1, T0, 1_000, 1_000)];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { source, calls } = fakeSource(events);
    const slow: EventSource = {
      ...source,
      async listUsage(args) {
        await gate;
        return source.listUsage(args);
      },
    };
    const added: string[] = [];
    const sync = createSync(store, slow, { onAdded: (threadId) => added.push(threadId) });

    const first = sync.syncThread(thread);
    const second = sync.syncThread(thread);
    events.push(usageEvent(2, T0 + 1, 1_000, 2_000));
    release();
    expect(await first).toBe(2);
    expect(await second).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([null, 2]);
    // The second read found nothing new, so only the first announced.
    expect(added).toEqual(["thr_widgets"]);
  });

  it("reads every thread on a full sync", async () => {
    const store = openStore();
    const { source } = fakeSource([usageEvent(1, T0, 1_000, 1_000)], [thread, { ...thread, id: "thr_gadgets" }]);
    const changed = await createSync(store, source).syncAll(new AbortController().signal);
    expect(changed).toEqual(["thr_widgets", "thr_gadgets"]);
  });

  it("keeps the first recording time across loads", () => {
    const store = openStore();
    expect(store.startedAt(T0)).toBe(T0);
    expect(store.startedAt(T0 + HOUR)).toBe(T0);
  });
});

describe("archived threads", () => {
  it("records when a thread was archived and clears it when unarchived", async () => {
    const store = openStore();
    const archived: ThreadLike = { ...thread, archivedAt: T0 };
    await createSync(store, fakeSource([usageEvent(1, T0, 1_000, 1_000)]).source).syncThread(archived);
    expect(store.threadsSince(0)[0]!.archivedAt).toBe(T0);
    store.setArchived(thread.id, null);
    expect(store.threadsSince(0)[0]!.archivedAt).toBeNull();
  });

  it("counts a deleted thread as archived", async () => {
    const store = openStore();
    const deleted: ThreadLike = { ...thread, archivedAt: null, deletedAt: T0 + HOUR };
    await createSync(store, fakeSource([usageEvent(1, T0, 1_000, 1_000)]).source).syncThread(deleted);
    expect(store.threadsSince(0)[0]!.archivedAt).toBe(T0 + HOUR);
  });

  it("sums each thread's usage by hour", async () => {
    const store = openStore();
    await createSync(
      store,
      fakeSource([usageEvent(1, T0 + 60_000, 1_000, 1_000), usageEvent(2, T0 + 120_000, 500, 1_500), usageEvent(3, T0 + HOUR, 200, 1_700)]).source,
    ).syncThread(thread);
    expect(store.threadHoursSince(T0)).toEqual([
      { threadId: "thr_widgets", hour: T0, total: 1_500 },
      { threadId: "thr_widgets", hour: T0 + HOUR, total: 200 },
    ]);
  });
});

describe("providerSlots", () => {
  it("sums a provider's tokens into 15-minute slots from the start", async () => {
    const store = openStore();
    const { source } = fakeSource([usageEvent(1, T0 + 5 * 60_000, 1_000, 1_000), usageEvent(2, T0 + 20 * 60_000, 2_000, 3_000)]);
    await createSync(store, source).syncThread(thread);
    // A start with a fraction, as a real reset time has, still lands on whole slots.
    const slots = store.providerSlots("claude-code", T0 + 0.5, T0 + 40 * 60_000, 15 * 60_000);
    expect(slots).toEqual([1_000, 2_000, 0]);
    expect(store.providerSlots("codex", T0, T0 + 40 * 60_000, 15 * 60_000)).toEqual([0, 0, 0]);
  });
});
