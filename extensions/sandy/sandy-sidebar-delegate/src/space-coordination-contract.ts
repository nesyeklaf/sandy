import { z } from "zod";

const IDEA_TITLE_CHARS_MAX = 200;
const IDEA_BODY_BYTES_MAX = 16384;
export const IDEAS_PER_SPACE_MAX = 500;
export const IDEA_LINKS_MAX = 50;
export const SCRATCHPAD_BYTES_MAX = 65536;
export const SPACE_MEMBERS_LISTED_MAX = 500;
export const WAKE_DIGEST_ENTRIES_MAX = 50;
export const WAKE_DIGEST_INTERVAL_MS = 60000;
export const THREAD_IDS_PER_LOOKUP_MAX = 200;

export const IDEA_STATUSES = ["open", "planned", "in-progress", "done", "dropped"] as const;
export const COORDINATION_MODES = ["independent", "managed"] as const;

const spaceIdSchema = z.string().trim().min(1);
const threadIdSchema = z.string().trim().min(1);
const BULK_ORCHESTRATOR_MAX = 200;
const ideaIdSchema = z.string().trim().min(1);
const ideaStatusSchema = z.enum(IDEA_STATUSES);
const coordinationModeSchema = z.enum(COORDINATION_MODES);
const ideaTitleSchema = z.string().trim().min(1).max(IDEA_TITLE_CHARS_MAX);
const ideaBodySchema = z.string().refine((value) => new TextEncoder().encode(value).length <= IDEA_BODY_BYTES_MAX, {
  message: `Idea body is over ${IDEA_BODY_BYTES_MAX} bytes`,
});
const ideaLinksSchema = z.array(threadIdSchema).max(IDEA_LINKS_MAX);

export const ideaSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  title: z.string(),
  body: z.string(),
  status: ideaStatusSchema,
  authorKind: z.enum(["owner", "session"]),
  authorThreadId: z.string().nullable(),
  threadIds: z.array(z.string()),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const scratchpadSchema = z.object({
  spaceId: z.string(),
  body: z.string(),
  revision: z.number().int().nonnegative(),
  updatedByKind: z.enum(["owner", "session"]).nullable(),
  updatedByThreadId: z.string().nullable(),
  updatedAt: z.number().int().nullable(),
});

export const scratchpadWriteSchema = z.object({
  status: z.enum(["written", "conflict"]),
  scratchpad: scratchpadSchema,
});

const memberSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  status: z.string(),
  projectId: z.string(),
  projectName: z.string().nullable(),
  environmentId: z.string().nullable(),
  environmentName: z.string().nullable(),
  environmentHostId: z.string().nullable(),
  environmentPath: z.string().nullable(),
  environmentIsWorktree: z.boolean().nullable(),
  branchName: z.string().nullable(),
  pullRequest: z.string(),
  hasPendingQuestion: z.boolean(),
  queuedWork: z.string(),
  activity: z.object({
    activeWorkflowCount: z.number().int().nonnegative(),
    activeBackgroundAgentCount: z.number().int().nonnegative(),
    activeBackgroundCommandCount: z.number().int().nonnegative(),
    activePlanModeCount: z.number().int().nonnegative(),
    activeGoalCount: z.number().int().nonnegative(),
  }),
  latestAttentionAt: z.number().int(),
  updatedAt: z.number().int(),
  mode: coordinationModeSchema,
  isOrchestrator: z.boolean(),
});

export const spaceCoordinationSchema = z.object({
  spaceId: z.string(),
  spaceName: z.string(),
  wakeEnabled: z.boolean(),
  orchestratorThreadIds: z.array(z.string()),
  members: z.array(memberSchema),
  membersTruncated: z.boolean(),
  ideas: z.array(ideaSchema),
  scratchpadRevision: z.number().int().nonnegative(),
});

const orphanSpaceSchema = z.object({
  spaceId: z.string(),
  ideaCount: z.number().int().nonnegative(),
  hasScratchpad: z.boolean(),
});

const spaceInput = { spaceId: spaceIdSchema };

export const spaceCoordinationRpcShape = {
  getSpaceCoordination: {
    input: z.object(spaceInput).strict(),
    output: spaceCoordinationSchema,
  },
  listOrchestrators: {
    input: z.object({}).strict(),
    output: z.object({ threadIds: z.array(z.string()) }),
  },
  setOrchestrator: {
    input: z.object({ threadId: threadIdSchema, orchestrator: z.boolean() }).strict(),
    output: z.object({ changed: z.boolean(), spaceId: z.string().nullable() }),
  },
  setOrchestrators: {
    input: z
      .object({ threadIds: z.array(threadIdSchema).min(1).max(BULK_ORCHESTRATOR_MAX), orchestrator: z.boolean() })
      .strict(),
    output: z.object({ changed: z.array(z.string()) }),
  },
  setMemberMode: {
    input: z.object({ threadId: threadIdSchema, mode: coordinationModeSchema }).strict(),
    output: z.object({ changed: z.boolean(), mode: coordinationModeSchema }),
  },
  setSpaceWake: {
    input: z.object({ ...spaceInput, enabled: z.boolean() }).strict(),
    output: z.object({ wakeEnabled: z.boolean() }),
  },
  listIdeas: {
    input: z.object(spaceInput).strict(),
    output: z.object({ ideas: z.array(ideaSchema) }),
  },
  createIdea: {
    input: z
      .object({
        ...spaceInput,
        title: ideaTitleSchema,
        body: ideaBodySchema.default(""),
        threadIds: ideaLinksSchema.default([]),
      })
      .strict(),
    output: ideaSchema,
  },
  updateIdea: {
    input: z
      .object({
        ideaId: ideaIdSchema,
        title: ideaTitleSchema.optional(),
        body: ideaBodySchema.optional(),
        status: ideaStatusSchema.optional(),
        threadIds: ideaLinksSchema.optional(),
      })
      .strict(),
    output: ideaSchema,
  },
  deleteIdea: {
    input: z.object({ ideaId: ideaIdSchema }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  getScratchpad: {
    input: z.object(spaceInput).strict(),
    output: scratchpadSchema,
  },
  writeScratchpad: {
    input: z
      .object({
        ...spaceInput,
        body: z.string().refine((value) => new TextEncoder().encode(value).length <= SCRATCHPAD_BYTES_MAX, {
          message: `Scratchpad is over ${SCRATCHPAD_BYTES_MAX} bytes`,
        }),
        baseRevision: z.number().int().nonnegative(),
      })
      .strict(),
    output: scratchpadWriteSchema,
  },
  listOrphanSpaces: {
    input: z.object({}).strict(),
    output: z.object({ orphans: z.array(orphanSpaceSchema) }),
  },
  adoptOrphanSpace: {
    input: z.object({ oldSpaceId: spaceIdSchema, spaceId: spaceIdSchema }).strict(),
    output: z.object({ ideasMoved: z.number().int().nonnegative(), scratchpadAppended: z.boolean() }),
  },
};

export type Idea = z.infer<typeof ideaSchema>;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export type CoordinationMode = (typeof COORDINATION_MODES)[number];
export type Scratchpad = z.infer<typeof scratchpadSchema>;
export type ScratchpadWrite = z.infer<typeof scratchpadWriteSchema>;
export type SpaceCoordination = z.infer<typeof spaceCoordinationSchema>;
export type SpaceMember = z.infer<typeof memberSchema>;
