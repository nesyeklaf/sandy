// A thread is "In review" while its branch has an open, non-draft pull
// request: the author's turn is over and somebody has to look at the PR. The
// status is derived from GitHub PR Status, never set by hand, so it cannot rot.
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk";
import type { EnvironmentPullRequest } from "./github-pr-status";

export type PullRequestsByEnvironment = ReadonlyMap<string, EnvironmentPullRequest>;

function threadPullRequest(
  thread: Pick<PluginSidebarThread, "environment">,
  byEnvironment: PullRequestsByEnvironment,
): EnvironmentPullRequest | null {
  const environmentId = thread.environment?.id;
  return environmentId ? (byEnvironment.get(environmentId) ?? null) : null;
}

export function isInReview(
  thread: Pick<PluginSidebarThread, "environment">,
  byEnvironment: PullRequestsByEnvironment,
): boolean {
  return threadPullRequest(thread, byEnvironment)?.state === "open";
}
