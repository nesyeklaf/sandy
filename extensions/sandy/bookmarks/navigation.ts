interface RouterHistoryState {
  usr: unknown;
  key: string;
  idx: number;
}

function isRouterHistoryState(value: unknown): value is RouterHistoryState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { idx?: unknown }).idx === "number"
  );
}

/** The app path of a thread that is not in the sidebar's live list. */
export function threadPath(
  threadId: string,
  projectId: string,
  isPersonalProject: boolean,
): string {
  const thread = encodeURIComponent(threadId);
  return isPersonalProject
    ? `/threads/${thread}`
    : `/projects/${encodeURIComponent(projectId)}/threads/${thread}`;
}

/**
 * Open `href` with the timeline scrolled to the message at `seq`.
 *
 * SANDY's thread search opens a hit by navigating with `searchMessageSeq` in the
 * router state; the timeline then pages back to that sequence, scrolls it into
 * view, and flashes it. `useSandyNavigate().toThread` cannot carry state, so this
 * pushes the history entry the router itself would push and replays it.
 * Returns false when the history is not the router's, so the caller can fall
 * back to `toThread`.
 */
export function openMessage(href: string, threadId: string, seq: number): boolean {
  const current: unknown = window.history.state;
  if (!isRouterHistoryState(current)) return false;
  window.history.pushState(
    {
      usr: { searchMessageSeq: seq, searchThreadId: threadId },
      key: Math.random().toString(36).slice(2, 10),
      idx: current.idx + 1,
    },
    "",
    href,
  );
  window.dispatchEvent(
    new PopStateEvent("popstate", { state: window.history.state }),
  );
  return true;
}
