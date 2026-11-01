import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@sandy-sdk/plugin-sdk/testing";
import plugin, {
  matchesQuery,
  toBookmark,
  type Bookmark,
  type BookmarkRow,
  type StoredBookmark,
} from "./server";
import { CHANGED_CHANNEL, MAX_TEXT_LENGTH } from "./shared";

type ToggleResult = { bookmark: Bookmark | null; removed: StoredBookmark | null };

function message(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thr_one",
    seq: 42,
    rowId: "thr_one:assistant:kind:assistant|turn:t1|parent:root|item:i2",
    role: "assistant",
    text: "Use **SQLite** for the `bookmarks` table.",
    ...overrides,
  };
}

async function setup(
  getThread: (args: { threadId: string }) => Promise<unknown> = async ({
    threadId,
  }) =>
    makeThreadResponse({
      id: threadId,
      title: "Сохранение закладок",
      projectId: "proj_one",
    }),
) {
  const { sandy, harness } = createFakePluginHost({
    pluginId: "bookmarks",
    sdk: { threads: { get: getThread as never } },
  });
  await plugin(sandy);
  const list = async (input: unknown = null) =>
    ((await harness.behavior.callRpc("list", input)) as { bookmarks: Bookmark[] })
      .bookmarks;
  const markers = async () =>
    ((await harness.behavior.callRpc("markers")) as { rowIds: string[] }).rowIds;
  return { harness, list, markers };
}

function row(overrides: Partial<BookmarkRow> = {}): BookmarkRow {
  return {
    id: "b1",
    thread_id: "thr_one",
    seq: 1,
    row_id: "row",
    role: "assistant",
    text: "Plain text",
    quote: null,
    thread_title: "Title",
    project_id: "proj_one",
    thread_deleted: 0,
    created_at: 1,
    ...overrides,
  };
}

describe("bookmark storage", () => {
  it("toggles a message on with a thread snapshot, then off again", async () => {
    const { harness, list, markers } = await setup();

    const added = (await harness.behavior.callRpc(
      "toggle",
      message(),
    )) as ToggleResult;
    expect(added.removed).toBeNull();
    expect(added.bookmark).toMatchObject({
      threadId: "thr_one",
      seq: 42,
      role: "assistant",
      excerpt: "Use **SQLite** for the `bookmarks` table.",
      quoted: false,
      threadTitle: "Сохранение закладок",
      projectId: "proj_one",
      threadDeleted: false,
    });
    expect(await list()).toHaveLength(1);
    expect(await markers()).toEqual([message().rowId]);

    const removed = (await harness.behavior.callRpc(
      "toggle",
      message(),
    )) as ToggleResult;
    expect(removed.bookmark).toBeNull();
    expect(removed.removed).toMatchObject({
      id: added.bookmark?.id,
      text: message().text,
    });
    expect(await list()).toEqual([]);
    expect(await markers()).toEqual([]);
    expect(
      harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === CHANGED_CHANNEL,
      ),
    ).toHaveLength(2);
    await harness.lifecycle.dispose();
  });

  it("restores a removed bookmark with its id and position", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, list } = await setup();
    vi.setSystemTime(1_000);
    const first = (await harness.behavior.callRpc(
      "toggle",
      message({ seq: 1 }),
    )) as ToggleResult;
    vi.setSystemTime(2_000);
    await harness.behavior.callRpc("toggle", message({ seq: 2 }));

    const { removed } = (await harness.behavior.callRpc("remove", {
      id: first.bookmark?.id,
    })) as { removed: StoredBookmark };
    expect((await list()).map((bookmark) => bookmark.seq)).toEqual([2]);

    await harness.behavior.callRpc("restore", removed);
    const restored = await list();
    expect(restored.map((bookmark) => bookmark.seq)).toEqual([2, 1]);
    expect(restored[1]).toMatchObject({
      id: first.bookmark?.id,
      createdAt: 1_000,
    });
    await harness.lifecycle.dispose();
    vi.useRealTimers();
  });

  it("keeps one bookmark per message and shows a saved selection", async () => {
    const { harness, list } = await setup();
    await harness.behavior.callRpc("toggle", message());
    await harness.behavior.callRpc("save", {
      ...message(),
      quote: "SQLite",
    });

    const bookmarks = await list();
    expect(bookmarks).toHaveLength(1);
    expect(bookmarks[0]).toMatchObject({ excerpt: "SQLite", quoted: true });

    const { text } = (await harness.behavior.callRpc("fullText", {
      id: bookmarks[0]?.id,
    })) as { text: string };
    expect(text).toBe("SQLite");
    await harness.lifecycle.dispose();
  });

  it("saves a message once when it is bookmarked twice at the same time", async () => {
    const { harness, list } = await setup();
    const results = (await Promise.all([
      harness.behavior.callRpc("toggle", message()),
      harness.behavior.callRpc("toggle", message()),
    ])) as ToggleResult[];

    expect(await list()).toHaveLength(1);
    expect(results[0]?.bookmark?.id).toBe(results[1]?.bookmark?.id);
    await harness.lifecycle.dispose();
  });

  it("searches saved text and thread titles without regard to case", async () => {
    const { harness, list } = await setup();
    await harness.behavior.callRpc("toggle", message({ seq: 1, text: "Кэш почти не работает" }));
    await harness.behavior.callRpc("toggle", message({ seq: 2, text: "Plain answer" }));

    expect((await list({ query: "КЭШ" })).map((bookmark) => bookmark.seq)).toEqual([1]);
    expect(await list({ query: "закладок" })).toHaveLength(2);
    expect(await list({ query: "missing" })).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("still saves the bookmark when the thread cannot be read", async () => {
    const { harness, list } = await setup(async () => {
      throw new Error("not found");
    });
    await harness.behavior.callRpc("toggle", message());

    expect(await list()).toMatchObject([{ threadTitle: null, projectId: null }]);
    expect(
      harness.inspection.logEntries.some((entry) => entry.message.includes("not found")),
    ).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("rejects message text past the stored limit", async () => {
    const { harness } = await setup();
    await expect(
      harness.behavior.callRpc(
        "toggle",
        message({ text: "x".repeat(MAX_TEXT_LENGTH + 1) }),
      ),
    ).rejects.toThrow();
    await harness.lifecycle.dispose();
  });
});

describe("thread lifecycle", () => {
  it("flags bookmarks of a deleted thread and drops their timeline markers", async () => {
    const { harness, list, markers } = await setup();
    await harness.behavior.callRpc("toggle", message());

    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thr_one" }),
    });

    expect(await list()).toMatchObject([{ threadDeleted: true }]);
    expect(await markers()).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("refreshes the saved title when the thread goes idle", async () => {
    const { harness, list } = await setup();
    await harness.behavior.callRpc("toggle", message());
    const signals = harness.inspection.realtimeSignals.length;

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_one",
        title: "Renamed",
        projectId: "proj_one",
      }),
      lastAssistantText: null,
    });
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_one",
        title: "Renamed",
        projectId: "proj_one",
      }),
      lastAssistantText: null,
    });

    expect(await list()).toMatchObject([{ threadTitle: "Renamed" }]);
    expect(harness.inspection.realtimeSignals.length).toBe(signals + 1);
    await harness.lifecycle.dispose();
  });
});

describe("list rows", () => {
  it("cuts long excerpts without splitting a surrogate pair", () => {
    const excerpt = toBookmark(row({ text: `${"a".repeat(599)}😀tail` })).excerpt;
    expect(excerpt).toBe("a".repeat(599));
  });

  it("matches the quote as well as the message", () => {
    expect(matchesQuery(row({ quote: "Selected words" }), "selected")).toBe(true);
    expect(matchesQuery(row(), "  ")).toBe(true);
    expect(matchesQuery(row({ thread_title: null }), "title")).toBe(false);
  });
});
