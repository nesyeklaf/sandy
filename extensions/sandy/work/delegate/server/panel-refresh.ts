import type Database from "better-sqlite3";
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { delegatesTag } from "../contract.ts";
import type { PanelList } from "../panel-types.ts";
import { getDelegation, getDelegationByChild } from "./ledger.ts";
import { createPanelListCache } from "./panel-cache.ts";

const PANEL_EVENTS = ["thread.created", "thread.active", "thread.idle", "thread.failed", "thread.archived", "thread.unarchived", "thread.deleted", "interaction.pending"] as const;

export interface PanelRefresh {
  list(threadId: string): Promise<PanelList>;
  touch(...threadIds: string[]): void;
  touchDelegation(delegationId: string): void;
}

export function createPanelRefresh(sandy: SandyPluginApi, db: Database.Database, load: (threadId: string) => Promise<PanelList>): PanelRefresh {
  const cache = createPanelListCache(load);
  const touch = (...threadIds: string[]) => {
    const unique = [...new Set(threadIds)];
    for (const threadId of unique) cache.invalidate(threadId);
    sandy.rpc.experimental_invalidate(unique.map(delegatesTag));
  };
  const touchThread = (threadId: string) => {
    const own = getDelegationByChild(db, threadId);
    touch(threadId, ...(own === null ? [] : [own.parentThreadId]));
  };
  for (const event of PANEL_EVENTS) sandy.events.on(event, ({ thread }) => touchThread(thread.id));
  return {
    list: cache.get,
    touch,
    touchDelegation(delegationId) {
      const row = getDelegation(db, delegationId);
      if (row !== null) touch(row.parentThreadId, ...(row.childThreadId === null ? [] : [row.childThreadId]));
    },
  };
}
