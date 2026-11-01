import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_BUFFER_SIZE,
  MIN_SESSION_FRAMES,
  SESSION_GAP_MS,
  ScrollSession,
  estimateRefreshMs,
  scrollContainerLabel,
  summarizeScroll,
  trimToEnd,
} from "./scroll.ts";

function stamps(intervals: readonly number[], start = 1000): Float64Array {
  const result = new Float64Array(intervals.length + 1);
  result[0] = start;
  intervals.forEach((interval, index) => {
    result[index + 1] = (result[index] ?? 0) + interval;
  });
  return result;
}

function repeat(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}

test("a steady 144 Hz scroll is fully smooth with no dropped frames", () => {
  const stats = summarizeScroll(stamps(repeat(6.9, 100)), 6.9, false);
  assert.equal(stats?.frames, 100);
  assert.equal(stats?.dropped, 0);
  assert.equal(stats?.smoothnessPct, 100);
  assert.equal(stats?.p95FrameMs, 6.9);
  assert.equal(stats?.refreshMs, 6.9);
});

test("long frames count as dropped and lower smoothness by presented over expected frames", () => {
  const intervals = [...repeat(6.9, 90), ...repeat(20.7, 10)];
  const stats = summarizeScroll(stamps(intervals), 6.9, false);
  assert.equal(stats?.dropped, 10);
  assert.equal(stats?.smoothnessPct, 83.3);
  assert.equal(stats?.p95FrameMs, 20.7);
  assert.equal(stats?.maxFrameMs, 20.7);
  assert.equal(stats?.durationMs, 828);
});

test("an interval of exactly 1.5 times the refresh is not dropped, anything above is", () => {
  assert.equal(summarizeScroll(stamps(repeat(15, 20)), 10, false)?.dropped, 0);
  assert.equal(summarizeScroll(stamps([...repeat(10, 19), 15.1]), 10, false)?.dropped, 1);
});

test("a 60 fps scroll on a 144 Hz display is rated against the display, not against itself", () => {
  const stats = summarizeScroll(stamps(repeat(16.7, 60)), 6.9, false);
  assert.equal(stats?.dropped, 60);
  assert.ok((stats?.smoothnessPct ?? 100) < 45);
});

test("the refresh estimate is the lower quartile of the intervals, so a janky minority does not inflate it", () => {
  assert.equal(estimateRefreshMs(stamps([...repeat(6.9, 30), ...repeat(13.8, 10)])), 6.9);
  assert.equal(estimateRefreshMs(new Float64Array([1, 2])), null);
});

test("frames after the last scroll event are trimmed so the idle tail does not pad smoothness", () => {
  const session = new ScrollSession();
  session.begin(0, "timeline");
  for (let i = 0; i <= 70; i++) session.record(i * 6.9);
  session.lastEventAt = 200;
  const result = session.finish(6.9);
  assert.equal(result?.stats.frames, 30);
  assert.equal(result?.stats.smoothnessPct, 100);
  assert.deepEqual(Array.from(trimToEnd(new Float64Array([1, 2, 3, 4]), 2.5)), [1, 2]);
});

test("a session with a stale calibration is corrected by its own idle tail", () => {
  const session = new ScrollSession();
  session.begin(0, "timeline");
  for (let i = 0; i <= 70; i++) session.record(i * 6.9);
  session.lastEventAt = 200;
  assert.equal(session.finish(13.9)?.refreshMs, 6.9);
  assert.equal(session.finish(6.9)?.refreshMs, 6.9);
});

test("sessions shorter than the minimum are discarded", () => {
  const session = new ScrollSession();
  session.begin(0, "x");
  for (let i = 0; i < MIN_SESSION_FRAMES - 1; i++) session.record(i * 6.9);
  session.lastEventAt = 1000;
  assert.equal(session.finish(6.9), null);
});

test("a session ends 300 ms after the last scroll event, and when the buffer or the time cap is reached", () => {
  const session = new ScrollSession();
  session.begin(1000, "x");
  assert.equal(session.shouldEnd(1000 + SESSION_GAP_MS), false);
  assert.equal(session.shouldEnd(1000 + SESSION_GAP_MS + 1), true);
  session.begin(1000, "x");
  session.lastEventAt = 25000;
  assert.equal(session.shouldEnd(24000), true);
  assert.equal(session.truncated, true);
  session.begin(0, "x");
  for (let i = 0; i < FRAME_BUFFER_SIZE; i++) session.record(i * 4);
  assert.equal(session.truncated, true);
  assert.equal(session.shouldEnd(FRAME_BUFFER_SIZE * 4), true);
});

test("a recycled session buffer carries nothing over from the previous session", () => {
  const session = new ScrollSession();
  session.begin(0, "a");
  for (let i = 0; i < 40; i++) session.record(i * 6.9);
  session.begin(5000, "b");
  assert.equal(session.count, 0);
  assert.equal(session.label, "b");
  assert.equal(session.truncated, false);
});

test("scroll containers get a short stable label from data attributes, then id, role and tag", () => {
  const element = (attributes: Record<string, string>, tagName = "DIV") => ({
    tagName,
    getAttributeNames: () => Object.keys(attributes),
    getAttribute: (name: string) => attributes[name] ?? null,
  });
  assert.equal(scrollContainerLabel(null), "page");
  assert.equal(scrollContainerLabel(element({ class: "x", "data-detail-scroll-area": "" })), "detail-scroll-area");
  assert.equal(scrollContainerLabel(element({ id: "thread list" })), "thread list");
  assert.equal(scrollContainerLabel(element({ role: "listbox" })), "listbox");
  assert.equal(scrollContainerLabel(element({}, "UL")), "ul");
});
