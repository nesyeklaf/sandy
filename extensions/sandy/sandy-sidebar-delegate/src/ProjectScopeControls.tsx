import type { useSidebarThreads } from "./sandy-sdk";
import { useInboxActions, useInboxEnvironment } from "./InboxContext";
import { ProjectScopeSelect } from "./ProjectScopeSelect";
import { ProjectFavicon } from "./ProjectFavicon";
import { projectIconUrl } from "./project-icons";
import { usePinnedProjects } from "./usePinnedProjects";
import { cn } from "./lib/utils";

export function ProjectScopeControls({
  scope,
  status,
}: {
  scope: readonly string[];
  status: ReturnType<typeof useSidebarThreads>["status"];
}) {
  const { projects, projectIconRevision } = useInboxEnvironment();
  const { setScope } = useInboxActions();
  const { pinnedProjects, toggleProjectPin } = usePinnedProjects({ projects, status });
  const shortcuts = pinnedProjects.flatMap((id) => {
    const project = projects.find((project) => project.id === id);
    return project ? [project] : [];
  });
  return (
    <div className="shrink-0 px-2 pb-1">
      <ProjectScopeSelect
        scope={scope}
        projects={projects}
        projectIconRevision={projectIconRevision}
        onScopeChange={setScope}
        pinnedProjects={pinnedProjects}
        onToggleProjectPin={toggleProjectPin}
      />
      {shortcuts.length > 0 ? (
        <div role="group" aria-label="Pinned repos" className="flex flex-wrap gap-1 pt-1">
          {shortcuts.map((project) => {
            const active = scope.includes(project.id);
            return (
              <button
                key={project.id}
                type="button"
                aria-label={`Filter by ${project.name}`}
                aria-pressed={active}
                title={`${active ? "Remove" : "Add"} ${project.name} ${active ? "from" : "to"} repo filter`}
                onClick={() =>
                  setScope((current) =>
                    current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id],
                  )
                }
                className={cn(
                  "flex min-h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs outline-none hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring",
                  active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground",
                )}
              >
                <ProjectFavicon
                  src={projectIconUrl(project.id, projectIconRevision)}
                  name={project.name}
                  className="size-3"
                />
                <span className="truncate">{project.name}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
