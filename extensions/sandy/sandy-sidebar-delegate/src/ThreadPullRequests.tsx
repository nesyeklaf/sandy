import { useEnvironmentPullRequest } from "./sandy-sdk";
import { useEffect, useId, useState } from "react";
import { UrlLink, useRpc, type PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract, ThreadPullRequest } from "./contract";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import { mergeThreadPullRequests, pullRequestStatusLabel, pullRequestToneClass } from "./pull-request-display";

/**
 * Every PR the thread opened, for the hover card. The row badge can only show
 * the PR on the current branch; this also lists the ones from earlier branches.
 * Mount it only while the card is open: the history costs an event-log scan.
 */
export function ThreadPullRequestDetails({ thread }: { thread: PluginSidebarThread }) {
  const pullRequest = useEnvironmentPullRequest(thread.environment?.id ?? null);
  const { call } = useRpc<typeof sandySidebarRpcContract>();
  const [history, setHistory] = useState<readonly ThreadPullRequest[]>([]);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    void call("getThreadPullRequests", { threadId: thread.id }).then(
      ({ pullRequests }) => {
        if (!cancelled) setHistory(pullRequests);
      },
      () => {
        /* The live branch PR still shows. */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [call, thread.id]);

  const ownsWorkspace =
    thread.environment?.workspaceDisplayKind === "managed-worktree" ||
    thread.environment?.workspaceDisplayKind === "unmanaged-worktree";
  const pullRequests = mergeThreadPullRequests(pullRequest, history, ownsWorkspace);
  if (!pullRequests.length) return null;
  const scrolls = pullRequests.length > 4;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-xs font-normal leading-4 text-muted-foreground">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
        className="pointer-events-auto flex items-center gap-2 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="GitPullRequest" className="size-3.5 shrink-0" aria-hidden />
        <span>Pull requests ({pullRequests.length})</span>
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="ml-auto size-3 shrink-0" aria-hidden />
      </button>
      {expanded ? (
        <ul
          id={listId}
          aria-label="Pull requests"
          tabIndex={scrolls ? 0 : undefined}
          className={
            scrolls
              ? "pointer-events-auto flex max-h-[min(12rem,30dvh)] flex-col gap-1.5 overflow-y-auto rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              : "flex flex-col gap-1.5"
          }
        >
          {pullRequests.map((entry) => (
            <li key={entry.url} className="min-w-0 pl-5">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <UrlLink
                  href={entry.url}
                  aria-label={`Open pull request #${entry.number}`}
                  onClick={(event) => event.stopPropagation()}
                  className={cn(
                    "pointer-events-auto shrink-0 rounded-sm font-mono hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    pullRequestToneClass(entry),
                  )}
                >
                  #{entry.number}
                </UrlLink>
                {entry.title ? (
                  <span className="truncate" title={entry.title}>
                    {entry.title}
                  </span>
                ) : null}
              </div>
              <div className="text-[11px] leading-4">{pullRequestStatusLabel(entry)}</div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
