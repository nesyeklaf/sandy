import { useEffect } from "react";
import type { useSidebarThreads } from "./sandy-sdk";
import { reconcileProjectScope } from "./inbox";
import { projectScopeCodec } from "./lib/inbox-preference-codecs";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { usePersistedPreference } from "./lib/use-persisted-preference";

export function useProjectScope({
  projects,
  status,
}: Pick<ReturnType<typeof useSidebarThreads>, "projects" | "status">) {
  const [scope, setScope] = usePersistedPreference(STORAGE_KEYS.projectScope.key, projectScopeCodec);
  useEffect(() => {
    // Loading and failed responses cannot tell us whether a saved project was removed.
    if (status === "ready") setScope((current) => reconcileProjectScope(current, projects));
  }, [projects, status, setScope]);
  return [scope, setScope] as const;
}
