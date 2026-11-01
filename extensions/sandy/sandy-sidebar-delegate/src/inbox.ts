import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk";

export function reconcileProjectScope(scope: string[], projects: readonly { id: string }[]): string[] {
  const available = new Set(projects.map((project) => project.id));
  const remaining = scope.filter((id) => available.has(id));
  return remaining.length === scope.length ? scope : remaining;
}

/**
 * The sort that defines this sidebar: newest thread on top, and NOTHING moves
 * it afterwards. Activity never re-orders the list, so a row holds its place
 * from creation until you park it and the screen only changes when you act.
 * Status is carried by the card, not by position.
 *
 * Ties break on id so the order is total and stable across renders.
 */
export function sortByCreatedAtDescending<T extends { readonly id: string; readonly createdAt: number }>(
  threads: readonly T[],
): T[] {
  return [...threads].sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

/** Newest parked work first, falling back to sandy's last activity timestamp. */
export function sortSettledThreads<
  T extends {
    readonly id: string;
    readonly latestAttentionAt: number;
    readonly updatedAt: number;
  },
>(threads: readonly T[], settledAtFor: (thread: T) => number | null): T[] {
  return [...threads].sort((left, right) => {
    const leftAt = settledAtFor(left) ?? Math.max(left.latestAttentionAt, left.updatedAt);
    const rightAt = settledAtFor(right) ?? Math.max(right.latestAttentionAt, right.updatedAt);
    return rightAt - leftAt || left.id.localeCompare(right.id);
  });
}

/** The title as stored, for editing: mentions stay tokens so a rename keeps them. */
export function threadStoredTitle(thread: PluginSidebarThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  return fallback ? fallback : "Untitled thread";
}

/**
 * Whether sandy resolved mentions in the title. sandy's `displayTitle` is the title,
 * else the fallback, with every mention it knows (threads, projects, sections,
 * folders, files) resolved to a name, so for a named thread it differs from
 * the stored text only when something was resolved. This follows sandy's mention
 * syntax instead of copying it.
 */
export function threadTitleHasMentions(thread: PluginSidebarThread): boolean {
  if (!thread.title?.trim() && !thread.titleFallback?.trim()) return false;
  const resolved = thread.displayTitle?.trim();
  return !!resolved && resolved !== threadStoredTitle(thread);
}

/** The title as sandy shows it: mentions resolved to names, anything else exactly as stored. */
export function threadDisplayTitle(thread: PluginSidebarThread): string {
  return threadTitleHasMentions(thread) ? thread.displayTitle.trim() : threadStoredTitle(thread);
}

/**
 * Server-built messages quote stored titles, mention tokens and all, because
 * only the app has sandy's resolved names. Swap each mention title for its name.
 * Mention tokens make a stored title distinctive, and plain titles are left
 * alone, so nothing else in the text can match.
 */
export function resolveThreadTitlesIn(text: string, threads: readonly PluginSidebarThread[]): string {
  const titles = threads
    .filter(threadTitleHasMentions)
    .map((thread) => [threadStoredTitle(thread), threadDisplayTitle(thread)] as const)
    // A title that contains another is replaced first.
    .sort(([left], [right]) => right.length - left.length);
  return titles.reduce((resolved, [stored, display]) => resolved.split(stored).join(display), text);
}

/** Projects whose name matches the picker query; every project when blank. */
export function filterProjectsByName<T extends { name: string }>(projects: readonly T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...projects];
  return projects.filter((project) => project.name.toLowerCase().includes(normalized));
}

/** Threads in the chosen projects; an empty selection includes every project. */
export function filterByProjects(
  threads: readonly PluginSidebarThread[],
  projectIds: readonly string[],
): PluginSidebarThread[] {
  if (projectIds.length === 0) return [...threads];
  const selected = new Set(projectIds);
  return threads.filter((thread) => selected.has(thread.projectId));
}

/**
 * Archived threads never belong in the inbox, and neither do hidden ones: a
 * hidden thread (a delegate child or worker) is reachable only through its
 * parent's tree, as in sandy's own thread list.
 */
export function visibleInboxThreads(threads: readonly PluginSidebarThread[]): PluginSidebarThread[] {
  return threads.filter((thread) => !thread.isArchived && !thread.isHidden);
}

/** Pinned first (they are the user's own ordering), then the static sort. */
export function partitionPinned(threads: readonly PluginSidebarThread[]): {
  pinned: PluginSidebarThread[];
  inbox: PluginSidebarThread[];
} {
  const pinned: PluginSidebarThread[] = [];
  const inbox: PluginSidebarThread[] = [];
  for (const thread of threads) {
    (thread.isPinned ? pinned : inbox).push(thread);
  }
  return { pinned, inbox };
}

/**
 * Child threads leave the flat list and live in their parent's header chip
 * instead — a flat inbox has nowhere to nest them.
 *
 * A child is only hidden when its parent is actually on screen. An orphan
 * (parent archived, deleted, or filtered out by the project scope) stays in
 * the list, because hiding it would make it unreachable everywhere.
 */
export function hideChildrenOfVisibleParents(threads: readonly PluginSidebarThread[]): PluginSidebarThread[] {
  const visibleIds = new Set(threads.map((thread) => thread.id));
  return threads.filter((thread) => thread.parentThreadId === null || !visibleIds.has(thread.parentThreadId));
}

/**
 * The parent of one thread, or null when the thread is a root, when the id is
 * unknown, or when the parent row is gone (deleted). The parent may be
 * archived or in another project: the flat list hides those, but the child
 * still needs a way back to them.
 */
export function parentOf(threads: readonly PluginSidebarThread[], threadId: string): PluginSidebarThread | null {
  const thread = threads.find((candidate) => candidate.id === threadId);
  const parentThreadId = thread?.parentThreadId;
  if (!parentThreadId) return null;
  return threads.find((candidate) => candidate.id === parentThreadId) ?? null;
}
