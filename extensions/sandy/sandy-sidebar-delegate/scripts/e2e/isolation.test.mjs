import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { outsideConnections, protectedFiles, scratchHome } from "./isolation.mjs";

test("established TCP peers must be loopback, for IPv4 and IPv6", () => {
  assert.deepEqual(outsideConnections("p42\nn127.0.0.1:5000->127.0.0.2:5001\nn[::1]:5000->[::1]:5001\n"), []);
  assert.deepEqual(outsideConnections("p42\nn127.0.0.1:5000->203.0.113.2:443\np43\nn[::1]:5000->[2001:db8::1]:443\n"), [
    { pid: 42, remote: "203.0.113.2:443" },
    { pid: 43, remote: "[2001:db8::1]:443" },
  ]);
  assert.throws(() => outsideConnections("p42\nnsocket peer unavailable\n"), /Cannot inspect/);
});

test("HOME must resolve inside scratch, including symlinks and prefix collisions", () => {
  const root = mkdtempSync("/tmp/sandy-sidebar-guard-test-");
  const scratch = join(root, "scratch");
  const home = join(scratch, "home");
  const outside = join(root, "scratch-other");
  mkdirSync(home, { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(scratch, "escaped"));
  try {
    assert.doesNotThrow(() => scratchHome(home, scratch));
    assert.throws(() => scratchHome(outside, scratch), /outside scratch/);
    assert.throws(() => scratchHome(join(scratch, "escaped"), scratch), /outside scratch/);
    assert.throws(() => scratchHome(undefined, scratch), /missing HOME/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("open files reject protected roots but not similarly named directories", () => {
  assert.deepEqual(
    protectedFiles("p42\nf1\nn/real/.codex/state.sqlite\nn/real/.sandy/db (deleted)\nn/real/.sandy-other/cache\n", [
      "/real/.codex",
      "/real/.sandy",
    ]),
    [
      { pid: 42, path: "/real/.codex/state.sqlite" },
      { pid: 42, path: "/real/.sandy/db" },
    ],
  );
});
