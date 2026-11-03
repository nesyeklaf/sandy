import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import { flowSchema, flowStepSchema } from "./graph.ts";

export const MAX_USE_CASES = 24;
export const MAX_KEYWORDS = 40;
export const MAX_FLOWS = 100;

export const useCaseSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  keywords: z.array(z.string().trim().min(1).max(40)).max(MAX_KEYWORDS),
});

const skillRow = z.object({
  name: z.string(),
  description: z.string().nullable(),
  scope: z.string(),
  provider: z.string().nullable(),
  useCaseId: z.string(),
  manual: z.boolean(),
  sources: z.array(z.string()),
});
export type SkillRow = z.infer<typeof skillRow>;

const projectSchema = z.object({ id: z.string(), name: z.string() });

const stateSchema = z.object({
  projects: z.array(projectSchema),
  projectId: z.string().nullable(),
  useCases: z.array(useCaseSchema),
  fallbackId: z.string(),
  fallbackLabel: z.string(),
  skills: z.array(skillRow),
  flows: z.array(flowSchema),
});
export type SkillUseCaseState = z.infer<typeof stateSchema>;

const overviewSchema = z.object({
  useCases: z.array(useCaseSchema),
  fallbackId: z.string(),
  fallbackLabel: z.string(),
  flows: z.array(flowSchema),
});
export type SkillOverview = z.infer<typeof overviewSchema>;

const okSchema = z.object({ ok: z.boolean() });

const proposalSchema = z.object({
  skillName: z.string(),
  areaId: z.string().nullable(),
  newAreaLabel: z.string().nullable(),
  areaLabel: z.string(),
  reason: z.string(),
});
export type AssignmentProposal = z.infer<typeof proposalSchema>;

const flowProposalSchema = z.object({
  name: z.string(),
  description: z.string(),
  steps: z.array(flowStepSchema),
});
export type FlowProposal = z.infer<typeof flowProposalSchema>;

export const CHANGED_EVENT = "changed";
export const FLOW_PROVIDER_ID = "flows";

export const rpcContract = defineRpcContract({
  state: {
    input: z.object({ projectId: z.string().nullable() }),
    output: stateSchema,
  },
  overview: {
    input: z.object({}),
    output: overviewSchema,
  },
  assign: {
    input: z.object({ skillName: z.string().min(1), useCaseId: z.string().nullable() }),
    output: okSchema,
  },
  saveUseCases: {
    input: z.object({ useCases: z.array(useCaseSchema).max(MAX_USE_CASES) }),
    output: okSchema,
  },
  resetUseCases: {
    input: z.object({}),
    output: okSchema,
  },
  saveFlows: {
    input: z.object({ flows: z.array(flowSchema).max(MAX_FLOWS) }),
    output: okSchema,
  },
  recommendAssignments: {
    input: z.object({ projectId: z.string().nullable() }),
    output: z.object({ proposals: z.array(proposalSchema) }),
  },
  applyAssignments: {
    input: z.object({
      items: z
        .array(
          z.object({
            skillName: z.string().min(1),
            areaId: z.string().nullable(),
            newAreaLabel: z.string().nullable(),
          }),
        )
        .max(500),
    }),
    output: okSchema,
  },
  recommendFlow: {
    input: z.object({
      projectId: z.string().nullable(),
      useCaseId: z.string().min(1),
      goal: z.string().max(500),
      current: z.array(flowStepSchema).nullable(),
    }),
    output: z.object({ rationale: z.string(), proposal: flowProposalSchema }),
  },
});
