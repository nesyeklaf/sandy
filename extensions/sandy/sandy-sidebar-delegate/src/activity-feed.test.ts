import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { ACTIVITY_WINDOW_MS, activityFeed } from "./activity-feed";

const NOW = 10 * ACTIVITY_WINDOW_MS;
const HOUR = 60 * 60 * 1000;

const thread = (fields: Partial<PluginSidebarThread> & { id: string }) =>
  ({
    hasPendingInteraction: false,
    isArchived: false,
    archivedAt: null,
    isHidden: false,
    isUnread: false,
    status: "idle",
    indicator: "none",
    queuedWork: "none",
    latestAttentionAt: NOW - HOUR,
    ...fields,
  }) as PluginSidebarThread;

describe("activityFeed", () => {
  it("lists asked, failed, finished and archived threads of the last day, newest first", () => {
    const asked = thread({ id: "asked", hasPendingInteraction: true, latestAttentionAt: NOW - 3 * HOUR });
    const feed = activityFeed(
      [
        asked,
        thread({ id: "failed", queuedWork: "failed", latestAttentionAt: NOW - 2 * HOUR }),
        thread({ id: "finished", isUnread: true, latestAttentionAt: NOW - HOUR }),
        thread({ id: "archived", isArchived: true, archivedAt: NOW - 4 * HOUR, latestAttentionAt: NOW - 30 * HOUR }),
      ],
      [asked],
      NOW,
    );
    expect(feed.map((item) => [item.kind, item.thread.id])).toEqual([
      ["finished", "finished"],
      ["failed", "failed"],
      ["asked", "asked"],
      ["archived", "archived"],
    ]);
  });

  it("leaves out older events, read or still running threads, and hidden threads", () => {
    const old = thread({ id: "old", hasPendingInteraction: true, latestAttentionAt: NOW - 25 * HOUR });
    const feed = activityFeed(
      [
        old,
        thread({ id: "old-archive", isArchived: true, archivedAt: NOW - 25 * HOUR }),
        thread({ id: "read", isUnread: false }),
        thread({ id: "running", isUnread: true, status: "active" }),
        thread({ id: "hidden", isUnread: true, isHidden: true }),
      ],
      [old],
      NOW,
    );
    expect(feed).toEqual([]);
  });

  it("dates a Needs you row by the newest question it rolls up", () => {
    const parent = thread({ id: "parent", latestAttentionAt: NOW - 20 * HOUR });
    const feed = activityFeed(
      [
        parent,
        thread({
          id: "child",
          parentThreadId: "parent",
          isHidden: true,
          hasPendingInteraction: true,
          latestAttentionAt: NOW - HOUR,
        }),
      ],
      [parent],
      NOW,
    );
    expect(feed.map((item) => [item.kind, item.thread.id, item.at])).toEqual([["asked", "parent", NOW - HOUR]]);
  });
});
