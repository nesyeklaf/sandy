import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import { TOPICS_CHANNEL } from "./realtime-channels";
import { useSuggestions } from "./useSuggestions";
import { buildEntries } from "./topic-layout";
import type { TocBand } from "./toc-extension";
import type { TopicSegment } from "./topics-contract";

const REFRESH_MS = 60_000;

/** Brackets for the thread TOC rail: saved topics solid, AI suggestions dashed. */
export function useTopicBands(threadId: string): readonly TocBand[] {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const [segments, setSegments] = useState<TopicSegment[]>([]);
  const suggestions = useSuggestions(threadId);

  const refresh = useCallback(async () => {
    try {
      setSegments((await rpc.call("listTopics", { threadId })).segments);
    } catch {
      // The rail just shows no brackets until the next refresh.
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setSegments([]);
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useRealtime(TOPICS_CHANNEL, () => void refresh());

  return useMemo(
    () =>
      buildEntries(segments, suggestions).map((entry) => ({
        fromSeq: entry.fromSeq,
        toSeq: entry.toSeq,
        hue: entry.hue,
        label: entry.suggested ? `Suggested: ${entry.title}` : entry.title,
        dashed: entry.suggested,
      })),
    [segments, suggestions],
  );
}
