import { useEnvironmentDiffStat, useEnvironmentPullRequest } from "./sandy-sdk";
import type { PullRequestChecksState } from "./github-pr-status";
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
const CHECKS_MARK: Partial<Record<PullRequestChecksState, { mark: string; label: string; tone: string }>> = {
  passing: { mark: "✓", label: "Checks passed", tone: "text-[color:var(--sandy-sidebar-tone-success)]" },
  failing: { mark: "✕", label: "Checks failed", tone: "text-[color:var(--sandy-sidebar-tone-error)]" },
  pending: { mark: "●", label: "Checks running", tone: "text-[color:var(--sandy-sidebar-tone-working)]" },
};

function ChecksMark({ state }: { state: PullRequestChecksState | undefined }) {
  const checks = state ? CHECKS_MARK[state] : undefined;
  if (!checks) return null;
  return (
    <span role="img" aria-label={checks.label} className={cn("ml-0.5 leading-none", checks.tone)}>
      {checks.mark}
    </span>
  );
}

export function ThreadDiffStat({ environmentId }: { environmentId: string | null }) {
  const stat = useEnvironmentDiffStat(environmentId);
  if (!stat) return null;
  return (
    <span
      aria-label={`${stat.insertions} lines added, ${stat.deletions} removed`}
      className="flex shrink-0 items-center gap-1 font-mono tabular-nums"
    >
      <span className="text-[color:var(--sandy-sidebar-tone-success)]">+{stat.insertions}</span>
      <span className="text-[color:var(--sandy-sidebar-tone-error)]">−{stat.deletions}</span>
    </span>
  );
}

export function ThreadPullRequest({ environmentId }: { environmentId: string | null }) {
  const pullRequest = useEnvironmentPullRequest(environmentId);
  if (!pullRequest) return null;
  const live = pullRequest.state === "open" || pullRequest.state === "draft";
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
        {live ? <ChecksMark state={pullRequest.checks?.state} /> : null}
      </a>
    </Tooltip>
  );
}
