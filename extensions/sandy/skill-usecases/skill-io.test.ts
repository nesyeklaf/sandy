import { test } from "node:test";
import assert from "node:assert/strict";
import { readIo, writeIoTags } from "./skill-io.ts";

const STAGED = [
  "---",
  "name: review-flow",
  "description: Review in stages",
  "metadata:",
  '  dialect: "1"',
  "---",
  "# Review",
  "",
  '{% input name="Diff" type="file" description="The change" /%}',
  "",
  '{% stage id="read" %}',
  "Read it.",
  '{% output name="notes" type="file(notes.md)" /%}',
  '{% next to="done" /%}',
  "{% /stage %}",
  "",
  '{% result name="Notes" from=$read.notes /%}',
  "",
].join("\n");

test("a staged skill reads its inputs from tags and its outputs from result tags", () => {
  const io = readIo(STAGED, { inputs: "Ignored: text" });
  assert.equal(io.source, "tags");
  assert.deepEqual(io.inputs, [{ name: "Diff", optional: false, type: { kind: "file", path: null } }]);
  assert.deepEqual(io.outputs.map((field) => field.name), ["Notes"]);
  assert.deepEqual(io.errors, []);
});

test("changing an input type keeps its description and leaves stages and results alone", () => {
  const next = writeIoTags(STAGED, {
    inputs: [{ name: "Diff", optional: true, type: { kind: "url" } }],
    outputs: [{ name: "Notes", optional: false, type: { kind: "text" } }],
  });
  assert.equal(next, STAGED.replace('{% input name="Diff" type="file" description="The change" /%}', '{% input name="Diff" type="url" description="The change" optional=true /%}'));
});

test("removing every input deletes its tag line and nothing else", () => {
  const next = writeIoTags(STAGED, { inputs: [] });
  assert.equal(next, STAGED.replace('{% input name="Diff" type="file" description="The change" /%}\n', ""));
});
