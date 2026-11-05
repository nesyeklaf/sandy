import { useEffect, useState } from "react";
import { useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";
import type { SearchScope } from "./search-contract";

const NONE: ReadonlySet<string> = new Set();
const DEBOUNCE_MS = 250;

/** Ids of the sessions whose name or content match, or null while the text is empty. */
export function useSessionSearch(query: string, scope: SearchScope): ReadonlySet<string> | null {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const text = query.trim();
  const [ids, setIds] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    if (text === "") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc
        .call("searchSessions", { query: text, scope })
        .then((found) => {
          if (!cancelled) setIds(new Set(found.threadIds));
        })
        .catch(() => {
          if (!cancelled) setIds(NONE);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, text, scope]);
  return text === "" ? null : ids;
}
