import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { spaceFactsOf } from "./lib/space-facts";
import { buildSpaces } from "./spaces-model";
import { idleSidebarThreadFields } from "./test-fixtures";
import { listed, overview, type Listed } from "./test-space-overview";

const NOW = Date.now();

interface Case {
  name: string;
  status?: "idle" | "active" | "error";
  asks?: boolean;
  unread?: boolean;
  queuedFailed?: boolean;
  workflow?: boolean;
  goal?: boolean;
  working: number;
  shelf: "needs" | "failed" | "working" | "idle";
}

const CASES: Case[] = [
  { name: "own question with a background workflow", asks: true, workflow: true, working: 0, shelf: "needs" },
  {
    name: "unread failure with a background workflow",
    status: "error",
    unread: true,
    workflow: true,
    working: 0,
    shelf: "failed",
  },
  { name: "failed queued send with an active goal", queuedFailed: true, goal: true, working: 0, shelf: "failed" },
  { name: "read failure with a background workflow", status: "error", workflow: true, working: 1, shelf: "failed" },
  { name: "own question on a running turn", status: "active", asks: true, working: 0, shelf: "needs" },
  { name: "plain running turn", status: "active", working: 1, shelf: "working" },
  { name: "plain idle thread", working: 0, shelf: "idle" },
];

function dto(id: string, spec: Case): Listed {
  return listed(id, {
    status: spec.status ?? "idle",
    hasPendingInteraction: spec.asks ?? false,
    queuedWork: spec.queuedFailed ? "failed" : "none",
    lastReadAt: spec.unread ? null : NOW + 1,
    latestAttentionAt: NOW - 1,
    updatedAt: NOW - 1,
    activity: {
      activeWorkflowCount: spec.workflow ? 1 : 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: spec.goal ? 1 : 0,
    },
  });
}

function sidebarThread(id: string, spec: Case): PluginSidebarThread {
  const failed = spec.status === "error" && spec.unread === true;
  const indicator = failed
    ? "unread-error"
    : spec.asks
      ? "waiting-for-input"
      : spec.workflow
        ? "workflow"
        : spec.goal
          ? "goal"
          : spec.status === "active"
            ? "runtime"
            : "none";
  return {
    ...idleSidebarThreadFields,
    id,
    projectId: "p1",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    parentNotifications: "auto",
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "pi",
    status: spec.status ?? "idle",
    queuedWork: spec.queuedFailed ? "failed" : "none",
    hasPendingInteraction: spec.asks ?? false,
    activity: {
      workflows: spec.workflow ? 1 : 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: spec.goal ? 1 : 0,
    },
    indicator,
    indicatorLabel: null,
    isUnread: spec.unread ?? false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: NOW - 1,
    updatedAt: NOW - 1,
    lastReadAt: spec.unread ? null : NOW + 1,
    latestAttentionAt: NOW - 1,
  };
}

function browserOverview(id: string, spec: Case) {
  const item = sidebarThread(id, spec);
  return buildSpaces({
    threads: [
      {
        id,
        parentThreadId: null,
        projectId: "p1",
        sectionId: null,
        isArchived: false,
        isHidden: false,
        thread: item,
      },
    ],
    sections: [],
    facts: ({ thread }) =>
      spaceFactsOf(thread, {
        lifecycle: { shelfFor: () => "active" },
        outcomes: new Map(),
        orchestratorIds: new Set(),
      }),
    now: NOW,
    unassignedName: "No Space",
  });
}

describe("getSpaceOverview and the browser agree on working counts", () => {
  it.each(CASES)("$name", async (spec) => {
    const [browser] = browserOverview("t1", spec);
    const server = (await overview([dto("t1", spec)])).spaces.find((space) => space.id === null);
    expect(browser?.counts.working).toBe(spec.working);
    expect(server?.counts).toEqual(browser?.counts);
    expect(server?.roots.map((root) => root.shelf)).toEqual(browser?.roots.map((root) => root.shelf));
    expect(server?.roots[0]?.shelf).toBe(spec.shelf);
  });
});
