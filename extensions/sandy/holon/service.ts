import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  HUMAN_MAX_DAYS,
  SIDES,
  confirmationPath,
  isHumanKind,
  parseConfirmation,
  parseEvidence,
  parseEvidenceLines,
  serializeConfirmation,
  type Confirmation,
  type Evidence,
  type EvidenceSide,
  type Holon,
  type Proof,
} from "./core/format.ts";
import type { EvalEnv } from "./core/evaluate.ts";
import { gitCodeChanges, gitHead, gitTopLevel } from "./core/git.ts";
import { DAY_MS, contractHash, formatDate, formatInstant, parseInstant } from "./core/time.ts";
import { HolonIndex, type RefreshStats } from "./index/holon-index.ts";

export class HolonInputError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(message: string, code: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export interface EnvOptions {
  now?: string | undefined;
  commit?: string | undefined;
}

export interface Opened {
  index: HolonIndex;
  env: EvalEnv;
  stats: RefreshStats;
}

export interface EvidenceInput {
  holon: string;
  side: string;
  kind?: string | undefined;
  source?: string | undefined;
  result: string;
  contractHash?: string | undefined;
  build?: string | undefined;
  environment?: string | undefined;
  at?: string | undefined;
  expires?: string | undefined;
  detail?: string | undefined;
}

export interface ConfirmInput {
  holon: string;
  side: string;
  by: string;
  recordedBy?: string | undefined;
  answer: string;
  hesitation: string[];
  result: "confirmed" | "refuted";
  at?: string | undefined;
  expires?: string | undefined;
}

export function resolveRoot(root: string | undefined, cwd: string | undefined): string {
  const base = cwd ?? process.cwd();
  if (root !== undefined) {
    const absolute = isAbsolute(root) ? root : resolve(base, root);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new HolonInputError(`--root ${root} is no directory`, "root_not_found");
    return absolute;
  }
  return gitTopLevel(base) ?? resolve(base);
}

function sideProof(holon: Holon, side: EvidenceSide): { proof: Proof | null; contract: string } | null {
  if (side.startsWith("seam:")) {
    const seam = holon.seams.find((item) => item.to === side.slice("seam:".length));
    return seam === undefined ? null : { proof: seam.proof, contract: seam.contract };
  }
  return { proof: holon.proofs[side as (typeof SIDES)[number]] ?? null, contract: holon.contract };
}

export class HolonService {
  private readonly db: Database.Database;
  private readonly indexes = new Map<string, HolonIndex>();
  private readonly clock: () => number;

  constructor(db: Database.Database, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }

  env(root: string, options: EnvOptions): EvalEnv {
    let nowMs = this.clock();
    if (options.now !== undefined) {
      try {
        nowMs = parseInstant(options.now);
      } catch {
        throw new HolonInputError(`--now ${options.now} is no ISO timestamp`, "invalid_now", "Use a form like 2026-11-08T12:00:00Z");
      }
    }
    const commit = options.commit ?? gitHead(root) ?? "none";
    return { nowMs, commit, code: gitCodeChanges(root) };
  }

  index(root: string): HolonIndex {
    let index = this.indexes.get(root);
    if (index === undefined) {
      index = new HolonIndex(this.db, root);
      this.indexes.set(root, index);
    }
    return index;
  }

  open(root: string, options: EnvOptions): Opened {
    const env = this.env(root, options);
    const index = this.index(root);
    const stats = index.refresh(env);
    return { index, env, stats };
  }

  holonFor(index: HolonIndex, id: string): Holon {
    const found = index.get(id);
    if (found === null) throw new HolonInputError(`no holon ${id} under ${index.root}`, "holon_not_found", "List them with sandy holon check");
    return found.holon;
  }

  completeEvidence(index: HolonIndex, env: EvalEnv, input: EvidenceInput): Evidence {
    const holon = index.get(input.holon)?.holon ?? null;
    const declared = holon === null ? null : sideProof(holon, input.side as EvidenceSide);
    const parsed = parseEvidence({
      holon: input.holon,
      side: input.side,
      kind: input.kind ?? declared?.proof?.kind,
      source: input.source ?? declared?.proof?.source ?? undefined,
      result: input.result,
      contractHash: input.contractHash ?? (declared === null ? undefined : contractHash(declared.contract)),
      build: input.build ?? env.commit,
      environment: input.environment ?? "local",
      at: input.at ?? formatInstant(env.nowMs),
      expires: input.expires ?? null,
      detail: input.detail ?? "",
    });
    if (!parsed.ok) {
      throw new HolonInputError(
        parsed.error,
        "invalid_evidence",
        holon === null ? `No holon ${input.holon} in the index: pass --kind, --source and --contract-hash` : undefined,
      );
    }
    return parsed.value;
  }

  readEvidenceFile(root: string, cwd: string | undefined, file: string): Evidence[] {
    const path = isAbsolute(file) ? file : resolve(cwd ?? root, file);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new HolonInputError(`cannot read ${file}`, "file_not_found");
    }
    return this.parseEvidenceText(text);
  }

  parseEvidenceText(text: string): Evidence[] {
    const parsed = parseEvidenceLines(text);
    if (!parsed.ok) throw new HolonInputError(parsed.error, "invalid_evidence");
    return parsed.value;
  }

  confirm(index: HolonIndex, env: EvalEnv, input: ConfirmInput): { path: string; confirmation: Confirmation } {
    const holon = this.holonFor(index, input.holon);
    const declared = sideProof(holon, input.side as EvidenceSide);
    if (declared === null) throw new HolonInputError(`${input.holon} has no seam for side ${input.side}`, "invalid_side");
    if (declared.proof !== null && !isHumanKind(declared.proof.kind)) {
      throw new HolonInputError(
        `${input.holon} proves ${input.side} with ${declared.proof.kind}, a machine kind`,
        "machine_side",
        "Record machine runs with sandy holon evidence record",
      );
    }
    const at = input.at ?? formatDate(env.nowMs);
    const atMs = parseInstant(at);
    const limitMs = atMs + (declared.proof?.everyDays ?? HUMAN_MAX_DAYS) * DAY_MS;
    const expires = input.expires ?? formatDate(limitMs);
    if (/^\d{4}-\d{2}-\d{2}$/.test(expires) && parseInstant(expires) > limitMs) {
      throw new HolonInputError(`--expires ${expires} is after ${formatDate(limitMs)}`, "expires_too_late", `Human proofs last at most ${HUMAN_MAX_DAYS} days`);
    }
    const draft = serializeConfirmation({
      holon: input.holon,
      side: input.side as EvidenceSide,
      by: input.by,
      recordedBy: input.recordedBy ?? input.by,
      at,
      expires,
      contractHash: contractHash(declared.contract),
      answer: input.answer,
      hesitation: input.hesitation,
      result: input.result,
    });
    const parsed = parseConfirmation(draft);
    if (!parsed.ok) throw new HolonInputError(parsed.error, "invalid_confirmation");
    const path = confirmationPath(parsed.value);
    const absolute = join(index.root, path);
    if (existsSync(absolute)) throw new HolonInputError(`${path} exists already`, "confirmation_exists", "One confirmation per holon, side, person and day");
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, draft);
    index.reindexPaths([path], env);
    return { path, confirmation: parsed.value };
  }
}

