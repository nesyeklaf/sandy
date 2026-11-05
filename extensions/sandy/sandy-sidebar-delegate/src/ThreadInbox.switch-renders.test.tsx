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

const THREAD_IDS = Array.from({ length: 40 }, (_, index) => `thr_${index}`);

function manyThreads() {
  return [
    ...THREAD_IDS.map((id, index) => thread({ id, title: `Thread ${id}`, createdAt: 1000 - index })),
    ...[0, 1, 2].map((index) =>
      thread({
        id: `thr_hidden_${index}`,
        title: `Finished worker ${index}`,
        parentThreadId: `thr_${index}`,
        originPluginId: "work",
        isHidden: true,
      }),
    ),
  ];
}

describe("ThreadInbox", () => {
  // Opening another thread is the most frequent sidebar change. Rows the
  // switch does not touch must not render again, or every switch pays for
  // the whole list.
  it("re-renders only the rows whose active state changes when another thread opens", () => {
    const props = { ...listProps, activeThreadId: "thr_0" };
    const rendered = renderSlot(inbox, props, {
      sidebarThreads: {
        status: "ready",
        threads: manyThreads(),
        projects: [{ id: "proj_1", name: "sandy", isPersonal: false, href: "", settingsHref: "" }],
      },
      providers: { status: "ready", providers: defaultProviders },
      rpc: { listLifecycle: () => ({ rows: [] }) },
    });
    expect(screen.getByRole("link", { name: "Thread thr_0" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText("Finished worker 0")).toBeNull();
    expect(rowRenders.count).toBeGreaterThanOrEqual(THREAD_IDS.length);

    const InboxComponent = inbox.component;
    for (const [from, to] of [
      ["thr_0", "thr_7"],
      ["thr_7", "thr_21"],
      ["thr_21", "thr_0"],
    ] as const) {
      rowRenders.count = 0;
      rendered.rerender(<InboxComponent {...props} activeThreadId={to} />);

      expect(screen.getByRole("link", { name: `Thread ${to}` }).getAttribute("aria-current")).toBe("page");
      expect(screen.getByRole("link", { name: `Thread ${from}` }).getAttribute("aria-current")).toBeNull();
      expect(rowRenders.count).toBeLessThanOrEqual(2);
    }
  });
});
