import test from "node:test";
import assert from "node:assert/strict";
import {
  bannerRows, canStopAll, needsAck, childSegmentText, fleetCounts, fleetSegmentText, formatDuration, isOpenRow, openRows, formatFleetCounts, formatModel, formatReasoning, formatRuntime,
  formatTokens, isEnded, mergeMessage, moveSelection, NARROW_PANEL_PX, panelLayout, statusTone,
} from "../panel-view.ts";

test("formatTokens shows total and context, a dash for unknown parts", () => {
  assert.equal(formatTokens({ total: 12_345, context: 40_000, contextWindow: 200_000 }), "Σ 12k / ctx 40k of 200k");
  assert.equal(formatTokens({ total: null, context: null, contextWindow: null }), "Σ — / ctx —");
  assert.equal(formatTokens({ total: 1500, context: 900, contextWindow: null }), "Σ 1.5k / ctx 900");
});

test("formatDuration", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(125_000), "2m 05s");
  assert.equal(formatDuration(3_900_000), "1h 05m");
});

test("statusTone: an open question reads as waiting, others by status", () => {
  assert.equal(statusTone({ status: "running", question: null }), "running");
  assert.equal(statusTone({ status: "running", question: { questionId: "q", state: "open", question: "?", options: [], askedAt: 0, expiresAt: 0 } }), "waiting");
  assert.equal(statusTone({ status: "completed", question: null }), "done");
  assert.equal(statusTone({ status: "failed", question: null }), "failed");
  assert.equal(statusTone({ status: "stopped", question: null }), "ended");
  assert.equal(isEnded({ status: "completed", state: "idle" }), false);
  assert.equal(isEnded({ status: "stopped", state: "stopped" }), true);
  assert.equal(formatModel({ model: null, reasoningLevel: "low" }), "— · low");
});

test("moveSelection: j/k and arrows, clamped", () => {
  assert.equal(moveSelection("j", 0, 3), 1);
  assert.equal(moveSelection("ArrowDown", 2, 3), 2);
  assert.equal(moveSelection("k", 0, 3), 0);
  assert.equal(moveSelection("ArrowUp", 2, 3), 1);
  assert.equal(moveSelection("x", 5, 3), 2);
  assert.equal(moveSelection("j", 0, 0), 0);
});

test("mergeMessage names the outcome and whether the checkout is clean", () => {
  assert.equal(mergeMessage({ status: "merged", branch: "b", into: "main", commit: "abc" }), "merged b into main (abc)");
  assert.match(mergeMessage({ status: "conflict", message: "merge of b into main conflicts; aborted", files: ["f"], clean: true }), /f; checkout left clean/);
  assert.match(mergeMessage({ status: "dirty", message: "the checkout has uncommitted changes", files: ["M f"] }), /^refused/);
});

const open = { questionId: "q", state: "open" as const, question: "which file?", options: [], askedAt: 0, expiresAt: 0 };
const tokens = (total: number | null) => ({ total, context: null, contextWindow: null });

test("fleetCounts / formatFleetCounts: header counts by state, an open question counted as asks you", () => {
  const rows = [
    { status: "running", question: null },
    { status: "completed", question: null },
    { status: "idle", question: null },
    { status: "idle", question: open },
  ];
  assert.deepEqual(fleetCounts(rows), { running: 1, idle: 2, asksYou: 1, failed: 0, ended: 0 });
  assert.equal(formatFleetCounts(fleetCounts(rows)), "1 running · 2 idle · 1 asks you");
  assert.equal(formatFleetCounts(fleetCounts([{ status: "failed", question: null }, { status: "stopped", question: null }])), "1 failed · 1 ended");
  assert.equal(formatFleetCounts(fleetCounts([])), "none");
});

test("canStopAll: only while a child is running or waiting to start", () => {
  assert.equal(canStopAll([{ status: "completed" }, { status: "idle" }, { status: "stopped" }]), false);
  assert.equal(canStopAll([{ status: "idle" }, { status: "reserved" }]), true);
  assert.equal(canStopAll([{ status: "starting" }]), true);
  assert.equal(canStopAll([{ status: "running" }]), true);
  assert.equal(canStopAll([]), false);
});

test("panelLayout: narrow below NARROW_PANEL_PX, wide otherwise and before the width is measured", () => {
  assert.equal(NARROW_PANEL_PX, 480);
  assert.equal(panelLayout(390), "narrow");
  assert.equal(panelLayout(479), "narrow");
  assert.equal(panelLayout(480), "wide");
  assert.equal(panelLayout(560), "wide");
  assert.equal(panelLayout(0), "wide");
});

test("formatReasoning / formatRuntime: labelled reasoning, last turn before time since bound", () => {
  assert.equal(formatReasoning("high"), "reasoning high");
  assert.equal(formatReasoning(null), "reasoning —");
  assert.equal(formatRuntime({ sinceBoundMs: 90_000, lastTurnMs: 12_000, lastTurnRunning: true }), "12s…");
  assert.equal(formatRuntime({ sinceBoundMs: 90_000, lastTurnMs: null, lastTurnRunning: false }), "1m 30s");
  assert.equal(formatRuntime({ sinceBoundMs: null, lastTurnMs: null, lastTurnRunning: false }), "—");
});

test("fleetSegmentText: open delegates, running, asks you, failed, +N done and Σ tokens; a dash when no total is known", () => {
  assert.equal(
    fleetSegmentText([
      { status: "running", question: null, tokens: tokens(50_000) },
      { status: "idle", question: open, tokens: tokens(24_000) },
      { status: "idle", question: null, tokens: tokens(null) },
    ]),
    "2 delegates · 1 running · 1 asks you · +1 done · Σ 74k",
  );
  assert.equal(fleetSegmentText([{ status: "failed", question: null, tokens: tokens(null) }]), "1 delegate · 1 failed · Σ —");
});

test("fleetSegmentText counts only open children and folds the rest into +N done; Σ covers all", () => {
  assert.equal(
    fleetSegmentText([
      { status: "running", question: null, tokens: tokens(10_000) },
      { status: "completed", question: null, tokens: tokens(20_000) },
      { status: "idle", question: null, tokens: tokens(null) },
      { status: "stopped", question: null, tokens: tokens(5_000) },
    ]),
    "1 delegate · 1 running · +3 done · Σ 35k",
  );
  assert.equal(fleetSegmentText([{ status: "completed", question: null, tokens: tokens(null) }]), "0 delegates · +1 done · Σ —");
});

test("isOpenRow / openRows: running, asks you and failed are open; done and ended are not", () => {
  for (const status of ["running", "starting", "reserved", "failed", "error", "refused", "interrupted"]) assert.equal(isOpenRow({ status, question: null }), true, status);
  for (const status of ["completed", "idle", "stopped", "archived", "gone"]) assert.equal(isOpenRow({ status, question: null }), false, status);
  assert.equal(isOpenRow({ status: "idle", question: open as never }), true);
  const rows = [{ status: "completed", question: null }, { status: "running", question: null }];
  assert.deepEqual(openRows(rows), [rows[1]]);
});

test("bannerRows: the banner shows only children that ask the parent or failed", () => {
  const asks = { status: "idle", question: open };
  const failed = { status: "error", question: null };
  assert.deepEqual(bannerRows([{ status: "running", question: null }, asks, { status: "completed", question: null }, failed]), [asks, failed]);
  assert.deepEqual(bannerRows([{ status: "running", question: null }, { status: "idle", question: { ...open, state: "answered" as const } }]), []);
});

test("an acknowledged failure leaves the banner and the open rows; an open question is never acknowledged away", () => {
  const acked = { status: "error", question: null, acknowledged: true };
  assert.deepEqual(bannerRows([acked]), []);
  assert.equal(isOpenRow(acked), false);
  assert.equal(needsAck(acked), false);
  assert.equal(needsAck({ status: "error", question: null, acknowledged: false }), true);
  const asks = { status: "idle", question: open, acknowledged: true };
  assert.deepEqual(bannerRows([asks]), [asks]);
});

test("childSegmentText: agent with version, role and state", () => {
  assert.equal(childSegmentText({ agent: "scout", agentVersion: 2, role: "reader", status: "idle", question: open }), "scout v2 · reader · asks you");
  assert.equal(childSegmentText({ agent: "writer", agentVersion: null, role: null, status: "running", question: null }), "writer · — · running");
});
