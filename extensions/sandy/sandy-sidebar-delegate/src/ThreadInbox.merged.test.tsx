import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp, toastMocks } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const environment = (id: string) => ({
  id,
  name: "Worktree",
  branchName: `sandy/${id}`,
  workspaceDisplayKind: "managed-worktree" as const,
  path: null,
  isWorktree: null,
  providerId: null,
});

function renderMerged(archive?: (input: { threadId: string }) => Promise<unknown>) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: [
        thread({ id: "thr_a", title: "Merged a", environment: environment("env_a") }),
        thread({ id: "thr_b", title: "Merged b", environment: environment("env_b") }),
        thread({ id: "thr_idle", title: "Idle work" }),
      ],
      projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
    },
    sdk: archive ? ({ threads: { archive } } as never) : undefined,
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      pullRequests: (input) =>
        Object.fromEntries(
          (input as { keys: string[] }).keys.map((key) => [
            key,
            {
              outcome: "available",
              pullRequest: {
                number: key === "env_a" ? 1 : 2,
                title: "Done",
                url: "https://github.com/o/r/pull/1",
                state: "merged",
                attention: "none",
                updatedAt: "2026-10-23T12:00:00Z",
              },
            },
          ]),
        ),
    },
  });
}

describe("Merged shelf", () => {
  it("archives every merged thread from its header and restores them with Undo", async () => {
    const rendered = renderMerged();
    const merged = await screen.findByRole("region", { name: "Merged" });
    fireEvent.click(within(merged).getByRole("button", { name: "Archive all 2 merged threads" }));
    await waitFor(() =>
      expect(rendered.sdkCalls.filter((call) => call.method === "threads.archive")).toEqual([
        { method: "threads.archive", args: [{ threadId: "thr_a" }] },
        { method: "threads.archive", args: [{ threadId: "thr_b" }] },
      ]),
    );
    const [message, options] = toastMocks.success.mock.calls.at(-1)! as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe("Archived 2 threads");
    expect(options.action.label).toBe("Undo");
    options.action.onClick();
    await waitFor(() =>
      expect(rendered.sdkCalls.filter((call) => call.method === "threads.unarchive")).toEqual([
        { method: "threads.unarchive", args: [{ threadId: "thr_a" }] },
        { method: "threads.unarchive", args: [{ threadId: "thr_b" }] },
      ]),
    );
    expect(rendered.sdkCalls.some((call) => JSON.stringify(call.args).includes("thr_idle"))).toBe(false);
  });

  it("reports the threads it could not archive and offers Undo only for the rest", async () => {
    const rendered = renderMerged(async ({ threadId }) => {
      if (threadId === "thr_b") throw new Error("offline");
      return { ok: true as const, archivedThreadIds: [threadId] };
    });
    const merged = await screen.findByRole("region", { name: "Merged" });
    fireEvent.click(within(merged).getByRole("button", { name: "Archive all 2 merged threads" }));
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("Could not archive 1 thread", expect.anything()));
    const [message, options] = toastMocks.success.mock.calls.at(-1)! as [
      string,
      { action: { onClick: () => void } },
    ];
    expect(message).toBe("Archived 1 thread");
    options.action.onClick();
    await waitFor(() =>
      expect(rendered.sdkCalls.filter((call) => call.method === "threads.unarchive")).toEqual([
        { method: "threads.unarchive", args: [{ threadId: "thr_a" }] },
      ]),
    );
  });
});
