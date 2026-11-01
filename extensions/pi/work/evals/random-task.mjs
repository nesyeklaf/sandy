#!/usr/bin/env node
// Seeded random task generator for an agent eval. One seed gives one fresh multi-part coding task:
// a small JS repo (files), a prompt with exactly 10 numbered requirements, hidden node:test files (one per
// requirement, test name starts with R01..R10) the agent never sees, and a reference solution.
// The checks are validated by code: the start repo fails all 10, the reference passes all 10, and a mutant
// of the reference with requirement k broken fails exactly Rk.
//
//   node random-task.mjs --seed 7 --out /tmp/rt7      write /tmp/rt7/{repo,prompt.txt,hidden,reference}
//   node random-task.mjs --validate 1-30              check generator + hidden tests for seeds (exit 1 on failure)
//   node random-task.mjs --judge /tmp/rt7/repo --seed 7   score a finished repo: JSON [{id, status, message?}]
// API: generate(seed), judge(repoDir, task), validate(seed). Families live in ./random-task/*.mjs.
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import stock from "./random-task/stock.mjs";
import ledger from "./random-task/ledger.mjs";
import weblog from "./random-task/weblog.mjs";
import { HIDDEN_HELPER } from "./random-task/util.mjs";

const FAMILIES = [stock, ledger, weblog];
const HIDDEN_DIR = "__hidden__";
const CLOSING = "A checker tests the contracts named above. Cover the new behavior with tests next to the existing ones, update README.md, and run npm test at the end.";
const isTestFile = (f) => /\.test\.m?js$/.test(f) && !f.startsWith(HIDDEN_DIR);

function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 5; i++) next();
  const rng = {
    pick: (list) => list[Math.floor(next() * list.length)],
    shuffle(list) {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    sample: (list, n) => rng.shuffle(list).slice(0, n),
  };
  return rng;
}

// Applies edits in order to a copy of files; with bad = template.bad(p), the template's new text is broken.
function applyEdits(files, edits, bad, key) {
  let broke = !bad;
  for (const edit of edits) {
    const field = edit.from === undefined ? "add" : "to";
    let text = edit[field];
    if (bad) {
      const broken = text.replace(bad[0], () => bad[1]);
      broke ||= broken !== text;
      text = broken;
    }
    const current = files[edit.file] ?? "";
    if (edit.from === undefined) files[edit.file] = current + (current === "" || current.endsWith("\n") ? "" : "\n") + text;
    else if (!current.includes(edit.from)) throw new Error(key + ": anchor not found in " + edit.file + ": " + edit.from);
    else files[edit.file] = current.replace(edit.from, () => text);
  }
  if (!broke) throw new Error(key + ": bad() found nothing to break");
}

function build(plan, badIndex = -1) {
  const files = plan.family.base(plan.p);
  plan.chosen.forEach((t, i) => applyEdits(files, t.edits(plan.p), i === badIndex ? t.bad(plan.p) : null, t.key));
  return files;
}

export function generate(seed) {
  const family = FAMILIES[Math.abs(seed) % FAMILIES.length];
  const rng = makeRng(seed);
  const p = family.params(rng);
  const chosen = rng.sample(family.templates, 10);
  const plan = { family, p, chosen };
  const files = family.base(p);
  const solved = build(plan);
  const id = (i) => "R" + String(i + 1).padStart(2, "0");
  const requirements = chosen.map((t, i) => ({ id: id(i), text: t.text(p).replaceAll("¦", "\u0060") }));
  const hidden = { [HIDDEN_DIR + "/h.mjs"]: HIDDEN_HELPER };
  chosen.forEach((t, i) => {
    const name = id(i) + " " + t.key;
    hidden[HIDDEN_DIR + "/" + id(i) + ".test.mjs"] =
      'import test from "node:test";\nimport assert from "node:assert/strict";\nimport * as H from "./h.mjs";\n' +
      family.hiddenHead(p) + "\ntest(" + JSON.stringify(name) + ", async () => {\n" + t.test(p) + "\n});\n";
  });
  const reference = Object.fromEntries(Object.entries(solved).filter(([f, c]) => files[f] !== c));
  const prompt = family.context(p).replaceAll("¦", "\u0060") + "\n\n" +
    requirements.map((r, i) => (i + 1) + ". " + r.text).join("\n") + "\n\n" + CLOSING + "\n";
  const task = { seed, family: family.name, prompt, files, requirements, hidden, reference };
  Object.defineProperty(task, "mutant", {
    value: (reqId) => ({ ...files, ...Object.fromEntries(Object.entries(build(plan, chosen.findIndex((_, i) => id(i) === reqId))).filter(([f, c]) => files[f] !== c)) }),
  });
  return task;
}

function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

function runNodeTest(cwd, files) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", ...files], {
      cwd, timeout: 60000, killSignal: "SIGKILL", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code, signal) => {
      const passed = Number(/pass (\d+)/.exec(out)?.[1] ?? 0);
      const failed = Number(/fail (\d+)/.exec(out)?.[1] ?? 0);
      if (code === 0 && passed >= files.length && failed === 0) return resolve({ status: "passed" });
      const detail = /(?:AssertionError|TypeError|RangeError|SyntaxError|Error)[^\n]*(?:\n[^\n]*){0,3}/.exec(out)?.[0] ?? out.slice(-300);
      resolve({ status: "failed", message: (signal ? "killed (" + signal + "): " : "") + detail.trim().slice(0, 400) });
    });
  });
}

export async function judge(repoDir, task) {
  const dir = mkdtempSync(join(tmpdir(), "rt-judge-"));
  try {
    cpSync(repoDir, dir, { recursive: true, filter: (src) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(relative(repoDir, src)) });
    write(dir, task.hidden);
    const originals = Object.fromEntries(Object.entries(task.files).filter(([f]) => isTestFile(f)));
    write(dir, originals);
    const runs = [
      ...task.requirements.map((r) => runNodeTest(dir, [HIDDEN_DIR + "/" + r.id + ".test.mjs"]).then((res) => ({ id: r.id, ...res }))),
      runNodeTest(dir, Object.keys(originals)).then((res) => ({ id: "P2P", ...res })),
    ];
    return await Promise.all(runs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function judgeFiles(task, files) {
  const dir = mkdtempSync(join(tmpdir(), "rt-repo-"));
  try {
    write(dir, files);
    return await judge(dir, task);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function validate(seed) {
  const problems = [];
  let task;
  try {
    task = generate(seed);
    if (JSON.stringify(task) !== JSON.stringify(generate(seed))) problems.push("generate is not deterministic");
    const numbered = task.prompt.split("\n").filter((l) => /^\d+\. /.test(l));
    if (numbered.length !== 10) problems.push("prompt has " + numbered.length + " numbered lines");
    if (!task.prompt.trimEnd().endsWith("run npm test at the end.")) problems.push("prompt ending");
  } catch (e) {
    return { ok: false, problems: ["generate: " + e.message] };
  }
  const expect = async (label, files, shouldFail) => {
    const results = await judgeFiles(task, files);
    for (const r of results) {
      const wantFail = r.id !== "P2P" && shouldFail.includes(r.id);
      if ((r.status === "failed") !== wantFail) problems.push(label + ": " + r.id + " " + r.status + (r.message ? " (" + r.message.split("\n")[0] + ")" : ""));
    }
  };
  const ids = task.requirements.map((r) => r.id);
  await expect("start", task.files, ids);
  await expect("reference", { ...task.files, ...task.reference }, []);
  for (const id of ids) {
    try {
      await expect("mutant " + id, task.mutant(id), [id]);
    } catch (e) {
      problems.push("mutant " + id + ": " + e.message);
    }
  }
  return { ok: problems.length === 0, problems };
}

function writeTask(task, out) {
  const repo = join(out, "repo");
  write(repo, task.files);
  write(out, { "prompt.txt": task.prompt });
  write(join(out, "hidden"), task.hidden);
  write(join(out, "reference"), task.reference);
  const git = (...args) => execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
}

function parseSeeds(spec) {
  return spec.split(",").flatMap((part) => {
    const [a, b = a] = part.split("-").map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
}

async function main(argv) {
  const arg = (name) => argv[argv.indexOf(name) + 1];
  if (argv.includes("--validate")) {
    const seeds = parseSeeds(arg("--validate"));
    const queue = [...seeds];
    const results = new Map();
    const worker = async () => {
      for (let seed = queue.shift(); seed !== undefined; seed = queue.shift()) results.set(seed, await validate(seed));
    };
    const pool = Promise.all(Array.from({ length: 4 }, worker));
    let failed = false;
    await pool;
    for (const seed of seeds) {
      const r = results.get(seed);
      failed ||= !r.ok;
      console.log("seed " + seed + " " + FAMILIES[seed % FAMILIES.length].name + " " + (r.ok ? "ok" : "FAIL: " + r.problems.join("; ")));
    }
    process.exit(failed ? 1 : 0);
  }
  const seed = Number(arg("--seed"));
  if (argv.includes("--judge")) {
    console.log(JSON.stringify(await judge(arg("--judge"), generate(seed)), null, 2));
  } else if (argv.includes("--seed") && argv.includes("--out")) {
    writeTask(generate(seed), arg("--out"));
  } else {
    console.error("usage: random-task.mjs --seed N --out DIR | --validate 1-30 | --judge DIR/repo --seed N");
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
