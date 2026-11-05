import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { ChildThreadBadge } from "./ChildThreadList";
import { Icon } from "./components/Icon";
import { useInboxEnvironment } from "./InboxContext";
import { cn } from "./lib/utils";
import { OpenPortsIndicator } from "./OpenPorts";
import { useProjectColor } from "./ProjectColors";
import { ProviderGlyph } from "./ProviderGlyph";
import { RowLastMessage } from "./RowLastMessage";
import { ActivityCount } from "./ThreadCardParts";
import { ThreadDiffStat, ThreadLocation, ThreadPullRequest } from "./ThreadMetadata";

export function RowMetaLine({
  thread,
  twoLine,
  showProject,
  projectIconOnly,
  showEnvironment,
  childThreads,
  childrenExpanded,
  childListId,
  onToggleChildren,
  isVisible,
}: {
  thread: PluginSidebarThread;
  twoLine: boolean;
  showProject: boolean;
  projectIconOnly: boolean;
  showEnvironment: boolean;
  childThreads: readonly PluginSidebarThread[];
  childrenExpanded: boolean;
  childListId: string;
  onToggleChildren: () => void;
  isVisible: boolean;
}) {
  const {
    providerById,
    projectNameById,
    childrenByParentId: childrenByParent,
    rowFields: fields,
  } = useInboxEnvironment();
  const provider = providerById.get(thread.providerId) ?? null;
  const projectName = projectNameById.get(thread.projectId) ?? null;
  const projectColor = useProjectColor(thread.projectId);
  return (
    <>
      <div
        data-settle-fade=""
        className={cn(
          "pointer-events-none relative flex items-center gap-1.5 text-2xs text-muted-foreground",
          showEnvironment ? "mt-0.5 h-4" : "h-5",
        )}
      >
        {twoLine && showProject && projectName ? (
          <>
            <span
              style={projectColor}
              className={cn(
                "min-w-0 max-w-[40%] shrink truncate font-medium",
                projectIconOnly && "sr-only",
                projectColor && "sandy-sidebar-project-name",
              )}
            >
              {projectName}
            </span>
            {!projectIconOnly && showEnvironment ? (
              <span aria-hidden="true" className="shrink-0 text-muted-foreground/60">
                ·
              </span>
            ) : null}
          </>
        ) : null}
        {showEnvironment ? <ThreadLocation thread={thread} /> : null}
        <OpenPortsIndicator thread={thread} />
        {fields.subagents && childThreads.length > 0 ? (
          <ChildThreadBadge
            threads={childThreads}
            childrenByParent={childrenByParent}
            expanded={childrenExpanded}
            controls={childListId}
            onToggle={onToggleChildren}
          />
        ) : null}
        {fields.host && thread.environment?.branchName && thread.host ? (
          <Icon
            name="Computer"
            aria-label={`Machine: ${thread.host.name}`}
            className="size-3 shrink-0 text-muted-foreground/60"
          />
        ) : null}
        {thread.activity.workflows > 0 ? <ActivityCount label="workflows" count={thread.activity.workflows} /> : null}
        {thread.activity.backgroundAgents > 0 ? (
          <ActivityCount label="background agents" count={thread.activity.backgroundAgents} />
        ) : null}
        {fields.diff && isVisible ? <ThreadDiffStat environmentId={thread.environment?.id ?? null} /> : null}
        {fields.pr && isVisible ? <ThreadPullRequest environmentId={thread.environment?.id ?? null} /> : null}
        {fields.provider ? <ProviderGlyph providerId={thread.providerId} provider={provider} /> : null}
      </div>
      {fields.lastMessage ? <RowLastMessage threadId={thread.id} /> : null}
    </>
  );
}
