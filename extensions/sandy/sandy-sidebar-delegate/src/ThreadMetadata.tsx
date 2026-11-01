import { useEnvironmentPullRequest } from "./sandy-sdk";
import { Tooltip } from "./components/Tooltip";
import { cn } from "./lib/utils";
import { pullRequestStatusLabel, pullRequestToneClass } from "./pull-request-display";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { Icon } from "./components/Icon";

export function ThreadLocation({ thread }: { thread: PluginSidebarThread }) {
  const branchName = thread.environment?.branchName;
  if (branchName) {
    const isWorktree =
      thread.environment?.workspaceDisplayKind === "managed-worktree" ||
      thread.environment?.workspaceDisplayKind === "unmanaged-worktree";
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
        <Icon
          name={isWorktree ? "FolderGit" : "GitBranch"}
          aria-label={isWorktree ? "Worktree branch" : "Branch"}
          className="size-3 shrink-0 text-muted-foreground/60"
        />
        <span className="truncate font-mono">{branchName}</span>
      </span>
    );
  }
  if (thread.host) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
        <Icon name="Computer" aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="truncate">{thread.host.name}</span>
      </span>
    );
  }
  return <span className="flex-1" />;
}
export function ThreadPullRequest({ environmentId }: { environmentId: string | null }) {
  const pullRequest = useEnvironmentPullRequest(environmentId);
  if (!pullRequest) return null;
  return (
    <Tooltip label={`${pullRequest.title}\n${pullRequestStatusLabel(pullRequest)}`} className="whitespace-pre-line">
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        className={cn(
          "pointer-events-auto relative shrink-0 font-mono hover:underline",
          pullRequestToneClass(pullRequest),
        )}
      >
        #{pullRequest.number}
      </a>
    </Tooltip>
  );
}
