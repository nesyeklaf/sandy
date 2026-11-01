// Family "ledger": integer-cents ledger entries ({date, amount, category}) with a balance CLI.
import { J, WORDS, pkg, raw } from "./util.mjs";

const LEDGER = "src/ledger.js";
const CLI = "cli.js";
const NEW_COMMAND = "  balance() {\n"; // anchor: new commands insert code before it
const cmp = (a, b) => `(${a} < ${b} ? -1 : ${a} > ${b} ? 1 : 0)`;
const printLine = (p) => `    console.log(${p.fFmt}(${p.fBal}(entries)));`; // anchor: flags insert code before it

function params(r) {
  return {
    date: r.pick(["date", "day", "posted"]),
    amount: r.pick(["amount", "cents", "delta"]),
    cat: r.pick(["category", "tag", "bucket"]),
    sep: r.pick([",", "'", "_"]),
    neg: r.pick([["(", ")"], ["", "-"], ["\u2212", ""]]),
    fAdd: r.pick(["addEntry", "record", "appendEntry"]),
    fBal: r.pick(["balance", "netTotal", "sumAmounts"]),
    fByCat: r.pick(["byCategory", "totalsPerCategory", "groupSums"]),
    fFmt: r.pick(["formatCents", "fmtCents", "centsToText"]),
    fMonthly: r.pick(["monthlyTotals", "totalsByMonth", "perMonth"]),
    fTop: r.pick(["topSpending", "biggestSpenders", "spendRanking"]),
    fBetween: r.pick(["between", "inRange", "withinDates"]),
    fBudget: r.pick(["budgetStatus", "checkBudgets", "budgetReport"]),
    fDedupe: r.pick(["dedupe", "dropDuplicates", "uniqueEntries"]),
    fRunning: r.pick(["runningBalance", "cumulative", "balanceTimeline"]),
    fTransfer: r.pick(["transfer", "moveFunds", "shiftBetween"]),
    fSplit: r.pick(["splitEvenly", "shareOut", "divideCents"]),
    fToCsv: r.pick(["toCsv", "exportCsv", "writeCsv"]),
    fFromCsv: r.pick(["fromCsv", "importCsv", "readCsv"]),
    fSave: r.pick(["saveLedger", "writeLedger", "persist"]),
    fLoad: r.pick(["loadLedger", "readLedger", "restore"]),
    catFlag: r.pick(["category", "only", "cat"]),
    cmdMonth: r.pick(["month", "statement", "period"]),
    cmdAdd: r.pick(["add", "post", "enter"]),
    w: r.sample(WORDS, 6),
    ex: r.sample([2, 3, 4, 64, 70], 5),
    names: r.sample(["salary", "rent", "food", "fun", "gift", "travel"], 3),
  };
}

function base(p) {
  const { date: D, amount: A, cat: C } = p;
  const [c1, c2] = p.names;
  return {
    "package.json": pkg("ledger"),
    "README.md": `# Ledger

Entries are plain objects: ¦{ ${D}: "YYYY-MM-DD", ${A}: <integer cents>, ${C}: "<name>" }¦. Income is positive, spending negative.

## Usage

    node cli.js balance <file.json>

Prints the sum of all ${A} values of the JSON array in the file, in units with two decimals.

## Modules

- src/ledger.js: ¦${p.fAdd}(entries, entry)¦, ¦${p.fBal}(entries)¦, ¦${p.fByCat}(entries)¦, ¦${p.fFmt}(cents)¦.
`.replaceAll("¦", "'"),
    [LEDGER]: raw`export function ${p.fAdd}(entries, entry) {
  return [...entries, { ...entry }];
}

export function ${p.fBal}(entries) {
  return entries.reduce((sum, e) => sum + e.${A}, 0);
}

export function ${p.fByCat}(entries) {
  const totals = {};
  for (const e of entries) totals[e.${C}] = (totals[e.${C}] ?? 0) + e.${A};
  return totals;
}

export function ${p.fFmt}(cents) {
  return (cents / 100).toFixed(2);
}
`,
    [CLI]: raw`#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { ${p.fBal}, ${p.fFmt} } from "./src/ledger.js";

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
  balance() {
    const entries = JSON.parse(readFileSync(pos[1], "utf8"));
${printLine(p)}
  },
};

if (!commands[pos[0]]) {
  console.error("usage: node cli.js balance <file.json>");
  process.exit(1);
}
commands[pos[0]]();
`,
    "src/ledger.test.js": raw`import test from "node:test";
import assert from "node:assert/strict";
import { ${p.fAdd}, ${p.fBal}, ${p.fByCat}, ${p.fFmt} } from "./ledger.js";

const entries = [
  { ${D}: "2024-01-05", ${A}: 5000, ${C}: "${c1}" },
  { ${D}: "2024-01-09", ${A}: -1250, ${C}: "${c2}" },
  { ${D}: "2024-01-10", ${A}: -250, ${C}: "${c2}" },
];

test("${p.fAdd} returns a new list and leaves the old one alone", () => {
  const next = ${p.fAdd}(entries, { ${D}: "2024-02-01", ${A}: 100, ${C}: "${c1}" });
  assert.equal(next.length, 4);
  assert.equal(entries.length, 3);
});

test("${p.fBal} and ${p.fByCat} sum the ${A} values", () => {
  assert.equal(${p.fBal}(entries), 3500);
  assert.deepEqual(${p.fByCat}(entries), { ${c1}: 5000, ${c2}: -1500 });
});

test("${p.fFmt} shows two decimals", () => {
  assert.equal(${p.fFmt}(1250), "12.50");
  assert.equal(${p.fFmt}(0), "0.00");
});
`,
    "cli.test.js": raw`import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("balance prints the sum with two decimals", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ledger-")), "l.json");
  writeFileSync(file, JSON.stringify([{ ${D}: "2024-01-05", ${A}: 5000, ${C}: "${c1}" }, { ${D}: "2024-01-09", ${A}: -1250, ${C}: "${c2}" }]));
  const out = execFileSync(process.execPath, ["cli.js", "balance", file], { encoding: "utf8" });
  assert.equal(out, "37.50\n");
});
`,
  };
}

function context(p) {
  return `This repo is a small Node ledger: entries are objects ¦{${p.date}: "YYYY-MM-DD", ${p.amount}: integer cents, ${p.cat}: string}¦ (income positive, spending negative), the library is src/ledger.js and ¦node cli.js balance <file.json>¦ prints the balance of a JSON array of entries. Extend it as follows.`;
}

function hiddenHead(p) {
  return raw`import { readFileSync } from "node:fs";
import * as ledger from "../src/ledger.js";
const D = ${J(p.date)}, A = ${J(p.amount)}, C = ${J(p.cat)};
const E = (d, a, c) => ({ [D]: d, [A]: a, [C]: c });
const L = [E("2024-01-05", 5000, "salary"), E("2024-01-20", -1200, "food"), E("2024-02-03", -300, "fun"), E("2024-02-03", -250, "food"), E("2024-03-01", 700, "gift")];
const go = (entries, ...args) => {
  const d = H.tmp({ "l.json": JSON.stringify(entries) });
  return H.cli(args.map((a) => (a === "@" ? d + "/l.json" : a)), d);
};
`;
}

// Template shape: see random-task/stock.mjs.
const templates = [
  {
    key: "monthlyTotals",
    text: (p) => `In src/ledger.js export ¦${p.fMonthly}(entries)¦: it returns ¦[{month, total}]¦ with ¦month¦ as ¦"YYYY-MM"¦ and ¦total¦ the sum of the ¦${p.amount}¦ values of that month, ordered by month ascending (whatever the input order). Months without entries are left out; an empty list returns ¦[]¦.`,
    test: (p) => raw`const want = [{ month: "2024-01", total: 3800 }, { month: "2024-02", total: -550 }, { month: "2024-03", total: 700 }];
assert.deepEqual(ledger.${p.fMonthly}(L), want);
assert.deepEqual(ledger.${p.fMonthly}([...L].reverse()), want);
assert.deepEqual(ledger.${p.fMonthly}([]), []);
assert.deepEqual(ledger.${p.fMonthly}([E("2023-12-31", 5, "x"), E("2024-01-01", 7, "x")]), [{ month: "2023-12", total: 5 }, { month: "2024-01", total: 7 }]);`,
    edits: (p) => [{ file: LEDGER, add: raw`
export function ${p.fMonthly}(entries) {
  const totals = new Map();
  for (const e of entries) {
    const month = e.${p.date}.slice(0, 7);
    totals.set(month, (totals.get(month) ?? 0) + e.${p.amount});
  }
  return [...totals]
    .map(([month, total]) => ({ month, total }))
    .sort((a, b) => ${cmp("a.month", "b.month")});
}
` }],
    bad: () => [".slice(0, 7)", ".slice(0, 8)"],
  },
  {
    key: "topSpending",
    text: (p) => `In src/ledger.js export ¦${p.fTop}(entries, n)¦: spending of a category is the sum of ¦-${p.amount}¦ over its entries with a negative ¦${p.amount}¦ (other entries are ignored). It returns the names of the ¦n¦ categories with the highest spending, highest first, equal spending ordered by name ascending (plain ¦<¦ / ¦>¦ comparison); categories without spending never appear. ¦n¦ must be a non-negative integer, otherwise it throws an Error whose message contains the word ¦${p.w[0]}¦.`,
    test: (p) => raw`assert.deepEqual(ledger.${p.fTop}(L, 1), ["food"]);
assert.deepEqual(ledger.${p.fTop}(L, 5), ["food", "fun"]);
assert.deepEqual(ledger.${p.fTop}(L, 0), []);
const more = [...L, E("2024-01-01", -300, "b"), E("2024-01-02", -300, "a"), E("2024-01-03", 0, "zero"), E("2024-01-04", 900, "fun")];
assert.deepEqual(ledger.${p.fTop}(more, 4), ["food", "a", "b", "fun"]);
assert.deepEqual(ledger.${p.fTop}([], 3), []);
for (const bad of [-1, 1.5, "2", undefined]) H.throwsWith(() => ledger.${p.fTop}(L, bad), "${p.w[0]}");`,
    edits: (p) => [{ file: LEDGER, add: raw`
export function ${p.fTop}(entries, n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("${p.w[0]}: n must be a non-negative integer");
  const spent = new Map();
  for (const e of entries) {
    if (e.${p.amount} < 0) spent.set(e.${p.cat}, (spent.get(e.${p.cat}) ?? 0) - e.${p.amount});
  }
  return [...spent]
    .sort((a, b) => b[1] - a[1] || ${cmp("a[0]", "b[0]")})
    .slice(0, n)
    .map(([name]) => name);
}
` }],
    bad: () => ["b[1] - a[1]", "a[1] - b[1]"],
  },
  {
    key: "validateAdd",
    text: (p) => `Change ¦${p.fAdd}(entries, entry)¦ in src/ledger.js to validate the entry before adding it and throw an Error otherwise. The message must contain the field name that is wrong (¦${p.date}¦, ¦${p.amount}¦ or ¦${p.cat}¦): ¦${p.date}¦ must be a string holding a real calendar date as ¦YYYY-MM-DD¦ (¦2024-02-29¦ yes, ¦2023-02-29¦, ¦2024-02-30¦, ¦2024-2-3¦ no); ¦${p.amount}¦ must be an integer number (0 and negatives are fine); ¦${p.cat}¦ must be a non-empty string. Valid entries are added as before.`,
    test: (p) => raw`const ok = E("2024-02-29", -5, "food");
const next = ledger.${p.fAdd}(L, ok);
assert.equal(next.length, L.length + 1);
assert.deepEqual(next.at(-1), ok);
assert.equal(L.length, 5);
assert.equal(ledger.${p.fAdd}([], E("2024-12-31", 0, "x")).length, 1);
for (const d of ["2023-02-29", "2024-02-30", "2024-13-01", "2024-2-3", "24-01-05", 20240105, undefined]) H.throwsWith(() => ledger.${p.fAdd}(L, E(d, 1, "x")), D);
for (const a of [1.5, "100", NaN, undefined]) H.throwsWith(() => ledger.${p.fAdd}(L, E("2024-01-01", a, "x")), A);
for (const c of ["", 5, undefined]) H.throwsWith(() => ledger.${p.fAdd}(L, E("2024-01-01", 1, c)), C);`,
    edits: (p) => [{ file: LEDGER, from: `export function ${p.fAdd}(entries, entry) {\n`, to: raw`export function ${p.fAdd}(entries, entry) {
  const day = new Date(String(entry.${p.date}) + "T00:00:00Z");
  if (typeof entry.${p.date} !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.${p.date}) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== entry.${p.date}) {
    throw new Error("invalid ${p.date}");
  }
  if (!Number.isInteger(entry.${p.amount})) throw new Error("invalid ${p.amount}");
  if (typeof entry.${p.cat} !== "string" || entry.${p.cat} === "") throw new Error("invalid ${p.cat}");
` }],
    bad: () => ["Number.isInteger(entry.", "Number.isFinite(entry."],
  },
  {
    key: "formatCents",
    text: (p) => `Change ¦${p.fFmt}(cents)¦ in src/ledger.js (cents is an integer): the integer part is grouped in threes with ¦${p.sep}¦ (¦${p.fFmt}(123456789)¦ is ¦"1${p.sep}234${p.sep}567.89"¦, ¦${p.fFmt}(5)¦ is ¦"0.05"¦, ¦${p.fFmt}(1250)¦ stays ¦"12.50"¦), and a negative amount is its absolute value formatted the same way with ¦${J(p.neg[0])}¦ in front and ¦${J(p.neg[1])}¦ behind (¦${p.fFmt}(-123456)¦ is ¦${J(p.neg[0] + "1" + p.sep + "234.56" + p.neg[1])}¦).`,
    test: (p) => raw`const S = ${J(p.sep)}, [PRE, SUF] = ${J(p.neg)};
const f = ledger.${p.fFmt};
assert.equal(f(0), "0.00");
assert.equal(f(5), "0.05");
assert.equal(f(1250), "12.50");
assert.equal(f(99999), "999.99");
assert.equal(f(100000), "1" + S + "000.00");
assert.equal(f(123456789), "1" + S + "234" + S + "567.89");
assert.equal(f(-5), PRE + "0.05" + SUF);
assert.equal(f(-123456), PRE + "1" + S + "234.56" + SUF);
assert.equal(f(-100), PRE + "1.00" + SUF);`,
    edits: (p) => [{ file: LEDGER, from: "  return (cents / 100).toFixed(2);", to: raw`  const abs = Math.abs(cents);
  const body = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+$)/g, ${J(p.sep)}) + "." + String(abs % 100).padStart(2, "0");
  return cents < 0 ? ${J(p.neg[0])} + body + ${J(p.neg[1])} : body;` }],
    bad: () => [raw`\d{3}`, raw`\d{2}`],
  },
  {
    key: "between",
    text: (p) => `In src/ledger.js export ¦${p.fBetween}(entries, from, to)¦: it returns a new list with the entries whose ¦${p.date}¦ lies between the ¦"YYYY-MM-DD"¦ strings ¦from¦ and ¦to¦, both ends included, in their original order. If ¦from¦ is after ¦to¦ it throws an Error whose message contains the word ¦${p.w[1]}¦.`,
    test: (p) => raw`assert.deepEqual(ledger.${p.fBetween}(L, "2024-01-20", "2024-02-03"), L.slice(1, 4));
assert.deepEqual(ledger.${p.fBetween}(L, "2024-02-03", "2024-02-03"), L.slice(2, 4));
assert.deepEqual(ledger.${p.fBetween}(L, "2024-01-06", "2024-01-19"), []);
assert.deepEqual(ledger.${p.fBetween}(L, "2000-01-01", "2999-12-31"), L);
assert.notEqual(ledger.${p.fBetween}(L, "2000-01-01", "2999-12-31"), L);
H.throwsWith(() => ledger.${p.fBetween}(L, "2024-03-01", "2024-01-01"), "${p.w[1]}");`,
    edits: (p) => [{ file: LEDGER, add: raw`
export function ${p.fBetween}(entries, from, to) {
  if (from > to) throw new RangeError("${p.w[1]}: from is after to");
  return entries.filter((e) => e.${p.date} >= from && e.${p.date} <= to);
}
` }],
    bad: (p) => [`e.${p.date} >= from`, `e.${p.date} > from`],
  },
  {
    key: "budgetStatus",
    text: (p) => `In src/ledger.js export ¦${p.fBudget}(entries, budgets)¦: ¦budgets¦ is an object ¦{ <${p.cat}>: <limit in cents> }¦. It returns ¦[{category, spent, limit, over}]¦ with one element per budget key, sorted by ¦category¦ ascending (plain comparison). ¦spent¦ is the sum of ¦-${p.amount}¦ over the entries of that category with a negative ¦${p.amount}¦ (0 if there are none), ¦over¦ is true only if ¦spent¦ is strictly greater than ¦limit¦. Categories without a budget are not listed.`,
    test: (p) => raw`assert.deepEqual(ledger.${p.fBudget}(L, { fun: 500, travel: 200, food: 1000 }), [
  { category: "food", spent: 1450, limit: 1000, over: true },
  { category: "fun", spent: 300, limit: 500, over: false },
  { category: "travel", spent: 0, limit: 200, over: false },
]);
assert.equal(ledger.${p.fBudget}(L, { food: 1450 })[0].over, false);
assert.equal(ledger.${p.fBudget}(L, { food: 1449 })[0].over, true);
assert.deepEqual(ledger.${p.fBudget}(L, {}), []);
assert.deepEqual(ledger.${p.fBudget}([], { a: 1 }), [{ category: "a", spent: 0, limit: 1, over: false }]);`,
    edits: (p) => [{ file: LEDGER, add: raw`
export function ${p.fBudget}(entries, budgets) {
  return Object.keys(budgets)
    .sort((a, b) => ${cmp("a", "b")})
    .map((category) => {
      const spent = entries
        .filter((e) => e.${p.cat} === category && e.${p.amount} < 0)
        .reduce((sum, e) => sum - e.${p.amount}, 0);
      return { category, spent, limit: budgets[category], over: spent > budgets[category] };
    });
}
` }],
    bad: () => ["spent > budgets[category]", "spent >= budgets[category]"],
  },
  {
    key: "dedupe",
    text: (p) => `In src/ledger.js export ¦${p.fDedupe}(entries)¦: it returns a new list without repeated entries. Two entries are the same if ¦${p.date}¦, ¦${p.amount}¦ and ¦${p.cat}¦ are all equal (other fields such as ¦memo¦ are ignored); the first one is kept and the order is preserved. The input is not modified.`,
    test: (p) => raw`const a = E("2024-01-01", 100, "x"), b = E("2024-01-01", 200, "x"), c = E("2024-01-02", 100, "x"), d = E("2024-01-01", 100, "y");
const input = [a, b, { ...a, memo: "again" }, c, d, { ...b }, d];
const snap = structuredClone(input);
assert.deepEqual(ledger.${p.fDedupe}(input), [a, b, c, d]);
assert.deepEqual(input, snap);
assert.deepEqual(ledger.${p.fDedupe}([]), []);
assert.deepEqual(ledger.${p.fDedupe}([{ ...a, memo: "first" }, a]), [{ ...a, memo: "first" }]);`,
    edits: (p) => [{ file: LEDGER, add: raw`
export function ${p.fDedupe}(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    const key = JSON.stringify([e.${p.date}, e.${p.amount}, e.${p.cat}]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
` }],
    bad: (p) => [`e.${p.date}, e.${p.amount}, `, `e.${p.date}, `],
  },
  {
    key: "balanceFilter",
    text: (p) => `¦node cli.js balance <file.json> --${p.catFlag} <names>¦ prints the balance of only the entries whose ¦${p.cat}¦ is one of the comma-separated ¦names¦ (exact, case-sensitive match), formatted like before. Names that match nothing give ¦0.00¦. Without the flag nothing changes.`,
    test: (p) => raw`const rows = [E("2024-01-05", 5000, "salary"), E("2024-01-06", 700, "gift"), E("2024-01-07", 1000, "salary"), E("2024-01-08", 50, "gift")];
const F = "--${p.catFlag}";
assert.deepEqual(H.ok(go(rows, "balance", "@")), ["67.50"]);
assert.deepEqual(H.ok(go(rows, "balance", "@", F, "salary")), ["60.00"]);
assert.deepEqual(H.ok(go(rows, "balance", "@", F, "salary,gift")), ["67.50"]);
assert.deepEqual(H.ok(go(rows, "balance", "@", F, "gift")), ["7.50"]);
assert.deepEqual(H.ok(go(rows, "balance", "@", F, "Salary")), ["0.00"]);
assert.deepEqual(H.ok(go(rows, "balance", "@", F, "none")), ["0.00"]);`,
    edits: (p) => [{ file: CLI, from: "    const entries =", to: "    let entries =" }, { file: CLI, from: printLine(p), to: raw`    const only = flags[${J(p.catFlag)}];
    if (typeof only === "string") {
      const names = only.split(",");
      entries = entries.filter((e) => names.includes(e.${p.cat}));
    }
${printLine(p)}` }],
    bad: () => ['.split(",")', '.split(";")'],
  },
  {
    key: "monthCmd",
    text: (p) => `¦node cli.js ${p.cmdMonth} <file.json> <YYYY-MM>¦ prints one line ¦<${p.date}> <amount> <${p.cat}>¦ per entry of that month (amount in units with two decimals as ¦balance¦ prints it, single spaces between the parts), ordered by ¦${p.date}¦ ascending and by file order for equal dates, followed by the line ¦total <sum>¦ in the same format. A month without entries prints only the total line. A month argument that is missing or not a real ¦YYYY-MM¦ (¦2024-5¦, ¦2024-13¦) prints nothing to stdout, writes a message containing the word ¦${p.w[2]}¦ to stderr and exits with code ${p.ex[0]}.`,
    test: (p) => raw`const rows = [E("2024-05-20", 1500, "b"), E("2024-05-03", 250, "a"), E("2024-06-01", 999, "x"), E("2024-05-03", 100, "c d")];
assert.deepEqual(H.ok(go(rows, "${p.cmdMonth}", "@", "2024-05")), ["2024-05-03 2.50 a", "2024-05-03 1.00 c d", "2024-05-20 15.00 b", "total 18.50"]);
assert.deepEqual(H.ok(go(rows, "${p.cmdMonth}", "@", "2024-06")), ["2024-06-01 9.99 x", "total 9.99"]);
assert.deepEqual(H.ok(go(rows, "${p.cmdMonth}", "@", "2023-05")), ["total 0.00"]);
for (const m of ["2024-5", "2024-13", "2024-00", "may", "2024-05-03"]) H.failed(go(rows, "${p.cmdMonth}", "@", m), "${p.w[2]}", ${p.ex[0]});
H.failed(go(rows, "${p.cmdMonth}", "@"), "${p.w[2]}", ${p.ex[0]});`,
    edits: (p) => [{ file: CLI, from: NEW_COMMAND, to: raw`  ${p.cmdMonth}() {
    const month = pos[2] ?? "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      console.error("${p.w[2]}: month must look like YYYY-MM");
      process.exit(${p.ex[0]});
    }
    const rows = JSON.parse(readFileSync(pos[1], "utf8"))
      .filter((e) => e.${p.date}.startsWith(month))
      .map((e, i) => ({ e, i }))
      .sort((a, b) => ${cmp("a.e." + p.date, "b.e." + p.date)} || a.i - b.i);
    for (const { e } of rows) console.log(e.${p.date} + " " + ${p.fFmt}(e.${p.amount}) + " " + e.${p.cat});
    console.log("total " + ${p.fFmt}(rows.reduce((sum, { e }) => sum + e.${p.amount}, 0)));
  },
${NEW_COMMAND}` }],
    bad: () => ["|| a.i - b.i", "|| b.i - a.i"],
  },
  {
    key: "csvio",
    text: (p) => `Create src/csvio.js exporting ¦${p.fToCsv}(entries)¦ and ¦${p.fFromCsv}(text)¦. ¦${p.fToCsv}¦ returns the header ¦${p.date},${p.amount},${p.cat}¦ and one line per entry with those three values joined by ¦,¦, every line ending with ¦\\n¦; a value containing a comma or a double quote is wrapped in double quotes with inner quotes doubled (¦say "hi"¦ becomes ¦"say ""hi"""¦). ¦${p.fFromCsv}¦ reads such text back: it skips the header line and blank lines, undoes the quoting and returns ¦{${p.date}, ${p.amount}, ${p.cat}}¦ objects with ¦${p.amount}¦ as a number. ¦${p.fFromCsv}(${p.fToCsv}(x))¦ equals ¦x¦.`,
    test: (p) => raw`const csvio = await import("../src/csvio.js");
const entries = [E("2024-01-02", 1250, "Dining, out"), E("2024-01-03", -5, 'say "hi"'), E("2024-01-04", 7, "Käse")];
const text = csvio.${p.fToCsv}(entries);
assert.equal(text, [D, A, C].join(",") + '\n2024-01-02,1250,"Dining, out"\n2024-01-03,-5,"say ""hi"""\n2024-01-04,7,Käse\n');
assert.deepEqual(csvio.${p.fFromCsv}(text), entries);
assert.deepEqual(csvio.${p.fFromCsv}(text + "\n\n"), entries);
assert.equal(csvio.${p.fToCsv}([]), [D, A, C].join(",") + "\n");
assert.deepEqual(csvio.${p.fFromCsv}(csvio.${p.fToCsv}([])), []);`,
    edits: (p) => [{ file: "src/csvio.js", add: raw`const COLUMNS = [${J(p.date)}, ${J(p.amount)}, ${J(p.cat)}];

const quote = (value) => (/[",]/.test(value) ? '"' + String(value).replaceAll('"', '""') + '"' : String(value));

function splitLine(line) {
  const cells = [];
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
  return cells;
}

export function ${p.fToCsv}(entries) {
  return [COLUMNS.join(","), ...entries.map((e) => COLUMNS.map((c) => quote(e[c])).join(","))].join("\n") + "\n";
}

export function ${p.fFromCsv}(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(1)
    .map((line) => {
      const [date, amount, category] = splitLine(line);
      return { ${p.date}: date, ${p.amount}: Number(amount), ${p.cat}: category };
    });
}
` }],
    bad: () => [raw`/[",]/`, raw`/[\n]/`],
  },
  {
    key: "store",
    text: (p) => `Create src/store.js exporting the synchronous functions ¦${p.fSave}(path, entries)¦ and ¦${p.fLoad}(path)¦. ¦${p.fSave}¦ writes the entries as a JSON array (UTF-8) and creates missing parent directories. ¦${p.fLoad}¦ returns the array; a file that does not exist gives ¦[]¦; a file that is not valid JSON, or valid JSON that is not an array, makes it throw an Error whose message contains the word ¦${p.w[3]}¦.`,
    test: (p) => raw`const store = await import("../src/store.js");
const { writeFileSync, readFileSync } = await import("node:fs");
const dir = H.tmp();
const entries = [E("2024-01-02", 1250, "Käse 日本"), E("2024-01-03", -5, "x")];
store.${p.fSave}(dir + "/deep/er/l.json", entries);
assert.deepEqual(JSON.parse(readFileSync(dir + "/deep/er/l.json", "utf8")), entries);
assert.deepEqual(store.${p.fLoad}(dir + "/deep/er/l.json"), entries);
store.${p.fSave}(dir + "/empty.json", []);
assert.deepEqual(store.${p.fLoad}(dir + "/empty.json"), []);
assert.deepEqual(store.${p.fLoad}(dir + "/missing.json"), []);
writeFileSync(dir + "/bad.json", "{oops");
H.throwsWith(() => store.${p.fLoad}(dir + "/bad.json"), "${p.w[3]}");
writeFileSync(dir + "/obj.json", '{"a":1}');
H.throwsWith(() => store.${p.fLoad}(dir + "/obj.json"), "${p.w[3]}");`,
    edits: (p) => [{ file: "src/store.js", add: raw`import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ${p.fSave}(path, entries) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
}

export function ${p.fLoad}(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("${p.w[3]}: " + path + " is not valid JSON");
  }
  if (!Array.isArray(data)) throw new Error("${p.w[3]}: " + path + " does not hold a list");
  return data;
}
` }],
    bad: () => ["!Array.isArray(data)", "false"],
  },
  {
    key: "runningBalance",
    text: (p) => `In src/ledger.js export ¦${p.fRunning}(entries)¦: it returns ¦[{date, balance}]¦ with one element per entry, ordered by ¦${p.date}¦ ascending (entries with the same date keep their input order), where ¦balance¦ is the sum of ¦${p.amount}¦ of that entry and all entries before it in that order. The input is not modified.`,
    test: (p) => raw`const input = [E("2024-02-03", -300, "a"), E("2024-01-05", 5000, "b"), E("2024-02-03", -250, "c")];
const snap = structuredClone(input);
assert.deepEqual(ledger.${p.fRunning}(input), [{ date: "2024-01-05", balance: 5000 }, { date: "2024-02-03", balance: 4700 }, { date: "2024-02-03", balance: 4450 }]);
assert.deepEqual(input, snap);
assert.deepEqual(ledger.${p.fRunning}([]), []);
assert.deepEqual(ledger.${p.fRunning}([E("2024-01-01", -5, "a")]), [{ date: "2024-01-01", balance: -5 }]);`,
    edits: (p) => [{ file: LEDGER, add: raw`
export function ${p.fRunning}(entries) {
  let balance = 0;
  return [...entries]
    .sort((a, b) => ${cmp("a." + p.date, "b." + p.date)})
    .map((e) => ({ date: e.${p.date}, balance: (balance += e.${p.amount}) }));
}
` }],
    bad: (p) => [cmp("a." + p.date, "b." + p.date), "0"],
  },
  {
    key: "transfer",
    text: (p) => `In src/ledger.js export ¦${p.fTransfer}(entries, from, to, cents, date)¦: it returns a new list with the given entries followed by two new ones, in this order: ¦{${p.date}: date, ${p.amount}: -cents, ${p.cat}: from}¦ and ¦{${p.date}: date, ${p.amount}: cents, ${p.cat}: to}¦. ¦cents¦ must be a positive integer (otherwise it throws an Error whose message contains the word ¦${p.w[4]}¦) and ¦from¦ and ¦to¦ must differ (otherwise it throws an Error whose message contains ¦${p.w[5]}¦). The input list is not modified.`,
    test: (p) => raw`const snap = structuredClone(L);
const out = ledger.${p.fTransfer}(L, "cash", "bank", 1500, "2024-04-01");
assert.deepEqual(out, [...L, E("2024-04-01", -1500, "cash"), E("2024-04-01", 1500, "bank")]);
assert.deepEqual(L, snap);
assert.equal(ledger.${p.fTransfer}([], "a", "b", 1, "2024-04-01").length, 2);
for (const c of [0, -5, 1.5, "10", undefined]) H.throwsWith(() => ledger.${p.fTransfer}(L, "a", "b", c, "2024-04-01"), "${p.w[4]}");
H.throwsWith(() => ledger.${p.fTransfer}(L, "a", "a", 10, "2024-04-01"), "${p.w[5]}");`,
    edits: (p) => [{ file: LEDGER, add: raw`
export function ${p.fTransfer}(entries, from, to, cents, date) {
  if (!Number.isInteger(cents) || cents < 1) throw new RangeError("${p.w[4]}: cents must be a positive integer");
  if (from === to) throw new Error("${p.w[5]}: from and to are the same");
  return [...entries, { ${p.date}: date, ${p.amount}: -cents, ${p.cat}: from }, { ${p.date}: date, ${p.amount}: cents, ${p.cat}: to }];
}
` }],
    bad: (p) => [`${p.amount}: -cents`, `${p.amount}: cents`],
  },
  {
    key: "addCmd",
    text: (p) => `¦node cli.js ${p.cmdAdd} <file.json> <${p.date}> <amount> <${p.cat}>¦ appends an entry to the JSON array in the file (the file is created with just that entry if it does not exist), prints ¦added¦ and exits 0. ¦amount¦ is a decimal number in units with an optional minus sign and at most two decimals (¦-12.50¦, ¦7¦, ¦3.5¦, ¦0.05¦); it is stored as integer cents in ¦${p.amount}¦. Any other amount (¦12.345¦, ¦abc¦, empty, missing) leaves the file untouched, prints nothing to stdout, writes a message containing the word ¦${p.w[0]}¦ to stderr and exits with code ${p.ex[1]}.`,
    test: (p) => raw`const dir = H.tmp();
const file = dir + "/new.json";
const add = (...rest) => H.cli(["${p.cmdAdd}", file, ...rest], dir);
const read = () => JSON.parse(readFileSync(file, "utf8"));
assert.deepEqual(H.ok(add("2024-05-01", "-12.50", "food")), ["added"]);
assert.deepEqual(read(), [E("2024-05-01", -1250, "food")]);
for (const [text, cents] of [["7", 700], ["3.5", 350], ["0.05", 5], ["-0.5", -50], ["0", 0]]) H.ok(add("2024-05-02", text, "x y"));
assert.deepEqual(read().slice(1).map((e) => e[A]), [700, 350, 5, -50, 0]);
assert.equal(read()[1][C], "x y");
const before = readFileSync(file, "utf8");
for (const bad of ["12.345", "abc", "", "1,5", "--5", "1e3"]) {
  H.failed(add("2024-05-03", bad, "z"), "${p.w[0]}", ${p.ex[1]});
  assert.equal(readFileSync(file, "utf8"), before);
}
H.failed(H.cli(["${p.cmdAdd}", file, "2024-05-03"], dir), "${p.w[0]}", ${p.ex[1]});`,
    edits: (p) => [{ file: CLI, from: 'import { readFileSync } from "node:fs";', to: 'import { readFileSync, writeFileSync } from "node:fs";' }, { file: CLI, from: NEW_COMMAND, to: raw`  ${p.cmdAdd}() {
    const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(pos[3] ?? "");
    if (!m) {
      console.error("${p.w[0]}: amount must be a decimal with at most two decimals");
      process.exit(${p.ex[1]});
    }
    const value = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
    let entries = [];
    try {
      entries = JSON.parse(readFileSync(pos[1], "utf8"));
    } catch {}
    entries.push({ ${p.date}: pos[2], ${p.amount}: m[1] ? -value : value, ${p.cat}: pos[4] });
    writeFileSync(pos[1], JSON.stringify(entries, null, 2) + "\n");
    console.log("added");
  },
${NEW_COMMAND}` }],
    bad: () => ["m[1] ? -value : value", "value"],
  },
  {
    key: "splitEvenly",
    text: (p) => `In src/ledger.js export ¦${p.fSplit}(total, parts)¦: it returns an array of ¦parts¦ integers that sum to ¦total¦ and differ by at most 1. The absolute value of ¦total¦ is split: every part gets the floor of ¦|total| / parts¦ and the remainder is handed out one unit each to the first parts; for a negative ¦total¦ the parts are negated (¦${p.fSplit}(10, 3)¦ is ¦[4, 3, 3]¦, ¦${p.fSplit}(-10, 3)¦ is ¦[-4, -3, -3]¦, ¦${p.fSplit}(2, 5)¦ is ¦[1, 1, 0, 0, 0]¦; zero parts are ¦0¦, never ¦-0¦). ¦total¦ must be an integer and ¦parts¦ a positive integer, otherwise it throws an Error whose message contains the word ¦${p.w[1]}¦.`,
    test: (p) => raw`const f = ledger.${p.fSplit};
assert.deepStrictEqual(f(10, 3), [4, 3, 3]);
assert.deepStrictEqual(f(-10, 3), [-4, -3, -3]);
assert.deepStrictEqual(f(9, 3), [3, 3, 3]);
assert.deepStrictEqual(f(0, 2), [0, 0]);
assert.deepStrictEqual(f(5, 1), [5]);
assert.deepStrictEqual(f(2, 5), [1, 1, 0, 0, 0]);
assert.deepStrictEqual(f(-2, 4), [-1, -1, 0, 0]);
for (const [t, n] of [[10, 0], [10, -1], [10, 2.5], [1.5, 2], [10, "3"]]) H.throwsWith(() => f(t, n), "${p.w[1]}");`,
    edits: (p) => [{ file: LEDGER, add: raw`
export function ${p.fSplit}(total, parts) {
  if (!Number.isInteger(total) || !Number.isInteger(parts) || parts < 1) throw new RangeError("${p.w[1]}: need an integer total and a positive number of parts");
  const abs = Math.abs(total);
  const base = Math.floor(abs / parts);
  const extra = abs % parts;
  return Array.from({ length: parts }, (_, i) => (base + (i < extra ? 1 : 0)) * Math.sign(total) || 0);
}
` }],
    bad: () => ["i < extra", "i >= parts - extra"],
  },
];

export default { name: "ledger", params, base, hiddenHead, context, templates };
