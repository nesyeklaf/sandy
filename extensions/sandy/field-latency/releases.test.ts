import { test } from "node:test";
import assert from "node:assert/strict";
import { sample } from "./fixtures.ts";
import { compareLastTwo, formatReleases, summarizeReleases, type ReleaseSample } from "./releases.ts";
import type { Sample } from "./contract.ts";

function scroll(smoothnessPct: number): Sample["scroll"] {
  return { durationMs: 500, frames: 70, dropped: 3, refreshMs: 6.9, p95FrameMs: 10, maxFrameMs: 20, smoothnessPct, truncated: false };
}

function item(release: string, overrides: Partial<Sample>): ReleaseSample {
  return { release, sample: sample({ at: 1000, ...overrides }) };
}

function load(release: string, switchFirst: number, open: number, smooth: number): ReleaseSample[] {
  return [
    item(release, { kind: "switch", visit: "first", readyMs: switchFirst }),
    item(release, { kind: "switch", visit: "first", readyMs: switchFirst + 10 }),
    item(release, { kind: "switch", visit: "revisit", readyMs: 50 }),
    item(release, { kind: "open", readyMs: open }),
    item(release, { kind: "scroll", label: "timeline", readyMs: null, scroll: scroll(smooth) }),
    item(release, { kind: "scroll", label: "timeline", readyMs: null, scroll: scroll(smooth + 4) }),
  ];
}

test("groups p75 per release and kind, oldest release first by first-seen time", () => {
  const rows = summarizeReleases(
    [...load("0.2+bbb", 200, 40, 90), ...load("0.1+aaa", 300, 60, 80)],
    new Map([
      ["0.1+aaa", 1000],
      ["0.2+bbb", 5000],
    ]),
  );
  assert.deepEqual(rows.map((row) => row.release), ["0.1+aaa", "0.2+bbb"]);
  const [older] = rows;
  assert.equal(older?.n, 6);
  assert.deepEqual(older?.switchFirstP75, { n: 2, value: 310 });
  assert.deepEqual(older?.switchRevisitP75, { n: 1, value: 50 });
  assert.deepEqual(older?.openP75, { n: 1, value: 60 });
  assert.deepEqual(older?.scrollSmoothnessP25, { n: 2, value: 80 });
});

test("timeouts do not count toward p75", () => {
  const rows = summarizeReleases(
    [item("r", { kind: "switch", visit: "first", readyMs: 100 }), item("r", { kind: "switch", visit: "first", readyMs: null, timedOut: true })],
    new Map(),
  );
  assert.deepEqual(rows[0]?.switchFirstP75, { n: 1, value: 100 });
});

test("compares the two most recently seen known releases with deltas, ignoring unknown", () => {
  const rows = summarizeReleases(
    [...load("0.1+aaa", 300, 60, 80), ...load("0.2+bbb", 240, 66, 92), ...load("unknown", 999, 999, 10)],
    new Map([
      ["unknown", 9000],
      ["0.1+aaa", 1000],
      ["0.2+bbb", 5000],
    ]),
  );
  const compare = compareLastTwo(rows);
  assert.equal(compare?.previous, "0.1+aaa");
  assert.equal(compare?.latest, "0.2+bbb");
  const first = compare?.deltas.find((entry) => entry.metric === "switchFirstP75");
  assert.deepEqual([first?.previous, first?.latest, first?.delta, first?.deltaPct], [310, 250, -60, -19.4]);
  const smooth = compare?.deltas.find((entry) => entry.metric === "scrollSmoothnessP25");
  assert.deepEqual([smooth?.previous, smooth?.latest, smooth?.delta], [80, 92, 12]);
});

test("a metric with no samples on one side has no delta, and one release alone gives no comparison", () => {
  const only = summarizeReleases(load("0.1+aaa", 300, 60, 80), new Map());
  assert.equal(compareLastTwo(only), null);
  const rows = summarizeReleases(
    [...load("0.1+aaa", 300, 60, 80), item("0.2+bbb", { kind: "open", readyMs: 70 })],
    new Map([
      ["0.1+aaa", 1],
      ["0.2+bbb", 2],
    ]),
  );
  const switchDelta = compareLastTwo(rows)?.deltas.find((entry) => entry.metric === "switchFirstP75");
  assert.deepEqual([switchDelta?.latest, switchDelta?.delta], [null, null]);
});

test("the text report lists releases and the compare block", () => {
  const rows = summarizeReleases(
    [...load("0.1+aaa", 300, 60, 80), ...load("0.2+bbb", 240, 66, 92)],
    new Map([
      ["0.1+aaa", Date.UTC(2026, 0, 1)],
      ["0.2+bbb", Date.UTC(2026, 0, 5)],
    ]),
  );
  const text = formatReleases(rows, compareLastTwo(rows), "2026-01-01 00:00");
  assert.match(text, /2026-01-05 00:00\s+0\.2\+bbb/);
  assert.match(text, /Compare 0\.1\+aaa -> 0\.2\+bbb/);
  assert.match(text, /switch first p75\s+310 -> 250\s+-60 ms \(-19\.4%\)/);
  assert.match(formatReleases([], null, "x"), /No samples since x/);
});
