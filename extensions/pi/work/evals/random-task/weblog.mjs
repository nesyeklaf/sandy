// Family "weblog": a request-log analyzer (lines like "2024-05-01T10:00:00Z GET /a 200 30ms") with a stats CLI.
import { J, WORDS, pkg, raw } from "./util.mjs";

const PARSE = "src/parse.js";
const STATS = "src/stats.js";
const CLI = "cli.js";
const NEW_COMMAND = "  stats() {\n"; // anchor: new commands insert code before it
const PRINT = '    console.log("requests: " + entries.length);'; // anchor: flags insert filters before it
const cmp = (a, b) => `(${a} < ${b} ? -1 : ${a} > ${b} ? 1 : 0)`;

function params(r) {
  return {
    fErrors: r.pick(["countErrors", "serverErrors", "failedRequests"]),
    fByStatus: r.pick(["countByStatus", "tallyStatus", "statusHistogram"]),
    fPct: r.pick(["percentile", "quantile", "nearestRank"]),
    fSlowest: r.pick(["slowest", "longestRequests", "worstLatency"]),
    fClass: r.pick(["countByClass", "classCounts", "statusClasses"]),
    fMinute: r.pick(["perMinute", "minuteBuckets", "countPerMinute"]),
    fRate: r.pick(["errorRate", "failureRatio", "serverErrorShare"]),
    fTop: r.pick(["topPaths", "busiestPaths", "hotPaths"]),
    fBurst: r.pick(["burstPaths", "rateLimited", "floodedPaths"]),
    fNorm: r.pick(["normalizePath", "templatePath", "genericPath"]),
    fPer: r.pick(["perPath", "pathSummary", "latencyByPath"]),
    statusFlag: r.pick(["status", "class", "only"]),
    sinceFlag: r.pick(["since", "from", "after"]),
    overFlag: r.pick(["over", "above", "min-ms"]),
    nFlag: r.pick(["n", "limit", "count"]),
    cmdSlow: r.pick(["slow", "slowest", "outliers"]),
    cmdTop: r.pick(["top", "busiest", "hot"]),
    w: r.sample(WORDS, 6),
    ex: r.sample([2, 3, 4, 64, 70], 5),
    paths: r.sample(["/users", "/orders", "/login", "/items", "/health"], 2),
  };
}

function base(p) {
  const [a, b] = p.paths;
  return {
    "package.json": pkg("weblog"),
    "README.md": `# Request log analyzer

A log line is ¦<ISO time> <METHOD> <path> <status> <ms>ms¦, for example ¦2024-05-01T10:00:00Z GET ${a} 200 30ms¦.

## Usage

    node cli.js stats <file>

Prints ¦requests: <n>¦ and ¦errors: <n>¦ (status 500 and above). Lines that do not parse are skipped.

## Modules

- src/parse.js: ¦parseLine(line)¦ returns ¦{time, method, path, status, ms}¦ or ¦null¦; ¦parseLog(text)¦ parses all lines.
- src/stats.js: ¦${p.fErrors}(entries)¦ and ¦${p.fByStatus}(entries)¦.
`.replaceAll("¦", "'"),
    [PARSE]: raw`const LINE = /^(\S+) ([A-Z]+) (\S+) (\d{3}) (\d+)ms$/;

export function parseLine(line) {
  const m = LINE.exec(line.trim());
  if (!m) return null;
  return { time: m[1], method: m[2], path: m[3], status: Number(m[4]), ms: Number(m[5]) };
}

export function parseLog(text) {
  return text.split(/\r?\n/).map((line) => parseLine(line)).filter(Boolean);
}
`,
    [STATS]: raw`export function ${p.fErrors}(entries) {
  return entries.filter((e) => e.status >= 500).length;
}

export function ${p.fByStatus}(entries) {
  const counts = {};
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  return counts;
}
`,
    [CLI]: raw`#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseLog } from "./src/parse.js";
import { ${p.fErrors} } from "./src/stats.js";

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
  stats() {
    let entries = parseLog(readFileSync(pos[1], "utf8"));
    console.log("requests: " + entries.length);
    console.log("errors: " + ${p.fErrors}(entries));
  },
};

if (!commands[pos[0]]) {
  console.error("usage: node cli.js stats <file>");
  process.exit(1);
}
commands[pos[0]]();
`,
    "src/parse.test.js": raw`import test from "node:test";
import assert from "node:assert/strict";
import { parseLine, parseLog } from "./parse.js";

test("parseLine reads the five fields", () => {
  assert.deepEqual(parseLine("2024-05-01T10:00:00Z GET ${a} 200 30ms"), { time: "2024-05-01T10:00:00Z", method: "GET", path: "${a}", status: 200, ms: 30 });
});

test("parseLine returns null for garbage", () => {
  assert.equal(parseLine("hello"), null);
  assert.equal(parseLine(""), null);
});

test("parseLog skips blank and broken lines", () => {
  const text = "2024-05-01T10:00:00Z GET ${a} 200 30ms\n\nbroken\n2024-05-01T10:00:01Z POST ${b} 500 5ms\n";
  assert.deepEqual(parseLog(text).map((e) => e.path), ["${a}", "${b}"]);
});
`,
    "src/stats.test.js": raw`import test from "node:test";
import assert from "node:assert/strict";
import { ${p.fErrors}, ${p.fByStatus} } from "./stats.js";

const entries = [{ status: 200 }, { status: 500 }, { status: 200 }, { status: 404 }, { status: 503 }];

test("${p.fErrors} counts status 500 and above", () => {
  assert.equal(${p.fErrors}(entries), 2);
  assert.equal(${p.fErrors}([]), 0);
});

test("${p.fByStatus} counts per status", () => {
  assert.deepEqual(${p.fByStatus}(entries), { 200: 2, 404: 1, 500: 1, 503: 1 });
});
`,
    "cli.test.js": raw`import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("stats prints request and error counts", () => {
  const file = join(mkdtempSync(join(tmpdir(), "weblog-")), "a.log");
  writeFileSync(file, "2024-05-01T10:00:00Z GET ${a} 200 30ms\nnot a log line\n2024-05-01T10:00:01Z GET ${b} 502 7ms\n");
  const out = execFileSync(process.execPath, ["cli.js", "stats", file], { encoding: "utf8" });
  assert.equal(out, "requests: 2\nerrors: 1\n");
});
`,
  };
}

function context() {
  return `This repo is a small Node tool for request logs: a log line is ¦<ISO time> <METHOD> <path> <status> <ms>ms¦ (for example ¦2024-05-01T10:00:00Z GET /a 200 30ms¦), src/parse.js turns lines into ¦{time, method, path, status, ms}¦ objects, src/stats.js holds the analysis functions and ¦node cli.js stats <file>¦ prints the request and error counts. Extend it as follows.`;
}

function hiddenHead() {
  return raw`import * as parse from "../src/parse.js";
import * as stats from "../src/stats.js";
const E = (time, path, status = 200, ms = 10, method = "GET") => ({ time, method, path, status, ms });
const L = (time, method, path, status, ms) => [time, method, path, status, ms + "ms"].join(" ");
const LOGS = [
  L("2024-05-01T10:00:00Z", "GET", "/a", 200, 30),
  L("2024-05-01T10:00:10Z", "POST", "/b", 404, 120),
  L("2024-05-01T10:01:00Z", "GET", "/a", 500, 250),
  L("2024-05-01T10:02:30Z", "GET", "/c", 503, 40),
  L("2024-05-01T10:02:40Z", "GET", "/d", 200, 250),
  "garbage line",
];
const go = (lines, ...args) => {
  const d = H.tmp({ "a.log": lines.join("\n") + "\n" });
  return H.cli(args.map((a) => (a === "@" ? d + "/a.log" : a)), d);
};
`;
}

// Template shape: see random-task/stock.mjs.
const templates = [
  {
    key: "percentile",
    text: (p) => `In src/stats.js export ¦${p.fPct}(values, p)¦ (nearest-rank percentile): sort a copy of the numbers ascending, take ¦rank = max(1, ceil(p * n / 100))¦ with ¦n = values.length¦ and return the value at that 1-based rank. An empty list returns ¦null¦. ¦p¦ must be a number from 0 to 100 (both included), otherwise it throws an Error whose message contains the word ¦${p.w[0]}¦. The input is not modified.`,
    test: (p) => raw`const v = [50, 15, 40, 35, 20];
const f = stats.${p.fPct};
assert.equal(f(v, 30), 20);
assert.equal(f(v, 40), 20);
assert.equal(f(v, 50), 35);
assert.equal(f(v, 100), 50);
assert.equal(f(v, 0), 15);
assert.equal(f(v, 1), 15);
assert.equal(f([7], 99), 7);
assert.equal(f([2.5, 1.5], 51), 2.5);
assert.deepEqual(v, [50, 15, 40, 35, 20]);
assert.equal(f([], 50), null);
for (const bad of [-1, 100.5, NaN, "50", undefined]) H.throwsWith(() => f(v, bad), "${p.w[0]}");`,
    edits: (p) => [{ file: STATS, add: raw`
export function ${p.fPct}(values, p) {
  if (typeof p !== "number" || !(p >= 0 && p <= 100)) throw new RangeError("${p.w[0]}: p must be between 0 and 100");
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((p * sorted.length) / 100)) - 1];
}
` }],
    bad: () => ["Math.ceil(", "Math.floor("],
  },
  {
    key: "slowest",
    text: (p) => `In src/stats.js export ¦${p.fSlowest}(entries, n)¦: it returns the ¦n¦ entries (the same objects) with the highest ¦ms¦, highest first; equal ¦ms¦ keep their input order. ¦n¦ larger than the list returns all entries. An ¦n¦ that is not a non-negative integer makes it throw an Error whose message contains the word ¦${p.w[1]}¦.`,
    test: (p) => raw`const e = [E("t1", "/a", 200, 30), E("t2", "/b", 200, 250), E("t3", "/c", 200, 250), E("t4", "/d", 200, 10)];
assert.deepEqual(stats.${p.fSlowest}(e, 2), [e[1], e[2]]);
assert.deepEqual(stats.${p.fSlowest}(e, 3), [e[1], e[2], e[0]]);
assert.deepEqual(stats.${p.fSlowest}(e, 9), [e[1], e[2], e[0], e[3]]);
assert.deepEqual(stats.${p.fSlowest}(e, 0), []);
assert.deepEqual(stats.${p.fSlowest}([], 2), []);
for (const bad of [-1, 1.5, "2", undefined]) H.throwsWith(() => stats.${p.fSlowest}(e, bad), "${p.w[1]}");`,
    edits: (p) => [{ file: STATS, add: raw`
export function ${p.fSlowest}(entries, n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("${p.w[1]}: n must be a non-negative integer");
  return [...entries].sort((a, b) => b.ms - a.ms).slice(0, n);
}
` }],
    bad: () => ["b.ms - a.ms", "a.ms - b.ms"],
  },
  {
    key: "classCounts",
    text: (p) => `In src/stats.js export ¦${p.fClass}(entries)¦: it returns an object that counts the entries per status class, with keys like ¦"2xx"¦, ¦"3xx"¦, ¦"4xx"¦, ¦"5xx"¦ (the class is the hundreds digit of ¦status¦). Only classes that occur appear as keys; an empty list returns ¦{}¦.`,
    test: (p) => raw`const e = [200, 204, 404, 500, 503, 302, 599, 199].map((s) => E("t", "/a", s));
assert.deepEqual(stats.${p.fClass}(e), { "1xx": 1, "2xx": 2, "3xx": 1, "4xx": 1, "5xx": 3 });
assert.deepEqual(stats.${p.fClass}([E("t", "/a", 404)]), { "4xx": 1 });
assert.deepEqual(stats.${p.fClass}([]), {});`,
    edits: (p) => [{ file: STATS, add: raw`
export function ${p.fClass}(entries) {
  const counts = {};
  for (const e of entries) {
    const key = Math.floor(e.status / 100) + "xx";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
` }],
    bad: () => ["Math.floor(e.status / 100)", "Math.round(e.status / 100)"],
  },
  {
    key: "queryStrip",
    text: () => `Change ¦parseLine¦ in src/parse.js: the ¦path¦ of the result no longer contains a query string, i.e. everything from the first ¦?¦ on is cut off (¦/search?q=a&b=1¦ becomes ¦/search¦, ¦/?x=1¦ becomes ¦/¦). Paths without ¦?¦ and all other fields stay as they are.`,
    test: () => raw`const line = (path) => "2024-05-01T10:00:00Z GET " + path + " 200 15ms";
assert.deepEqual(parse.parseLine(line("/search?q=a&b=1")), { time: "2024-05-01T10:00:00Z", method: "GET", path: "/search", status: 200, ms: 15 });
assert.equal(parse.parseLine(line("/?x=1")).path, "/");
assert.equal(parse.parseLine(line("/a/b?")).path, "/a/b");
assert.equal(parse.parseLine(line("/a/b")).path, "/a/b");
assert.deepEqual(parse.parseLog(line("/x?y=1") + "\n" + line("/z")).map((e) => e.path), ["/x", "/z"]);`,
    edits: () => [{ file: PARSE, from: "path: m[3],", to: 'path: m[3].split("?")[0],' }],
    bad: () => ['split("?")', 'split("&")'],
  },
  {
    key: "perMinute",
    text: (p) => `In src/stats.js export ¦${p.fMinute}(entries)¦: it returns ¦[{minute, count}]¦ where ¦minute¦ is the first 16 characters of ¦time¦ (¦"2024-05-01T10:01"¦) and ¦count¦ the number of entries in that minute, ordered by minute ascending whatever the input order. Minutes without entries are left out.`,
    test: (p) => raw`const e = [E("2024-05-01T10:01:05Z", "/a"), E("2024-05-01T10:00:59Z", "/b"), E("2024-05-01T10:01:30Z", "/a"), E("2024-05-01T11:00:00Z", "/c")];
assert.deepEqual(stats.${p.fMinute}(e), [{ minute: "2024-05-01T10:00", count: 1 }, { minute: "2024-05-01T10:01", count: 2 }, { minute: "2024-05-01T11:00", count: 1 }]);
assert.deepEqual(stats.${p.fMinute}([]), []);`,
    edits: (p) => [{ file: STATS, add: raw`
export function ${p.fMinute}(entries) {
  const counts = new Map();
  for (const e of entries) {
    const minute = e.time.slice(0, 16);
    counts.set(minute, (counts.get(minute) ?? 0) + 1);
  }
  return [...counts]
    .map(([minute, count]) => ({ minute, count }))
    .sort((a, b) => ${cmp("a.minute", "b.minute")});
}
` }],
    bad: () => [".slice(0, 16)", ".slice(0, 17)"],
  },
  {
    key: "errorRate",
    text: (p) => `In src/stats.js export ¦${p.fRate}(entries)¦: it returns the share of entries with ¦status¦ 500 or above as a number between 0 and 1, rounded to 3 decimals with ¦Math.round(x * 1000) / 1000¦. An empty list returns ¦0¦.`,
    test: (p) => raw`const mk = (...s) => s.map((x) => E("t", "/a", x));
assert.equal(stats.${p.fRate}(mk(200, 500, 404, 503, 200, 200, 200, 200)), 0.25);
assert.equal(stats.${p.fRate}(mk(500, 200, 200)), 0.333);
assert.equal(stats.${p.fRate}(mk(500, 500, 200)), 0.667);
assert.equal(stats.${p.fRate}(mk(499, 200)), 0);
assert.equal(stats.${p.fRate}(mk(500)), 1);
assert.equal(stats.${p.fRate}([]), 0);`,
    edits: (p) => [{ file: STATS, add: raw`
export function ${p.fRate}(entries) {
  if (entries.length === 0) return 0;
  const errors = entries.filter((e) => e.status >= 500).length;
  return Math.round((errors / entries.length) * 1000) / 1000;
}
` }],
    bad: () => ["e.status >= 500", "e.status > 500"],
  },
  {
    key: "topPaths",
    text: (p) => `In src/stats.js export ¦${p.fTop}(entries, n)¦: it returns ¦[{path, count}]¦ for the ¦n¦ most requested paths, highest count first, equal counts ordered by ¦path¦ ascending (plain ¦<¦ / ¦>¦ comparison). ¦n¦ larger than the number of paths returns all of them. An ¦n¦ that is not a non-negative integer makes it throw an Error whose message contains the word ¦${p.w[2]}¦.`,
    test: (p) => raw`const e = ["/d", "/a", "/c", "/b", "/a", "/d", "/a", "/c"].map((x) => E("t", x));
assert.deepEqual(stats.${p.fTop}(e, 3), [{ path: "/a", count: 3 }, { path: "/c", count: 2 }, { path: "/d", count: 2 }]);
assert.deepEqual(stats.${p.fTop}(e, 10).at(-1), { path: "/b", count: 1 });
assert.equal(stats.${p.fTop}(e, 10).length, 4);
assert.deepEqual(stats.${p.fTop}(e, 0), []);
assert.deepEqual(stats.${p.fTop}([], 2), []);
for (const bad of [-1, 2.5, "2"]) H.throwsWith(() => stats.${p.fTop}(e, bad), "${p.w[2]}");`,
    edits: (p) => [{ file: STATS, add: raw`
export function ${p.fTop}(entries, n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("${p.w[2]}: n must be a non-negative integer");
  const counts = new Map();
  for (const e of entries) counts.set(e.path, (counts.get(e.path) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || ${cmp("a[0]", "b[0]")})
    .slice(0, n)
    .map(([path, count]) => ({ path, count }));
}
` }],
    bad: () => [cmp("a[0]", "b[0]"), "0"],
  },
  {
    key: "burstPaths",
    text: (p) => `In src/stats.js export ¦${p.fBurst}(entries, limit, windowSec)¦: a path is flagged if some request to it at time ¦t¦ (parsed with ¦Date.parse¦) is followed by more than ¦limit¦ requests to the same path in the window ¦[t, t + windowSec seconds)¦, counting the request at ¦t¦ itself and excluding the window end. It returns the flagged paths, each once, sorted ascending (plain comparison), whatever the input order. ¦limit¦ must be a non-negative integer and ¦windowSec¦ a number greater than 0, otherwise it throws an Error whose message contains the word ¦${p.w[3]}¦.`,
    test: (p) => raw`const at = (t) => "2024-05-01T10:" + t + "Z";
const e = [
  ...["00:00", "00:10", "00:20", "00:30"].map((t) => E(at(t), "/a")),
  ...["00:00", "01:00", "02:00"].map((t) => E(at(t), "/b")),
  ...["00:00", "00:59"].map((t) => E(at(t), "/c")),
].reverse();
const f = stats.${p.fBurst};
assert.deepEqual(f(e, 3, 60), ["/a"]);
assert.deepEqual(f(e, 1, 60), ["/a", "/c"]);
assert.deepEqual(f(e, 1, 61), ["/a", "/b", "/c"]);
assert.deepEqual(f(e, 4, 600), []);
assert.deepEqual(f(e, 0, 1), ["/a", "/b", "/c"]);
assert.deepEqual(f([], 1, 60), []);
for (const [l, w] of [[-1, 60], [1.5, 60], [1, 0], [1, -5], [1, "60"]]) H.throwsWith(() => f(e, l, w), "${p.w[3]}");`,
    edits: (p) => [{ file: STATS, add: raw`
export function ${p.fBurst}(entries, limit, windowSec) {
  if (!Number.isInteger(limit) || limit < 0 || typeof windowSec !== "number" || !(windowSec > 0)) throw new RangeError("${p.w[3]}: bad limit or window");
  const times = new Map();
  for (const e of entries) {
    if (!times.has(e.path)) times.set(e.path, []);
    times.get(e.path).push(Date.parse(e.time));
  }
  const hits = [];
  for (const [path, list] of times) {
    if (list.some((start) => list.filter((t) => t >= start && t < start + windowSec * 1000).length > limit)) hits.push(path);
  }
  return hits.sort((a, b) => ${cmp("a", "b")});
}
` }],
    bad: () => ["t < start + windowSec * 1000", "t <= start + windowSec * 1000"],
  },
  {
    key: "normalizePath",
    text: (p) => `In src/stats.js export ¦${p.fNorm}(path)¦: it replaces every path segment that consists only of digits with ¦:id¦ and removes a trailing ¦/¦ unless the whole path is ¦/¦ (¦/users/42/posts/7¦ becomes ¦/users/:id/posts/:id¦, ¦/users/42/¦ becomes ¦/users/:id¦). Segments with other characters (¦v2¦, ¦22b¦) and the case of letters stay unchanged.`,
    test: (p) => raw`const f = stats.${p.fNorm};
assert.equal(f("/users/42/posts/7"), "/users/:id/posts/:id");
assert.equal(f("/users/42/"), "/users/:id");
assert.equal(f("/"), "/");
assert.equal(f("/a1/22b/333"), "/a1/22b/:id");
assert.equal(f("/v2/Items/0"), "/v2/Items/:id");
assert.equal(f("/users/"), "/users");
assert.equal(f("/health"), "/health");`,
    edits: (p) => [{ file: STATS, add: raw`
export function ${p.fNorm}(path) {
  const out = path.split("/").map((segment) => (/^\d+$/.test(segment) ? ":id" : segment)).join("/");
  return out.length > 1 && out.endsWith("/") ? out.slice(0, -1) : out;
}
` }],
    bad: () => [raw`/^\d+$/`, raw`/^\d{2,}$/`],
  },
  {
    key: "statusFlag",
    text: (p) => `¦node cli.js stats <file> --${p.statusFlag} <class>¦ counts only the entries of that status class (¦1xx¦ to ¦5xx¦, e.g. ¦4xx¦) in both output lines. A missing value or anything else (¦6xx¦, ¦404¦, ¦abc¦) prints nothing to stdout, writes a message containing the word ¦${p.w[4]}¦ to stderr and exits with code ${p.ex[0]}.`,
    test: (p) => raw`const F = "--${p.statusFlag}";
const s = (...a) => H.ok(go(LOGS, "stats", "@", ...a));
assert.deepEqual(s(), ["requests: 5", "errors: 2"]);
assert.deepEqual(s(F, "4xx"), ["requests: 1", "errors: 0"]);
assert.deepEqual(s(F, "5xx"), ["requests: 2", "errors: 2"]);
assert.deepEqual(s(F, "2xx"), ["requests: 2", "errors: 0"]);
assert.deepEqual(s(F, "1xx"), ["requests: 0", "errors: 0"]);
for (const bad of ["6xx", "404", "abc", "4XX"]) H.failed(go(LOGS, "stats", "@", F, bad), "${p.w[4]}", ${p.ex[0]});
H.failed(go(LOGS, "stats", "@", F), "${p.w[4]}", ${p.ex[0]});`,
    edits: (p) => [{ file: CLI, from: PRINT, to: raw`    const cls = flags[${J(p.statusFlag)}];
    if (cls !== undefined) {
      if (!/^[1-5]xx$/.test(cls)) {
        console.error("${p.w[4]}: --${p.statusFlag} takes a class like 5xx");
        process.exit(${p.ex[0]});
      }
      entries = entries.filter((e) => Math.floor(e.status / 100) === Number(cls[0]));
    }
${PRINT}` }],
    bad: () => ["=== Number(cls[0])", ">= Number(cls[0])"],
  },
  {
    key: "slowCmd",
    text: (p) => `¦node cli.js ${p.cmdSlow} <file> --${p.overFlag} <ms>¦ prints one line ¦<ms>ms <path>¦ for every entry whose ¦ms¦ is strictly greater than the given number, slowest first, equal ¦ms¦ in file order; if there is none it prints the single line ¦none¦. A missing or non-numeric value prints nothing to stdout, writes a message containing the word ¦${p.w[5]}¦ to stderr and exits with code ${p.ex[1]}.`,
    test: (p) => raw`const F = "--${p.overFlag}";
const s = (...a) => H.ok(go(LOGS, "${p.cmdSlow}", "@", ...a));
assert.deepEqual(s(F, "100"), ["250ms /a", "250ms /d", "120ms /b"]);
assert.deepEqual(s(F, "249.5"), ["250ms /a", "250ms /d"]);
assert.deepEqual(s(F, "250"), ["none"]);
assert.deepEqual(s(F, "0"), ["250ms /a", "250ms /d", "120ms /b", "40ms /c", "30ms /a"]);
for (const bad of ["abc", "x1"]) H.failed(go(LOGS, "${p.cmdSlow}", "@", F, bad), "${p.w[5]}", ${p.ex[1]});
H.failed(go(LOGS, "${p.cmdSlow}", "@"), "${p.w[5]}", ${p.ex[1]});`,
    edits: (p) => [{ file: CLI, from: NEW_COMMAND, to: raw`  ${p.cmdSlow}() {
    const value = flags[${J(p.overFlag)}];
    const over = Number(value);
    if (value === undefined || value === true || Number.isNaN(over)) {
      console.error("${p.w[5]}: --${p.overFlag} needs a number");
      process.exit(${p.ex[1]});
    }
    const hits = parseLog(readFileSync(pos[1], "utf8"))
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.ms > over)
      .sort((a, b) => b.e.ms - a.e.ms || a.i - b.i);
    if (hits.length === 0) console.log("none");
    for (const { e } of hits) console.log(e.ms + "ms " + e.path);
  },
${NEW_COMMAND}` }],
    bad: () => ["e.ms > over", "e.ms >= over"],
  },
  {
    key: "topCmd",
    text: (p) => `¦node cli.js ${p.cmdTop} <file> [--${p.nFlag} <k>]¦ prints the ¦k¦ most requested paths (default 3), one line ¦<count> <path>¦ each, highest count first, equal counts by path ascending. ¦k¦ must be a positive integer; anything else (¦0¦, ¦-1¦, ¦1.5¦, ¦abc¦, no value) prints nothing to stdout, writes a message containing the word ¦${p.w[0]}¦ to stderr and exits with code ${p.ex[2]}.`,
    test: (p) => raw`const F = "--${p.nFlag}";
const s = (...a) => H.ok(go(LOGS, "${p.cmdTop}", "@", ...a));
assert.deepEqual(s(), ["2 /a", "1 /b", "1 /c"]);
assert.deepEqual(s(F, "1"), ["2 /a"]);
assert.deepEqual(s(F, "10"), ["2 /a", "1 /b", "1 /c", "1 /d"]);
for (const bad of ["0", "-1", "1.5", "abc"]) H.failed(go(LOGS, "${p.cmdTop}", "@", F, bad), "${p.w[0]}", ${p.ex[2]});
H.failed(go(LOGS, "${p.cmdTop}", "@", F), "${p.w[0]}", ${p.ex[2]});`,
    edits: (p) => [{ file: CLI, from: NEW_COMMAND, to: raw`  ${p.cmdTop}() {
    const value = flags[${J(p.nFlag)}];
    const n = value === undefined ? 3 : value === true ? NaN : Number(value);
    if (!Number.isInteger(n) || n < 1) {
      console.error("${p.w[0]}: --${p.nFlag} needs a positive integer");
      process.exit(${p.ex[2]});
    }
    const counts = new Map();
    for (const e of parseLog(readFileSync(pos[1], "utf8"))) counts.set(e.path, (counts.get(e.path) ?? 0) + 1);
    [...counts]
      .sort((a, b) => b[1] - a[1] || ${cmp("a[0]", "b[0]")})
      .slice(0, n)
      .forEach(([path, count]) => console.log(count + " " + path));
  },
${NEW_COMMAND}` }],
    bad: () => [".slice(0, n)", ".slice(0, n + 1)"],
  },
  {
    key: "sinceFlag",
    text: (p) => `¦node cli.js stats <file> --${p.sinceFlag} <time>¦ counts only the entries whose ¦time¦ is at or after ¦time¦ in both output lines; both are compared as instants with ¦Date.parse¦, so ¦2024-05-01T12:01:00+02:00¦ equals ¦2024-05-01T10:01:00Z¦. A missing or unparsable value prints nothing to stdout, writes a message containing the word ¦${p.w[1]}¦ to stderr and exits with code ${p.ex[3]}.`,
    test: (p) => raw`const F = "--${p.sinceFlag}";
const s = (...a) => H.ok(go(LOGS, "stats", "@", ...a));
assert.deepEqual(s(F, "2024-05-01T10:01:00Z"), ["requests: 3", "errors: 2"]);
assert.deepEqual(s(F, "2024-05-01T12:01:00+02:00"), ["requests: 3", "errors: 2"]);
assert.deepEqual(s(F, "2024-05-01T10:01:01Z"), ["requests: 2", "errors: 1"]);
assert.deepEqual(s(F, "2000-01-01T00:00:00Z"), ["requests: 5", "errors: 2"]);
assert.deepEqual(s(F, "2030-01-01T00:00:00Z"), ["requests: 0", "errors: 0"]);
H.failed(go(LOGS, "stats", "@", F, "yesterday"), "${p.w[1]}", ${p.ex[3]});
H.failed(go(LOGS, "stats", "@", F), "${p.w[1]}", ${p.ex[3]});`,
    edits: (p) => [{ file: CLI, from: PRINT, to: raw`    const since = flags[${J(p.sinceFlag)}];
    if (since !== undefined) {
      const from = Date.parse(since);
      if (since === true || Number.isNaN(from)) {
        console.error("${p.w[1]}: --${p.sinceFlag} needs a date and time");
        process.exit(${p.ex[3]});
      }
      entries = entries.filter((e) => Date.parse(e.time) >= from);
    }
${PRINT}` }],
    bad: () => [">= from", "> from"],
  },
  {
    key: "strictParse",
    text: (p) => `Change ¦parseLog(text, options)¦ in src/parse.js: with ¦{ strict: true }¦ as second argument it throws an Error for the first line that is neither blank nor parsable; the message contains ¦line <n>: ${p.w[2]}¦ where ¦n¦ is the 1-based number of that line in the text (blank lines count). Blank lines are always skipped. Without the option (or with ¦strict: false¦) it behaves as before and skips broken lines.`,
    test: (p) => raw`const good1 = L("2024-05-01T10:00:00Z", "GET", "/a", 200, 5), good2 = L("2024-05-01T10:00:01Z", "GET", "/b", 200, 6);
const text = [good1, "", "this is not a log line", good2, "also bad"].join("\n");
assert.deepEqual(parse.parseLog(text).map((e) => e.path), ["/a", "/b"]);
assert.deepEqual(parse.parseLog(text, { strict: false }).map((e) => e.path), ["/a", "/b"]);
H.throwsWith(() => parse.parseLog(text, { strict: true }), "line 3: ${p.w[2]}");
H.throwsWith(() => parse.parseLog("oops\n" + good1, { strict: true }), "line 1: ${p.w[2]}");
assert.deepEqual(parse.parseLog([good1, "", "  ", good2, ""].join("\n"), { strict: true }).map((e) => e.path), ["/a", "/b"]);
assert.deepEqual(parse.parseLog("", { strict: true }), []);`,
    edits: (p) => [{ file: PARSE, from: raw`export function parseLog(text) {
  return text.split(/\r?\n/).map((line) => parseLine(line)).filter(Boolean);
}`, to: raw`export function parseLog(text, { strict = false } = {}) {
  const entries = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    const entry = parseLine(line);
    if (entry) entries.push(entry);
    else if (strict) throw new Error("line " + (i + 1) + ": ${p.w[2]}");
  });
  return entries;
}` }],
    bad: () => ["(i + 1)", "i"],
  },
  {
    key: "perPath",
    text: (p) => `In src/stats.js export ¦${p.fPer}(entries)¦: it returns ¦[{path, count, avgMs}]¦ with one element per path, sorted by ¦path¦ ascending (plain comparison); ¦avgMs¦ is the mean of ¦ms¦ rounded with ¦Math.round¦ (so 5.5 gives 6). An empty list returns ¦[]¦.`,
    test: (p) => raw`const e = [E("t", "/b", 200, 10), E("t", "/a", 200, 5), E("t", "/b", 200, 21), E("t", "/a", 200, 6), E("t", "/b", 200, 20), E("t", "/c", 200, 1)];
assert.deepEqual(stats.${p.fPer}(e), [{ path: "/a", count: 2, avgMs: 6 }, { path: "/b", count: 3, avgMs: 17 }, { path: "/c", count: 1, avgMs: 1 }]);
assert.deepEqual(stats.${p.fPer}([]), []);`,
    edits: (p) => [{ file: STATS, add: raw`
export function ${p.fPer}(entries) {
  const groups = new Map();
  for (const e of entries) {
    const g = groups.get(e.path) ?? { count: 0, sum: 0 };
    groups.set(e.path, { count: g.count + 1, sum: g.sum + e.ms });
  }
  return [...groups]
    .map(([path, g]) => ({ path, count: g.count, avgMs: Math.round(g.sum / g.count) }))
    .sort((a, b) => ${cmp("a.path", "b.path")});
}
` }],
    bad: () => ["Math.round(", "Math.floor("],
  },
];

export default { name: "weblog", params, base, hiddenHead, context, templates };
