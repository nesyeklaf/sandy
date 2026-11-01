import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("host writePolicy never replaces a newer rev (graft 3); a v1 file without rev is older", async () => {
  const dir = await mkdtemp(join(tmpdir(), "track-host-"));
  process.env.TRACK_STATE_DIR = dir;
  const { default: entry } = await import("./host.ts");
  const write = (rev: number | undefined, stage: string) =>
    entry.handlers.writePolicy({ threadId: "t1", policy: { version: 1, stage, ...(rev === undefined ? {} : { rev }) } }, {} as never);
  const read = async () => JSON.parse(await readFile(join(dir, "threads", "t1.json"), "utf8"));
  assert.equal((await write(undefined, "v1")).written, true);
  assert.equal((await write(3, "a")).written, true);
  assert.equal((await write(2, "late")).written, false);
  assert.equal((await read()).stage, "a");
  assert.equal((await write(3, "same rev")).written, true, "the same rev may be rewritten (a retried publish)");
  assert.equal((await write(4, "b")).written, true);
  assert.equal((await read()).stage, "b");
});

test("host writePolicy: concurrent writes of one thread are compared and written one at a time; the newest rev wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "track-host-"));
  process.env.TRACK_STATE_DIR = dir;
  const { default: entry } = await import("./host.ts");
  // Issued together, newest first: each older write must see the newer file and be refused, none may fail or win.
  const revs = [5, 4, 3, 2, 1];
  const results = await Promise.allSettled(revs.map((rev) => entry.handlers.writePolicy({ threadId: "t2", policy: { version: 1, rev, stage: `s${rev}` } }, {} as never)));
  assert.deepEqual(results.map((r) => (r.status === "fulfilled" ? r.value.written : String(r.reason))), [true, false, false, false, false]);
  assert.equal(JSON.parse(await readFile(join(dir, "threads", "t2.json"), "utf8")).rev, 5);
  assert.deepEqual((await readdir(join(dir, "threads"))).sort(), ["t2.json"], "no temporary file is left behind");
});
