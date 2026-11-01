import { test } from "node:test";
import assert from "node:assert/strict";
import { clientSchema, sampleSchema } from "./contract.ts";
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
