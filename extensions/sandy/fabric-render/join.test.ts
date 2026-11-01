import assert from "node:assert/strict";
import { test } from "node:test";
import { joinExecs, type Row } from "./join.ts";

const call = (seq: number, type: "item/started" | "item/completed", id: string, extra: object = {}): Row => ({
  seq, createdAt: seq * 1000, type,
  data: { item: { type: "toolCall", id, tool: "fabric_exec", arguments: { code: "await pi.bash()\nsecond", display: { name: "Build" } }, ...extra } },
});
const entry = (seq: number, data: object): Row => ({
  seq, createdAt: seq * 1000, type: "provider/unhandled",
  data: { rawEvent: { params: { message: { type: "entry_appended", entry: { type: "custom", customType: "fabric-render", data: { schemaVersion: 1, ...data } } } } } },
});

test("an entry between a call's start and end belongs to that call", () => {
  const rows = [
    call(10, "item/started", "i1"), entry(11, { success: true, phases: ["run"], auditCount: 2, truncated: false, display: { name: "Build" }, audits: [{ ref: "a", tool: "bash" }, { ref: "b", tool: "read" }] }), call(12, "item/completed", "i1", { status: "completed", result: "ok" }),
    call(20, "item/started", "i2"), call(21, "item/completed", "i2", { status: "completed", result: "plain" }),
  ];
  const [a, b] = joinExecs(rows);
  assert.equal(a!.source, "entry");
  assert.equal(a!.audits.length, 2);
  assert.equal(a!.name, "Build");
  assert.equal(a!.status, "completed");
  assert.equal(b!.source, "call");
  assert.equal(b!.resultText, "plain");
  assert.equal(b!.codeHead, "await pi.bash()\nsecond");
});

test("two calls do not share one entry; a call without end is running; failure comes from the entry", () => {
  const rows = [
    call(1, "item/started", "i1"), entry(2, { success: false, phases: [], auditCount: 0, truncated: false, audits: [] }), call(3, "item/completed", "i1"),
    call(4, "item/started", "i2"),
  ];
  const [a, b] = joinExecs(rows);
  assert.equal(a!.status, "failed");
  assert.equal(b!.status, "running");
  assert.equal(b!.source, "call");
});

test("entries of other types and wrong schema versions are ignored", () => {
  const other: Row = { seq: 2, createdAt: 2, type: "provider/unhandled", data: { rawEvent: { params: { message: { type: "entry_appended", entry: { type: "custom", customType: "permissions-tool-inventory", data: { schemaVersion: 1 } } } } } } };
  const [a] = joinExecs([call(1, "item/started", "i1"), other, entry(2, { schemaVersion: 2 } as object), call(3, "item/completed", "i1")]);
  assert.equal(a!.source, "call");
});
