import {
  type DeleteSkillRequest,
  type SkillContentResponse,
  type SkillFilesResponse,
  type SkillListResponse,
} from "@sandy/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface SkillWorkspaceArgs {
  projectId: string;
  environmentId: string | null;
}

export interface SkillListArgs extends SkillWorkspaceArgs {
  signal?: AbortSignal;
}

export interface SkillIdentityArgs extends SkillListArgs {
  skillId: string;
}

export interface SkillContentArgs extends SkillIdentityArgs {
  path: string;
}

export interface SkillUpdateArgs extends SkillWorkspaceArgs {
  skillId: string;
  content: string;
  revision: string;
}

export interface SkillDeleteArgs extends SkillWorkspaceArgs {
  skillId: string;
}

export interface SkillsArea {
  getContent(args: SkillContentArgs): Promise<SkillContentResponse>;
  list(args: SkillListArgs): Promise<SkillListResponse>;
  listFiles(args: SkillIdentityArgs): Promise<SkillFilesResponse>;
  remove(args: SkillDeleteArgs): Promise<{ deletedPath: string }>;
  update(
    args: SkillUpdateArgs,
  ): Promise<{ filePath: string; revision: string }>;
}

export function createSkillsArea(args: CreateSdkAreaArgs): SkillsArea {
  const { transport } = args;

  return {
    async getContent(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.content.$get(
          {
            param: { id: input.projectId },
            query: {
              skillId: input.skillId,
              path: input.path,
              environmentId: input.environmentId ?? "",
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async list(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.$get(
          {
            param: { id: input.projectId },
            query: { environmentId: input.environmentId ?? "" },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async listFiles(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.files.$get(
          {
            param: { id: input.projectId },
            query: {
              skillId: input.skillId,
              environmentId: input.environmentId ?? "",
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async remove(input) {
      const body: DeleteSkillRequest = {
        skillId: input.skillId,
        environmentId: input.environmentId,
      };
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.$delete({
          param: { id: input.projectId },
          json: body,
        }),
      );
    },
    async update(input) {
      return transport.readJson(
        transport.api.v1.projects[":id"].skills.content.$patch({
          param: { id: input.projectId },
          json: {
            skillId: input.skillId,
            environmentId: input.environmentId,
            content: input.content,
            revision: input.revision,
          },
        }),
      );
    },
  };
}
