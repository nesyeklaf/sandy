import { useCallback, type ReactNode } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { Icon } from "./components/Icon";
import { ProjectFavicon } from "./ProjectFavicon";
import { projectIconUrl } from "./project-icons";
import { StatusGlyph } from "./StatusGlyph";
import { buildTree, worstIndicator, type TreeProjectInput, type TreeSectionInput } from "./tree-layout";
import { cn } from "./lib/utils";
import { STORAGE_KEYS } from "./lib/storage-keys";
import { projectCollapseCodec, type ListView } from "./lib/inbox-preference-codecs";
import { usePersistedPreference } from "./lib/use-persisted-preference";
import { useInboxEnvironment } from "./InboxContext";

const SEGMENTS: readonly { value: ListView; label: string }[] = [
  { value: "flow", label: "Flow" },
  { value: "tree", label: "Tree" },
];

/** Flow (shelves) or Tree (section, repo, session); remembered on this device. */
export function ListViewSegment({ view, onChange }: { view: ListView; onChange: (view: ListView) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="List layout"
      className="mx-1.5 mt-1 flex gap-px rounded-md bg-sidebar-accent/40 p-px"
    >
      {SEGMENTS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={view === value}
          onClick={() => onChange(value)}
          className={cn(
            "flex-1 rounded-[5px] px-2 py-0.5 text-2xs font-medium transition-colors",
            view === value ? "bg-sidebar text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TreeHeader({
  level,
  label,
  count,
  worst,
  expanded,
  onToggle,
  icon,
}: {
  level: "section" | "repo" | "bare";
  label: string;
  count: number;
  worst: PluginSidebarThread["indicator"];
  expanded: boolean;
  onToggle: () => void;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={`${label} (${count})`}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2.5 text-left hover:bg-sidebar-accent/50",
        level === "section" ? "mt-3 bg-sidebar-accent/40 py-1" : "mt-0.5 py-1 pl-4",
      )}
    >
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3 shrink-0 text-muted-foreground/60" />
      {icon}
      <span
        className={cn(
          "min-w-0 truncate text-2xs",
          level === "section" ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
          level === "bare" && "italic",
        )}
      >
        {label}
      </span>
      <span className="text-2xs tabular-nums text-muted-foreground/50">{count}</span>
      <span className="ml-auto flex shrink-0 items-center">
        {!expanded && worst !== "none" ? <StatusGlyph indicator={worst} label={null} /> : null}
      </span>
    </button>
  );
}

/**
 * Section (a sandy thread section, the user's "Projekt") -> repo (a sandy project)
 * -> session. Rows are the ordinary Flow rows; a repo header only appears for
 * sessions that have a repo, so repo-less sessions sit right under the section.
 */
export function ThreadTreeView({
  threads,
  sections,
  projects,
  renderThread,
}: {
  threads: readonly PluginSidebarThread[];
  sections: readonly TreeSectionInput[];
  projects: readonly TreeProjectInput[];
  renderThread: (thread: PluginSidebarThread) => ReactNode;
}) {
  const { projectIconRevision } = useInboxEnvironment();
  const [collapsed, setCollapsed] = usePersistedPreference(STORAGE_KEYS.treeCollapse.key, projectCollapseCodec);
  const toggle = useCallback(
    (key: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [setCollapsed],
  );
  const tree = buildTree({ threads, sections, projects });
  if (tree.length === 0) {
    return <p className="px-2 py-6 text-center text-xs text-muted-foreground">No sessions yet.</p>;
  }
  return (
    <div className="flex flex-col">
      {tree.map((section) => {
        const open = !collapsed.has(section.key);
        return (
          <section key={section.key} aria-label={section.name}>
            <TreeHeader
              level="section"
              label={section.name}
              count={section.count}
              worst={section.worst}
              expanded={open}
              onToggle={() => toggle(section.key)}
            />
            {open ? (
              <ul className="ml-3.5 flex flex-col gap-px border-l border-sidebar-border/70">
                {section.repos.map((repo) => {
                  const repoOpen = !collapsed.has(repo.key);
                  return (
                    <li key={repo.key} className="list-none">
                      <TreeHeader
                        level="repo"
                        label={repo.name}
                        count={repo.threads.length}
                        worst={repo.worst}
                        expanded={repoOpen}
                        onToggle={() => toggle(repo.key)}
                        icon={
                          <ProjectFavicon
                            projectId={repo.projectId}
                            src={projectIconUrl(repo.projectId, projectIconRevision)}
                            name={repo.name}
                            className="size-3"
                          />
                        }
                      />
                      {repoOpen ? (
                        <ul className="ml-3.5 flex flex-col gap-px border-l border-sidebar-border/70">
                          {repo.threads.map((thread) => renderThread(thread))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
                {section.loose.length > 0 ? (
                  <li className="list-none">
                    <TreeHeader
                      level="bare"
                      label="No repo"
                      count={section.loose.length}
                      worst={worstIndicator(section.loose)}
                      expanded={!collapsed.has(`${section.key}/none`)}
                      onToggle={() => toggle(`${section.key}/none`)}
                    />
                    {!collapsed.has(`${section.key}/none`) ? (
                      <ul className="ml-3.5 flex flex-col gap-px border-l border-sidebar-border/70">
                        {section.loose.map((thread) => renderThread(thread))}
                      </ul>
                    ) : null}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
