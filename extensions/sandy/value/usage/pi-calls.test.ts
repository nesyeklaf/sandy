import { describe, expect, it } from "vitest";

import { piCallsOf, sessionFileName } from "./pi-calls.js";

const call = (extra: object, id = "a1") =>
  JSON.stringify({
    type: "message",
    id,
    timestamp: "2026-10-28T11:56:47.184Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-5-5",
      responseId: `msg_${id}`,
      timestamp: 1793188601684,
      usage: { input: 4, output: 332, cacheRead: 68276, cacheWrite: 23752, cost: { total: 0.1051636 } },
      ...extra,
    },
  });

describe("piCallsOf", () => {
  it("reads every assistant call with its cost, folding cache writes into input", () => {
    const [one] = piCallsOf(call({}), "f");
    expect(one).toEqual({
      key: "msg_a1",
      createdAt: 1793188601684,
      model: "claude-sonnet-5-5",
      input: 23756,
      cacheRead: 68276,
      output: 332,
      costUsd: 0.1051636,
    });
  });

  it("counts two calls as two, and a repeated response once", () => {
    const text = [call({}, "a1"), call({}, "a2"), call({}, "a1")].join("\n");
    expect(piCallsOf(text, "f").map((c) => c.key)).toEqual(["msg_a1", "msg_a2"]);
  });

  it("gives no cost when Pi priced the call at zero", () => {
    const [one] = piCallsOf(call({ usage: { input: 1, output: 1, cost: { total: 0 } } }), "f");
    expect(one?.costUsd).toBeNull();
  });

  it("skips user lines, other types and a line cut off mid-write", () => {
    const text = [
      JSON.stringify({ type: "message", id: "u", message: { role: "user" } }),
      JSON.stringify({ type: "custom", id: "c" }),
      call({}, "a1").slice(0, 60),
    ].join("\n");
    expect(piCallsOf(text, "f")).toEqual([]);
  });

  it("keys a call without a response id by file and entry", () => {
    const [one] = piCallsOf(call({ responseId: undefined }, "e9"), "pi_x");
    expect(one?.key).toBe("pi_x:e9");
  });
});

describe("sessionFileName", () => {
  it("names the file, and refuses a path", () => {
    expect(sessionFileName("pi_14cfa543-7f56")).toBe("pi_14cfa543-7f56.jsonl");
    expect(sessionFileName("../etc/passwd")).toBeNull();
  });
});
