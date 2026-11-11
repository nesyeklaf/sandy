import {
  skillWriteConflictDetailsSchema,
  type CreatableSkillScope,
  type DeleteSkillRequest,
  type SkillContentResponse,
  type SkillFilesResponse,
  type SkillListResponse,
  type SkillSelectionView,
} from "@sandy/server-contract";
import type { SkillSelection } from "@sandy/domain";
import { z } from "zod";
import { SandyHttpError } from "../response.js";
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
  path?: string;
  content: string;
  revision: string | null;
}

export interface SkillCreateArgs extends SkillWorkspaceArgs {
  scope: CreatableSkillScope;
  name: string;
  content: string;
}

export interface SkillDeleteArgs extends SkillWorkspaceArgs {
  skillId: string;
}

export interface SkillSelectionReadArgs {
  signal?: AbortSignal;
}

export type ExperimentalSkillWriteResult =
  | { outcome: "written"; filePath: string; revision: string }
  | { outcome: "conflict"; currentRevision: string | null };

const skillWriteConflictBodySchema = z.object({
  code: z.literal("conflict"),
  details: skillWriteConflictDetailsSchema,
});

function readSkillWriteConflict(
  error: unknown,
): { currentRevision: string | null } | null {
  if (!(error instanceof SandyHttpError) || error.status !== 409) {
    return null;
  }
  const parsed = skillWriteConflictBodySchema.safeParse(error.body);
  return parsed.success ? parsed.data.details : null;
}

export interface SkillsArea {
  experimental_create(
    args: SkillCreateArgs,
  ): Promise<ExperimentalSkillWriteResult>;
  experimental_read(args: SkillIdentityArgs): Promise<SkillContentResponse>;
  experimental_getSelection(
    args?: SkillSelectionReadArgs,
  ): Promise<SkillSelectionView>;
  experimental_setSelection(
    selection: SkillSelection,
  ): Promise<SkillSelectionView>;
  experimental_write(
    args: SkillUpdateArgs,
  ): Promise<ExperimentalSkillWriteResult>;
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

  const getContent = (
    input: SkillContentArgs,
  ): Promise<SkillContentResponse> =>
    transport.readJson(
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

  const patchContent = (
    input: SkillUpdateArgs,
  ): Promise<{ filePath: string; revision: string }> =>
    transport.readJson(
      transport.api.v1.projects[":id"].skills.content.$patch({
        param: { id: input.projectId },
        json: {
          skillId: input.skillId,
          environmentId: input.environmentId,
          path: input.path ?? "SKILL.md",
          content: input.content,
          revision: input.revision,
        },
      }),
    );

  const write = async (
    input: SkillUpdateArgs,
  ): Promise<ExperimentalSkillWriteResult> => {
    try {
      const written = await patchContent(input);
      return { outcome: "written", ...written };
    } catch (error) {
      const conflict = readSkillWriteConflict(error);
      if (conflict === null) throw error;
      return { outcome: "conflict", ...conflict };
    }
  };

  const create = async (
    input: SkillCreateArgs,
  ): Promise<ExperimentalSkillWriteResult> => {
    try {
      const written = await transport.readJson(
        transport.api.v1.projects[":id"].skills.$post({
          param: { id: input.projectId },
          json: {
            environmentId: input.environmentId,
            scope: input.scope,
            name: input.name,
            content: input.content,
          },
        }),
      );
      return { outcome: "written", ...written };
    } catch (error) {
      const conflict = readSkillWriteConflict(error);
      if (conflict === null) throw error;
      return { outcome: "conflict", ...conflict };
    }
  };

  return {
    experimental_create: create,
    async experimental_read(input) {
      return getContent({ ...input, path: "SKILL.md" });
    },
    experimental_write: write,
    async experimental_getSelection(input) {
      return transport.readJson(
        transport.api.v1.settings["skill-selection"].$get(
          {},
          ...signalRequestArgs(input?.signal),
        ),
      );
    },
    async experimental_setSelection(selection) {
      return transport.readJson(
        transport.api.v1.settings["skill-selection"].$put({ json: selection }),
      );
    },
    async getContent(input) {
      return getContent(input);
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
      return patchContent(input);
    },
  };
}
