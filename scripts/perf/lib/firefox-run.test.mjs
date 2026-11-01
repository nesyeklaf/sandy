import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appTimings,
  requestTimings,
  summarizeSamples,
} from "./firefox-run.mjs";

describe("appTimings", () => {
  it("reads the phases of the longest switch span and ignores spans of other switches", () => {
    const timings = appTimings([
      { name: "sandy:switch", start: 0, duration: 40, label: "early" },
      { name: "sandy:switch:render", start: 5, duration: 30 },
      { name: "sandy:switch", start: 100, duration: 500, label: "thr_a" },
      { name: "sandy:switch:input", start: 100, duration: 90 },
      { name: "sandy:switch:render", start: 190, duration: 260 },
      { name: "sandy:switch:paint", start: 450, duration: 150 },
      { name: "sandy:open", start: 120, duration: 999 },
    ]);
    assert.deepEqual(timings, {
      appMs: 500,
      label: "thr_a",
      input: 90,
      render: 260,
      timeline: null,
      paint: 150,
    });
  });

  it("returns null when the app recorded no switch", () => {
    assert.equal(
      appTimings([{ name: "sandy:open", start: 0, duration: 1 }]),
      null,
    );
  });
});

describe("requestTimings", () => {
  it("takes network and server time from the slowest thread request", () => {
    assert.deepEqual(
      requestTimings([
        { duration: 40, server: 2 },
        { duration: 140, server: 11 },
      ]),
      { network: 140, server: 11 },
    );
    assert.deepEqual(requestTimings([]), { network: null, server: null });
  });
});

describe("summarizeSamples", () => {
  it("groups samples by browser and visit and skips missing values", () => {
    const sample = (browser, visit, waitMs, render) => ({
      browser,
      visit,
      waitMs,
      appMs: waitMs - 10,
      render,
    });
    const groups = summarizeSamples([
      sample("firefox", "first", 600, 300),
      sample("firefox", "first", 500, null),
      sample("firefox", "first", 700, 280),
      sample("firefox", "revisit", 550, 290),
      sample("chrome", "revisit", 400, 200),
    ]);
    assert.deepEqual(
      groups.map(({ browser, visit, samples }) => [browser, visit, samples]),
      [
        ["firefox", "first", 3],
        ["firefox", "revisit", 1],
        ["chrome", "revisit", 1],
      ],
    );
    assert.deepEqual(groups[0].metrics.waitMs, { n: 3, p50: 600, p75: 650 });
    assert.deepEqual(groups[0].metrics.render, { n: 2, p50: 290, p75: 295 });
  });
});
