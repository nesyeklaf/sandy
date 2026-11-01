import type { ServerContext, ServerHandlers } from "./server-context";
import type { createServerProjectIcons } from "./server-project-icons";
import { PROJECT_ICONS_CHANNEL, PROJECT_COLORS_CHANNEL } from "./contract";

export function createServerProjectManagement(ctx: ServerContext, icons: ReturnType<typeof createServerProjectIcons>) {
  const { defaultProjectHostIds, clearProjectIconCache } = icons;

  const handlers = {
    async listProjects() {
      const projects = await ctx.sandy.sdk.projects.list();
      return {
        projects: projects
          .filter((project) => project.kind === "standard")
          .map((project) => ({ id: project.id, name: project.name })),
      };
    },
    async renameProject({ projectId, name }) {
      const project = await ctx.sandy.sdk.projects.get({ projectId });
      if (project.kind !== "standard") throw new Error("Personal projects cannot be renamed");
      await ctx.sandy.sdk.projects.update({ projectId, name });
      ctx.sandy.realtime.publish(PROJECT_ICONS_CHANNEL, { projectId });
      return { ok: true as const };
    },
    async projectPathHosts({ projectId }) {
      const project = await ctx.sandy.sdk.projects.get({ projectId });
      if (project.kind !== "standard") return { hosts: [] };
      const hosts = await ctx.sandy.sdk.hosts.list();
      return {
        hosts: hosts
          .filter((host) => host.status === "connected" && !project.sources.some((source) => source.hostId === host.id))
          .map(({ id, name }) => ({ id, name })),
      };
    },
    async addProjectPath({ projectId, hostId, path }) {
      const project = await ctx.sandy.sdk.projects.get({ projectId });
      if (project.kind !== "standard") throw new Error("Personal projects cannot have local paths added");
      if (project.sources.some((source) => source.hostId === hostId)) {
        throw new Error("This project already has a path on that machine");
      }
      await ctx.sandy.sdk.projects.sources.add({ projectId, hostId, path, type: "local_path" });
      defaultProjectHostIds.delete(projectId);
      ctx.sandy.realtime.publish(PROJECT_ICONS_CHANNEL, { projectId });
      return { ok: true as const };
    },
    async removeProject({ projectId, confirmation }) {
      const project = await ctx.sandy.sdk.projects.get({ projectId });
      if (project.kind !== "standard") {
        throw new Error("Personal projects cannot be removed");
      }
      if (confirmation !== project.name) {
        throw new Error("Enter the project name exactly as shown");
      }
      await ctx.sandy.sdk.projects.delete({ projectId });
      ctx.db.transaction(() => {
        ctx.db.prepare("DELETE FROM project_colors WHERE project_id = ?").run(projectId);
        ctx.db.prepare(`DELETE FROM project_icons WHERE project_id = ?`).run(projectId);
        ctx.db.prepare(`DELETE FROM project_icon_uploads WHERE project_id = ?`).run(projectId);
      })();
      defaultProjectHostIds.delete(projectId);
      clearProjectIconCache(projectId);
      ctx.sandy.realtime.publish(PROJECT_ICONS_CHANNEL, { projectId });
      ctx.sandy.realtime.publish(PROJECT_COLORS_CHANNEL, { projectId });
      return { ok: true as const };
    },
  } satisfies Pick<
    ServerHandlers,
    "listProjects" | "renameProject" | "projectPathHosts" | "addProjectPath" | "removeProject"
  >;

  return { handlers };
}
