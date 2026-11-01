#!/usr/bin/env node
// One-shot rename of the hard fork: bb -> sandy. Usage: node scripts/rename-sandy.mjs [--apply] [--only=<path prefix>]
// Matches whole segments only, so hashes, ids and words like bbox or bubbles stay untouched.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const apply = process.argv.includes("--apply");
const SKIP_CONTENT = [/^LICENSE$/, /^CHANGELOG\.md$/, /(^|\/)THIRD_PARTY_NOTICES/, /^scripts\/rename-sandy\.mjs$/];
const PROTECT = "(?!ox|edit|code|Edit|Code)";

// Order matters: specific forms first.
const RULES = [
  [/@get-bb(?![A-Za-z0-9-])/g, "@sandy-sdk"],
  [/createBBSdk/g, "createSandySdk"],
  [/github\.com\/get-bb\/bb/g, "github.com/nesyeklaf/sandy"],
  [/(?<![A-Za-z0-9-])get-bb\/bb(?![A-Za-z0-9])/g, "nesyeklaf/sandy"],
  [/app\.getbb\./g, "app.sandy."],
  [/__bb(?=perf|measures|Spike)/g, "__sandy"],
  [/(?<![A-Za-z0-9])(?<!get-)bb(?=cm_|de_|dh_|perf|thread:|task:)/g, "sandy"],
  [/(?<=\\u0000|\\[nrt]|%3A)bb(?![a-z0-9])/g, "sandy"],
  [/(?<=\\u0000|\\[nrt]|%3A)BB(?![a-z0-9])/g, "SANDY"],
  [/(?<![A-Za-z0-9])BB(?=(?!Edit)[A-Z][a-z])/g, "Sandy"],
  [new RegExp("(?<![A-Za-z0-9])BB(?![a-z0-9])" + PROTECT, "g"), "SANDY"],
  [new RegExp("(?<![A-Za-z0-9\\[])Bb" + PROTECT + "(?![a-z])", "g"), "Sandy"],
  [new RegExp("(?<=[a-z0-9])Bb(?!\\])" + PROTECT + "(?![a-z])", "g"), "Sandy"],
  [new RegExp("(?<![A-Za-z0-9])(?<!get-)bb(?![a-z0-9])" + PROTECT, "g"), "sandy"],
];
// Opaque tokens (base64 digests, keys) stay untouched: long mixed-case runs that hold a digit.
const OPAQUE = /(?:\\[ux][0-9A-Fa-f]{2,4}|(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{28,}|(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{80,})={0,2}/g;
const applyRules = (s) => RULES.reduce((acc, [re, to]) => acc.replace(re, to), s);
export const rename = (s) => {
  let out = "", last = 0;
  for (const m of s.matchAll(OPAQUE)) {
    out += applyRules(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + applyRules(s.slice(last));
};

const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const files = execFileSync("git", ["ls-files", "-z"], { maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean).filter((f) => !only || f.startsWith(only));
const isText = (buf) => !buf.subarray(0, 8000).includes(0);
let contentFiles = 0, hits = 0, moves = [];
for (const f of files) {
  if (!existsSync(f)) continue;
  if (!SKIP_CONTENT.some((re) => re.test(f))) {
    const buf = readFileSync(f);
    if (isText(buf)) {
      const before = buf.toString("utf8");
      const after = rename(before);
      if (after !== before) {
        contentFiles++;
        hits += before.split(/(?<![A-Za-z0-9])(?:bb|BB|Bb|get-bb)/).length - 1;
        if (apply) writeFileSync(f, after);
      }
    }
  }
  const to = rename(f);
  if (to !== f) moves.push([f, to]);
}
console.log(JSON.stringify({ apply, contentFiles, approxHits: hits, pathRenames: moves.length }));
if (process.argv.includes("--list-moves")) for (const [a, b] of moves) console.log(a + " -> " + b);
if (apply) {
  for (const [a, b] of moves.sort((x, y) => y[0].length - x[0].length)) {
    mkdirSync(dirname(b), { recursive: true });
    execFileSync("git", ["mv", a, b]);
  }
}
