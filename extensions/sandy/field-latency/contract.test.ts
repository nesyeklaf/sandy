import { test } from "node:test";
import assert from "node:assert/strict";
import { clientSchema, sampleSchema, toWire } from "./contract.ts";
import { sample } from "./fixtures.ts";

test("samples and clients stored by 0.2.0 still parse and get null for the new fields", () => {
  const { scroll: _scroll, ...old } = sample({});
  const parsed = sampleSchema.parse(old);
  assert.equal(parsed.scroll, null);
  const client = clientSchema.parse({ userAgent: "x", cores: 8, devicePixelRatio: 2, viewport: "1x1" });
  assert.deepEqual([client.sandyVersion, client.appScript, client.benchmarkIndex], [null, null, null]);
});

test("a scroll sample needs its session stats to be well formed", () => {
  const bad = sample({ kind: "scroll", scroll: { durationMs: 1, frames: 1, dropped: 0, refreshMs: 6.9, p95FrameMs: 1, maxFrameMs: 1, smoothnessPct: 101, truncated: false } });
  assert.equal(sampleSchema.safeParse(bad).success, false);
});

test("samples stored before the content-done mark parse with null content fields", () => {
  const { contentDoneMs: _ms, contentDone: _status, ...old } = sample({});
  const parsed = sampleSchema.parse(old);
  assert.deepEqual([parsed.contentDoneMs, parsed.contentDone], [null, null]);
  assert.equal(sampleSchema.safeParse(sample({ contentDone: "settled", contentDoneMs: 453 })).success, true);
  assert.equal(sampleSchema.safeParse({ ...old, contentDone: "done" }).success, false);
});

test("samples without a content mark are sent without the new fields so an older strict server accepts them", () => {
  const wire = toWire(sample({ kind: "open" }));
  assert.equal("contentDoneMs" in wire, false);
  assert.equal("contentDone" in wire, false);
  assert.equal(sampleSchema.safeParse(wire).success, true);
  const withMark = toWire(sample({ kind: "switch", contentDone: "aborted" }));
  assert.equal(withMark.contentDone, "aborted");
  assert.equal(sampleSchema.parse(withMark).contentDoneMs, null);
});

test("the content source fields are sent only with a content mark and parse to null when absent", () => {
  const marked = toWire(sample({ kind: "switch", contentDone: "settled", contentDoneMs: 450, contentSource: "genui", contentWrites: 2 }));
  assert.equal(marked.contentSource, "genui");
  assert.equal(marked.contentWrites, 2);
  const bare = toWire(sample({ kind: "open" }));
  assert.equal("contentSource" in bare, false);
  assert.equal("contentWrites" in bare, false);
  const parsed = sampleSchema.parse(bare);
  assert.deepEqual([parsed.contentSource, parsed.contentWrites], [null, null]);
});
