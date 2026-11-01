// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@sandy-sdk/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { markerStyles } from "./markers";
import { openMessage, threadPath } from "./navigation";
import { excerptText, formatSavedAt, plainExcerpt } from "./presentation";
import type { Bookmark } from "./server";

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: "b1",
    threadId: "thr_one",
    seq: 10,
    role: "assistant",
    excerpt: "Keep **one** bookmark per message.",
    quoted: false,
    threadTitle: "Saved title",
    projectId: "proj_one",
    threadDeleted: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

function sidebarThread(overrides: Partial<PluginSidebarThread>): PluginSidebarThread {
  return {
    id: "thr_one",
    projectId: "proj_one",
    title: "Live title",
    titleFallback: null,
    displayTitle: "Live title",
    href: "/projects/proj_one/threads/thr_one",
    ...overrides,
  } as PluginSidebarThread;
}

function panel(app: CapturedPluginApp) {
  const action = app.threadPanelActions[0];
  if (action === undefined) throw new Error("Expected the Bookmarks panel");
  return action;
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("registrations", () => {
  it("adds a message action, the panel in both surfaces, a header button, and a command", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.messageActions.map((action) => action.title)).toEqual(["Bookmark"]);
    expect(app.threadPanelActions.map((action) => action.id)).toEqual(["bookmarks"]);
    expect(app.newThreadPanelActions.map((action) => action.id)).toEqual(["bookmarks"]);
    expect(app.threadHeaderActions).toHaveLength(1);
    expect(app.appOverlays).toHaveLength(1);
  });
});

describe("bookmark action", () => {
  it("toggles the clicked message and saves a selection as its quote", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const requests: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({ ok: true, result: { bookmark: bookmark(), removed: null } }),
        );
      }),
    );
    const action = app.messageActions[0]!;
    const context = {
      threadId: "thr_one",
      message: {
        id: "row-1",
        threadId: "thr_one",
        role: "assistant" as const,
        text: "Full answer",
        sourceSeqEnd: 10,
      },
      openPanel: () => true,
    };

    await action.run(context);
    await action.run({ ...context, selectedText: "  answer " });

    expect(requests).toEqual([
      {
        url: "/api/v1/plugins/bookmarks/rpc/toggle",
        body: {
          threadId: "thr_one",
          seq: 10,
          rowId: "row-1",
          role: "assistant",
          text: "Full answer",
        },
      },
      {
        url: "/api/v1/plugins/bookmarks/rpc/save",
        body: {
          threadId: "thr_one",
          seq: 10,
          rowId: "row-1",
          role: "assistant",
          text: "Full answer",
          quote: "answer",
        },
      },
    ]);
  });
});

describe("bookmarks panel", () => {
  it("lists every bookmark with its live thread title", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      panel(app),
      { threadId: "thr_two", params: null },
      {
        rpc: {
          list: () => ({
            bookmarks: [
              bookmark(),
              bookmark({
                id: "b2",
                threadId: "thr_gone",
                role: "user",
                excerpt: "Selected words",
                quoted: true,
                threadTitle: "Old title",
              }),
            ],
          }),
        },
        sidebarThreads: { threads: [sidebarThread({})] },
      },
    );

    await slot.findByText("Keep one bookmark per message.");
    expect(slot.getByText("Live title")).toBeTruthy();
    expect(slot.getByText("Old title")).toBeTruthy();
    expect(slot.getByText("· You")).toBeTruthy();
    expect(slot.getByText("Selected words").className).toContain("border-l-2");
    slot.lifecycle.unmount();
  });

  it("shows only this thread's bookmarks in timeline order", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      panel(app),
      { threadId: "thr_one", params: null },
      {
        rpc: {
          list: () => ({
            bookmarks: [
              bookmark({ id: "b3", seq: 30, excerpt: "Third" }),
              bookmark({ id: "b2", threadId: "thr_two", excerpt: "Elsewhere" }),
              bookmark({ id: "b1", seq: 5, excerpt: "First" }),
            ],
          }),
        },
      },
    );

    await slot.findByText("Elsewhere");
    fireEvent.click(slot.getByRole("button", { name: "This thread" }));
    const excerpts = slot.container.querySelectorAll("li .line-clamp-3");
    expect(Array.from(excerpts, (element) => element.textContent)).toEqual([
      "First",
      "Third",
    ]);
    slot.lifecycle.unmount();
  });

  it("opens a bookmark at its message through the router's history entry", async () => {
    window.history.replaceState({ usr: null, key: "start", idx: 3 }, "", "/");
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      panel(app),
      { threadId: "thr_one", params: null },
      {
        rpc: { list: () => ({ bookmarks: [bookmark()] }) },
        sidebarThreads: { threads: [sidebarThread({})] },
      },
    );

    fireEvent.click(await slot.findByText("Keep one bookmark per message."));
    expect(window.location.pathname).toBe("/projects/proj_one/threads/thr_one");
    expect(window.history.state).toMatchObject({
      usr: { searchMessageSeq: 10, searchThreadId: "thr_one" },
      idx: 4,
    });
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("falls back to plain thread navigation outside the router", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      panel(app),
      { threadId: "thr_one", params: null },
      { rpc: { list: () => ({ bookmarks: [bookmark()] }) } },
    );

    fireEvent.click(await slot.findByText("Keep one bookmark per message."));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_one" },
    ]);
    slot.lifecycle.unmount();
  });

  it("removes a bookmark and refetches on the change signal", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let bookmarks = [bookmark()];
    const slot = renderSlot(
      panel(app),
      { threadId: "thr_one", params: null },
      {
        rpc: {
          list: () => ({ bookmarks }),
          remove: () => {
            bookmarks = [];
            return { removed: null };
          },
        },
      },
    );

    await slot.findByText("Keep one bookmark per message.");
    fireEvent.click(slot.getByRole("button", { name: "Remove bookmark" }));
    await slot.behavior.emitRealtime("changed", null);
    await slot.findByText(/No bookmarks yet/);
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toContain("remove");
    slot.lifecycle.unmount();
  });

  it("searches on the server once typing settles", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      panel(app),
      { threadId: "thr_one", params: null },
      { rpc: { list: () => ({ bookmarks: [] }) } },
    );

    fireEvent.change(slot.getByPlaceholderText("Search"), {
      target: { value: "  кэш " },
    });
    await slot.findByText("No bookmarks match “кэш”.");
    expect(slot.inspection.rpcCalls.at(-1)).toEqual({
      method: "list",
      input: { query: "кэш" },
    });
    slot.lifecycle.unmount();
  });
});

describe("timeline markers", () => {
  it("keeps one style element for the bookmarked rows while mounted", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.appOverlays[0]!,
      {},
      { rpc: { markers: () => ({ rowIds: ["row-1"] }) } },
    );

    await vi.waitFor(() => {
      expect(document.querySelectorAll("style[data-bookmarks-markers]")).toHaveLength(1);
    });
    expect(
      document.querySelector("style[data-bookmarks-markers]")?.textContent,
    ).toContain('[data-timeline-row-id="row-1"]');
    slot.lifecycle.unmount();
    expect(document.querySelector("style[data-bookmarks-markers]")).toBeNull();
  });

  it("escapes row ids inside the attribute selector", () => {
    const css = markerStyles(['row"}body{x:y']);
    expect(css).toContain('[data-timeline-row-id="row\\"}body{x:y"]');
    expect(markerStyles([])).toBe("");
  });
});

describe("navigation", () => {
  it("builds personal and project thread paths", () => {
    expect(threadPath("thr_1", "proj_personal", true)).toBe("/threads/thr_1");
    expect(threadPath("thr_1", "proj_2", false)).toBe("/projects/proj_2/threads/thr_1");
  });

  it("replays the pushed entry as a history pop", () => {
    window.history.replaceState({ usr: null, key: "a", idx: 0 }, "", "/");
    const listener = vi.fn();
    window.addEventListener("popstate", listener);
    expect(openMessage("/threads/thr_1", "thr_1", 7)).toBe(true);
    window.removeEventListener("popstate", listener);
    expect(listener).toHaveBeenCalledTimes(1);

    window.history.replaceState(null, "", "/");
    expect(openMessage("/threads/thr_1", "thr_1", 7)).toBe(false);
  });
});

describe("presentation", () => {
  it("flattens markdown into one readable line", () => {
    expect(
      plainExcerpt(
        "## Result\n\n- Use **SQLite** and [docs](https://x.dev)\n```ts\nconst a = 1;\n```\n| a | b |\n|---|---|\n| 1 | 2 |",
      ),
    ).toBe("Result Use SQLite and docs a b 1 2");
    expect(plainExcerpt("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(plainExcerpt("keep snake_case_names")).toBe("keep snake_case_names");
  });

  it("keeps plain text such as a user message or a selection as typed", () => {
    expect(excerptText("2*3*4 and **not bold**\n\nnext", false)).toBe(
      "2*3*4 and **not bold** next",
    );
    expect(excerptText("**bold**", true)).toBe("bold");
  });

  it("formats how long ago a bookmark was saved", () => {
    const now = new Date(2026, 8, 22, 12).getTime();
    expect(formatSavedAt(now - 20_000, now)).toBe("now");
    expect(formatSavedAt(now - 5 * 60_000, now)).toBe("5m");
    expect(formatSavedAt(now - 3 * 3_600_000, now)).toBe("3h");
    expect(formatSavedAt(now - 2 * 86_400_000, now)).toBe("2d");
    expect(formatSavedAt(now - 30 * 86_400_000, now)).toMatch(/23|Aug/);
  });
});
