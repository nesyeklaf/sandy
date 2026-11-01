#!/usr/bin/env node
// Benchmark "resume": one medium feature from idea to a fake release, on a small copy of the autopilot (resume-task/base,
// pi-autopilot 0.1.0: the /autopilot command and plan-run). The agent designs, builds, tests, documents and releases
// "/autopilot resume" (continue a plan-run that a pi reload cut off) without any input. Judged afterwards by hidden
// behavior checks (resume-task/hidden.mts, H01-H12: a fresh copy of the repo per pi "instance", sharing only the
// session entries) and release checks (R01-R07), plus P2P: the start repo's own tests still pass against the result.
//   node resume-task.mjs --validate          base scores 0, the reference (resume-task/reference) scores all
//   node resume-task.mjs --judge <repo>      JSON results
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = join(import.meta.dirname, "resume-task");
const BASE = join(HERE, "base");

export const prompt =
  "This repo is pi-autopilot 0.1.0: the /autopilot command and its plan-run autopilot (src/, see README.md). The problem: when pi reloads in the middle of /autopilot plan-run, the run is lost. The task list stays on a step in_progress and there is no way to continue. Take this from idea to a release on your own; nobody will answer questions. " +
  "(1) Design: write docs/autopilot-resume.md with the problem, at least two designs you considered, and the one you chose and why. " +
  "(2) Build /autopilot resume: it continues the newest unfinished plan-run of this session where it stopped. A reloaded pi is a new extension instance that sees the old run only through the session: read it with ctx.sessionManager.getBranch(), whose entries are {type: \"custom\", customType, data} as pi.appendEntry wrote them. Completed steps do not run again and the plan is not made again; the step that was running when pi stopped runs again from the start; an interrupted check runs again; a run stopped during planning plans again with the original task. The resumed run keeps writing the same task list (same ids and subjects) and still blocks the task tools. A run that ended blocked can be resumed from its blocked step. A run that finished (passed, or failed its check) is not resumed; when there is nothing to resume, or while a run is still going in this pi process, /autopilot resume starts no step and says why with pi.sendMessage. Keep the exports and signatures of src/autopilot.ts and src/plan-run.ts and the behavior the existing tests pin. " +
  "(3) Cover it with tests next to the existing ones; npm test must pass. " +
  "(4) Document /autopilot resume in README.md. " +
  "(5) Release it as 0.2.0: the version in package.json, a CHANGELOG.md entry, everything committed, and an annotated git tag v0.2.0 whose message holds the release notes. Do not push.";

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const gitOk = (dir, ...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

export function fixture(dir) {
  cpSync(BASE, dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-qm", "pi-autopilot 0.1.0");
  git(dir, "-c", "user.email=eval@local", "-c", "user.name=eval", "tag", "-a", "v0.1.0", "-m", "pi-autopilot 0.1.0: /autopilot and plan-run");
}

const copy = (repo) => {
  const dir = mkdtempSync(join(tmpdir(), "resume-judge-"));
  cpSync(repo, dir, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)$/.test(src) });
  return dir;
};
const testFiles = (dir, at = "") =>
  readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) =>
    e.name === ".git" || e.name === "node_modules" ? [] : e.isDirectory() ? testFiles(dir, join(at, e.name)) : /\.test\.(ts|mts|js|mjs)$/.test(e.name) ? [join(at, e.name)] : [],
  );
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

export function judge(repo) {
  const results = [];
  const add = (id, title, pass, message) => results.push({ id, title, status: pass ? "passed" : "failed", ...(pass ? {} : { message }) });

  // P2P: the start repo's tests, as the agent got them, against its result.
  const p2p = copy(repo);
  for (const name of ["plan-run.test.ts", "autopilot.test.ts"]) writeFileSync(join(p2p, "src", "p2p-" + name), readFileSync(join(BASE, "src", name), "utf8"));
  const start = spawnSync("node", ["--test", "--experimental-strip-types", "src/p2p-plan-run.test.ts", "src/p2p-autopilot.test.ts"], { cwd: p2p, encoding: "utf8", timeout: 60000 });
  results.push({ id: "P2P", title: "the start repo's tests still pass", status: start.status === 0 ? "passed" : "failed", message: start.status === 0 ? undefined : (start.stdout + start.stderr).slice(-600) });

  const hidden = spawnSync("node", ["--experimental-strip-types", join(HERE, "hidden.mts"), copy(repo)], { encoding: "utf8", timeout: 120000 });
  try {
    results.push(...JSON.parse(hidden.stdout.trim().split("\n").at(-1)));
  } catch {
    for (let i = 1; i <= 12; i++) add("H" + String(i).padStart(2, "0"), "hidden check", false, "hidden checks crashed: " + (hidden.stderr || hidden.stdout).slice(-300));
  }

  const pkg = (() => {
    try {
      return JSON.parse(read(join(repo, "package.json")));
    } catch {
      return {};
    }
  })();
  add("R01", "package.json says 0.2.0", pkg.version === "0.2.0", "version " + pkg.version);
  const changelog = read(join(repo, "CHANGELOG.md"));
  const section = changelog.split(/^#+\s.*0\.2\.0.*$/m)[1]?.split(/^#+\s.*\d+\.\d+\.\d+/m)[0] ?? "";
  add("R02", "CHANGELOG.md has a 0.2.0 entry about resume", /resume/i.test(section), section ? "the 0.2.0 section does not mention resume" : "no 0.2.0 heading");
  const type = gitOk(repo, "cat-file", "-t", "v0.2.0").stdout.trim();
  const notes = gitOk(repo, "tag", "-l", "--format=%(contents)", "v0.2.0").stdout.trim();
  const head = gitOk(repo, "rev-parse", "HEAD").stdout.trim();
  const tagged = gitOk(repo, "rev-parse", "v0.2.0^{commit}").stdout.trim();
  add("R03", "annotated tag v0.2.0 with release notes on HEAD", type === "tag" && notes.length >= 40 && tagged === head, "type " + (type || "none") + ", notes " + notes.length + " chars, on HEAD " + (tagged === head));
  const dirty = gitOk(repo, "status", "--porcelain").stdout.trim();
  add("R04", "everything is committed", dirty === "", "uncommitted: " + dirty.split("\n").slice(0, 5).join(", "));
  const doc = read(join(repo, "docs", "autopilot-resume.md"));
  const lines = doc.split("\n").filter((l) => l.trim()).length;
  // Designs: the items (numbered, bold bullets or subheadings) under a heading about designs, options or approaches,
  // or failing that the words themselves.
  const docLines = doc.split("\n");
  const at = docLines.findIndex((l) => /^#+.*\b(design|option|alternative|approach)/i.test(l));
  const level = at < 0 ? 0 : docLines[at].match(/^#+/)[0].length;
  const end = at < 0 ? at : docLines.findIndex((l, i) => i > at && (l.match(/^#+(?=\s)/)?.[0].length ?? 99) <= level);
  const items = at < 0 ? 0 : docLines.slice(at + 1, end < 0 ? undefined : end).filter((l) => /^\s*(\d+[.)]\s|[-*]\s+\*\*|#{2,}\s)/.test(l)).length;
  const designs = Math.max(items, (doc.match(/\b(design|option|approach|alternative)s?\b/gi) ?? []).length);
  add("R05", "docs/autopilot-resume.md: problem, designs, decision", lines >= 12 && designs >= 2 && /(decision|decide|chose|choose|chosen|pick)/i.test(doc), doc ? lines + " lines, " + designs + " design words" : "missing");
  add("R06", "README.md documents /autopilot resume", /\/autopilot resume/.test(read(join(repo, "README.md"))), "no /autopilot resume in README.md");
  const own = testFiles(repo).filter((f) => /resume/i.test(read(join(repo, f))));
  const npm = spawnSync("npm", ["test"], { cwd: repo, encoding: "utf8", timeout: 120000 });
  add("R07", "own tests cover resume and npm test passes", own.length > 0 && npm.status === 0, "test files about resume: " + own.length + ", npm test exit " + npm.status);
  return results;
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const show = (results) => {
    const score = results.filter((r) => r.id !== "P2P" && r.status === "passed").length;
    return score + "/" + results.filter((r) => r.id !== "P2P").length + ", P2P " + results.find((r) => r.id === "P2P")?.status + "\n" + results.filter((r) => r.status !== "passed").map((r) => "  " + r.id + " " + r.title + ": " + String(r.message ?? "").slice(0, 140)).join("\n");
  };
  if (args[0] === "--judge") console.log(JSON.stringify(judge(args[1]), null, 2));
  else if (args[0] === "--validate") {
    const base = mkdtempSync(join(tmpdir(), "resume-base-"));
    fixture(base);
    console.log("base: " + show(judge(base)));
    const ref = mkdtempSync(join(tmpdir(), "resume-ref-"));
    fixture(ref);
    const R = join(HERE, "reference");
    cpSync(join(R, "src"), join(ref, "src"), { recursive: true });
    cpSync(join(R, "docs"), join(ref, "docs"), { recursive: true });
    cpSync(join(R, "CHANGELOG.md"), join(ref, "CHANGELOG.md"));
    writeFileSync(join(ref, "README.md"), read(join(ref, "README.md")).replace("\n## Development", read(join(R, "README-resume.md")) + "\n## Development"));
    writeFileSync(join(ref, "package.json"), read(join(ref, "package.json")).replace('"0.1.0"', '"0.2.0"'));
    git(ref, "add", ".");
    git(ref, "-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-qm", "/autopilot resume");
    git(ref, "-c", "user.email=eval@local", "-c", "user.name=eval", "tag", "-a", "v0.2.0", "-m", "pi-autopilot 0.2.0\n\n/autopilot resume continues a plan-run that a pi reload cut off.");
    const results = judge(ref);
    console.log("reference: " + show(results));
    if (results.some((r) => r.status !== "passed")) process.exit(1);
  } else console.log(prompt);
}
