import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport, normalizeLabel, percentile, summarize } from "./stats.ts";
import { sample } from "./fixtures.ts";

test("summarize gives each traced phase its median and counts traced samples", () => {
  const groups = summarize([
    sample({ tracedMs: 100, phases: { input: 10, render: 60, paint: 30 } }),
    sample({ tracedMs: 140, phases: { input: 20, render: 90, paint: 30 } }),
    sample({ tracedMs: 300, phases: { input: 30, render: 240, paint: 30 } }),
    sample({}),
  ]);
  assert.equal(groups[0]?.traced, 3);
  assert.equal(groups[0]?.tracedP50, 140);
  assert.deepEqual(groups[0]?.phasesP50, { input: 20, render: 90, paint: 30 });
});

test("normalizeLabel drops the dynamic part after a colon and collapses whitespace", () => {
  assert.equal(normalizeLabel("  Provider, model and reasoning:  Claude Opus 5.5 High "), "Provider, model and reasoning");
  assert.equal(normalizeLabel("x".repeat(80)).length, 60);
});

test("percentile uses nearest rank", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test("summarize separates switch visits and excludes timeouts from percentiles", () => {
  const groups = summarize([
    sample({ kind: "switch", label: "sidebar thread", visit: "first", readyMs: 300 }),
    sample({ kind: "switch", label: "sidebar thread", visit: "revisit", readyMs: 90 }),
    sample({ kind: "switch", label: "sidebar thread", visit: "first", readyMs: null, timedOut: true }),
  ]);
  const first = groups.find((group) => group.label === "sidebar thread (first)");
  assert.equal(first?.n, 2);
  assert.equal(first?.timedOut, 1);
  assert.equal(first?.p95, 300);
  assert.equal(groups.find((group) => group.label === "sidebar thread (revisit)")?.p50, 90);
});

test("summarize falls back to mount time when the paint was not observed and ranks scripts by total time", () => {
  const [group] = summarize([
    sample({ readyMs: null, mountMs: 40, scripts: [{ source: "app.js", invoker: "click", durationMs: 30, forcedStyleLayoutMs: 0 }] }),
    sample({ readyMs: 60, scripts: [{ source: "app.js", invoker: "click", durationMs: 20, forcedStyleLayoutMs: 0 }, { source: "plugin.js", invoker: "x", durationMs: 5, forcedStyleLayoutMs: 0 }] }),
  ]);
  assert.equal(group?.max, 60);
  assert.deepEqual(group?.topScripts, [{ source: "app.js", totalMs: 50 }, { source: "plugin.js", totalMs: 5 }]);
});

test("switch content-done percentiles count settled samples only and report capped and aborted ones", () => {
  const groups = summarize([
    sample({ kind: "switch", label: "sidebar thread", visit: "revisit", readyMs: 324, contentDoneMs: 453, contentDone: "settled" }),
    sample({ kind: "switch", label: "sidebar thread", visit: "revisit", readyMs: 330, contentDoneMs: 500, contentDone: "settled" }),
    sample({ kind: "switch", label: "sidebar thread", visit: "revisit", readyMs: 320, contentDoneMs: 4900, contentDone: "capped" }),
    sample({ kind: "switch", label: "sidebar thread", visit: "revisit", readyMs: 310, contentDoneMs: null, contentDone: "aborted" }),
    sample({ kind: "switch", label: "sidebar thread", visit: "revisit", readyMs: 300 }),
  ]);
  const [group] = groups;
  assert.deepEqual([group?.n, group?.contentN, group?.contentCapped, group?.contentAborted], [5, 2, 1, 1]);
  assert.deepEqual([group?.p50, group?.contentP50, group?.contentP75], [320, 453, 500]);
  const text = formatReport(groups, "x");
  assert.match(text, /5 \(1 capped, 1 aborted\)/);
  assert.match(text, /453 \(n 2\)\s+500/);
});

test("samples without a content-done mark keep their ready numbers and show no content column value", () => {
  const groups = summarize([sample({ kind: "switch", label: "sidebar thread", visit: "first", readyMs: 300 })]);
  assert.deepEqual([groups[0]?.p75, groups[0]?.contentN, groups[0]?.contentP75], [300, 0, null]);
  assert.match(formatReport(groups, "x"), /sidebar thread \(first\)\s+1\s+300\s+300\s+300\s+300\s+-\s+-/);
});
