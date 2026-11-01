import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import type { PiCall } from "./pi-calls.js";
import { createStore, MIGRATIONS } from "./store.js";

function openStore() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return createStore(db);
}

const T = Date.UTC(2026, 9, 28, 10);
const info = { threadId: "thr_a", title: "t", projectId: "p", providerId: "pi", archivedAt: null, hostId: "host_1", model: "claude-opus-5-5" };
const call = (key: string, at: number, costUsd: number | null): PiCall => ({ key, createdAt: at, model: "claude-opus-5-5", input: 10, cacheRead: 1000, output: 5, costUsd });

function withTurn(store: ReturnType<typeof openStore>) {
  // One sandy turn event that holds only the last call of a turn.
  store.record(info, [{ eventId: "e1", createdAt: T + 100, tokens: { input: 1, cacheRead: 130, output: 1 }, runningTotal: 132 }], 1);
}

describe("Pi calls in the store", () => {
  it("takes a thread's calls from Pi's file once it has any, and keeps its sandy turns as turns", () => {
    const store = openStore();
    withTurn(store);
    expect(store.turnRowsSince(0)).toHaveLength(1);
    expect(store.recordPiCalls("thr_a", "host_1", [call("k1", T, 0.5), call("k2", T + 50, 0.25)])).toBe(2);
    const rows = store.turnRowsSince(0);
    expect(rows.map((row) => row.costUsd)).toEqual([0.5, 0.25]);
    expect(rows.every((row) => row.hostId === "host_1")).toBe(true);
    const [thread] = store.threadsSince(0);
    expect(thread).toMatchObject({ turns: 1, input: 20, cacheRead: 2000, output: 10 });
    expect(store.hoursSince(0).reduce((sum, hour) => sum + hour.cacheRead, 0)).toBe(2000);
  });

  it("counts a call once, even when a forked thread's file lists it again", () => {
    const store = openStore();
    withTurn(store);
    store.recordPiCalls("thr_a", "host_1", [call("k1", T, 0.5)]);
    expect(store.recordPiCalls("thr_b", "host_1", [call("k1", T, 0.5), call("k3", T + 9, 0.1)])).toBe(1);
    expect(store.turnRowsSince(0)).toHaveLength(2);
  });

  it("knows the host of a Pi thread only", () => {
    const store = openStore();
    withTurn(store);
    store.record({ ...info, threadId: "thr_cc", providerId: "claude-code" }, [], 0);
    expect(store.piHost("thr_a")).toBe("host_1");
    expect(store.piHost("thr_cc")).toBeNull();
  });

  it("lists the Pi threads that had a turn since a time", () => {
    const store = openStore();
    withTurn(store);
    expect(store.piThreadsSince(T)).toEqual([{ threadId: "thr_a", hostId: "host_1" }]);
    expect(store.piThreadsSince(T + 1000)).toEqual([]);
  });
});
