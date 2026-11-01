import type { PluginSidebarThread, PluginSidebarThreadIndicator } from "@sandy-sdk/plugin-sdk";

/**
 * The Tree view: Section (the user's "Projekt") -> Repo (a sandy project) -> Session.
 * A session belongs to at most one section through `sectionId`; the repo is an
 * attribute of the session. Sessions of the personal repo have no repo level
 * and hang directly under their section.
 */

export const NO_SECTION_KEY = "none";

export interface TreeSectionInput {
  id: string;
  name: string;
}

export interface TreeProjectInput {
  id: string;
  name: string;
  isPersonal: boolean;
}

interface TreeRepo {
  key: string;
  projectId: string;
  name: string;
  threads: PluginSidebarThread[];
  worst: PluginSidebarThreadIndicator;
}

interface TreeSection {
  /** "none" for the catch-all, else the sandy section id. */
  key: string;
  sectionId: string | null;
  name: string;
  /** Sessions without a repo, shown directly under the section. */
  loose: PluginSidebarThread[];
  repos: TreeRepo[];
  count: number;
  worst: PluginSidebarThreadIndicator;
}

// Most urgent first; an indicator sandy adds later ranks below all of these.
const URGENCY: readonly PluginSidebarThreadIndicator[] = [
  "queued-failed",
  "unread-error",
  "waiting-for-input",
  "queued-waiting",
  "runtime",
  "workflow",
  "background-agent",
  "background-command",
  "unread-success",
];

function urgency(indicator: PluginSidebarThreadIndicator): number {
  const index = URGENCY.indexOf(indicator);
  return index === -1 ? URGENCY.length : index;
}

export function worstIndicator(threads: readonly PluginSidebarThread[]): PluginSidebarThreadIndicator {
  let worst: PluginSidebarThreadIndicator = "none";
  for (const thread of threads) {
    if (urgency(thread.indicator) < urgency(worst)) worst = thread.indicator;
  }
  return worst;
}

interface BuildTreeInput {
  threads: readonly PluginSidebarThread[];
  sections: readonly TreeSectionInput[];
  projects: readonly TreeProjectInput[];
  noSectionName?: string;
}

/**
 * Group threads into sections and repos. Sections keep the order sandy gives;
 * repos and sessions keep the order of `threads`. Child threads are left out
 * when their parent is in the list, because the parent's row shows them. A
 * section without sessions is dropped; threads whose section is unknown fall
 * into the catch-all, which comes last.
 */
export function buildTree({
  threads,
  sections,
  projects,
  noSectionName = "No project",
}: BuildTreeInput): TreeSection[] {
  const present = new Set(threads.map((thread) => thread.id));
  const roots = threads.filter((thread) => !thread.parentThreadId || !present.has(thread.parentThreadId));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const sectionName = new Map(sections.map((section) => [section.id, section.name]));

  const buckets = new Map<string, PluginSidebarThread[]>();
  for (const thread of roots) {
    const key = thread.sectionId && sectionName.has(thread.sectionId) ? thread.sectionId : NO_SECTION_KEY;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(thread);
    else buckets.set(key, [thread]);
  }

  const order = [...sections.map((section) => section.id), NO_SECTION_KEY];
  const result: TreeSection[] = [];
  for (const key of order) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const loose: PluginSidebarThread[] = [];
    const repoByProject = new Map<string, TreeRepo>();
    const repos: TreeRepo[] = [];
    for (const thread of bucket) {
      const project = projectById.get(thread.projectId);
      if (!project || project.isPersonal) {
        loose.push(thread);
        continue;
      }
      let repo = repoByProject.get(project.id);
      if (!repo) {
        repo = { key: `${key}/${project.id}`, projectId: project.id, name: project.name, threads: [], worst: "none" };
        repoByProject.set(project.id, repo);
        repos.push(repo);
      }
      repo.threads.push(thread);
    }
    for (const repo of repos) repo.worst = worstIndicator(repo.threads);
    result.push({
      key,
      sectionId: key === NO_SECTION_KEY ? null : key,
      name: key === NO_SECTION_KEY ? noSectionName : (sectionName.get(key) ?? key),
      loose,
      repos,
      count: bucket.length,
      worst: worstIndicator(bucket),
    });
  }
  return result;
}
