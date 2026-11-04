// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { giveEachHookItsOwnRpcClient, renderSlot } from "./test-slot";
import { deferred } from "./test-fixtures";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { DEFAULT_ROW_FIELDS } from "./row-fields";
import { inbox, defaultSidebarSettings, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const threads = [thread({ id: "said", title: "Said work" }), thread({ id: "silent", title: "Silent work" })];
const messages = [{ threadId: "said", text: "Tests pass and the branch is ready." }];

function renderInbox(settings: Partial<typeof defaultSidebarSettings> = {}) {
  const reads: unknown[] = [];
  const rendered = renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads,
      projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: {
      getSidebarSettings: () => ({ ...defaultSidebarSettings, ...settings }),
      listLifecycle: () => ({ rows: [] }),
      listLastMessages: (input) => {
        reads.push(input);
        return { messages };
      },
    },
  });
  return { ...rendered, reads };
}

const enableLastMessage = () =>
  localStorage.setItem(STORAGE_KEYS.rowFields.key, JSON.stringify({ ...DEFAULT_ROW_FIELDS, lastMessage: true }));

beforeEach(() => localStorage.clear());

describe("Last message reads with a client per hook, as in core", () => {
  let restoreRpc = () => {};
  beforeEach(() => {
    restoreRpc = giveEachHookItsOwnRpcClient();
  });
  afterEach(() => restoreRpc());

  it("costs one request for a hundred rows and at most one more for a realtime burst", async () => {
    enableLastMessage();
    const many = Array.from({ length: 100 }, (_, index) => thread({ id: `thr_${index}`, title: `Work ${index}` }));
    const reads: Array<{ threadIds: string[] }> = [];
    const answer = { messages: [{ threadId: "thr_0", text: "First of a hundred." }] };
    const answers: Array<ReturnType<typeof deferred<typeof answer>>> = [];
    const rendered = renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: many,
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        getSidebarSettings: () => defaultSidebarSettings,
        listLifecycle: () => ({ rows: [] }),
        listLastMessages: (input) => {
          reads.push(input as { threadIds: string[] });
          const pending = deferred<typeof answer>();
          answers.push(pending);
          return pending.promise;
        },
      },
    });
    await screen.findByRole("link", { name: "Work 99" });
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(reads[0]!.threadIds).toHaveLength(100);
    for (let burst = 0; burst < 10; burst += 1) await rendered.emitRealtime("last-message", {});
    expect(reads).toHaveLength(1);
    answers[0]!.resolve(answer);
    await waitFor(() => expect(reads).toHaveLength(2));
    answers[1]!.resolve(answer);
    expect(await screen.findByText(answer.messages[0]!.text)).toBeDefined();
    await rendered.emitRealtime("last-message", {});
    await waitFor(() => expect(reads).toHaveLength(3));
  });
});

describe("Last message row field", () => {
  it("is off by default and does not even ask the server", async () => {
    const { reads } = renderInbox();
    await screen.findByRole("link", { name: "Said work" });
    expect(screen.queryByText(messages[0]!.text)).toBeNull();
    expect(reads).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /^View options/ }));
    const toggle = await screen.findByRole("button", { name: "Last message" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the stored text on the row once toggled on, and nothing for a thread without one", async () => {
    const { reads } = renderInbox();
    await screen.findByRole("link", { name: "Said work" });
    fireEvent.click(screen.getByRole("button", { name: /^View options/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Last message" }));
    const line = await screen.findByText(messages[0]!.text);
    expect(line.className).toContain("truncate");
    expect(screen.getAllByText(messages[0]!.text)).toHaveLength(1);
    expect(reads).toEqual([{ threadIds: ["said", "silent"] }]);
    expect(screen.getByRole("button", { name: "Last message" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("stays visible after a reload when the owner turned it on", async () => {
    enableLastMessage();
    renderInbox();
    expect(await screen.findByText(messages[0]!.text)).toBeDefined();
  });

  it("is not drawn on Dense rows", async () => {
    enableLastMessage();
    renderInbox({ threadDensity: "dense" });
    await screen.findByRole("link", { name: "Said work" });
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Said work" }).closest("[data-parent-card]")?.getAttribute("data-row-density"),
      ).toBe("dense"),
    );
    await waitFor(() => expect(screen.queryByText(messages[0]!.text)).toBeNull());
  });

  it("is drawn on Compact rows", async () => {
    enableLastMessage();
    renderInbox({ threadDensity: "compact" });
    expect(await screen.findByText(messages[0]!.text)).toBeDefined();
  });
});
