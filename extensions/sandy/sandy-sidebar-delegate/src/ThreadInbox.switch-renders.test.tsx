// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderSlot } from "./test-slot";
import { inbox, thread, listProps, loadInboxApp, defaultProviders } from "./test-inbox";
import type * as SnoozeSelectModule from "./SnoozeSelect";

const rowRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("sonner", async () => (await import("./test-inbox")).sonnerMock());
vi.mock("./SnoozeSelect", async (importOriginal) => {
  const original = await importOriginal<typeof SnoozeSelectModule>();
  return {
    ...original,
    SnoozeSelect: (props: Parameters<typeof original.SnoozeSelect>[0]) => {
      rowRenders.count += 1;
      return original.SnoozeSelect(props);
    },
  };
});

await loadInboxApp();

describe("ThreadInbox", () => {
  // Opening another thread is the most frequent sidebar change. Rows the
  // switch does not touch must not render again, or every switch pays for
  // the whole list.
  it("re-renders only the rows whose active state changes when another thread opens", () => {
    const props = { ...listProps, activeThreadId: "thr_a" };
    const rendered = renderSlot(inbox, props, {
      sidebarThreads: {
        status: "ready",
        threads: ["a", "b", "c", "d", "e"].map((id, index) =>
          thread({ id: `thr_${id}`, title: `Thread ${id}`, createdAt: 100 - index }),
        ),
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      providers: { status: "ready", providers: defaultProviders },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });
    expect(screen.getByRole("link", { name: "Thread a" }).getAttribute("aria-current")).toBe("page");
    expect(rowRenders.count).toBeGreaterThanOrEqual(5);

    rowRenders.count = 0;
    const InboxComponent = inbox.component;
    rendered.rerender(<InboxComponent {...props} activeThreadId="thr_b" />);

    expect(screen.getByRole("link", { name: "Thread b" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Thread a" }).getAttribute("aria-current")).toBeNull();
    expect(rowRenders.count).toBeLessThanOrEqual(2);
  });
});
