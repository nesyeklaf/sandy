import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { readStages, replaceStage, setTag, sourceProblems, stageSource } from "./skill-stages.ts";

const fixture = readFileSync(new URL("../../../packages/skill-dialect/test/fixtures/full-send.md", import.meta.url), "utf8");

function changedLines(before: string, after: string): number[] {
  const a = before.split("\n");
  const b = after.split("\n");
  assert.equal(a.length, b.length);
  return a.flatMap((line, index) => (line === b[index] ? [] : [index + 1]));
}

test("readStages lists every stage with its compiled form and editable output tags", () => {
  const read = readStages(fixture);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.problems, []);
  assert.deepEqual(read.stages.slice(0, 3).map((stage) => stage.id), ["entry", "build", "verify"]);
  const entry = read.stages[0]!;
  assert.equal(entry.title, "Entry gate");
  assert.deepEqual(entry.outputs.map((output) => output.attrs.name), ["mr_url", "go", "shape"]);
  assert.equal(entry.compiled?.next[0]?.to, "build");
  assert.match(stageSource(fixture, entry), /^\{% stage id="entry"/u);
});

test("editing one stage output tag changes only that tag's line and keeps every other byte", () => {
  const read = readStages(fixture);
  if (!read.ok) throw new Error(read.error);
  const output = read.stages[1]!.outputs[0]!;
  const edited = setTag(fixture, output, { ...output.attrs, description: "per slice: commit and Accept result" });
  assert.deepEqual(changedLines(fixture, edited), [output.line]);
  assert.equal(edited.slice(0, output.start), fixture.slice(0, output.start));
  assert.equal(edited.slice(edited.length - (fixture.length - output.end)), fixture.slice(output.end));
  assert.deepEqual(sourceProblems(edited), []);
  const reread = readStages(edited);
  assert.equal(reread.ok && reread.stages[1]!.compiled?.outputs[0]?.description, "per slice: commit and Accept result");
});

test("replacing a stage block leaves the rest of the file untouched and reports parser problems", () => {
  const read = readStages(fixture);
  if (!read.ok) throw new Error(read.error);
  const verify = read.stages[2]!;
  const text = stageSource(fixture, verify).replace('title="Verify the whole"', 'title="Verify everything"');
  const edited = replaceStage(fixture, verify, text);
  assert.deepEqual(changedLines(fixture, edited), [verify.line]);
  const broken = replaceStage(fixture, verify, stageSource(fixture, verify).replace('to="build"', 'to="nowhere"'));
  assert.ok(sourceProblems(broken).some((problem) => problem.message.includes("nowhere")));
});

test("tags with variable or function attributes are not offered for structured edits", () => {
  const source = '---\nname: demo\ndescription: d\nmetadata:\n  dialect: "1"\n---\n{% stage id="a" %}\nDo it.\n{% output name="x" /%}\n{% next to="done" when=equals($a.x, "y") /%}\n{% next to="done" /%}\n{% /stage %}\n';
  const read = readStages(source);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.stages[0]!.outputs.map((output) => output.attrs.name), ["x"]);
});
