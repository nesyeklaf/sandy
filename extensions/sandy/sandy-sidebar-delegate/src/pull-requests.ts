// Pull request helpers shared by the server, host entry, and hover card.
import type { ThreadPullRequest } from "./contract";

const PULL_REQUEST_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
// `gh pr create` run as a command: at the start, after a shell separator, or
// as the script of a `zsh -lc "..."` wrapper (how Codex records commands).
// Mentions inside quotes or prose, like a grep for the phrase, do not count.
const CREATE_COMMAND =
  /(?:^(?:[\w./-]*\/)?(?:ba|z)?sh\s+-[a-z]*c\s+["']|^|[\n;&|(])\s*(?:\w+=\S*\s+)*(?:[\w./-]*\/)?gh\s+pr\s+create\b/;

/**
 * PR URLs printed by `gh pr create` commands, in the order they appeared. A
 * failed create that reports "a pull request already exists" names the
 * thread's PR too, so the command status is not checked.
 */
export function createdPullRequestUrls(events: readonly { type: string; data: unknown }[]): string[] {
  const urls = new Set<string>();
  for (const event of events) {
    if (event.type !== "item/completed") continue;
    const item = (event.data as { item?: unknown } | null)?.item as
      | { type?: unknown; command?: unknown; aggregatedOutput?: unknown }
      | undefined;
    if (item?.type !== "commandExecution") continue;
    if (typeof item.command !== "string" || !CREATE_COMMAND.test(item.command)) continue;
    if (typeof item.aggregatedOutput !== "string") continue;
    for (const [url] of item.aggregatedOutput.matchAll(PULL_REQUEST_URL)) urls.add(url);
  }
  return [...urls];
}

export function pullRequestNumber(url: string): number {
  return Number(url.slice(url.lastIndexOf("/") + 1));
}

/** Parses `gh pr view --json number,title,state,isDraft,url`. */
export function parseGhPullRequest(output: string): ThreadPullRequest | null {
  try {
    const value = JSON.parse(output) as {
      number?: unknown;
      title?: unknown;
      state?: unknown;
      isDraft?: unknown;
      url?: unknown;
    };
    if (typeof value.number !== "number" || typeof value.url !== "string") return null;
    const state =
      value.state === "MERGED"
        ? "merged"
        : value.state === "CLOSED"
          ? "closed"
          : value.state === "OPEN"
            ? value.isDraft === true
              ? "draft"
              : "open"
            : null;
    return {
      url: value.url,
      number: value.number,
      title: typeof value.title === "string" ? value.title : null,
      state,
    };
  } catch {
    return null;
  }
}
