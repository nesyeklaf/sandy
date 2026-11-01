// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

const shelves = [
  { name: "Snoozed", row: { settledAt: null, snoozedUntil: Date.now() + 86_400_000, snoozedAt: Date.now() } },
  { name: "Parked", row: { settledAt: null, snoozedUntil: null, snoozedAt: null, parkedAt: Date.now() - 1_000 } },
  { name: "Settled", row: { settledAt: 200, snoozedUntil: null, snoozedAt: null } },
] as const;

describe("children of shelved threads", () => {
  it.each(shelves)("shows the child chip on $name rows and expands the children on demand", async ({ name, row }) => {
    localStorage.setItem("sandy-sidebar:shelf-expansion:v1", JSON.stringify({ [name.toLowerCase()]: true }));
    renderSlot(inbox, listProps, {
      sidebarThreads: {
        status: "ready",
        threads: [
          thread({ id: "parent", title: "Shelved parent" }),
          thread({ id: "quiet", title: "Quiet child", parentThreadId: "parent" }),
          // Failed, but a shelved row stays one line until expanded. A child
          // that asks for input is the exception: it brings the parent back.
          thread({ id: "failed", title: "Failed child", parentThreadId: "parent", indicator: "unread-error" }),
          thread({ id: "lonely", title: "No children" }),
        ],
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      rpc: {
        listLifecycle: () => ({
          rows: ["parent", "lonely"].map((threadId) => ({ threadId, ...row })),
        }),
      },
    });
    const shelf = await screen.findByRole("region", { name });
    await waitFor(() => expect(within(shelf).getByText("Shelved parent")).toBeDefined());
    const chip = within(shelf).getByRole("button", { name: /^2 child threads/ });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(within(shelf).getAllByRole("button", { name: /child thread/ })).toHaveLength(1);
    expect(within(shelf).queryByText("Quiet child")).toBeNull();
    expect(within(shelf).queryByText("Failed child")).toBeNull();

    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(within(shelf).getByText("Quiet child")).toBeDefined();
    expect(within(shelf).getByText("Failed child")).toBeDefined();
    expect(JSON.parse(localStorage.getItem("sandy-sidebar:child-expansion:v1")!)).toEqual(["parent"]);

    fireEvent.click(chip);
    expect(within(shelf).queryByText("Quiet child")).toBeNull();
  });
});
