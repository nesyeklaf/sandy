import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createStore, MIGRATIONS } from "./store.js";
import { completeLines, subagentCallsOf } from "./subagents.js";

function line(id: string, timestamp: string, usage: Record<string, number>, type = "assistant") {
  return JSON.stringify({ type, timestamp, message: { id, usage } });
}

const usage = { input_tokens: 3, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 50_000, output_tokens: 20 };

describe("subagentCallsOf", () => {
  it("counts each message once, keeping its last line, with cache writes as new input", () => {
    const text = [
      line("msg_1", "2026-09-24T10:00:00Z", { ...usage, output_tokens: 5 }),
      line("msg_1", "2026-09-24T10:00:01Z", usage),
      line("msg_2", "2026-09-24T10:00:05Z", { ...usage, cache_read_input_tokens: 51_000 }),
      JSON.stringify({ type: "user", timestamp: "2026-09-24T10:00:06Z", message: { content: "next" } }),
      "not json",
    ].join("\n");
    expect(subagentCallsOf(text)).toEqual([
      { messageId: "msg_1", createdAt: Date.parse("2026-09-24T10:00:01Z"), input: 1_003, cacheRead: 50_000, output: 20 },
      { messageId: "msg_2", createdAt: Date.parse("2026-09-24T10:00:05Z"), input: 1_003, cacheRead: 51_000, output: 20 },
    ]);
  });

  it("leaves a line still being written for the next read", () => {
    expect(completeLines('{"a":1}\n{"b":')).toBe('{"a":1}\n');
    expect(completeLines('{"b":')).toBe("");
  });
});

describe("subagent tokens in the totals", () => {
  it("adds them to the thread and the hours without counting them as turns", () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const store = createStore(db);
    const at = Date.UTC(2026, 8, 24, 10);
    store.record(
      { threadId: "thr_widgets", title: null, projectId: "prj_acme", providerId: "claude-code", archivedAt: null },
      [{ eventId: "evt_1", createdAt: at, tokens: { input: 100, cacheRead: 1_000, output: 10 }, runningTotal: 1_110 }],
      1,
    );
    const read = {
      path: "/tmp/agent-a1.jsonl",
      agentId: "a1",
      description: "Research",
      calls: [{ messageId: "msg_1", createdAt: at + 1_000, input: 50, cacheRead: 5_000, output: 5 }],
      offset: 120,
    };
    store.recordSubagents("thr_widgets", [read]);
    // Reading the same call again changes nothing.
    store.recordSubagents("thr_widgets", [read]);

    expect(store.threadTotal("thr_widgets")).toEqual({
      tokens: { input: 150, cacheRead: 6_000, output: 15 },
      total: 6_165,
      turns: 1,
      subagents: { count: 1, tokens: 5_055 },
    });
    expect(store.threadsSince(at)[0]).toMatchObject({ turns: 1, cacheRead: 6_000 });
    expect(store.subagentOffsets("thr_widgets").get("/tmp/agent-a1.jsonl")).toBe(120);
  });
});
