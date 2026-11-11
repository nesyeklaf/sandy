import { useCallback, useEffect } from "react";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { usePersistedPreference } from "./lib/use-persisted-preference";
import { childExpansionCodec } from "./lib/inbox-preference-codecs";

export function useChildExpansion(childrenByParentId: ReadonlyMap<string, unknown>, delegateChildrenLoaded: boolean) {
  const [expandedChildParentIds, setExpandedChildParentIds] = usePersistedPreference(
    STORAGE_KEYS.childExpansion.key,
    childExpansionCodec,
  );
  useEffect(() => {
    if (!delegateChildrenLoaded) return;
    setExpandedChildParentIds((current) => {
      const next = new Set([...current].filter((threadId) => childrenByParentId.has(threadId)));
      return next.size === current.size ? current : next;
    });
  }, [childrenByParentId, delegateChildrenLoaded, setExpandedChildParentIds]);
  const toggleChildExpansion = useCallback(
    (parentThreadId: string) => {
      setExpandedChildParentIds((current) => {
        const next = new Set(current);
        if (next.has(parentThreadId)) next.delete(parentThreadId);
        else next.add(parentThreadId);
        return next;
      });
    },
    [setExpandedChildParentIds],
  );
  return { expandedChildParentIds, setExpandedChildParentIds, toggleChildExpansion };
}
