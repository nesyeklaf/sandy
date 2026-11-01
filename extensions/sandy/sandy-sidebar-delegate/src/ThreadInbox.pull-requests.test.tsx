// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, render, loadInboxApp, stubIntersectionObservers } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

describe("pull request badge", () => {
  it("mounts pull request lookups only while the row is visible", async () => {
    const { observers, instances, notify } = stubIntersectionObservers();
    const row = () => screen.getByRole("link", { name: "A thread" }).closest("li")!;
    try {
      const view = withPr("none");
      await waitFor(() => expect(observers.has(row())).toBe(true));
      expect(screen.queryByRole("link", { name: "#412" })).toBeNull();
      // Settings and lifecycle effects can remount the row. Notify the observer
      // attached to the current element on every retry while showing the badge.
      await waitFor(async () => {
        await act(async () => notify(row(), true));
        expect(screen.getByRole("link", { name: "#412" })).toBeTruthy();
      });
      await act(async () => notify(row(), false));
      expect(screen.queryByRole("link", { name: "#412" })).toBeNull();
      view.unmount();
      for (const observer of instances) expect(observer.disconnect).toHaveBeenCalledOnce();
      expect(observers.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  const prEnvironment = {
    id: "env_pr",
    name: "Worktree",
    branchName: "sandy/fix-flake",
    workspaceDisplayKind: "managed-worktree" as const,
    path: null,
    isWorktree: null,
    providerId: null,
  };
  const withPr = (attention: string, state = "open") =>
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [thread({ id: "thr_pr", environment: prEnvironment })],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        // GitHub PR Status's keyed read, answered per environment id.
        pullRequests: (input) =>
          Object.fromEntries(
            (input as { keys: string[] }).keys.map((key) => [
              key,
              key === "env_pr"
                ? {
                    outcome: "available",
                    pullRequest: {
                      number: 412,
                      title: "Fix the flake",
                      url: "https://github.com/o/r/pull/412",
                      state,
                      attention,
                      updatedAt: "2026-10-23T12:00:00Z",
                    },
                  }
                : { outcome: "absent" },
            ]),
          ),
      },
    });

  it("links the PR number out to the git host", async () => {
    withPr("none");
    const badge = await screen.findByRole("link", { name: "#412" });
    expect(badge.getAttribute("href")).toBe("https://github.com/o/r/pull/412");
    expect(badge.getAttribute("title")).toBeNull();
    fireEvent.focus(badge);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Fix the flake\nOpen");
  });

  it("shows no badge when the branch has no PR", async () => {
    render([thread({ id: "thr_nopr" })]);
    await screen.findByText("A thread");
    expect(screen.queryByRole("link", { name: /^#/ })).toBeNull();
  });

  // SANDY's richer attention state keeps failed open PRs red while other open
  // states use the emerald pull request color.
  it("colors the badge from the attention state", async () => {
    const failing = withPr("checks_failed");
    expect((await screen.findByRole("link", { name: "#412" })).className).toContain(
      "text-[color:var(--sandy-sidebar-pr-alert)]",
    );
    failing.unmount();

    withPr("ready_to_merge");
    expect((await screen.findByRole("link", { name: "#412" })).className).toContain(
      "text-[color:var(--sandy-sidebar-pr-open)]",
    );
  });

  it("covers pending, review, draft, closed, and merged states", async () => {
    const pending = withPr("checks_pending");
    expect((await screen.findByRole("link", { name: "#412" })).className).toContain(
      "text-[color:var(--sandy-sidebar-pr-open)]",
    );
    pending.unmount();

    const review = withPr("review_requested");
    expect((await screen.findByRole("link", { name: "#412" })).className).toContain(
      "text-[color:var(--sandy-sidebar-pr-open)]",
    );
    review.unmount();

    const draft = withPr("draft", "draft");
    expect((await screen.findByRole("link", { name: "#412" })).className).toContain("text-muted-foreground/60");
    draft.unmount();

    const closed = withPr("closed", "closed");
    expect((await screen.findByRole("link", { name: "#412" })).className).toContain(
      "text-[color:var(--sandy-sidebar-pr-alert)]",
    );
    closed.unmount();

    withPr("merged", "merged");
    expect((await screen.findByRole("link", { name: "#412" })).className).toContain(
      "text-[color:var(--sandy-sidebar-pr-merged)]",
    );
  });
});
