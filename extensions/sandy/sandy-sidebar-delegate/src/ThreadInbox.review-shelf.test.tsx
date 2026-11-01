// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp } from "./test-inbox";

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

function renderWithPullRequests(states: Record<string, "open" | "draft" | "merged">, threads = ["env_a", "env_b"]) {
  return renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: threads.map((env) => thread({ id: `thr_${env}`, title: `Work ${env}`, environment: environment(env) })),
      projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: {
      listLifecycle: () => ({ rows: [] }),
      pullRequests: (input) =>
        Object.fromEntries(
          (input as { keys: string[] }).keys.map((key) => [
            key,
            states[key]
              ? {
                  outcome: "available",
                  pullRequest: {
                    number: 7,
                    title: "A PR",
                    url: "https://github.com/o/r/pull/7",
                    state: states[key],
                    attention: "none",
                    updatedAt: "2026-10-31T00:00:00Z",
                  },
                }
              : { outcome: "absent" },
          ]),
        ),
    },
  });
}

describe("In review shelf", () => {
  it("lists threads with an open pull request and leaves the rest in Active", async () => {
    renderWithPullRequests({ env_a: "open", env_b: "draft" });
    const shelf = await screen.findByRole("region", { name: "In review" });
    expect(within(shelf).getByText("Work env_a")).toBeDefined();
    expect(within(shelf).queryByText("Work env_b")).toBeNull();
    // A draft is still the author's work, so it stays in Active.
    expect(within(screen.getByRole("region", { name: "Needs you" })).getByText("Work env_b")).toBeDefined();
    expect(within(screen.getByRole("region", { name: "Needs you" })).queryByText("Work env_a")).toBeNull();
  });

  it("shows no shelf when no pull request is open", async () => {
    renderWithPullRequests({ env_a: "merged" });
    await screen.findByText("Work env_a");
    expect(screen.queryByRole("region", { name: "In review" })).toBeNull();
  });
});
