import { z } from "zod";

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SIDES = ["I", "It", "We", "They"] as const;
export type Side = (typeof SIDES)[number];
export type EvidenceSide = Side | `seam:${string}`;

export const KINDS = [
  "context", "system", "container", "component", "operation",
  "initiative", "project", "task", "step",
  "field", "topic", "concept", "claim", "source",
  "vision", "area", "goal", "habit", "data-point",
  "organisation", "team", "person",
] as const;
export type HolonKind = (typeof KINDS)[number];

export const MACHINE_PROOF_KINDS = ["ci", "metric", "alert", "file", "ticket", "formal"] as const;
export const HUMAN_PROOF_KINDS = ["interview", "confirmation", "ai-review"] as const;
export type ProofKind = (typeof MACHINE_PROOF_KINDS)[number] | (typeof HUMAN_PROOF_KINDS)[number];
export const HUMAN_MAX_DAYS = 90;

export function isHumanKind(kind: ProofKind): boolean {
  return (HUMAN_PROOF_KINDS as readonly string[]).includes(kind);
}

export interface Proof {
  kind: ProofKind;
  source: string | null;
  everyDays: number | null;
  by: string | null;
}

export interface Seam {
  to: string;
  contract: string;
  readOnly: boolean;
  exclusive: boolean;
  proof: Proof | null;
}

export interface Holon {
  id: string;
  kind: HolonKind;
  partOf: string | null;
  title: string;
  status: "proposed" | "active" | "retired";
  why: string;
  contract: string;
  carriedBy: string[];
  code: string[];
  seams: Seam[];
  proofs: Partial<Record<Side, Proof>>;
}

export interface Confirmation {
  holon: string;
  side: EvidenceSide;
  by: string;
  recordedBy: string;
  at: string;
  expires: string;
  contractHash: string;
  answer: string;
  hesitation: string[];
  result: "confirmed" | "refuted";
}

export interface Evidence {
  holon: string;
  side: EvidenceSide;
  kind: ProofKind;
  source: string;
  result: "pass" | "fail";
  contractHash: string;
  build: string;
  environment: string;
  at: string;
  expires: string | null;
  detail: string;
}

const slug = z.string().regex(SLUG, "must be a slug like password-reset");
const proofKind = z.enum([...MACHINE_PROOF_KINDS, ...HUMAN_PROOF_KINDS]);
const every = z.string().regex(/^[1-9][0-9]*d$/, "must look like 90d");
const evidenceSide = z.union([z.enum(SIDES), z.string().regex(/^seam:[a-z0-9]+(-[a-z0-9]+)*$/)]) as z.ZodType<EvidenceSide>;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-mm-dd").refine((value) => isValidDate(value), "is no calendar date");
const iso = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), "must be an ISO timestamp");
const by = z.union([slug, z.string().regex(/^agent:[a-z0-9]+(-[a-z0-9]+)*$/, "must be a slug or agent:<name>")]);
const contractHash = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex>");

const proofSchema = z
  .object({ kind: proofKind, source: z.string().min(1).optional(), every: every.optional(), by: z.string().min(1).optional() })
  .strict();

const holonSchema = z
  .object({
    format: z.literal("holon/v0"),
    id: slug,
    kind: z.enum(KINDS),
    partOf: slug.nullable(),
    title: z.string().min(1),
    status: z.enum(["proposed", "active", "retired"]),
    why: z.string(),
    contract: z.string(),
    carriedBy: z.array(slug),
    code: z.array(z.string().min(1)),
    seams: z.array(
      z
        .object({
          to: slug,
          contract: z.string(),
          readOnly: z.boolean().optional(),
          exclusive: z.boolean().optional(),
          proof: proofSchema.optional(),
        })
        .strict(),
    ),
    proofs: z.object({ I: proofSchema.optional(), It: proofSchema.optional(), We: proofSchema.optional(), They: proofSchema.optional() }).strict(),
  })
  .strict();

const confirmationSchema = z
  .object({
    format: z.literal("holon-confirmation/v0"),
    holon: slug,
    side: evidenceSide,
    by,
    recordedBy: by,
    at: date,
    expires: date,
    contractHash,
    answer: z.string(),
    hesitation: z.array(z.string()),
    result: z.enum(["confirmed", "refuted"]),
  })
  .strict();

export const evidenceSchema = z
  .object({
    holon: slug,
    side: evidenceSide,
    kind: z.enum(MACHINE_PROOF_KINDS),
    source: z.string(),
    result: z.enum(["pass", "fail"]),
    contractHash,
    build: z.string().min(1),
    environment: z.string().min(1),
    at: iso,
    expires: iso.nullable(),
    detail: z.string(),
  })
  .strict();

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isValidDate(value: string): boolean {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

function parseJson(text: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    return { ok: false, error: `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

function toProof(raw: z.infer<typeof proofSchema>): Proof {
  const declared = raw.every === undefined ? null : Number.parseInt(raw.every, 10);
  const human = isHumanKind(raw.kind);
  return {
    kind: raw.kind,
    source: raw.source ?? null,
    everyDays: human ? Math.min(declared ?? HUMAN_MAX_DAYS, HUMAN_MAX_DAYS) : declared,
    by: raw.by ?? null,
  };
}

export function parseHolon(text: string): Parsed<Holon> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const result = holonSchema.safeParse(json.value);
  if (!result.success) return { ok: false, error: `invalid holon/v0: ${describeIssues(result.error)}` };
  const raw = result.data;
  const proofs: Partial<Record<Side, Proof>> = {};
  for (const side of SIDES) {
    const proof = raw.proofs[side];
    if (proof !== undefined) proofs[side] = toProof(proof);
  }
  return {
    ok: true,
    value: {
      id: raw.id,
      kind: raw.kind,
      partOf: raw.partOf,
      title: raw.title,
      status: raw.status,
      why: raw.why,
      contract: raw.contract,
      carriedBy: raw.carriedBy,
      code: raw.code,
      seams: raw.seams.map((seam) => ({
        to: seam.to,
        contract: seam.contract,
        readOnly: seam.readOnly ?? false,
        exclusive: seam.exclusive ?? false,
        proof: seam.proof === undefined ? null : toProof(seam.proof),
      })),
      proofs,
    },
  };
}

export function parseConfirmation(text: string): Parsed<Confirmation> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const result = confirmationSchema.safeParse(json.value);
  if (!result.success) return { ok: false, error: `invalid holon-confirmation/v0: ${describeIssues(result.error)}` };
  const { format: _format, ...confirmation } = result.data;
  return { ok: true, value: confirmation };
}

export function parseEvidence(value: unknown): Parsed<Evidence> {
  const result = evidenceSchema.safeParse(value);
  if (!result.success) return { ok: false, error: `invalid evidence: ${describeIssues(result.error)}` };
  return { ok: true, value: result.data };
}

export function parseEvidenceLines(text: string): Parsed<Evidence[]> {
  const records: Evidence[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    const json = parseJson(line);
    if (!json.ok) return { ok: false, error: `line ${index + 1}: ${json.error}` };
    const parsed = parseEvidence(json.value);
    if (!parsed.ok) return { ok: false, error: `line ${index + 1}: ${parsed.error}` };
    records.push(parsed.value);
  }
  return { ok: true, value: records };
}

export function confirmationPath(confirmation: Pick<Confirmation, "holon" | "at" | "side" | "by">): string {
  return `.holons/confirmations/${confirmation.holon}/${confirmation.at}-${confirmation.side}-${confirmation.by}.json`;
}

export function serializeConfirmation(confirmation: Confirmation): string {
  return `${JSON.stringify({ format: "holon-confirmation/v0", ...confirmation }, null, 2)}\n`;
}
