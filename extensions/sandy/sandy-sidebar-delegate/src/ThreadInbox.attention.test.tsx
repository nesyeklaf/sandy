// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { thread, render, loadInboxApp } from "./test-inbox";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

// The three states that need attention take the slot from the age label.
describe("attention states", () => {
  const states = [
    ["waiting-for-input", "Thread needs user input", "Needs you", "text-[color:var(--sandy-sidebar-tone-pending)]"],
    ["unread-error", "Unread thread failed", "Failed", "text-[color:var(--sandy-sidebar-tone-error)]"],
    ["unread-success", "Unread thread succeeded", "Unread", "text-[color:var(--sandy-sidebar-tone-success)]"],
  ] as const;

  for (const [indicator, label, shortLabel, toneClass] of states) {
    it(`shows the ${indicator} label instead of the age`, async () => {
      render([
        thread({
          id: `thr_${indicator}`,
          indicator,
          indicatorLabel: label,
          updatedAt: Date.now() - (3 * 3_600_000 + 60_000),
        }),
      ]);
      expect(await screen.findByLabelText(label)).toBeDefined();
      // The first shelf is also called "Needs you", so match the row label by its tone.
      expect(
        screen
          .getAllByText(shortLabel)
          .map((node) => node.className)
          .join(" "),
      ).toContain(toneClass);
      expect(screen.queryByText("3h")).toBeNull();
    });
  }

  it("uses a working label instead of an unread success state", async () => {
    render([
      thread({
        id: "thr_busy",
        isUnread: true,
        indicator: "runtime",
        indicatorLabel: "Thread working",
      }),
    ]);
    expect(await screen.findByLabelText("Thread working")).toBeDefined();
    expect(screen.getByText("Working")).toBeDefined();
    expect(screen.queryByLabelText("Unread thread succeeded")).toBeNull();
  });
});
