// Shared helpers for the random-task families.
export const raw = String.raw;
export const J = JSON.stringify;

export const WORDS = ["invalid", "bogus", "rejected", "unsupported", "malformed", "illegal", "unknown", "forbidden"];

export function pkg(name) {
  return `{ "name": "${name}", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n`;
}

// Hidden-test boilerplate shared by all families: module path of the repo root, temp dirs, CLI runner.
export const HIDDEN_HELPER = raw`import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function tmp(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rt-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

export function cli(args, cwd = tmp()) {
  const r = spawnSync(process.execPath, [join(root, "cli.js"), ...args], { cwd, encoding: "utf8", timeout: 20000, input: "" });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

export const lines = (s) => (s.trim() === "" ? [] : s.replace(/\n$/, "").split("\n"));

export function throwsWith(fn, word) {
  let error;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Error, "expected an Error to be thrown");
  assert.ok(error.message.includes(word), "message " + JSON.stringify(error.message) + " lacks " + JSON.stringify(word));
}

// A CLI run that must fail: exit code, a word on stderr, nothing on stdout.
export function failed(r, word, code) {
  assert.equal(r.code, code, "exit code, stderr: " + r.err);
  assert.ok(r.err.includes(word), "stderr " + JSON.stringify(r.err) + " lacks " + JSON.stringify(word));
  assert.equal(r.out, "");
}

export function ok(r) {
  assert.equal(r.code, 0, "exit code, stderr: " + r.err);
  return lines(r.out);
}
`;
