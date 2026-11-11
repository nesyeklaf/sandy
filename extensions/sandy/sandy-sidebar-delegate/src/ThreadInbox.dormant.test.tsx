// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp } from "./test-inbox";
import { useDormancyClock } from "./useDormancyClock";
import { DORMANT_AFTER_MS } from "./spaces-model";

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());

await loadInboxApp();

it("draws a thread untouched for a week on Dormant and a fresh one on Idle", async () => {
  vi.mocked(useDormancyClock).mockReturnValue(DORMANT_AFTER_MS + 1_000);
  localStorage.setItem("sandy-sidebar:shelf-expansion:v1", JSON.stringify({ dormant: true }));
  renderSlot(inbox, listProps, {
    sidebarThreads: {
      status: "ready",
      threads: [
        thread({ id: "old", title: "Old work", updatedAt: 1_000, latestAttentionAt: 1_000 }),
        thread({
          id: "fresh",
          title: "Fresh work",
          updatedAt: DORMANT_AFTER_MS,
          latestAttentionAt: DORMANT_AFTER_MS,
        }),
      ],
      projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
    },
    rpc: { listLifecycle: () => ({ rows: [] }) },
  });
  const dormant = await screen.findByRole("region", { name: "Dormant" });
  expect(within(dormant).getByRole("link", { name: "Old work" })).toBeDefined();
  const idle = screen.getByRole("region", { name: "Idle" });
  expect(within(idle).getByRole("link", { name: "Fresh work" })).toBeDefined();
  expect(within(idle).queryByRole("link", { name: "Old work" })).toBeNull();
  vi.mocked(useDormancyClock).mockReturnValue(0);
});
