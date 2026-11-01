import { useEffect, useState } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { Anchor } from "./anchors-contract";
import type { sandySidebarRpcContract } from "./contract";
import { ANCHORS_CHANNEL } from "./realtime-channels";

interface AnchorSearch {
  query: string;
  kind: Anchor["kind"] | null;
  /** Limits the search to one session; null searches every session. */
  threadId: string | null;
}

interface SearchResult {
  anchors: readonly Anchor[];
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 200;

/** Marks matching a search, newest first, re-run when a mark changes anywhere. */
export function useAnchorSearch({ query, kind, threadId }: AnchorSearch): SearchResult {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const [result, setResult] = useState<SearchResult>({ anchors: [], loading: true, error: null });
  const [stamp, setStamp] = useState(0);
  useRealtime(ANCHORS_CHANNEL, () => setStamp((value) => value + 1));
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      rpc
        .call("searchAnchors", {
          query: query.trim() === "" ? undefined : query.trim(),
          kind: kind ?? undefined,
          threadId: threadId ?? undefined,
        })
        .then((answer) => current && setResult({ anchors: answer.anchors, loading: false, error: null }))
        .catch(
          (cause) =>
            current &&
            setResult({ anchors: [], loading: false, error: cause instanceof Error ? cause.message : String(cause) }),
        );
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [rpc, query, kind, threadId, stamp]);

  return result;
}
