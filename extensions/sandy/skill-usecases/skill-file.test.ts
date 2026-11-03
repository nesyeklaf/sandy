import { test } from "node:test";
import assert from "node:assert/strict";
import { formatIo, parseIo } from "./io.ts";
import { applyDraft, emptyIoRow, formatIoRows, ioRowProblems, isDraftChanged, parseSkillFile, type SkillDraft } from "./skill-file.ts";

const SKILL = [
  "---",
  "name: quick-send",
  "# owner note",
  'description: "Finish a small agreed task alone. Use for quick send"',
  "license: MIT",
  "metadata:",
  '  author: "forge"',
  '  inputs: "Issue: url; Mode?: choice(fast, careful); Plan?: file(plan.md)"',
  "  tags:",
  "    - quick",
  "allowed-tools: Bash Read",
  "---",
  "",
  "# Quick send",
  "",
  "Body text.",
  "",
].join("\n");

function draftOf(content: string): SkillDraft {
  const parsed = parseSkillFile(content);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.draft;
}

test("an untouched draft writes the file back byte for byte", () => {
  const draft = draftOf(SKILL);
  assert.equal(applyDraft(SKILL, draft), SKILL);
  assert.equal(isDraftChanged(SKILL, draft), false);
  const crlf = SKILL.replaceAll("\n", "\r\n");
  assert.equal(applyDraft(crlf, draftOf(crlf)), crlf);
});

test("parsing reads description, IO rows, string metadata and keeps the rest aside", () => {
  const draft = draftOf(SKILL);
  assert.equal(draft.name, "quick-send");
  assert.equal(draft.description, "Finish a small agreed task alone. Use for quick send");
  assert.deepEqual(draft.inputs, [
    { name: "Issue", optional: false, kind: "url", path: "", values: "" },
    { name: "Mode", optional: true, kind: "choice", path: "", values: "fast, careful" },
    { name: "Plan", optional: true, kind: "file", path: "plan.md", values: "" },
  ]);
  assert.deepEqual(draft.outputs, []);
  assert.deepEqual(draft.metadata, [{ key: "author", value: "forge" }]);
  assert.deepEqual(draft.keptMetadataKeys, ["tags"]);
  assert.equal(draft.body, "\n# Quick send\n\nBody text.\n");
});

test("IO rows format back to the metadata string they came from", () => {
  const raw = "Issue: url; Mode?: choice(fast, careful); Plan?: file(plan.md); Notes: text; Doc: file";
  const rows = parseIo(raw).fields.map((field) => ({ ...emptyIoRow(), name: field.name, optional: field.optional, kind: field.type.kind, path: field.type.kind === "file" ? (field.type.path ?? "") : "", values: field.type.kind === "choice" ? field.type.values.join(", ") : "" }));
  assert.equal(formatIoRows(rows), raw);
  assert.equal(formatIo(parseIo(formatIoRows(rows)).fields), raw);
});

test("editing the description changes only its line and keeps order, comments and unknown keys", () => {
  const next = applyDraft(SKILL, { ...draftOf(SKILL), description: "Ship it: with a colon # and a hash" });
  const before = SKILL.split("\n");
  const after = next.split("\n");
  assert.equal(after.length, before.length);
  assert.deepEqual(
    after.flatMap((line, index) => (line === before[index] ? [] : [line])),
    ['description: "Ship it: with a colon # and a hash"'],
  );
  assert.equal(draftOf(next).description, "Ship it: with a colon # and a hash");
});

test("new outputs and metadata keys are written as quoted strings under metadata", () => {
  const draft = draftOf(SKILL);
  const next = applyDraft(SKILL, {
    ...draft,
    outputs: [{ name: "Report", optional: false, kind: "file", path: "report.md", values: "" }],
    metadata: [{ key: "author", value: "owner" }, { key: "version", value: "2" }],
  });
  assert.match(next, /\n {2}author: "owner"\n/u);
  assert.match(next, /\n {2}outputs: "Report: file\(report\.md\)"\n/u);
  assert.match(next, /\n {2}version: "2"\n/u);
  assert.match(next, /\n {2}tags:\n {4}- quick\n/u);
  assert.ok(next.indexOf("license: MIT") < next.indexOf("metadata:"));
  assert.ok(next.indexOf("metadata:") < next.indexOf("allowed-tools"));
  const reread = draftOf(next);
  assert.deepEqual(reread.outputs, [{ name: "Report", optional: false, kind: "file", path: "report.md", values: "" }]);
  assert.deepEqual(reread.metadata, [{ key: "author", value: "owner" }, { key: "version", value: "2" }]);
});

test("removing every metadata entry drops the empty metadata block", () => {
  const plain = "---\nname: tiny\ndescription: Small\nmetadata:\n  inputs: \"Goal: text\"\n---\nBody\n";
  const next = applyDraft(plain, { ...draftOf(plain), inputs: [] });
  assert.equal(next, "---\nname: tiny\ndescription: Small\n---\nBody\n");
});

test("adding inputs to a skill without metadata creates the block", () => {
  const plain = "---\nname: tiny\ndescription: Small\n---\nBody\n";
  const next = applyDraft(plain, { ...draftOf(plain), inputs: [{ name: "Goal", optional: true, kind: "text", path: "", values: "" }] });
  assert.equal(next, '---\nname: tiny\ndescription: Small\nmetadata:\n  inputs: "Goal?: text"\n---\nBody\n');
});

test("unreadable IO entries stay as written until their rows are edited", () => {
  const broken = '---\nname: x\ndescription: d\nmetadata:\n  inputs: "Goal: text; oops"\n---\n';
  const parsed = parseSkillFile(broken);
  assert.ok(parsed.ok);
  assert.equal(parsed.warnings.length, 1);
  assert.equal(applyDraft(broken, { ...parsed.draft, body: "new\n" }), broken + "new\n");
});

test("IO row problems come from parseIo plus the PascalCase rule", () => {
  assert.deepEqual(ioRowProblems([{ name: "Goal", optional: false, kind: "text", path: "", values: "" }]), []);
  assert.equal(ioRowProblems([emptyIoRow()]).length, 1);
  assert.match(ioRowProblems([{ name: "Mode", optional: false, kind: "choice", path: "", values: "only" }])[0] ?? "", /at least two values/u);
  assert.match(ioRowProblems([{ name: "plan file", optional: false, kind: "file", path: "", values: "" }])[0] ?? "", /PascalCase/u);
});

test("a file without frontmatter or with broken YAML is reported, not guessed", () => {
  assert.deepEqual(parseSkillFile("# Just a body\n"), { ok: false, error: "The file has no frontmatter block between --- lines." });
  const broken = parseSkillFile("---\nname: [unclosed\n---\n");
  assert.equal(broken.ok, false);
});
