import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CONTEXT_EVENT, contextLevel, contextRowOf, countLevels, parseThreshold } from "./context.js";
import { createStore, MIGRATIONS } from "./store.js";
import { createSync, type EventSource, type ThreadLike, type UsageEventLike } from "./sync.js";

const thread: ThreadLike = { id: "thr_widgets", title: "Add a CSV export", projectId: "prj_acme", providerId: "claude-code" };

function contextEvent(seq: number, usedTokens: number | null): UsageEventLike {
  return {
    id: `evt_${seq}`,
    seq,
    createdAt: 1_000 + seq,
    type: CONTEXT_EVENT,
    data: {
      providerThreadId: "p",
      contextWindowUsage: {
        usedTokens,
        modelContextWindow: 1_000_000,
        estimated: true,
        snapshot: { autoCompactAtTokens: 967_000 },
      },
    },
  };
}

describe("contextRowOf", () => {
  it("reads the size, the window, and where the provider compacts", () => {
    expect(contextRowOf(contextEvent(1, 509_666))).toEqual({
      eventId: "evt_1",
      createdAt: 1_001,
      usedTokens: 509_666,
      contextWindow: 1_000_000,
      autoCompactAt: 967_000,
    });
  });

  it("skips the sizeless event Claude Code sends straight after compacting", () => {
    expect(contextRowOf(contextEvent(2, null))).toBeNull();
  });
});

describe("parseThreshold", () => {
  it("reads plain counts and K or M suffixes", () => {
    expect(parseThreshold("300K")).toBe(300_000);
    expect(parseThreshold("300,000")).toBe(300_000);
    expect(parseThreshold("0.5m")).toBe(500_000);
  });

  it("turns the warning off for an empty or unreadable value", () => {
    expect(parseThreshold("")).toBeNull();
    expect(parseThreshold("0")).toBeNull();
    expect(parseThreshold("lots")).toBeNull();
  });
});

describe("recording context", () => {
  it("keeps the latest size and announces it, without counting it as usage", async () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const store = createStore(db);
    const events = [contextEvent(1, 400_000), contextEvent(2, null), contextEvent(3, 510_000)];
    const source: EventSource = {
      async listUsage({ afterSeq }) {
        return events.filter((event) => event.seq > (afterSeq ?? 0));
      },
      async listThreads() {
        return [thread];
      },
    };
    const announced: string[] = [];
    const sync = createSync(store, source, { onContext: (threadId) => announced.push(threadId) });

    expect(await sync.syncThread(thread)).toBe(0);
    expect(store.latestContext(thread.id)?.usedTokens).toBe(510_000);
    expect(announced).toEqual([thread.id]);
    expect(store.cursor(thread.id)).toBe(3);

    // Nothing new, so nothing to announce.
    await sync.syncThread(thread);
    expect(announced).toEqual([thread.id]);
  });
});

describe("contextLevel", () => {
  it("is an error past the error setting and a warning past the warning one", () => {
    const thresholds = { warning: 300_000, error: 550_000 };
    expect(contextLevel(299_999, thresholds)).toBeNull();
    expect(contextLevel(300_000, thresholds)).toBe("warning");
    expect(contextLevel(550_000, thresholds)).toBe("error");
  });
});

describe("countLevels", () => {
  it("counts each context once, at the higher level it passes", () => {
    expect(countLevels([100_000, 300_000, 549_999, 550_000, 900_000], { warning: 300_000, error: 550_000 })).toEqual({
      warning: 2,
      error: 2,
    });
    expect(countLevels([400_000, 900_000], { warning: 300_000, error: null })).toEqual({ warning: 2, error: 0 });
    expect(countLevels([400_000], { warning: null, error: null })).toEqual({ warning: 0, error: 0 });
  });
});

describe("activeLatestContexts", () => {
  it("lists each active thread's latest context and leaves archived threads out", async () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const store = createStore(db);
    const gadgets: ThreadLike = { ...thread, id: "thr_gadgets", title: "Fix the gadget sync" };
    // Event ids are unique across threads, so each thread gets its own.
    const events: Record<string, UsageEventLike[]> = {
      [thread.id]: [contextEvent(1, 200_000), contextEvent(2, 600_000)],
      [gadgets.id]: [contextEvent(3, 350_000)],
    };
    const source: EventSource = {
      async listUsage({ threadId, afterSeq }) {
        return events[threadId]!.filter((event) => event.seq > (afterSeq ?? 0));
      },
      async listThreads() {
        return [thread, gadgets];
      },
    };
    const sync = createSync(store, source);
    await sync.syncThread(thread);
    await sync.syncThread(gadgets);
    expect(store.activeLatestContexts().sort()).toEqual([350_000, 600_000]);

    store.setArchived(gadgets.id, 5_000);
    expect(store.activeLatestContexts()).toEqual([600_000]);
  });
});
