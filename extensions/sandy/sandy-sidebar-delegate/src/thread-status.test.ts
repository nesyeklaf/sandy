import { describe, expect, it } from "vitest";
import {
  inboxShelfOf,
  threadFailed,
  threadInboxStatus,
  type ThreadInboxStatus,
  type ThreadStatusSignals,
} from "./thread-status";

const idle: ThreadStatusSignals = {
  lifecycleShelf: "active",
  asks: false,
  failed: false,
  workingTree: false,
  woke: false,
  pullRequestState: null,
};

describe("threadInboxStatus", () => {
  it.each<[string, Partial<ThreadStatusSignals>, ThreadInboxStatus]>([
    ["an idle thread", {}, "waiting"],
    ["an open question", { asks: true }, "needs"],
    ["a working parent whose child asks", { asks: true, workingTree: true }, "needs"],
    ["a question beats a failure and running work", { asks: true, failed: true, workingTree: true }, "needs"],
    ["a failure", { failed: true }, "failed"],
    ["a failure beats running work", { failed: true, workingTree: true }, "failed"],
    ["running work", { workingTree: true }, "working"],
    ["running work beats an open PR", { workingTree: true, pullRequestState: "open" }, "working"],
    ["an open PR", { pullRequestState: "open" }, "review"],
    ["a merged PR", { pullRequestState: "merged" }, "merged"],
    ["a closed PR", { pullRequestState: "closed" }, "waiting"],
    ["a woken thread with work and a PR", { woke: true, workingTree: true, pullRequestState: "open" }, "waiting"],
    ["a woken thread that asks", { woke: true, asks: true }, "needs"],
    ["a snoozed thread that asks", { lifecycleShelf: "snoozed", asks: true }, "snoozed"],
    ["a parked thread", { lifecycleShelf: "parked", failed: true }, "snoozed"],
    ["a settled thread", { lifecycleShelf: "settled", asks: true }, "archived"],
    ["a renaming lock", { lockedShelf: "working", asks: true }, "working"],
    ["a renaming lock under a snooze", { lockedShelf: "waiting", lifecycleShelf: "snoozed" }, "snoozed"],
  ])("puts %s on its shelf", (_, signals, expected) => {
    expect(threadInboxStatus({ ...idle, ...signals })).toBe(expected);
  });
});

describe("inboxShelfOf", () => {
  it.each<[ThreadInboxStatus, string]>([
    ["needs", "needs"],
    ["failed", "failed"],
    ["working", "pinned"],
    ["review", "pinned"],
    ["waiting", "pinned"],
    ["merged", "pinned"],
    ["snoozed", "snoozed"],
    ["archived", "archived"],
  ])("puts a pinned %s thread on %s", (status, shelf) => {
    expect(inboxShelfOf(status, true)).toBe(shelf);
    expect(inboxShelfOf(status, false)).toBe(status);
  });
});

describe("threadFailed", () => {
  it.each([
    [{ status: "error", indicator: "none", queuedWork: "none" }, true],
    [{ status: "idle", indicator: "unread-error", queuedWork: "none" }, true],
    [{ status: "idle", indicator: "none", queuedWork: "failed" }, true],
    [{ status: "idle", indicator: "unread-success", queuedWork: "none" }, false],
  ] as const)("reads %o as failed=%s", (thread, expected) => {
    expect(threadFailed(thread)).toBe(expected);
  });
});
