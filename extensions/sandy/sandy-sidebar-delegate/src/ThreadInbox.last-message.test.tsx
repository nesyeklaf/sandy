// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderSlot } from "./test-slot";
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
    expect(reads).toEqual([{}]);
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
