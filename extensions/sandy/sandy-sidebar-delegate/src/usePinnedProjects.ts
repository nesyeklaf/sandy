import { useCallback, useEffect } from "react";
import type { useSidebarThreads } from "./sandy-sdk";
import { reconcileProjectScope } from "./inbox";
import { pinnedProjectsCodec } from "./lib/inbox-preference-codecs";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { usePersistedPreference } from "./lib/use-persisted-preference";

export function usePinnedProjects({
  projects,
  status,
}: Pick<ReturnType<typeof useSidebarThreads>, "projects" | "status">) {
  const [pinnedProjects, setPinnedProjects] = usePersistedPreference(
    STORAGE_KEYS.pinnedProjects.key,
    pinnedProjectsCodec,
  );
  useEffect(() => {
    if (status === "ready") setPinnedProjects((current) => reconcileProjectScope(current, projects));
  }, [projects, status, setPinnedProjects]);
  const toggleProjectPin = useCallback(
    (projectId: string) =>
      setPinnedProjects((current) =>
        current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId],
      ),
    [setPinnedProjects],
  );
  return { pinnedProjects, toggleProjectPin };
}
