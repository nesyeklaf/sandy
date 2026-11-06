import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTENT_CAP_MS, CONTENT_SETTLE_MS, ContentRun, isContentRecord, isContentTarget, type ContentTarget } from "./contentdone.ts";

function element(region: "main" | "sidebar" | "outside", connected = true) {
  return {
    isConnected: connected,
    parentElement: null,
    closest: (selector: string) => (selector === '[data-sidebar="inset"]' && region === "main" ? {} : null),
  };
}

test("a late card paint extends content done, which settles only after a quiet window", () => {
  const run = new ContentRun(0);
  run.markReady(300);
  run.paint(360);
  run.paint(453);
  assert.equal(run.evaluate(453 + CONTENT_SETTLE_MS - 1), null);
  assert.deepEqual(run.evaluate(453 + CONTENT_SETTLE_MS), { status: "settled", doneMs: 453 });
});

test("a switch with no later content writes settles at its ready paint", () => {
  const run = new ContentRun(100);
  run.markReady(424);
  assert.deepEqual(run.evaluate(424 + CONTENT_SETTLE_MS), { status: "settled", doneMs: 324 });
});

test("paints before ready never settle the run and the quiet window counts from ready", () => {
  const run = new ContentRun(0);
  run.paint(50);
  assert.equal(run.evaluate(50 + CONTENT_SETTLE_MS), null);
  run.markReady(1500);
  assert.equal(run.evaluate(1500 + CONTENT_SETTLE_MS - 1), null);
  assert.deepEqual(run.evaluate(1500 + CONTENT_SETTLE_MS), { status: "settled", doneMs: 1500 });
});

test("content that never goes quiet is capped at the last paint inside the cap and later paints are ignored", () => {
  const run = new ContentRun(0);
  run.markReady(200);
  for (let at = 600; at < CONTENT_CAP_MS; at += 600) run.paint(at);
  run.paint(CONTENT_CAP_MS + 200);
  assert.equal(run.evaluate(CONTENT_CAP_MS - 1), null);
  assert.deepEqual(run.evaluate(CONTENT_CAP_MS), { status: "capped", doneMs: 4800 });
});

test("a run that is not ready by the cap is capped without a value", () => {
  const run = new ContentRun(0);
  assert.equal(run.nextCheckAt(), CONTENT_CAP_MS);
  assert.deepEqual(run.evaluate(CONTENT_CAP_MS), { status: "capped", doneMs: null });
});

test("only connected nodes inside the main content count, sidebar and outside regions do not", () => {
  assert.equal(isContentTarget(element("main")), true);
  assert.equal(isContentTarget(element("sidebar")), false);
  assert.equal(isContentTarget(element("outside")), false);
  assert.equal(isContentTarget(element("main", false)), false);
});

test("a text node counts through its parent element", () => {
  const text: ContentTarget = { isConnected: true, parentElement: element("main") };
  const sidebarText: ContentTarget = { isConnected: true, parentElement: element("sidebar") };
  assert.equal(isContentTarget(text), true);
  assert.equal(isContentTarget(sidebarText), false);
  assert.equal(isContentTarget({ isConnected: true, parentElement: null }), false);
});

test("a touched run never settles before its paint, and the paint restarts the quiet window", () => {
  const run = new ContentRun(0);
  run.markReady(100);
  run.touch();
  assert.equal(run.evaluate(100 + CONTENT_SETTLE_MS + 50), null);
  assert.equal(run.nextCheckAt(), CONTENT_CAP_MS);
  run.paint(100 + CONTENT_SETTLE_MS + 60);
  assert.equal(run.evaluate(100 + CONTENT_SETTLE_MS + 60 + CONTENT_SETTLE_MS - 1), null);
  assert.deepEqual(run.evaluate(100 + CONTENT_SETTLE_MS + 60 + CONTENT_SETTLE_MS), { status: "settled", doneMs: 1160 });
});

test("a touched run whose paint never arrives still ends at the cap", () => {
  const run = new ContentRun(0);
  run.markReady(100);
  run.touch();
  assert.deepEqual(run.evaluate(CONTENT_CAP_MS), { status: "capped", doneMs: 100 });
});

test("attribute records count only when the value really changed inside the content", () => {
  const main = { ...element("main"), getAttribute: (name: string) => (name === "style" ? "display:block" : null) };
  const sidebar = { ...element("sidebar"), getAttribute: () => "x" };
  assert.equal(isContentRecord({ target: main, type: "attributes", attributeName: "style", oldValue: "display:none" }), true);
  assert.equal(isContentRecord({ target: main, type: "attributes", attributeName: "style", oldValue: "display:block" }), false);
  assert.equal(isContentRecord({ target: main, type: "attributes", attributeName: "class", oldValue: null }), false);
  assert.equal(isContentRecord({ target: sidebar, type: "attributes", attributeName: "style", oldValue: "y" }), false);
  assert.equal(isContentRecord({ target: main, type: "childList" }), true);
});
