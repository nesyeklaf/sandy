import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSkill } from "@sandy/skill-dialect";
import { parseMachine, type Machine } from "./machine.ts";
import { endText, statusText, step, ticketOf, toldBy, type Command, type Lease, type Reply, type Run } from "./run.ts";

const T0 = 1_000_000;
const fixtures = new URL("../../../../packages/skill-dialect/test/fixtures/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, fixtures), "utf8");

function compiled(name: string): Machine {
  const out = parseSkill(fixture(name), name);
  if (!out.ok) throw new Error(JSON.stringify(out.problems));
  const parsed = parseMachine(out.machine);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.machine;
}

const think = compiled("think-it-through.md");
const ids = () => {
  let n = 0;
  return { newRunId: () => `run${++n}` };
};

function commit(run: Run | null, command: Command): { run: Run; reply: Reply } {
  const out = step(run, command, T0, ids());
  assert.ok(out.run, "commit expects a run");
  const published = step(out.run, { by: "system", op: "published", rev: out.run.rev, ...toldBy(command, out.reply) }, T0, ids());
  return { run: published.run!, reply: out.reply };
}

const lease = (run: Run): Lease => {
  assert.equal(run.state.kind, "active");
  return (run.state as { kind: "active"; lease: Lease }).lease;
};
const ticket = (run: Run) => ticketOf(run, lease(run));
const stageNow = (run: Run) => lease(run).stage;
const submit = (run: Run, outputs: Record<string, string>) => commit(run, { by: "agent", op: "submit", ticket: ticket(run), outputs });
const advance = (run: Run, to?: string) => commit(run, { by: "agent", op: "advance", ticket: ticket(run), ...(to ? { to } : {}) });
const refusal = (reply: Reply): string => {
  assert.equal(reply.kind, "refused", JSON.stringify(reply));
  return (reply as { reasons: string[] }).reasons.join(" | ");
};

function started(): Run {
  const out = commit(null, { by: "agent", op: "start", source: { kind: "skill", skill: "think-it-through", machine: think }, inputs: { Task: "pick a db", Choice: "sqlite or postgres" } });
  assert.equal(out.reply.kind, "started");
  return out.run;
}

function atReview(): Run {
  let run = started();
  run = submit(run, { Frame: "the frame", Clear: "yes", Musts: "1. fast\n2. cheap" }).run;
  run = advance(run).run;
  assert.equal(stageNow(run), "weigh");
  return toReview(run);
}

function toReview(run: Run): Run {
  run = submit(run, { Pick: "sqlite" }).run;
  run = advance(run).run;
  run = submit(run, { Premortem: "it grows" }).run;
  run = advance(run).run;
  assert.equal(stageNow(run), "review");
  return run;
}

test("compiled full-control and full-send equal their stages.json on stages, allow and start", () => {
  for (const name of ["full-control", "full-send"]) {
    const json = parseMachine(JSON.parse(fixture(`${name}.stages.json`)));
    if (!json.ok) throw new Error(json.error);
    const fromSkill = compiled(`${name}.md`);
    const shape = (m: Machine) => ({
      allow: m.allow,
      start: m.start,
      stages: m.stages.map((s) => ({ id: s.id, title: s.title, inputs: s.inputs, outputs: s.outputs, allow: s.allow, gate: s.gate, next: s.next, autopilot: s.autopilot })),
    });
    assert.deepEqual(shape(fromSkill), shape(json.machine), name);
  }
});

test("stage_start refuses missing and unknown inputs by name; given inputs are stored and shown", () => {
  const source = { kind: "skill" as const, skill: "think-it-through", machine: think };
  const missing = step(null, { by: "agent", op: "start", source, inputs: { Task: "x", Extra: "y" } }, T0, ids());
  assert.equal(missing.run, null);
  assert.match(refusal(missing.reply), /Unknown inputs: Extra/);
  assert.match(refusal(missing.reply), /Missing inputs: Choice/);
  const run = started();
  assert.deepEqual(run.inputs, { Task: "pick a db", Choice: "sqlite or postgres" });
  assert.match(statusText(run), /pick a db/);
});

test("the first true edge wins, the edge without condition is the fallback, and because is logged", () => {
  let run = started();
  run = submit(run, { Frame: "f", Clear: "no", Musts: "1. a" }).run;
  run = advance(run).run;
  assert.equal(stageNow(run), "ask");
  assert.match(endText(run.log.at(-1)!.end), /advanced to ask, because equals\(\$frame\.Clear, "no"\)/);
  run = atReview();
  assert.match(endText(run.log.find((r) => r.stage === "frame")!.end), /advanced to weigh, because no condition held/);
});

test("typed submit: a choice outside its options, bad map positions and a derived output are refused with what is allowed", () => {
  const run = atReview();
  assert.match(refusal(submit(run, { Checks: "- 1: nope — x\n- 2: met" }).reply), /"nope" is not one of: met, broken, unclear/);
  assert.match(refusal(submit(run, { Checks: "- 1: met" }).reply), /missing positions: 2/);
  assert.match(refusal(submit(run, { Checks: "- 1: met\n- 1: met\n- 2: met" }).reply), /position 1 is given twice/);
  assert.match(refusal(submit(run, { Checks: "- 1: met\n- 2: met\n- 3: met" }).reply), /position 3 is not an entry/);
  assert.match(refusal(submit(run, { Verdict: "pass" }).reply), /Verdict is decided by the track .*submit only: Checks/);
  const frame = started();
  assert.match(refusal(submit(frame, { Clear: "maybe" }).reply), /Output Clear: "maybe" is not one of: yes, no/);
});

test("an explicit to that differs from the decided edge is refused naming it and why", () => {
  let run = atReview();
  run = submit(run, { Checks: "- 1: broken — too slow\n- 2: unclear — no price" }).run;
  const wrong = refusal(advance(run, "done").reply);
  assert.match(wrong, /The track decides this branch: "weigh"/);
  assert.match(wrong, /any\(\$review\.Checks, "broken"\)|equals\(\$review\.Verdict, "fix"\)/);
  const right = advance(run, "weigh");
  assert.equal(right.reply.kind, "entered");
  assert.equal(right.run.outputs.review?.Verdict, "fix");
});

const answer = (run: Run, approved: boolean, picks?: Record<string, string>) =>
  commit(run, { by: "system", op: "answered", runId: run.runId, ticket: ticket(run) as never, formId: lease(run).work!.id, approved, ...(picks ? { picks } : {}) });

test("fix, owner (decide), fix count two weigh traversals; the third fix routes to decide, where the owner's pick decides", () => {
  let run = atReview();
  assert.match(refusal(commit(run, { by: "agent", op: "proposeForce", ticket: ticket(run), to: "weigh", reason: "r" }).reply), /The track decides the branch/);
  run = submit(run, { Checks: "- 1: broken — slow\n- 2: met" }).run;
  run = advance(run).run;
  assert.equal(stageNow(run), "weigh");
  run = toReview(run);
  run = submit(run, { Checks: "- 1: unclear — which load\n- 2: met" }).run;
  run = advance(run).run;
  assert.equal(stageNow(run), "decide");
  assert.match(refusal(submit(run, { Decision: "fix" }).reply), /picked by the owner in the gate form/);
  assert.match(statusText(run), /The owner picks Decision \(fix, pass\) in the gate form/);
  assert.match(refusal(advance(run, "weigh").reply), /call stage_advance without to/);
  const asked = advance(run);
  assert.equal(asked.reply.kind, "pending");
  run = answer(asked.run, true).run;
  assert.equal(stageNow(run), "decide");
  assert.match(String(lease(run).outcome && JSON.stringify(lease(run).outcome)), /without picking Decision \(fix, pass\)/);
  run = advance(run).run;
  run = answer(run, true, { Decision: "fix" }).run;
  assert.equal(stageNow(run), "weigh");
  assert.equal(run.outputs.decide?.Decision, "fix");
  assert.match(endText(run.log.at(-1)!.end), /because equals\(\$decide\.Decision, "fix"\)/);
  run = toReview(run);
  run = submit(run, { Checks: "- 1: broken — still slow\n- 2: met" }).run;
  run = advance(run).run;
  assert.equal(stageNow(run), "weigh");
  assert.equal(run.edgeCounts?.["review>weigh"], 2);
  assert.equal(run.edgeCounts?.["decide>weigh"], 1);
  run = JSON.parse(JSON.stringify(toReview(run))) as Run;
  assert.equal(run.edgeCounts?.["review>weigh"], 2, "edgeCounts survive save and load");
  run = submit(run, { Checks: "- 1: broken — again\n- 2: met" }).run;
  assert.match(statusText(run), /at most 2 times, taken 2/);
  run = advance(run).run;
  assert.equal(stageNow(run), "decide");
  assert.match(endText(run.log.at(-1)!.end), /round limit reached: "weigh" was taken 2 of at most 2 times/);
  run = advance(run).run;
  run = answer(run, true, { Decision: "pass" }).run;
  assert.equal(run.state.kind, "done");
});

test("exceeded=owner refuses the exhausted branch and only then permits a force proposal", () => {
  const owner: Machine = { ...think, stages: think.stages.map((s) => (s.id === "review" ? { ...s, next: s.next.map((e) => (e.to === "weigh" ? { ...e, exceeded: "owner" } : e)) } : s)) };
  let run = commit(null, { by: "agent", op: "start", source: { kind: "skill", skill: "think-it-through", machine: owner }, inputs: { Task: "pick a db", Choice: "sqlite or postgres" } }).run;
  run = submit(run, { Frame: "the frame", Clear: "yes", Musts: "1. fast\n2. cheap" }).run;
  run = advance(run).run;
  for (let i = 0; i < 2; i++) {
    run = toReview(run);
    run = submit(run, { Checks: "- 1: broken — slow\n- 2: met" }).run;
    run = advance(run).run;
    assert.equal(stageNow(run), "weigh");
  }
  run = toReview(run);
  run = submit(run, { Checks: "- 1: broken — again\n- 2: met" }).run;
  assert.match(refusal(advance(run).reply), /^round limit reached: ask the owner/);
  assert.equal(commit(run, { by: "agent", op: "proposeForce", ticket: ticket(run), to: "premortem", reason: "the owner should pick" }).reply.kind, "pending");
});

test("all musts met finishes the run with its result; the brief shows types, formats and decided edges", () => {
  let run = atReview();
  const brief = statusText(run);
  assert.match(brief, /Checks \(map\(\$frame\.Musts, choice\(met, broken, unclear\)\)\)/);
  assert.match(brief, /format: one "- n: value — reason" line per entry n of \$frame\.Musts/);
  assert.match(brief, /Decided by the track \(do not submit\): Verdict/);
  assert.match(brief, /weigh — when A must is broken: go back to weigh \(the track decides: equals\(\$review\.Verdict, "fix"\)\)/);
  assert.match(brief, /done \(finishes the track\) — when All musts met: finish \(the track decides: when no other branch applies\)/);
  run = submit(run, { Checks: "- 1: met\n- 2: met" }).run;
  const out = advance(run);
  assert.equal(out.reply.kind, "finished");
  assert.equal(out.run.edgeCounts?.["review>done"], 1);
  assert.match(statusText(out.run), /Result:\n {2}- Pick: sqlite\n {2}- Premortem: it grows/);
});

test("a stored v2 run without inputs or edgeCounts still loads and advances; stages without cond edges keep pickEdge", () => {
  const plain = parseMachine({
    id: "plain",
    title: "Plain",
    stages: [
      { id: "a", title: "A", outputs: [{ name: "x" }], gate: [{ type: "outputs" }], next: [{ to: "b" }, { to: "c" }] },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ],
  });
  if (!plain.ok) throw new Error(plain.error);
  let run = commit(null, { by: "agent", op: "start", source: { kind: "skill", skill: "plain", machine: plain.machine } }).run;
  assert.equal("inputs" in run, false);
  const stored = JSON.parse(JSON.stringify(run)) as Run;
  delete stored.edgeCounts;
  run = submit(stored, { x: "1" }).run;
  assert.match(refusal(advance(run).reply), /stage "a" branches; pass to: one of b, c/);
  run = advance(run, "c").run;
  assert.equal(stageNow(run), "c");
  assert.equal(run.log.at(-1)!.end.kind === "advanced" && "because" in run.log.at(-1)!.end, false);
  assert.equal(commit(run, { by: "agent", op: "proposeForce", ticket: ticket(run), to: "a", reason: "redo" }).reply.kind, "pending");
});
