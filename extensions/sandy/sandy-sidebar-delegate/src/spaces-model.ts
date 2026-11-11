import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk";

export const DORMANT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type SpaceLifecycle = "active" | "parked" | "snoozed" | "settled";
export type SpacePrState = "open" | "merged" | "none" | "unknown";

export const SPACE_SIGNALS = ["needs", "failed", "working", "openPr", "dormant"] as const;
export type SpaceSignal = (typeof SPACE_SIGNALS)[number];

export const SPACE_SHELVES = [
  "needs",
  "failed",
  "working",
  "review",
  "merged",
  "orchestrators",
  "ideas",
  "dormant",
  "ready",
  "snoozed",
  "archived",
] as const;
export type SpaceShelf = (typeof SPACE_SHELVES)[number];

export type SpaceThread = Pick<
  PluginSidebarThread,
  "id" | "parentThreadId" | "projectId" | "sectionId" | "isArchived" | "isHidden"
>;

export interface SpaceThreadFacts {
  lifecycle: SpaceLifecycle;
  asks: boolean;
  failed: boolean;
  working: boolean;
  pr: SpacePrState;
  idea: boolean;
  orchestrator: boolean;
  activityAt: number;
}

export interface SpaceRoot {
  rootId: string;
  projectId: string;
  shelf: SpaceShelf;
  signals: Readonly<Record<SpaceSignal, boolean>>;
}

export interface SpaceView {
  id: string | null;
  name: string;
  total: number;
  counts: Readonly<Record<SpaceSignal, number>>;
  ready: number;
  repositories: number;
  roots: SpaceRoot[];
}

interface SpaceSectionInput {
  id: string;
  name: string;
}

interface BuildSpacesInput<T extends SpaceThread> {
  threads: readonly T[];
  sections: readonly SpaceSectionInput[];
  facts: (thread: T) => SpaceThreadFacts;
  matches?: (thread: T) => boolean;
  includeArchived?: boolean;
  now: number;
  unassignedName: string;
}

interface TreeRollup {
  asks: boolean;
  failed: boolean;
  working: boolean;
  activityAt: number;
}

function eligible(thread: SpaceThread, includeArchived: boolean): boolean {
  return !thread.isHidden && (includeArchived || !thread.isArchived);
}

function childIndex<T extends SpaceThread>(threads: readonly T[]): Map<string, T[]> {
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    if (thread.parentThreadId === null || thread.isArchived) continue;
    const siblings = children.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else children.set(thread.parentThreadId, [thread]);
  }
  return children;
}

function representativeRoots<T extends SpaceThread>(
  threads: readonly T[],
  present: ReadonlySet<string>,
  children: ReadonlyMap<string, readonly T[]>,
): T[] {
  const roots = threads.filter(
    (thread) => present.has(thread.id) && (thread.parentThreadId === null || !present.has(thread.parentThreadId)),
  );
  const reached = new Set<string>();
  const visit = (root: T) => {
    const pending = [root];
    while (pending.length > 0) {
      const thread = pending.pop()!;
      if (reached.has(thread.id)) continue;
      reached.add(thread.id);
      pending.push(...(children.get(thread.id) ?? []));
    }
  };
  for (const root of roots) visit(root);
  const chosen = new Set(roots);
  for (const thread of threads) {
    if (!present.has(thread.id) || reached.has(thread.id)) continue;
    chosen.add(thread);
    visit(thread);
  }
  return threads.filter((thread) => chosen.has(thread));
}

function rollUp<T extends SpaceThread>(
  root: T,
  children: ReadonlyMap<string, readonly T[]>,
  facts: (thread: T) => SpaceThreadFacts,
): TreeRollup {
  const own = facts(root);
  const rollup: TreeRollup = {
    asks: own.asks,
    failed: own.failed,
    working: own.working,
    activityAt: own.activityAt,
  };
  const visited = new Set<string>([root.id]);
  const pending = [...(children.get(root.id) ?? [])];
  while (pending.length > 0) {
    const thread = pending.pop()!;
    if (visited.has(thread.id)) continue;
    visited.add(thread.id);
    const descendant = facts(thread);
    rollup.asks ||= descendant.asks;
    rollup.failed ||= descendant.failed;
    rollup.working ||= descendant.working;
    rollup.activityAt = Math.max(rollup.activityAt, descendant.activityAt);
    pending.push(...(children.get(thread.id) ?? []));
  }
  return rollup;
}

function classify(
  own: SpaceThreadFacts,
  rollup: TreeRollup,
  now: number,
  archived: boolean,
): { shelf: SpaceShelf; dormant: boolean } {
  if (archived) return { shelf: "archived", dormant: false };
  if (own.lifecycle === "snoozed" || own.lifecycle === "parked") return { shelf: "snoozed", dormant: false };
  if (own.lifecycle === "settled") return { shelf: "archived", dormant: false };
  if (rollup.asks) return { shelf: "needs", dormant: false };
  if (rollup.failed) return { shelf: "failed", dormant: false };
  if (rollup.working) return { shelf: "working", dormant: false };
  if (own.pr === "open") return { shelf: "review", dormant: false };
  if (own.pr === "merged") return { shelf: "merged", dormant: false };
  if (own.orchestrator) return { shelf: "orchestrators", dormant: false };
  if (own.idea) return { shelf: "ideas", dormant: false };
  const dormant = own.pr === "none" && now - rollup.activityAt >= DORMANT_AFTER_MS;
  return { shelf: dormant ? "dormant" : "ready", dormant };
}

function emptyCounts(): Record<SpaceSignal, number> {
  return { needs: 0, failed: 0, working: 0, openPr: 0, dormant: 0 };
}

export function buildSpaces<T extends SpaceThread>({
  threads,
  sections,
  facts,
  matches = () => true,
  includeArchived = false,
  now,
  unassignedName,
}: BuildSpacesInput<T>): SpaceView[] {
  const present = new Set(
    threads.filter((thread) => eligible(thread, includeArchived) && matches(thread)).map((thread) => thread.id),
  );
  const children = childIndex(threads);
  const sectionIds = new Set(sections.map((section) => section.id));
  const roots = representativeRoots(threads, present, children);

  type OpenSpace = Omit<SpaceView, "counts"> & { counts: Record<SpaceSignal, number>; projects: Set<string> };
  const spaces = new Map<string | null, OpenSpace>();
  const open = (id: string | null, name: string) => {
    const space: OpenSpace = {
      id,
      name,
      total: 0,
      counts: emptyCounts(),
      ready: 0,
      repositories: 0,
      roots: [] as SpaceRoot[],
      projects: new Set<string>(),
    };
    spaces.set(id, space);
    return space;
  };
  for (const section of sections) open(section.id, section.name);

  for (const root of roots) {
    const key = root.sectionId !== null && sectionIds.has(root.sectionId) ? root.sectionId : null;
    const space = spaces.get(key) ?? open(null, unassignedName);
    const own = facts(root);
    const rollup = rollUp(root, children, facts);
    const { shelf, dormant } = classify(own, rollup, now, root.isArchived);
    const lifecycleRoot = shelf === "snoozed" || shelf === "archived";
    const signals: Record<SpaceSignal, boolean> = {
      needs: !lifecycleRoot && rollup.asks,
      failed: !lifecycleRoot && rollup.failed,
      working: !lifecycleRoot && rollup.working,
      openPr: !lifecycleRoot && own.pr === "open",
      dormant,
    };
    space.total += 1;
    space.projects.add(root.projectId);
    if (shelf === "ready") space.ready += 1;
    for (const signal of SPACE_SIGNALS) if (signals[signal]) space.counts[signal] += 1;
    space.roots.push({ rootId: root.id, projectId: root.projectId, shelf, signals });
  }

  const unassigned = spaces.get(null);
  const named = sections.map((section) => spaces.get(section.id)!);
  const ordered = unassigned && unassigned.total > 0 ? [...named, unassigned] : named;
  return ordered.map(({ projects, ...space }) => ({ ...space, repositories: projects.size }));
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : null;
}

export function spacePrOfRow(row: unknown): SpacePrState {
  const fields = recordOf(row);
  if (fields?.outcome === "absent") return "none";
  if (fields?.outcome !== "available") return "unknown";
  const state = recordOf(fields.pullRequest)?.state;
  return state === "open" ? "open" : state === "merged" ? "merged" : "unknown";
}
