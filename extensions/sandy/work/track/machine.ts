// The stage machine: its definition (a skill's stages.json or an ad-hoc track) and the pure rule helpers.
// The per-thread run state and its transitions live in run.ts. No sandy API here, so it is testable with node --test.
import { condRefs, DONE_STAGE, INPUT_SCOPE, parseType, RESERVED_STAGE_IDS, type Cond, type Segment } from "@sandy/skill-dialect/runtime";
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, "lowercase id: a-z 0-9 _ -");
const fieldName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/, "name: A-Z a-z 0-9 _ -, at most 48 characters");
const valueType = z.string().refine((type) => parseType(type).ok, { message: "unknown value type" });

export const condSchema: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.object({ fn: z.literal("present"), ref: z.string().min(1) }).strict(),
    z.object({ fn: z.enum(["equals", "any", "all"]), ref: z.string().min(1), value: z.string() }).strict(),
    z.object({ fn: z.literal("not"), arg: condSchema }).strict(),
    z.object({ fn: z.enum(["and", "or"]), args: z.array(condSchema).min(2) }).strict(),
  ]),
);

const segmentSchema: z.ZodType<Segment> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
    z.object({ type: z.literal("ref"), ref: z.string().min(1), list: z.string().min(1).optional() }).strict(),
    z.object({ type: z.literal("if"), cond: condSchema, then: z.array(segmentSchema), else: z.array(segmentSchema) }).strict(),
  ]),
);

const deriveSchema = z
  .object({
    name: fieldName,
    type: valueType,
    cases: z.array(z.object({ value: z.string().min(1), when: condSchema.optional() }).strict()).min(1),
  })
  .strict();

export const allowSchema = z
  .object({
    skills: z.array(z.string().min(1)).optional(),
    edits: z.boolean().optional(),
    subagents: z.array(z.object({ agent: z.string().optional(), model: z.string().optional() }).strict()).optional(),
    denyTools: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type Allow = z.infer<typeof allowSchema>;

export const ruleSchema = z.discriminatedUnion("type", [
  /** Every required output of the stage is submitted and non-empty. */
  z.object({ type: z.literal("outputs") }).strict(),
  /** The owner approves in the thread composer. Evaluated last. */
  z.object({ type: z.literal("user"), prompt: z.string().optional() }).strict(),
  /** A shell command exits 0 in the thread's workspace, on the thread's host. */
  z
    .object({
      type: z.literal("check"),
      command: z.string().min(1),
      label: z.string().optional(),
      timeoutSec: z.number().int().min(1).max(1800).optional(),
    })
    .strict(),
  /**
   * The driver submitted evidence under this name (what it ran or observed). ran: only a plugin-run command of this
   * name (sandy work track drive run) that exited 0 in this visit satisfies it; typed text does not.
   */
  z.object({ type: z.literal("evidence"), name: id, description: z.string().optional(), ran: z.literal(true).optional() }).strict(),
  /**
   * The goal this track serves (the goal focused when it started) has an approved auditor verdict.
   * optional: a run that serves no goal passes it (a template used with and without goals).
   */
  z.object({ type: z.literal("goal"), label: z.string().optional(), optional: z.literal(true).optional() }).strict(),
]);
export type Rule = z.infer<typeof ruleSchema>;

const fieldSchema = z
  .object({ name: fieldName, description: z.string().optional(), optional: z.boolean().optional(), type: valueType.optional() })
  .strict();

export const stageSchema = z
  .object({
    id,
    title: z.string().min(1),
    description: z.string().optional(),
    /** "<stage>.<output>" references to earlier outputs, or free-text names of what the stage starts from. */
    inputs: z.array(z.string().min(1)).default([]),
    outputs: z.array(fieldSchema).default([]),
    allow: allowSchema.optional(),
    /** The template's default driver: an autopilot (pi/autopilot, autopilots/<name>.ts) instead of the agent; args is its argument string. The owner may override it per run (run.ts DriverPlan). */
    autopilot: z
      .object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/, "autopilot name: a-z 0-9 -, at most 48 characters"), args: z.string().max(500).optional() })
      .strict()
      .optional(),
    gate: z.array(ruleSchema).default([]),
    next: z
      .array(
        z
          .object({
            to: id,
            when: z.string().optional(),
            /** Extra rules for this branch only, checked after the stage gate. */
            gate: z.array(ruleSchema).optional(),
            cond: condSchema.optional(),
            max: z.number().int().min(1).optional(),
            exceeded: z.literal("owner").optional(),
          })
          .strict(),
      )
      .default([]),
    template: z.array(segmentSchema).optional(),
    derive: z.array(deriveSchema).optional(),
  })
  .strict();
export type Stage = z.infer<typeof stageSchema>;
export type Edge = Stage["next"][number];

export const machineSchema = z
  .object({
    id,
    title: z.string().min(1),
    description: z.string().optional(),
    start: id.optional(),
    /** Applied to every stage that does not set its own allow. */
    allow: allowSchema.optional(),
    inputs: z.array(fieldSchema).optional(),
    result: z.array(z.object({ name: fieldName, from: z.string().min(1) }).strict()).optional(),
    stages: z.array(stageSchema).min(1).max(40),
  })
  .strict()
  .superRefine((machine, ctx) => {
    const ids = new Set<string>();
    for (const stage of machine.stages) {
      if (ids.has(stage.id)) ctx.addIssue({ code: "custom", message: `duplicate stage id "${stage.id}"` });
      if (RESERVED_STAGE_IDS.includes(stage.id)) ctx.addIssue({ code: "custom", message: `"${stage.id}" is reserved and cannot be a stage id` });
      ids.add(stage.id);
    }
    if (machine.start !== undefined && !ids.has(machine.start))
      ctx.addIssue({ code: "custom", message: `start "${machine.start}" is not a stage` });
    const produces = (ref: string): boolean => {
      const [from, name] = ref.split(".");
      if (from === INPUT_SCOPE) return (machine.inputs ?? []).some((i) => i.name === name);
      const source = machine.stages.find((s) => s.id === from);
      return source !== undefined && (source.outputs.some((o) => o.name === name) || (source.derive ?? []).some((d) => d.name === name));
    };
    for (const stage of machine.stages) {
      for (const edge of stage.next) {
        if (edge.to !== DONE_STAGE && !ids.has(edge.to)) ctx.addIssue({ code: "custom", message: `stage "${stage.id}": next "${edge.to}" is not a stage` });
        if (edge.exceeded !== undefined && edge.max === undefined)
          ctx.addIssue({ code: "custom", message: `stage "${stage.id}": next "${edge.to}" sets exceeded without max` });
      }
      for (const input of stage.inputs) {
        if (input.split(".")[1] === undefined) continue;
        if (!produces(input)) ctx.addIssue({ code: "custom", message: `stage "${stage.id}": input "${input}" names no output` });
      }
      for (const ref of stage.next.flatMap((e) => (e.cond === undefined ? [] : condRefs(e.cond))))
        if (!produces(ref)) ctx.addIssue({ code: "custom", message: `stage "${stage.id}": condition reads "${ref}", which names no output` });
    }
    for (const field of machine.result ?? [])
      if (!produces(field.from)) ctx.addIssue({ code: "custom", message: `result "${field.name}" reads "${field.from}", which names no output` });
  });
export type Machine = z.infer<typeof machineSchema>;

export type RuleResult = { ok: boolean; detail: string; at: number };

export function parseMachine(raw: unknown): { ok: true; machine: Machine } | { ok: false; error: string } {
  const parsed = machineSchema.safeParse(raw);
  if (parsed.success) return { ok: true, machine: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
  };
}

export function stageOf(machine: Machine, stageId: string): Stage {
  const stage = machine.stages.find((s) => s.id === stageId);
  if (stage === undefined) throw new Error(`unknown stage "${stageId}"`);
  return stage;
}

export function ruleKey(rule: Rule, index: number, edge?: string): string {
  const scope = edge === undefined ? "gate" : `edge:${edge}`;
  switch (rule.type) {
    case "check":
      return `${scope}:${index}:check`;
    case "evidence":
      return `${scope}:${index}:evidence:${rule.name}`;
    default:
      return `${scope}:${index}:${rule.type}`;
  }
}

export function describeRule(rule: Rule): string {
  switch (rule.type) {
    case "outputs":
      return "all required outputs submitted";
    case "user":
      return rule.prompt ?? "owner approves";
    case "check":
      return rule.label ?? `\`${rule.command}\` exits 0`;
    case "evidence":
      return `evidence "${rule.name}"${rule.description ? `: ${rule.description}` : ""}`;
    case "goal":
      return rule.label ?? "the auditor approved the goal this track serves";
  }
}

/** Rules that guard leaving `stage` towards `to` (null: the stage is final). */
export function rulesFor(stage: Stage, to: string | null): { rule: Rule; key: string }[] {
  const rules = stage.gate.map((rule, i) => ({ rule, key: ruleKey(rule, i) }));
  const edge = to === null ? undefined : stage.next.find((e) => e.to === to);
  for (const [i, rule] of (edge?.gate ?? []).entries()) rules.push({ rule, key: ruleKey(rule, i, to!) });
  return rules;
}

/** The effective allow list of the current stage, as the pi guard reads it. */
export function effectiveAllow(machine: Machine, stage: Stage): Allow {
  // Per key: a stage key overrides the track's; a key the stage leaves out inherits the track's.
  const out: Allow = { ...(machine.allow ?? {}) };
  for (const [key, value] of Object.entries(stage.allow ?? {})) if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  return out;
}

/** Pick the edge for an advance: explicit `to`, the only edge, or null for a final stage. */
export function pickEdge(stage: Stage, to: string | undefined): { ok: true; to: string | null } | { ok: false; error: string } {
  if (to !== undefined) {
    if (stage.next.some((e) => e.to === to)) return { ok: true, to };
    const options = stage.next.map((e) => e.to).join(", ") || "none (final stage)";
    return { ok: false, error: `"${to}" is not a next stage of "${stage.id}". Options: ${options}` };
  }
  if (stage.next.length === 0) return { ok: true, to: null };
  if (stage.next.length === 1) return { ok: true, to: stage.next[0]!.to };
  return {
    ok: false,
    error: `stage "${stage.id}" branches; pass to: one of ${stage.next.map((e) => `${e.to}${e.when ? ` (${e.when})` : ""}`).join(", ")}`,
  };
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
