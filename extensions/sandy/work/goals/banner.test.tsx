// @vitest-environment jsdom
// The composer banner opens on a click and lists the tasks with their subtasks.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@sandy-sdk/plugin-sdk/testing/app";
import { GoalBanner } from "./app.tsx";
import type { Goal, SessionActivity, SessionTask, Snapshot, Task } from "./contract.ts";

const sessionTask = (id: string, subject: string, status: SessionTask["status"], parent: string | null = null): SessionTask => ({
  id, subject, status, description: null, activeForm: null, parent, blockedBy: [],
});
const goalTask = (id: string, title: string, status: Task["status"], subtasks: Task[] = []): Task => ({
  id, title, status, evidence: null, skipReason: null, verificationContract: null, completedAt: null, subtasks,
});

function snapshot(over: Partial<Snapshot>): Snapshot {
  return { root: "/tmp", linked: true, focusedId: null, goals: [], archived: [], events: [], sessionTasks: [], sessionActivity: null, error: null, ...over };
}

function goal(tasks: Task[]): Goal {
  return {
    id: "g1", objective: "Ship the banner", status: "active", autoContinue: true, sisyphus: false, createdAt: null, updatedAt: null,
    tokensUsed: 0, activeSeconds: 0, tokenBudget: null, pauseReason: null, pauseSuggestedAction: null, stopReason: null,
    currentTaskId: "t1", verificationContract: null, skipAuditor: false, blockCompletion: null, tasks, audit: null,
  };
}

const activity: SessionActivity = { tool: "edit", label: "Editing app.tsx", since: "2026-10-28T12:00:00.000Z" };

function render(data: Snapshot, isRunning = true) {
  return renderSlot({ component: GoalBanner }, {}, {
    composer: { scope: { kind: "thread", threadId: "thr_a" }, isRunning },
    rpc: { snapshot: () => data, command: () => ({ sent: "" }), setView: () => ({}) } as never,
  });
}

describe("goal banner", () => {
  afterEach(cleanup);

  it("opens the session tasks on a click and shows the subtasks", async () => {
    const slot = render(snapshot({ sessionTasks: [sessionTask("1", "Build it", "in_progress"), sessionTask("2", "Write the test", "completed", "1"), sessionTask("3", "Ship it", "pending")] }));
    const toggle = await slot.findByRole("button", { name: /session tasks 1\/3/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryByText("Write the test")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(slot.getByText("Write the test")).toBeTruthy();
    expect(slot.getByText("Ship it")).toBeTruthy();
    fireEvent.click(toggle);
    expect(slot.queryByText("Write the test")).toBeNull();
  });

  it("says Now: with the activeForm of the task in progress, not the running tool call", async () => {
    const slot = render(snapshot({ sessionTasks: [{ ...sessionTask("1", "Build it", "in_progress"), activeForm: "building it" }], sessionActivity: activity }));
    await slot.findByRole("button", { name: /session tasks 0\/1/i });
    expect(slot.getByText("building it")).toBeTruthy();
    expect(slot.queryByText(/Editing app\.tsx/)).toBeNull();
  });

  it("says Now: with the running tool call when no task is in progress", async () => {
    const slot = render(snapshot({ sessionTasks: [sessionTask("1", "Ship it", "pending")], sessionActivity: activity }));
    expect(await slot.findByText(/Now: Editing app\.tsx/)).toBeTruthy();
    expect(slot.queryByText(/Next:/)).toBeNull();
  });

  it("falls back to Next: while the thread does not run, because an aborted turn leaves its call open", async () => {
    const slot = render(snapshot({ sessionTasks: [sessionTask("1", "Ship it", "pending")], sessionActivity: activity }), false);
    expect(await slot.findByText(/Next:/)).toBeTruthy();
    expect(slot.queryByText(/Editing app\.tsx/)).toBeNull();
  });

  it("shows the running tool call alone when the session keeps no task list", async () => {
    const slot = render(snapshot({ sessionActivity: activity }));
    expect(await slot.findByText(/Now: Editing app\.tsx/)).toBeTruthy();
  });

  it("hides the banner without a task list while the thread does not run", async () => {
    const slot = render(snapshot({ sessionActivity: activity }), false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.textContent).toBe("");
  });

  it("opens the focused goal's tasks on a click and shows the subtasks", async () => {
    const g = goal([goalTask("t1", "Build it", "pending", [goalTask("t1.1", "Write the test", "complete")]), goalTask("t2", "Ship it", "pending")]);
    const slot = render(snapshot({ goals: [g], focusedId: "g1" }));
    const toggle = await slot.findByRole("button", { name: /goal tasks/i });
    expect(slot.queryByText("Write the test")).toBeNull();
    fireEvent.click(toggle);
    expect(slot.getByText("Write the test")).toBeTruthy();
    expect(slot.getByText("Ship it")).toBeTruthy();
  });
});
