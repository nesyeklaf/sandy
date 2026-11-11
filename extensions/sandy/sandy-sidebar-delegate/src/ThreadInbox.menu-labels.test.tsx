// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const threads = { status: "ready" as const, threads: [thread({ title: "Login bug" })], projects: [] };

describe("row menu labels", () => {
  it("edits the session's own tags and topics from Tags & Topics…", async () => {
    const setTopicTags = vi.fn((input: unknown) => ({ tags: (input as { tags: string[] }).tags }));
    const setThreadTopics = vi.fn((input: unknown) => ({ topics: (input as { topics: string[] }).topics }));
    renderSlot(inbox, listProps, {
      sidebarThreads: threads,
      rpc: {
        listLifecycle: () => ({ rows: [] }),
        listTopics: () => ({ segments: [], threadTags: ["bug"], threadTopics: ["Release"] }),
        setTopicTags,
        setThreadTopics,
      },
    });
    fireEvent.contextMenu(await screen.findByText("Login bug"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Tags & Topics…" }));
    const dialog = await screen.findByRole("dialog", { name: "Tags & Topics" });
    expect(await within(dialog).findByText("bug")).toBeDefined();
    expect(within(dialog).getByText("Release")).toBeDefined();
    const tagField = within(dialog).getByRole("textbox", { name: "Tags of this session" });
    fireEvent.change(tagField, { target: { value: "Urgent" } });
    fireEvent.keyDown(tagField, { key: "Enter" });
    await waitFor(() =>
      expect(setTopicTags).toHaveBeenCalledWith({ kind: "thread", ownerId: "thr_1", tags: ["bug", "urgent"] }),
    );
    const topicField = within(dialog).getByRole("textbox", { name: "Topics of this session" });
    fireEvent.change(topicField, { target: { value: "Sidebar Polish" } });
    fireEvent.keyDown(topicField, { key: "Enter" });
    await waitFor(() =>
      expect(setThreadTopics).toHaveBeenCalledWith({ threadId: "thr_1", topics: ["Release", "Sidebar Polish"] }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Topic Release" }));
    await waitFor(() =>
      expect(setThreadTopics).toHaveBeenLastCalledWith({ threadId: "thr_1", topics: ["Sidebar Polish"] }),
    );
  });

  it("marks a session as an idea and takes the mark back", async () => {
    let ideas: string[] = [];
    const setIdea = vi.fn((raw: unknown) => {
      const input = raw as { threadIds: string[]; idea: boolean };
      ideas = input.idea ? input.threadIds : [];
      return { changed: input.threadIds };
    });
    renderSlot(inbox, listProps, {
      sidebarThreads: threads,
      rpc: { listLifecycle: () => ({ rows: [] }), listIdeas: () => ({ threadIds: ideas }), setIdea },
    });
    fireEvent.contextMenu(await screen.findByText("Login bug"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as idea" }));
    await waitFor(() => expect(setIdea).toHaveBeenCalledWith({ threadIds: ["thr_1"], idea: true }));
    const shelf = await screen.findByRole("region", { name: "Ideas" });
    expect(within(shelf).getByText("Login bug")).toBeDefined();
    fireEvent.contextMenu(within(shelf).getByText("Login bug"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Not an idea any more" }));
    await waitFor(() => expect(setIdea).toHaveBeenLastCalledWith({ threadIds: ["thr_1"], idea: false }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Ideas" })).toBeNull());
  });
});
