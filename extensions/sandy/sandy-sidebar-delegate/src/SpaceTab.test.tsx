// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceCoordination } from "./space-coordination-contract";
import { SpaceTab, useSpaceTabVisible } from "./SpaceTab";

let threads: Array<{ id: string; sectionId: string | null }> = [];
let space: SpaceCoordination;
let scratchpad: {
  spaceId: string;
  body: string;
  revision: number;
  updatedByKind: null;
  updatedByThreadId: null;
  updatedAt: null;
};
let writeStatus: "written" | "conflict" = "written";
const call = vi.fn(async (method: string, input?: Record<string, unknown>) => {
  if (method === "getSpaceCoordination") return space;
  if (method === "getScratchpad") return scratchpad;
  if (method === "writeScratchpad") {
    if (writeStatus === "conflict")
      return { status: "conflict", scratchpad: { ...scratchpad, body: "theirs", revision: 5 } };
    return { status: "written", scratchpad: { ...scratchpad, body: String(input?.body), revision: 4 } };
  }
  return {};
});
const rpc = { call };
vi.mock("@sandy-sdk/plugin-sdk/app", () => ({
  useRpc: () => rpc,
  useRealtime: () => {},
}));
vi.mock("./sandy-sdk", () => ({ useSidebarThreads: () => ({ threads }) }));
vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

function member(threadId: string, mode: "independent" | "managed" = "independent") {
  return {
    threadId,
    title: "Title " + threadId,
    status: "idle",
    projectId: "p",
    projectName: null,
    environmentId: null,
    environmentName: null,
    environmentHostId: null,
    environmentPath: null,
    environmentIsWorktree: null,
    branchName: null,
    pullRequest: "none",
    hasPendingQuestion: false,
    queuedWork: "none",
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    latestAttentionAt: 0,
    updatedAt: 0,
    mode,
    isOrchestrator: false,
    latestReport: null,
  };
}

beforeEach(() => {
  threads = [{ id: "t1", sectionId: "sec_a" }];
  writeStatus = "written";
  scratchpad = {
    spaceId: "sec_a",
    body: "notes",
    revision: 3,
    updatedByKind: null,
    updatedByThreadId: null,
    updatedAt: null,
  };
  space = {
    spaceId: "sec_a",
    spaceName: "Launch",
    settings: { selfReports: true, checkInMinutes: 10, failureFallback: true },
    orchestratorThreadIds: [],
    members: [member("t1"), member("t2")],
    membersTruncated: false,
    ideas: [
      {
        id: "i1",
        spaceId: "sec_a",
        title: "Cache layer",
        body: "idea body",
        status: "open",
        authorKind: "owner",
        authorThreadId: null,
        threadIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    scratchpadRevision: 3,
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Space tab visibility", () => {
  it("shows only for threads filed under a Space", () => {
    threads = [
      { id: "in", sectionId: "sec_a" },
      { id: "out", sectionId: null },
    ];
    expect(renderHook(() => useSpaceTabVisible({ threadId: "in" })).result.current).toBe(true);
    expect(renderHook(() => useSpaceTabVisible({ threadId: "out" })).result.current).toBe(false);
  });
});

describe("Space tab", () => {
  it("switches a member to managed through the RPC", async () => {
    render(<SpaceTab threadId="t1" />);
    const toggle = await screen.findByRole("switch", { name: "Managed: Title t2" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(call).toHaveBeenCalledWith("setMemberMode", { threadId: "t2", mode: "managed" }));
  });

  it("changes the orchestrator update settings through the RPC", async () => {
    render(<SpaceTab threadId="t1" />);
    fireEvent.change(await screen.findByLabelText("Check-in interval"), { target: { value: "0" } });
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("setSpaceCoordinationSettings", { spaceId: "sec_a", checkInMinutes: 0 }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Self-reports" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("setSpaceCoordinationSettings", { spaceId: "sec_a", selfReports: false }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Failure fallback" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("setSpaceCoordinationSettings", { spaceId: "sec_a", failureFallback: false }),
    );
  });

  it("shows a member's latest report", async () => {
    space.members = [{ ...member("t2"), latestReport: { outcome: "done", summary: "Shipped the fix", reportedAt: 5 } }];
    render(<SpaceTab threadId="t1" />);
    const label = await screen.findByText("reported done");
    expect(label.getAttribute("title")).toBe("Shipped the fix");
  });

  it("adds and removes orchestrators", async () => {
    render(<SpaceTab threadId="t1" />);
    fireEvent.change(await screen.findByLabelText("Session to add as orchestrator"), { target: { value: "t2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("setOrchestrator", { threadId: "t2", orchestrator: true }));
  });

  it("edits an idea's status and text", async () => {
    render(<SpaceTab threadId="t1" />);
    fireEvent.click(await screen.findByRole("tab", { name: "Ideas" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Cache layer" }));
    fireEvent.change(screen.getByLabelText("Idea title"), { target: { value: "Cache v2" } });
    fireEvent.change(screen.getByLabelText("Idea status"), { target: { value: "planned" } });
    fireEvent.click(screen.getByRole("button", { name: "Save idea" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("updateIdea", {
        ideaId: "i1",
        title: "Cache v2",
        body: "idea body",
        status: "planned",
        threadIds: [],
      }),
    );
  });

  it("saves the scratchpad against its revision", async () => {
    render(<SpaceTab threadId="t1" />);
    fireEvent.click(await screen.findByRole("tab", { name: "Scratchpad" }));
    const editor = await screen.findByLabelText("Scratchpad");
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("notes"));
    fireEvent.change(editor, { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("writeScratchpad", { spaceId: "sec_a", body: "mine", baseRevision: 3 }),
    );
  });

  it("shows the current text on a scratchpad conflict and keeps the draft", async () => {
    writeStatus = "conflict";
    render(<SpaceTab threadId="t1" />);
    fireEvent.click(await screen.findByRole("tab", { name: "Scratchpad" }));
    const editor = await screen.findByLabelText("Scratchpad");
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("notes"));
    fireEvent.change(editor, { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByLabelText("Current scratchpad")).textContent).toBe("theirs");
    expect((screen.getByLabelText("Scratchpad") as HTMLTextAreaElement).value).toBe("mine");
  });

  async function conflictOnRevision5() {
    writeStatus = "conflict";
    render(<SpaceTab threadId="t1" />);
    fireEvent.click(await screen.findByRole("tab", { name: "Scratchpad" }));
    const editor = await screen.findByLabelText("Scratchpad");
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("notes"));
    expect(screen.getByText("Revision 3")).toBeTruthy();
    fireEvent.change(editor, { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByLabelText("Current scratchpad");
  }

  it("shows the current revision beside the conflicting text and keeps it after using that text", async () => {
    await conflictOnRevision5();
    expect(screen.getByText("Revision 5")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use current text" }));
    expect(screen.getByText("Revision 5")).toBeTruthy();
    expect((screen.getByLabelText("Scratchpad") as HTMLTextAreaElement).value).toBe("theirs");
  });

  it("shows the saved revision after overwriting from a conflict", async () => {
    await conflictOnRevision5();
    writeStatus = "written";
    fireEvent.click(screen.getByRole("button", { name: "Overwrite with my draft" }));
    expect(await screen.findByText("Revision 4")).toBeTruthy();
    expect(screen.queryByLabelText("Current scratchpad")).toBeNull();
  });
});
