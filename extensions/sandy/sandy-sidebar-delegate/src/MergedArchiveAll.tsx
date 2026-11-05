import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { useBulkArchive } from "./useBulkArchive";

export function MergedArchiveAll({ threads }: { threads: readonly PluginSidebarThread[] }) {
  const archiveAll = useBulkArchive();
  return (
    <button
      type="button"
      aria-label={`Archive all ${threads.length} merged threads`}
      title="Archive all"
      onClick={(event) => {
        event.stopPropagation();
        void archiveAll(threads);
      }}
      className="flex size-4 items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted-foreground/40 shadow-none transition-colors duration-150 hover:bg-sidebar-accent hover:text-muted-foreground hover:duration-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name="Archive" className="size-3" />
    </button>
  );
}
