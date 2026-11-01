// The stage machine: its definition (a skill's stages.json or an ad-hoc track) and the pure rule helpers.
// The per-thread run state and its transitions live in run.ts. No sandy API here, so it is testable with node --test.
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, "lowercase id: a-z 0-9 _ -");

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
  .object({ name: id, description: z.string().optional(), optional: z.boolean().optional() })
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
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type Stage = z.infer<typeof stageSchema>;

export const machineSchema = z
  .object({
    id,
    title: z.string().min(1),
    description: z.string().optional(),
    start: id.optional(),
    /** Applied to every stage that does not set its own allow. */
    allow: allowSchema.optional(),
    stages: z.array(stageSchema).min(1).max(40),
  })
  .strict()
  .superRefine((machine, ctx) => {
    const ids = new Set<string>();
    for (const stage of machine.stages) {
      if (ids.has(stage.id)) ctx.addIssue({ code: "custom", message: `duplicate stage id "${stage.id}"` });
      ids.add(stage.id);
    }
    if (machine.start !== undefined && !ids.has(machine.start))
      ctx.addIssue({ code: "custom", message: `start "${machine.start}" is not a stage` });
    for (const stage of machine.stages) {
      for (const edge of stage.next)
        if (!ids.has(edge.to)) ctx.addIssue({ code: "custom", message: `stage "${stage.id}": next "${edge.to}" is not a stage` });
      for (const input of stage.inputs) {
        const [from, name] = input.split(".");
        if (name === undefined) continue;
        const source = machine.stages.find((s) => s.id === from);
        if (source === undefined || !source.outputs.some((o) => o.name === name))
          ctx.addIssue({ code: "custom", message: `stage "${stage.id}": input "${input}" names no output` });
      }
    }
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
