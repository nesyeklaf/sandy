// The bundled GitHub PR Status plugin owns pull request data for each
// environment's checked-out branch. Its `pullRequests` method is a keyed read:
// environment ids in, one row per id out. These are the fields the sidebar
// reads; `sandy plugin rpc inspect sandy--github-pr-status pullRequests` prints the
// full schema.

export const GITHUB_PR_STATUS_PLUGIN_ID = "sandy--github-pr-status";

/** `pullRequests` accepts at most this many environment ids per call. */
export const MAX_PULL_REQUEST_KEYS = 200;

export type PullRequestState = "draft" | "open" | "merged" | "closed";

export type PullRequestAttention =
  | "checks_failed"
  | "checks_pending"
  | "changes_requested"
  | "review_requested"
  | "conflicts"
  | "blocked"
  | "draft"
  | "queued"
  | "ready_to_merge"
  | "merged"
  | "closed"
  | "none";

export interface EnvironmentPullRequest {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  attention: PullRequestAttention;
  updatedAt: string;
}

/**
 * `unavailable` means the machine is offline or `gh` failed. It says nothing
 * about whether a PR exists, unlike `absent`.
 */
export type EnvironmentPullRequestRow =
  | { outcome: "available"; pullRequest: EnvironmentPullRequest }
  | { outcome: "absent" }
  | { outcome: "unavailable"; message: string };
