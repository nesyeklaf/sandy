// A writer's target project, shared by sandy_delegate (project, baseBranch) and workflows-plus agent() options
// (writes, project, baseBranch): a writer whose origin is no git checkout on a branch, such as a personal
// thread, gets a managed worktree of a project instead. One rule for both: which project a ref names, when
// it cannot take a worktree, and on which host and base the worktree goes.

export type TargetProject = { id: string; name: string; kind: "personal" | "standard"; sourceHostIds: string[]; defaultHostId: string | null };

// The fields of SANDY's project listing the target needs.
export type ListedProject = {
  id: string;
  name: string;
  kind: "personal" | "standard";
  sources: readonly { hostId: string; isDefault: boolean }[];
};

export type TargetWorktree = {
  type: "host";
  // Absent: SANDY places the worktree on the project's default host.
  hostId?: string;
  workspace: { type: "managed-worktree"; baseBranch: { kind: "named"; name: string } | { kind: "default" } };
};

// The project with this id, else the one project with this name; null when none or several match.
export function findProject(projects: readonly ListedProject[], ref: string): TargetProject | null {
  const byName = projects.filter((project) => project.name === ref);
  const project = projects.find((entry) => entry.id === ref) ?? (byName.length === 1 ? byName[0] : undefined);
  if (project === undefined) return null;
  return {
    id: project.id,
    name: project.name,
    kind: project.kind,
    sourceHostIds: project.sources.map((source) => source.hostId),
    defaultHostId: project.sources.find((source) => source.isDefault)?.hostId ?? null,
  };
}

// Why the ref cannot take a writer's worktree, or null when it can.
export function targetProblem(ref: string, project: TargetProject | null): string | null {
  if (project === null) return `no project with id or name ${ref} (or several with that name; pass the id)`;
  if (project.kind === "personal") return `project ${project.name} is the personal project, which has no git checkout for a managed worktree`;
  if (project.sourceHostIds.length === 0) return `project ${project.name} has no source checkout on any host`;
  return null;
}

export const BASE_BRANCH_NEEDS_PROJECT = "baseBranch needs project: it names the base branch of the target project's worktree";

// The worktree: on the origin's host when the project has a checkout there (the origin's repos live on
// it), else on the project's default host; based on baseBranch, else the project's default branch.
export function targetWorktree(project: TargetProject, originHostId: string, baseBranch: string | undefined): TargetWorktree {
  const hostId = project.sourceHostIds.includes(originHostId) ? originHostId : (project.defaultHostId ?? undefined);
  return {
    type: "host",
    ...(hostId === undefined ? {} : { hostId }),
    workspace: { type: "managed-worktree", baseBranch: baseBranch === undefined ? { kind: "default" } : { kind: "named", name: baseBranch } },
  };
}
