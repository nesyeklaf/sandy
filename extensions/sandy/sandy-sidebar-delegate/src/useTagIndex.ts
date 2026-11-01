import { useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { TOPICS_CHANNEL } from "./realtime-channels";
import { filterByTags, isFiltering, type TagIndex } from "./tag-filter";
import { useTagFilter } from "./useTagFilter";

const EMPTY: TagIndex = { threadTags: {}, segments: [] };

/** Every tag and topic the server knows, refreshed when they change. */
export function useTagIndex(enabled = true): TagIndex {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const [index, setIndex] = useState<TagIndex>(EMPTY);
  const [revision, setRevision] = useState(0);
  useRealtime(TOPICS_CHANNEL, () => setRevision((value) => value + 1));
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    rpc
      .call("listAllTags", {})
      .then((next) => {
        if (!cancelled) setIndex(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rpc, enabled, revision]);
  return index;
}

/** The sidebar's threads, narrowed to the tag and text the filter bar holds. */
export function useTagFilteredThreads<T extends { id: string }>(threads: readonly T[]): readonly T[] {
  const filter = useTagFilter();
  const index = useTagIndex(isFiltering(filter));
  return useMemo(() => filterByTags(threads, index, filter), [threads, index, filter]);
}
