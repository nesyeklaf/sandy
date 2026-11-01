import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMachine, pickEdge, rulesFor, stageOf } from "./machine.ts";

const template = JSON.parse(readFileSync(new URL("./templates/full-control.stages.json", import.meta.url), "utf8"));

test("the full-control template is valid", () => {
  const parsed = parseMachine(template);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
});

test("invalid machines name the problem", () => {
  const bad = parseMachine({ id: "x", title: "X", stages: [{ id: "a", title: "A", next: [{ to: "nope" }], inputs: ["a.missing"] }, { id: "a", title: "dup" }] });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.error, /duplicate stage id "a"/);
    assert.match(bad.error, /next "nope" is not a stage/);
    assert.match(bad.error, /input "a.missing" names no output/);
  }
  const extra = parseMachine({ id: "x", title: "X", stages: [{ id: "a", title: "A", gate: [{ type: "magic" }] }] });
  assert.equal(extra.ok, false);
});

test("branching needs an explicit target; final stage finishes", () => {
  const m = parseMachine(template);
  if (!m.ok) throw new Error(m.error);
  const intent = stageOf(m.machine, "intent");
  assert.equal(pickEdge(intent, undefined).ok, false);
  assert.deepEqual(pickEdge(intent, "design"), { ok: true, to: "design" });
  assert.equal(pickEdge(intent, "go").ok, false);
  assert.deepEqual(pickEdge(stageOf(m.machine, "go"), undefined), { ok: true, to: null });
  assert.deepEqual(pickEdge(stageOf(m.machine, "design"), undefined), { ok: true, to: "spec" });
});

test("a stage's rules for an edge are its gate plus the edge's gate", () => {
  const m = parseMachine(template);
  if (!m.ok) throw new Error(m.error);
  assert.equal(rulesFor(stageOf(m.machine, "intent"), "design").length, 2);
});
