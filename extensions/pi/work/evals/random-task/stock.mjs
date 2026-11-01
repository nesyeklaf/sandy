// Family "stock": a CSV inventory reader with a report CLI (src/csv.js, src/report.js, cli.js).
import { J, WORDS, pkg, raw } from "./util.mjs";

const REPORT = "src/report.js";
const CSV = "src/csv.js";
const CLI = "cli.js";
const PRINT = "    for (const t of totals)"; // anchor in the base CLI: flags insert code before it
const NEW_COMMAND = "  report() {\n"; // anchor: new commands insert code before it
const cmp = (a, b) => `(${a} < ${b} ? -1 : ${a} > ${b} ? 1 : 0)`;

function params(r) {
  return {
    key: r.pick(["sku", "code", "item"]),
    qty: r.pick(["qty", "count", "units"]),
    price: r.pick(["price", "cost", "rate"]),
    sep: r.pick([",", "'", "_"]),
    fMoney: r.pick(["formatMoney", "fmtMoney", "money"]),
    fTotals: r.pick(["lineTotals", "totalsByKey", "sumLines"]),
    fLow: r.pick(["lowStock", "belowLevel", "reorderList"]),
    fTop: r.pick(["topLines", "biggestLines", "rankByValue"]),
    fMerge: r.pick(["mergeRows", "combineRows", "mergeInventories"]),
    fValid: r.pick(["validateRows", "auditRows", "rowProblems"]),
    fPrefix: r.pick(["totalsByPrefix", "prefixTotals", "groupByPrefix"]),
    fWrite: r.pick(["writeCsv", "toCsv", "serializeRows"]),
    minFlag: r.pick(["min", "floor", "at-least"]),
    sortFlag: r.pick(["order", "sort", "rank"]),
    fmtFlag: r.pick(["format", "as", "output"]),
    cmdSummary: r.pick(["summary", "totals", "overview"]),
    cmdCheck: r.pick(["check", "lint", "audit"]),
    labels: r.pick([["rows", "units", "value"], ["lines", "pieces", "worth"], ["entries", "stock", "amount"]]),
    negWord: r.pick(["negative", "below-zero", "oversold"]),
    w: r.sample(WORDS, 6),
    ex: r.sample([2, 3, 4, 64, 70], 5),
    names: r.sample(["Bolt", "Nut", "Washer", "Screw", "Gasket", "Rivet", "Clamp"], 3),
    letter: r.pick(["A", "B", "K", "T"]),
  };
}

function base(p) {
  const { key: K, qty: Q, price: P } = p;
  const [n1, n2] = p.names;
  const k1 = p.letter + "1";
  const k2 = p.letter + "2";
  return {
    "package.json": pkg("stock-report"),
    "README.md": `# Stock report

Reads inventory CSV files (columns ${K}, name, ${Q}, ${P}) and prints totals per ${K}.

## Usage

    node cli.js report <file.csv>

Prints one line per ${K}, sorted by ${K}: the ${K}, a tab, and the total (${Q} times ${P}, summed over all rows of that ${K}) with two decimals.

## Modules

- src/csv.js: ¦parseCsv(text)¦ turns CSV text into row objects (${Q} and ${P} become numbers).
- src/report.js: ¦${p.fTotals}(rows)¦ and ¦${p.fMoney}(n)¦.
`.replaceAll("¦", "'"),
    [CSV]: raw`// Minimal CSV reader: the first line is the header, the ${Q} and ${P} columns become numbers.
const NUMERIC = [${J(Q)}, ${J(P)}];

function skipLine(line) {
  return line.trim() === "";
}

function splitLine(line) {
  return line.split(",");
}

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => !skipLine(line));
  if (lines.length === 0) return [];
  const cols = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row = {};
    cols.forEach((col, i) => {
      row[col] = NUMERIC.includes(col) ? Number(cells[i]) : cells[i];
    });
    return row;
  });
}
`,
    [REPORT]: raw`export function ${p.fMoney}(n) {
  return n.toFixed(2);
}

export function ${p.fTotals}(rows) {
  const totals = new Map();
  for (const row of rows) {
    totals.set(row.${K}, (totals.get(row.${K}) ?? 0) + row.${Q} * row.${P});
  }
  return [...totals]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
`,
    [CLI]: raw`#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseCsv } from "./src/csv.js";
import { ${p.fTotals}, ${p.fMoney} } from "./src/report.js";

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      flags[argv[i].slice(2)] = next === undefined || next.startsWith("--") ? true : argv[++i];
    } else {
      pos.push(argv[i]);
    }
  }
  return { pos, flags };
}

const { pos, flags } = parseArgs(process.argv.slice(2));

const commands = {
  report() {
    let totals = ${p.fTotals}(parseCsv(readFileSync(pos[1], "utf8")));
    for (const t of totals) console.log(t.key + "\t" + ${p.fMoney}(t.total));
  },
};

if (!commands[pos[0]]) {
  console.error("usage: node cli.js report <file.csv>");
  process.exit(1);
}
commands[pos[0]]();
`,
    "src/csv.test.js": raw`import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./csv.js";

test("parseCsv reads the header and converts numbers", () => {
  const rows = parseCsv("${K},name,${Q},${P}\n${k1},${n1},3,0.5\n\n${k2},${n2},10,0.25\n");
  assert.deepEqual(rows, [
    { ${K}: "${k1}", name: "${n1}", ${Q}: 3, ${P}: 0.5 },
    { ${K}: "${k2}", name: "${n2}", ${Q}: 10, ${P}: 0.25 },
  ]);
});

test("parseCsv of an empty text is an empty list", () => {
  assert.deepEqual(parseCsv(""), []);
});
`,
    "src/report.test.js": raw`import test from "node:test";
import assert from "node:assert/strict";
import { ${p.fTotals}, ${p.fMoney} } from "./report.js";

test("${p.fTotals} sums ${Q} times ${P} per ${K}, sorted by ${K}", () => {
  const rows = [
    { ${K}: "${k2}", ${Q}: 2, ${P}: 1.5 },
    { ${K}: "${k1}", ${Q}: 1, ${P}: 4 },
    { ${K}: "${k2}", ${Q}: 2, ${P}: 0.25 },
  ];
  assert.deepEqual(${p.fTotals}(rows), [
    { key: "${k1}", total: 4 },
    { key: "${k2}", total: 3.5 },
  ]);
});

test("${p.fMoney} keeps two decimals", () => {
  assert.equal(${p.fMoney}(12.5), "12.50");
  assert.equal(${p.fMoney}(0), "0.00");
});
`,
    "cli.test.js": raw`import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("report prints one line per ${K}", () => {
  const file = join(mkdtempSync(join(tmpdir(), "stock-")), "in.csv");
  writeFileSync(file, "${K},name,${Q},${P}\n${k2},${n2},2,1.5\n${k1},${n1},4,0.25\n");
  const out = execFileSync(process.execPath, ["cli.js", "report", file], { encoding: "utf8" });
  assert.equal(out, "${k1}\t1.00\n${k2}\t3.00\n");
});
`,
  };
}

function hiddenHead(p) {
  return raw`import * as csv from "../src/csv.js";
import * as report from "../src/report.js";
const K = ${J(p.key)}, Q = ${J(p.qty)}, P = ${J(p.price)};
const R = (k, q, pr, name = "item") => ({ [K]: k, name, [Q]: q, [P]: pr });
const CSV = (rows) => [[K, "name", Q, P].join(","), ...rows].join("\n") + "\n";
const go = (rows, ...args) => {
  const d = H.tmp({ "in.csv": CSV(rows) });
  return H.cli(args.map((a) => (a === "@" ? d + "/in.csv" : a)), d);
};
const FILE = ["a1,x,2,5", "b2,y,1,3", "c3,z,4,2.5", "d4,w,1,0.5"];
const REPORT = ["a1\t10.00", "b2\t3.00", "c3\t10.00", "d4\t0.50"];
`;
}

// Each template: key, text(p) for the prompt (¦ becomes a backtick), test(p) for the hidden test body,
// edits(p) for the reference ({file, add} appends, {file, from, to} replaces), bad(p) = [from, to] that breaks it.
const templates = [
  {
    key: "lowStock",
    text: (p) => `In src/report.js export ¦${p.fLow}(rows, threshold)¦: it returns the ¦${p.key}¦ values of the rows whose ¦${p.qty}¦ is strictly below ¦threshold¦, ordered by ¦${p.qty}¦ ascending (rows with equal ¦${p.qty}¦ keep their input order). A ¦threshold¦ that is not a finite number (typeof must be "number") makes it throw an Error whose message contains the word ¦${p.w[0]}¦.`,
    test: (p) => raw`const rows = [R("a1", 5, 1), R("b2", 2, 1), R("c3", 9, 1), R("d4", 2, 1), R("e5", 0, 1)];
assert.deepEqual(report.${p.fLow}(rows, 6), ["e5", "b2", "d4", "a1"]);
assert.deepEqual(report.${p.fLow}(rows, 5), ["e5", "b2", "d4"]);
assert.deepEqual(report.${p.fLow}(rows, 100), ["e5", "b2", "d4", "a1", "c3"]);
assert.deepEqual(report.${p.fLow}(rows, 0), []);
assert.deepEqual(report.${p.fLow}(rows, -1), []);
assert.deepEqual(report.${p.fLow}([], 5), []);
for (const bad of ["5", NaN, undefined]) H.throwsWith(() => report.${p.fLow}(rows, bad), "${p.w[0]}");`,
    edits: (p) => [{ file: REPORT, add: raw`
export function ${p.fLow}(rows, threshold) {
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) throw new TypeError("${p.w[0]}: threshold must be a finite number");
  return rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => row.${p.qty} < threshold)
    .sort((a, b) => a.row.${p.qty} - b.row.${p.qty} || a.i - b.i)
    .map(({ row }) => row.${p.key});
}
` }],
    bad: (p) => [`row.${p.qty} < threshold`, `row.${p.qty} <= threshold`],
  },
  {
    key: "topLines",
    text: (p) => `In src/report.js export ¦${p.fTop}(rows, n)¦: it returns the ¦${p.key}¦ values of the ¦n¦ rows with the highest line total (¦${p.qty}¦ times ¦${p.price}¦ of that single row, rows are not merged), highest first; equal totals are ordered by ¦${p.key}¦ ascending using plain ¦<¦ / ¦>¦ string comparison. ¦n¦ larger than the row count returns all rows. An ¦n¦ that is not a non-negative integer makes it throw an Error whose message contains the word ¦${p.w[1]}¦.`,
    test: (p) => raw`const rows = [R("a", 2, 3), R("b", 1, 10), R("c", 3, 2), R("d", 4, 0.5), R("e", 5, 2)];
assert.deepEqual(report.${p.fTop}(rows, 3), ["b", "e", "a"]);
assert.deepEqual(report.${p.fTop}(rows, 10), ["b", "e", "a", "c", "d"]);
assert.deepEqual(report.${p.fTop}(rows, 0), []);
assert.deepEqual(report.${p.fTop}([], 2), []);
assert.deepEqual(rows.map((r) => r[K]), ["a", "b", "c", "d", "e"]);
for (const bad of [1.5, -1, "2"]) H.throwsWith(() => report.${p.fTop}(rows, bad), "${p.w[1]}");`,
    edits: (p) => [{ file: REPORT, add: raw`
export function ${p.fTop}(rows, n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("${p.w[1]}: n must be a non-negative integer");
  return [...rows]
    .sort((a, b) => b.${p.qty} * b.${p.price} - a.${p.qty} * a.${p.price} || ${cmp("a." + p.key, "b." + p.key)})
    .slice(0, n)
    .map((row) => row.${p.key});
}
` }],
    bad: () => [".slice(0, n)", ".slice(0, n + 1)"],
  },
  {
    key: "comments",
    text: (p) => `Change ¦parseCsv¦ in src/csv.js: lines whose first character is ¦#¦ are ignored wherever they appear (also before the header), in addition to blank lines. A ¦#¦ inside a line is ordinary data.`,
    test: (p) => raw`const text = "# exported by hand\n" + [K, "name", Q, P].join(",") + "\n\n# note\na1,x#y,2,1.5\n   \n# c,3,3\nb2,z,1,3\n";
const rows = csv.parseCsv(text);
assert.deepEqual(rows.map((r) => r[K]), ["a1", "b2"]);
assert.equal(rows[0].name, "x#y");
assert.equal(rows[0][Q], 2);
assert.equal(rows[1][P], 3);
assert.deepEqual(csv.parseCsv("# only a comment\n"), []);
assert.equal(csv.parseCsv(CSV(["#a1,x,1,1"])).length, 0);`,
    edits: () => [{ file: CSV, from: `  return line.trim() === "";`, to: `  return line.trim() === "" || line.startsWith("#");` }],
    bad: () => [`startsWith("#")`, `startsWith("//")`],
  },
  {
    key: "quotes",
    text: (p) => `Change ¦parseCsv¦ in src/csv.js to understand double-quoted fields: a field wrapped in ¦"¦ may contain commas, ¦""¦ inside it stands for one literal quote, and the wrapping quotes are not part of the value (¦"Widget, large"¦ gives ¦Widget, large¦, ¦""¦ gives an empty string). Unquoted fields behave as before.`,
    test: (p) => raw`const rows = csv.parseCsv(CSV(['a1,"Widget, large",3,2.5', 'a2,"say ""hi""",1,1', 'a3,"",4,1', 'a4,plain,2,2']));
assert.deepEqual(rows.map((r) => r.name), ["Widget, large", 'say "hi"', "", "plain"]);
assert.deepEqual(rows.map((r) => r[Q]), [3, 1, 4, 2]);
assert.deepEqual(rows.map((r) => r[K]), ["a1", "a2", "a3", "a4"]);`,
    edits: () => [{ file: CSV, from: `  return line.split(",");`, to: raw`  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c !== '"') cur += c;
      else if (line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else cur += c;
  }
  cells.push(cur);
  return cells;` }],
    bad: () => [`line[i + 1] === '"'`, "false"],
  },
  {
    key: "moneyGrouping",
    text: (p) => `Change ¦${p.fMoney}(n)¦ in src/report.js: the integer part is grouped in threes with the separator ¦${p.sep}¦ (¦${p.fMoney}(1234567.891)¦ is ¦"1${p.sep}234${p.sep}567.89"¦, ¦${p.fMoney}(12.5)¦ stays ¦"12.50"¦). The number is still rounded to two decimals first, and a negative number keeps a leading ¦-¦ (¦${p.fMoney}(-1234.5)¦ is ¦"-1${p.sep}234.50"¦).`,
    test: (p) => raw`const S = ${J(p.sep)};
const f = report.${p.fMoney};
assert.equal(f(12.5), "12.50");
assert.equal(f(0), "0.00");
assert.equal(f(100), "100.00");
assert.equal(f(1234.5), "1" + S + "234.50");
assert.equal(f(1234567.891), "1" + S + "234" + S + "567.89");
assert.equal(f(1000), "1" + S + "000.00");
assert.equal(f(999.999), "1" + S + "000.00");
assert.equal(f(-1234.5), "-1" + S + "234.50");
assert.equal(f(-12), "-12.00");
assert.equal(f(-1000), "-1" + S + "000.00");`,
    edits: (p) => [{ file: REPORT, from: "  return n.toFixed(2);", to: raw`  const [int, frac] = Math.abs(n).toFixed(2).split(".");
  return (n < 0 ? "-" : "") + int.replace(/\B(?=(\d{3})+$)/g, ${J(p.sep)}) + "." + frac;` }],
    bad: () => ["\\d{3}", "\\d{2}"],
  },
  {
    key: "minFlag",
    text: (p) => `¦node cli.js report <file.csv> --${p.minFlag} <n>¦ prints only the report lines whose unformatted total is at least ¦n¦. If ¦n¦ is missing or not a number, nothing goes to stdout, stderr gets a message containing the word ¦${p.w[2]}¦ and the exit code is ${p.ex[0]}.`,
    test: (p) => raw`const F = "--${p.minFlag}";
assert.deepEqual(H.ok(go(FILE, "report", "@")), REPORT);
assert.deepEqual(H.ok(go(FILE, "report", "@", F, "3")), ["a1\t10.00", "b2\t3.00", "c3\t10.00"]);
assert.deepEqual(H.ok(go(FILE, "report", "@", F, "10.5")), []);
assert.deepEqual(H.ok(go(FILE, "report", "@", F, "0")), REPORT);
H.failed(go(FILE, "report", "@", F, "abc"), "${p.w[2]}", ${p.ex[0]});
H.failed(go(FILE, "report", "@", F), "${p.w[2]}", ${p.ex[0]});`,
    edits: (p) => [{ file: CLI, from: PRINT, to: raw`    if (flags[${J(p.minFlag)}] !== undefined) {
      const min = Number(flags[${J(p.minFlag)}]);
      if (flags[${J(p.minFlag)}] === true || Number.isNaN(min)) {
        console.error("${p.w[2]}: --${p.minFlag} needs a number");
        process.exit(${p.ex[0]});
      }
      totals = totals.filter((t) => t.total >= min);
    }
${PRINT}` }],
    bad: () => ["t.total >= min", "t.total > min"],
  },
  {
    key: "sortFlag",
    text: (p) => `¦node cli.js report <file.csv> --${p.sortFlag} <by>¦: ¦key¦ (the default) keeps the current order; ¦total¦ orders the lines by unformatted total, highest first, equal totals by ${p.key} ascending. Any other value, or no value, prints nothing to stdout, writes a message containing the word ¦${p.w[3]}¦ to stderr and exits with code ${p.ex[1]}.`,
    test: (p) => raw`const F = "--${p.sortFlag}";
assert.deepEqual(H.ok(go(FILE, "report", "@", F, "total")), ["a1\t10.00", "c3\t10.00", "b2\t3.00", "d4\t0.50"]);
assert.deepEqual(H.ok(go(FILE, "report", "@", F, "key")), REPORT);
assert.deepEqual(H.ok(go(FILE, "report", "@")), REPORT);
assert.deepEqual(H.ok(go([], "report", "@", F, "total")), []);
H.failed(go(FILE, "report", "@", F, "name"), "${p.w[3]}", ${p.ex[1]});
H.failed(go(FILE, "report", "@", F), "${p.w[3]}", ${p.ex[1]});`,
    edits: (p) => [{ file: CLI, from: PRINT, to: raw`    if (flags[${J(p.sortFlag)}] !== undefined) {
      if (flags[${J(p.sortFlag)}] === "total") {
        totals = [...totals].sort((a, b) => b.total - a.total || ${cmp("a.key", "b.key")});
      } else if (flags[${J(p.sortFlag)}] !== "key") {
        console.error("${p.w[3]}: --${p.sortFlag} takes key or total");
        process.exit(${p.ex[1]});
      }
    }
${PRINT}` }],
    bad: () => ["b.total - a.total", "a.total - b.total"],
  },
  {
    key: "formatFlag",
    text: (p) => `¦node cli.js report <file.csv> --${p.fmtFlag} <f>¦: ¦json¦ prints a single JSON array with one object per line, ¦{"${p.key}": <${p.key}>, "total": <formatted total string>}¦, in report order (¦[]¦ when there are no rows); ¦csv¦ prints the header ¦${p.key},total¦ followed by one ¦<${p.key}>,<formatted total>¦ line per row. Any other value prints nothing to stdout, writes a message containing the word ¦${p.w[4]}¦ to stderr and exits with code ${p.ex[2]}. Without the flag the output is unchanged.`,
    test: (p) => raw`const F = "--${p.fmtFlag}";
assert.deepEqual(JSON.parse(go(FILE, "report", "@", F, "json").out), [
  { [K]: "a1", total: "10.00" }, { [K]: "b2", total: "3.00" }, { [K]: "c3", total: "10.00" }, { [K]: "d4", total: "0.50" },
]);
assert.deepEqual(JSON.parse(H.ok(go([], "report", "@", F, "json")).join("")), []);
assert.deepEqual(H.ok(go(FILE, "report", "@", F, "csv")), [K + ",total", "a1,10.00", "b2,3.00", "c3,10.00", "d4,0.50"]);
assert.deepEqual(H.ok(go([], "report", "@", F, "csv")), [K + ",total"]);
assert.deepEqual(H.ok(go(FILE, "report", "@")), REPORT);
H.failed(go(FILE, "report", "@", F, "xml"), "${p.w[4]}", ${p.ex[2]});`,
    edits: (p) => [{ file: CLI, from: PRINT, to: raw`    const fmt = flags[${J(p.fmtFlag)}];
    if (fmt === "json") {
      console.log(JSON.stringify(totals.map((t) => ({ ${p.key}: t.key, total: ${p.fMoney}(t.total) }))));
      return;
    }
    if (fmt === "csv") {
      console.log("${p.key},total");
      totals.forEach((t) => console.log(t.key + "," + ${p.fMoney}(t.total)));
      return;
    }
    if (fmt !== undefined) {
      console.error("${p.w[4]}: --${p.fmtFlag} takes json or csv");
      process.exit(${p.ex[2]});
    }
${PRINT}` }],
    bad: () => ['fmt === "csv"', 'fmt === "tsv"'],
  },
  {
    key: "summaryCmd",
    text: (p) => `¦node cli.js ${p.cmdSummary} <file.csv>¦ prints exactly three lines: ¦${p.labels[0]}: <number of data rows>¦, ¦${p.labels[1]}: <sum of ${p.qty}>¦ and ¦${p.labels[2]}: <sum of ${p.qty} times ${p.price}>¦ with two decimals. A file with only a header prints zeros (¦${p.labels[2]}: 0.00¦). Exit code 0.`,
    test: (p) => raw`assert.deepEqual(H.ok(go(["a1,x,2,5", "a1,x,1,5", "b2,y,4,0.25"], "${p.cmdSummary}", "@")), ["${p.labels[0]}: 3", "${p.labels[1]}: 7", "${p.labels[2]}: 16.00"]);
assert.deepEqual(H.ok(go([], "${p.cmdSummary}", "@")), ["${p.labels[0]}: 0", "${p.labels[1]}: 0", "${p.labels[2]}: 0.00"]);
assert.deepEqual(H.ok(go(["z9,q,10,0.5"], "${p.cmdSummary}", "@")), ["${p.labels[0]}: 1", "${p.labels[1]}: 10", "${p.labels[2]}: 5.00"]);`,
    edits: (p) => [{ file: CLI, from: NEW_COMMAND, to: raw`  ${p.cmdSummary}() {
    const rows = parseCsv(readFileSync(pos[1], "utf8"));
    console.log("${p.labels[0]}: " + rows.length);
    console.log("${p.labels[1]}: " + rows.reduce((s, r) => s + r.${p.qty}, 0));
    console.log("${p.labels[2]}: " + ${p.fMoney}(rows.reduce((s, r) => s + r.${p.qty} * r.${p.price}, 0)));
  },
${NEW_COMMAND}` }],
    bad: () => ["rows.length", "new Set(rows.map((r) => r.sku ?? r.code ?? r.item)).size"],
  },
  {
    key: "checkCmd",
    text: (p) => `¦node cli.js ${p.cmdCheck} <file.csv>¦ prints ¦ok¦ and exits 0 when no row has a negative ¦${p.qty}¦. Otherwise it prints nothing to stdout, writes one line ¦${p.negWord}: <${p.key}>¦ per offending row to stderr in file order, and exits with code ${p.ex[3]}. A ¦${p.qty}¦ of 0 is fine.`,
    test: (p) => raw`assert.deepEqual(H.ok(go(FILE, "${p.cmdCheck}", "@")), ["ok"]);
assert.deepEqual(H.ok(go([], "${p.cmdCheck}", "@")), ["ok"]);
const r = go(["a1,x,3,1", "b2,y,-1,1", "c3,z,-2,1", "d4,w,0,1"], "${p.cmdCheck}", "@");
assert.equal(r.code, ${p.ex[3]});
assert.equal(r.out, "");
assert.deepEqual(H.lines(r.err), ["${p.negWord}: b2", "${p.negWord}: c3"]);`,
    edits: (p) => [{ file: CLI, from: NEW_COMMAND, to: raw`  ${p.cmdCheck}() {
    const negative = parseCsv(readFileSync(pos[1], "utf8")).filter((r) => r.${p.qty} < 0);
    if (negative.length === 0) {
      console.log("ok");
      return;
    }
    for (const r of negative) console.error("${p.negWord}: " + r.${p.key});
    process.exit(${p.ex[3]});
  },
${NEW_COMMAND}` }],
    bad: (p) => [`r.${p.qty} < 0`, `r.${p.qty} <= 0`],
  },
  {
    key: "mergeRows",
    text: (p) => `In src/report.js export ¦${p.fMerge}(a, b)¦: it merges two row lists by ¦${p.key}¦ into a new list. Rows with the same ¦${p.key}¦ (also within one list) are combined into one row whose ¦${p.qty}¦ is the sum and whose other fields (¦name¦, ¦${p.price}¦) come from the last such row (rows of ¦b¦ come after rows of ¦a¦). The result is ordered by first appearance of each ¦${p.key}¦, ¦a¦ before ¦b¦. The inputs are not modified.`,
    test: (p) => raw`const a = [R("a", 1, 2, "a-old"), R("b", 2, 3, "old"), R("a", 3, 2.5, "a-new")];
const b = [R("c", 1, 1, "c"), R("b", 5, 4, "new")];
const snap = structuredClone([a, b]);
assert.deepEqual(report.${p.fMerge}(a, b), [R("a", 4, 2.5, "a-new"), R("b", 7, 4, "new"), R("c", 1, 1, "c")]);
assert.deepEqual([a, b], snap);
assert.deepEqual(report.${p.fMerge}([], b), b);
assert.deepEqual(report.${p.fMerge}(a, []), [R("a", 4, 2.5, "a-new"), R("b", 2, 3, "old")]);
assert.deepEqual(report.${p.fMerge}([], []), []);`,
    edits: (p) => [{ file: REPORT, add: raw`
export function ${p.fMerge}(a, b) {
  const merged = new Map();
  for (const row of [...a, ...b]) {
    const prev = merged.get(row.${p.key});
    merged.set(row.${p.key}, { ...row, ${p.qty}: (prev?.${p.qty} ?? 0) + row.${p.qty} });
  }
  return [...merged.values()];
}
` }],
    bad: (p) => [`(prev?.${p.qty} ?? 0) + row.${p.qty}`, `row.${p.qty}`],
  },
  {
    key: "validateRows",
    text: (p) => `In src/report.js export ¦${p.fValid}(rows)¦: it returns an array of problem strings, rows numbered from 1. For each row, in this order: ¦row <i>: missing ${p.key}¦ if ¦${p.key}¦ is not a non-empty string; ¦row <i>: ${p.w[5]} ${p.qty}¦ if ¦${p.qty}¦ is not a number or not a non-negative integer; ¦row <i>: ${p.w[5]} ${p.price}¦ if ¦${p.price}¦ is not a finite number or is negative. Valid rows (0 is valid for both numbers) produce nothing; an empty list returns ¦[]¦.`,
    test: (p) => raw`const W = "${p.w[5]}";
const rows = [R("a", 1, 1), R("", 1, 1), R("c", -1, 2), R("d", 1.5, -3), R("e", 2, NaN), R("f", "3", 1), R("g", 0, 0)];
assert.deepEqual(report.${p.fValid}(rows), [
  "row 2: missing " + K,
  "row 3: " + W + " " + Q,
  "row 4: " + W + " " + Q,
  "row 4: " + W + " " + P,
  "row 5: " + W + " " + P,
  "row 6: " + W + " " + Q,
]);
assert.deepEqual(report.${p.fValid}([]), []);
assert.deepEqual(report.${p.fValid}([R("a", 1, 1)]), []);
assert.deepEqual(report.${p.fValid}([{ name: "x", [Q]: 1, [P]: 1 }]), ["row 1: missing " + K]);`,
    edits: (p) => [{ file: REPORT, add: raw`
export function ${p.fValid}(rows) {
  const problems = [];
  rows.forEach((row, i) => {
    const at = "row " + (i + 1) + ": ";
    if (typeof row.${p.key} !== "string" || row.${p.key} === "") problems.push(at + "missing ${p.key}");
    if (!Number.isInteger(row.${p.qty}) || row.${p.qty} < 0) problems.push(at + "${p.w[5]} ${p.qty}");
    if (!Number.isFinite(row.${p.price}) || row.${p.price} < 0) problems.push(at + "${p.w[5]} ${p.price}");
  });
  return problems;
}
` }],
    bad: (p) => [`row.${p.price} < 0`, `row.${p.price} < -5`],
  },
  {
    key: "writeCsv",
    text: (p) => `In src/csv.js export ¦${p.fWrite}(rows)¦: it returns CSV text that ¦parseCsv¦ reads back to the same rows. First line is the header ¦${p.key},name,${p.qty},${p.price}¦, then one line per row with the values in that column order joined by ¦,¦; every line, including the header, ends with ¦\\n¦. Numbers are written as JavaScript prints them (¦0.25¦, ¦10¦). Names do not contain commas or quotes. An empty list gives just the header line.`,
    test: (p) => raw`const rows = [R("a1", 3, 2.5, "Käse"), R("b2", 10, 0.25, "日本"), R("c3", 0, 1e-7, "x y")];
const text = csv.${p.fWrite}(rows);
assert.equal(text, [K, "name", Q, P].join(",") + "\na1,Käse,3,2.5\nb2,日本,10,0.25\nc3,x y,0," + String(1e-7) + "\n");
assert.deepEqual(csv.parseCsv(text), rows);
assert.equal(csv.${p.fWrite}([]), [K, "name", Q, P].join(",") + "\n");
assert.deepEqual(csv.parseCsv(csv.${p.fWrite}([])), []);`,
    edits: (p) => [{ file: CSV, add: raw`
export function ${p.fWrite}(rows) {
  const cols = [${J(p.key)}, "name", ${J(p.qty)}, ${J(p.price)}];
  return [cols.join(","), ...rows.map((row) => cols.map((c) => row[c]).join(","))].join("\n") + "\n";
}
` }],
    bad: () => [raw`.join("\n") + "\n"`, raw`.join("\n")`],
  },
  {
    key: "byPrefix",
    text: (p) => `In src/report.js export ¦${p.fPrefix}(rows, n)¦: it groups the rows by the first ¦n¦ characters of ¦${p.key}¦ (the whole ¦${p.key}¦ if it is shorter) and returns ¦[{prefix, total}]¦ with the summed ¦${p.qty}¦ times ¦${p.price}¦ per group, sorted by ¦prefix¦ ascending using plain ¦<¦ / ¦>¦ string comparison. ¦n¦ must be a positive integer, otherwise it throws an Error whose message contains the word ¦${p.w[0]}¦.`,
    test: (p) => raw`const rows = [R("ab1", 2, 1), R("ab2", 1, 3), R("ac1", 1, 4), R("b", 2, 5), R("ä1", 1, 1)];
assert.deepEqual(report.${p.fPrefix}(rows, 2), [{ prefix: "ab", total: 5 }, { prefix: "ac", total: 4 }, { prefix: "b", total: 10 }, { prefix: "ä1", total: 1 }]);
assert.deepEqual(report.${p.fPrefix}(rows, 1), [{ prefix: "a", total: 9 }, { prefix: "b", total: 10 }, { prefix: "ä", total: 1 }]);
assert.deepEqual(report.${p.fPrefix}(rows, 99).map((g) => g.prefix), ["ab1", "ab2", "ac1", "b", "ä1"]);
assert.deepEqual(report.${p.fPrefix}([], 2), []);
for (const bad of [0, -1, 1.5, "2"]) H.throwsWith(() => report.${p.fPrefix}(rows, bad), "${p.w[0]}");`,
    edits: (p) => [{ file: REPORT, add: raw`
export function ${p.fPrefix}(rows, n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("${p.w[0]}: n must be a positive integer");
  const groups = new Map();
  for (const row of rows) {
    const prefix = String(row.${p.key}).slice(0, n);
    groups.set(prefix, (groups.get(prefix) ?? 0) + row.${p.qty} * row.${p.price});
  }
  return [...groups]
    .map(([prefix, total]) => ({ prefix, total }))
    .sort((a, b) => ${cmp("a.prefix", "b.prefix")});
}
` }],
    bad: () => [".slice(0, n)", ".slice(0, n + 1)"],
  },
];


function context(p) {
  return `This repo is a small Node tool that reads inventory CSV files (columns ${p.key}, name, ${p.qty}, ${p.price}) and prints a report per ${p.key} with ¦node cli.js report <file.csv>¦. Extend it as follows.`;
}

export default { name: "stock", params, base, hiddenHead, templates, context };
