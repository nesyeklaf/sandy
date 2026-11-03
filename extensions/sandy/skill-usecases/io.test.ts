import { test } from "node:test";
import assert from "node:assert/strict";
import { formatIo, parseIo, satisfies, type IoType } from "./io.ts";

test("parseIo reads every type, optional marks and round-trips through formatIo", () => {
  const source = "Feature: text; Link?: url; Notes: file; Journeys: file(journeys.md); Mode?: choice(new, rework)";
  const { fields, errors } = parseIo(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(fields, [
    { name: "Feature", optional: false, type: { kind: "text" } },
    { name: "Link", optional: true, type: { kind: "url" } },
    { name: "Notes", optional: false, type: { kind: "file", path: null } },
    { name: "Journeys", optional: false, type: { kind: "file", path: "journeys.md" } },
    { name: "Mode", optional: true, type: { kind: "choice", values: ["new", "rework"] } },
  ]);
  assert.equal(formatIo(fields), source);
});

test("parseIo treats a missing or blank value as no fields", () => {
  assert.deepEqual(parseIo(undefined), { fields: [], errors: [] });
  assert.deepEqual(parseIo("  "), { fields: [], errors: [] });
});

test("parseIo reports each grammar error and keeps the valid entries", () => {
  const cases: [string, RegExp][] = [
    ["A: text;; B: url", /entry 2 is empty/u],
    ["Feature", /has no type/u],
    [": text", /has no name/u],
    ["A: number", /unknown type "number"/u],
    ["A: list(x, y)", /unknown type "list\(\.\.\.\)"/u],
    ["A: file()", /file\(\) needs a path/u],
    ["A: choice(one)", /at least two values/u],
    ["A: choice(a, , b)", /empty value/u],
    ["A: choice(a, a)", /repeats a value/u],
    ["A: text; A: url", /declared twice/u],
  ];
  for (const [source, pattern] of cases) {
    const { errors } = parseIo(source);
    assert.equal(errors.length, 1, source);
    assert.match(errors[0] ?? "", pattern, source);
  }
  assert.deepEqual(parseIo("A: text; B: bogus").fields.map((field) => field.name), ["A"]);
});

test("satisfies follows the compatibility table", () => {
  const text: IoType = { kind: "text" };
  const url: IoType = { kind: "url" };
  const file: IoType = { kind: "file", path: "a.md" };
  const anyFile: IoType = { kind: "file", path: null };
  const ab: IoType = { kind: "choice", values: ["a", "b"] };
  const abc: IoType = { kind: "choice", values: ["a", "b", "c"] };
  const rows: [IoType, IoType, boolean][] = [
    [text, text, true],
    [url, url, true],
    [file, anyFile, true],
    [anyFile, file, true],
    [file, text, true],
    [ab, text, true],
    [ab, abc, true],
    [abc, ab, false],
    [text, file, false],
    [text, url, false],
    [url, text, false],
    [text, ab, false],
    [file, url, false],
  ];
  for (const [output, input, expected] of rows) assert.equal(satisfies(output, input), expected, JSON.stringify([output, input]));
});
