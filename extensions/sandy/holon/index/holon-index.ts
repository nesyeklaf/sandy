import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { Confirmation, Evidence, EvidenceSide, Holon } from "../core/format.ts";
import {
  evaluateHolon,
  type EvalContext,
  type EvalEnv,
  type HolonEvaluation,
} from "../core/evaluate.ts";
import { readConfirmationFile, readHolonFile, rollUp } from "../core/model.ts";
import {
  checkModel,
  driftOutput,
  viewOutput,
  type CheckOutput,
  type ComputedHolon,
  type DriftOutput,
  type ViewOutput,
  type ViewSource,
} from "../core/outputs.ts";
import { scanRoot, type ScannedFile } from "../core/scan.ts";
import { parseInstant } from "../core/time.ts";
import { MIGRATIONS } from "./schema.ts";

export interface RefreshStats {
  scanned: number;
  reparsed: number;
  evaluated: number;
  fullRollUp: boolean;
}

interface FileRow {
  path: string;
  size: number;
  mtime_ms: number;
  hash: string;
  holon_id: string | null;
}

interface HolonRow {
  id: string;
  path: string;
  part_of: string | null;
  holon_json: string;
  evaluation_json: string;
  drift_count: number;
  drift_below: number;
}

type StoredEvaluation = Pick<HolonEvaluation, "light" | "sides" | "seams" | "drift">;

const CONFIRMATIONS = ".holons/confirmations/";

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function statFile(root: string, path: string): ScannedFile | null {
  try {
    const info = statSync(join(root, path));
    return info.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

function openEvaluation(): StoredEvaluation {
  const side = { light: "open" as const, kind: null, source: null, at: null, expires: null, by: null, detail: "Not evaluated yet" };
  return { light: "open", sides: { I: side, It: side, We: side, They: side }, seams: [], drift: [] };
}

export function migrateIndex(db: Database.Database, migrate: (db: Database.Database, statements: string[]) => void): void {
  migrate(db, MIGRATIONS);
}

export class HolonIndex implements ViewSource {
  readonly root: string;
  private readonly db: Database.Database;
  private readonly statements;
  private partOfCache = new Map<string, string | null | undefined>();

  constructor(db: Database.Database, root: string) {
    this.db = db;
    this.root = resolve(root);
    const prepare = (sql: string) => db.prepare(sql);
    this.statements = {
      model: prepare("SELECT now_ms, commit_sha FROM models WHERE root = ?"),
      upsertModel: prepare(
        "INSERT INTO models (root, now_ms, commit_sha, scanned_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT (root) DO UPDATE SET now_ms = excluded.now_ms, commit_sha = excluded.commit_sha, scanned_at_ms = excluded.scanned_at_ms",
      ),
      holonFiles: prepare("SELECT path, size, mtime_ms, hash, holon_id FROM holon_files WHERE root = ?"),
      holonFile: prepare("SELECT path, size, mtime_ms, hash, holon_id FROM holon_files WHERE root = ? AND path = ?"),
      upsertHolonFile: prepare(
        "INSERT INTO holon_files (root, path, size, mtime_ms, hash, holon_id, holon_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (root, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, hash = excluded.hash, holon_id = excluded.holon_id, holon_json = excluded.holon_json, error = excluded.error",
      ),
      touchHolonFile: prepare("UPDATE holon_files SET size = ?, mtime_ms = ? WHERE root = ? AND path = ?"),
      deleteHolonFile: prepare("DELETE FROM holon_files WHERE root = ? AND path = ?"),
      winner: prepare("SELECT path, holon_json FROM holon_files WHERE root = ? AND holon_id = ? AND holon_json IS NOT NULL ORDER BY path LIMIT 1"),
      confirmationFiles: prepare("SELECT path, size, mtime_ms, hash, holon AS holon_id FROM confirmation_files WHERE root = ?"),
      confirmationFile: prepare("SELECT path, size, mtime_ms, hash, holon AS holon_id FROM confirmation_files WHERE root = ? AND path = ?"),
      upsertConfirmationFile: prepare(
        "INSERT INTO confirmation_files (root, path, size, mtime_ms, hash, holon, side, at, confirmation_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (root, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, hash = excluded.hash, holon = excluded.holon, side = excluded.side, at = excluded.at, confirmation_json = excluded.confirmation_json, error = excluded.error",
      ),
      touchConfirmationFile: prepare("UPDATE confirmation_files SET size = ?, mtime_ms = ? WHERE root = ? AND path = ?"),
      deleteConfirmationFile: prepare("DELETE FROM confirmation_files WHERE root = ? AND path = ?"),
      latestConfirmation: prepare(
        "SELECT confirmation_json FROM confirmation_files WHERE root = ? AND holon = ? AND side = ? AND confirmation_json IS NOT NULL ORDER BY at DESC, path DESC LIMIT 1",
      ),
      confirmedHolons: prepare("SELECT DISTINCT holon FROM confirmation_files WHERE root = ? AND confirmation_json IS NOT NULL"),
      holon: prepare("SELECT id, path, part_of, holon_json, evaluation_json, drift_count, drift_below FROM holons WHERE root = ? AND id = ?"),
      partOf: prepare("SELECT part_of FROM holons WHERE root = ? AND id = ?"),
      insertHolon: prepare(
        "INSERT INTO holons (root, id, path, part_of, holon_json, light, evaluation_json, drift_count, drift_below, valid_from, valid_until, uses_commit) VALUES (?, ?, ?, ?, ?, 'open', ?, 0, ?, NULL, NULL, 0)",
      ),
      updateHolonSource: prepare("UPDATE holons SET path = ?, part_of = ?, holon_json = ? WHERE root = ? AND id = ?"),
      updateEvaluation: prepare(
        "UPDATE holons SET light = ?, evaluation_json = ?, drift_count = ?, valid_from = ?, valid_until = ?, uses_commit = ? WHERE root = ? AND id = ?",
      ),
      deleteHolon: prepare("DELETE FROM holons WHERE root = ? AND id = ?"),
      addDriftBelow: prepare("UPDATE holons SET drift_below = drift_below + ? WHERE root = ? AND id = ?"),
      setDriftBelow: prepare("UPDATE holons SET drift_below = ? WHERE root = ? AND id = ?"),
      childBelowSum: prepare("SELECT COALESCE(SUM(drift_below), 0) AS total FROM holons WHERE root = ? AND part_of = ?"),
      children: prepare("SELECT id, path, part_of, holon_json, evaluation_json, drift_count, drift_below FROM holons WHERE root = ? AND part_of = ? ORDER BY id"),
      childCount: prepare("SELECT COUNT(*) AS n FROM holons WHERE root = ? AND part_of = ?"),
      allStructure: prepare("SELECT id, part_of, drift_count FROM holons WHERE root = ?"),
      allHolons: prepare("SELECT id, path, holon_json FROM holons WHERE root = ?"),
      withDrift: prepare("SELECT id, evaluation_json FROM holons WHERE root = ? AND drift_count > 0"),
      countHolons: prepare("SELECT COUNT(*) AS n FROM holons WHERE root = ?"),
      seamsFrom: prepare("SELECT to_id, read_only, exclusive FROM seams WHERE root = ? AND from_id = ? ORDER BY idx"),
      deleteSeams: prepare("DELETE FROM seams WHERE root = ? AND from_id = ?"),
      insertSeam: prepare("INSERT INTO seams (root, from_id, idx, to_id, read_only, exclusive) VALUES (?, ?, ?, ?, ?, ?)"),
      seamsTo: prepare("SELECT from_id, idx, read_only FROM seams WHERE root = ? AND to_id = ? ORDER BY from_id, idx"),
      exclusiveWritersTo: prepare("SELECT DISTINCT from_id FROM seams WHERE root = ? AND to_id = ? AND exclusive = 1"),
      exclusiveWriters: prepare("SELECT DISTINCT from_id FROM seams WHERE root = ? AND exclusive = 1"),
      latestEvidence: prepare("SELECT record_json FROM evidence WHERE root = ? AND holon = ? AND side = ? ORDER BY at_ms DESC, id DESC LIMIT 1"),
      insertEvidence: prepare("INSERT INTO evidence (root, holon, side, at_ms, record_json) VALUES (?, ?, ?, ?, ?)"),
      clearEvidence: prepare("DELETE FROM evidence WHERE root = ?"),
      evidenceHolons: prepare("SELECT DISTINCT holon FROM evidence WHERE root = ?"),
      expiredWindow: prepare("SELECT id FROM holons WHERE root = ? AND (valid_until <= ? OR valid_from > ?)"),
      usingCommit: prepare("SELECT id FROM holons WHERE root = ? AND uses_commit = 1"),
      markDirty: prepare("INSERT OR IGNORE INTO dirty (root, holon) VALUES (?, ?)"),
      dirty: prepare("SELECT holon FROM dirty WHERE root = ? ORDER BY holon"),
      clearDirty: prepare("DELETE FROM dirty WHERE root = ?"),
    };
  }

  refresh(env: EvalEnv): RefreshStats {
    const scan = scanRoot(this.root);
    return this.apply(env, scan.holonFiles, scan.confirmationFiles, true);
  }

  reindexPaths(paths: readonly string[], env: EvalEnv): RefreshStats {
    const holonFiles: (ScannedFile | { path: string; missing: true })[] = [];
    const confirmationFiles: (ScannedFile | { path: string; missing: true })[] = [];
    for (const path of paths) {
      const file = statFile(this.root, path) ?? { path, missing: true as const };
      if (path.startsWith(CONFIRMATIONS)) confirmationFiles.push(file);
      else if (path.endsWith(".holon")) holonFiles.push(file);
    }
    return this.apply(env, holonFiles, confirmationFiles, false);
  }

  recordEvidence(records: readonly Evidence[], env: EvalEnv): RefreshStats {
    return this.db.transaction(() => {
      for (const record of records) {
        this.statements.insertEvidence.run(this.root, record.holon, record.side, parseInstant(record.at), JSON.stringify(record));
        this.markDirty(record.holon);
      }
      return this.settle(env, 0, records.length, false);
    })();
  }

  replaceEvidence(records: readonly Evidence[], env: EvalEnv): RefreshStats {
    return this.db.transaction(() => {
      for (const { holon } of this.statements.evidenceHolons.all(this.root) as { holon: string }[]) this.markDirty(holon);
      this.statements.clearEvidence.run(this.root);
      return this.recordEvidence(records, env);
    })();
  }

  private apply(
    env: EvalEnv,
    holonFiles: readonly (ScannedFile | { path: string; missing: true })[],
    confirmationFiles: readonly (ScannedFile | { path: string; missing: true })[],
    complete: boolean,
  ): RefreshStats {
    return this.db.transaction(() => {
      let reparsed = 0;
      const touchedIds = new Set<string>();
      const known = new Map((complete ? (this.statements.holonFiles.all(this.root) as FileRow[]) : []).map((row) => [row.path, row]));
      for (const file of holonFiles) {
        const row = complete ? known.get(file.path) : (this.statements.holonFile.get(this.root, file.path) as FileRow | undefined);
        known.delete(file.path);
        if ("missing" in file) {
          if (row !== undefined) this.removeHolonFile(row, touchedIds);
          continue;
        }
        if (row !== undefined && row.size === file.size && row.mtime_ms === file.mtimeMs) continue;
        const text = readFileSync(join(this.root, file.path), "utf8");
        const hash = sha(text);
        if (row !== undefined && row.hash === hash) {
          this.statements.touchHolonFile.run(file.size, file.mtimeMs, this.root, file.path);
          continue;
        }
        reparsed += 1;
        const parsed = readHolonFile(file.path, text);
        const id = parsed.holon?.id ?? null;
        this.statements.upsertHolonFile.run(
          this.root, file.path, file.size, file.mtimeMs, hash, id,
          parsed.holon === null ? null : JSON.stringify(parsed.holon), parsed.error,
        );
        if (row?.holon_id) touchedIds.add(row.holon_id);
        if (id !== null) touchedIds.add(id);
      }
      for (const row of known.values()) this.removeHolonFile(row, touchedIds);
      const knownConfirmations = new Map(
        (complete ? (this.statements.confirmationFiles.all(this.root) as FileRow[]) : []).map((row) => [row.path, row]),
      );
      for (const file of confirmationFiles) {
        const row = complete ? knownConfirmations.get(file.path) : (this.statements.confirmationFile.get(this.root, file.path) as FileRow | undefined);
        knownConfirmations.delete(file.path);
        if ("missing" in file) {
          if (row !== undefined) this.removeConfirmationFile(row);
          continue;
        }
        if (row !== undefined && row.size === file.size && row.mtime_ms === file.mtimeMs) continue;
        const text = readFileSync(join(this.root, file.path), "utf8");
        const hash = sha(text);
        if (row !== undefined && row.hash === hash) {
          this.statements.touchConfirmationFile.run(file.size, file.mtimeMs, this.root, file.path);
          continue;
        }
        reparsed += 1;
        const parsed = readConfirmationFile(file.path, text);
        const confirmation = parsed.confirmation;
        this.statements.upsertConfirmationFile.run(
          this.root, file.path, file.size, file.mtimeMs, hash, parsed.holon,
          confirmation?.side ?? null, confirmation?.at ?? null,
          confirmation === null ? null : JSON.stringify(confirmation), parsed.error,
        );
        if (row?.holon_id) this.markDirty(row.holon_id);
        if (parsed.holon !== null) this.markDirty(parsed.holon);
      }
      for (const row of knownConfirmations.values()) this.removeConfirmationFile(row);
      let structural = false;
      for (const id of touchedIds) structural = this.syncHolon(id) || structural;
      return this.settle(env, holonFiles.length + confirmationFiles.length, reparsed, structural);
    })();
  }

  private removeHolonFile(row: FileRow, touchedIds: Set<string>): void {
    this.statements.deleteHolonFile.run(this.root, row.path);
    if (row.holon_id !== null) touchedIds.add(row.holon_id);
  }

  private removeConfirmationFile(row: FileRow): void {
    this.statements.deleteConfirmationFile.run(this.root, row.path);
    if (row.holon_id !== null) this.markDirty(row.holon_id);
  }

  private markDirty(id: string): void {
    this.statements.markDirty.run(this.root, id);
  }

  private markExclusiveWriters(targets: Iterable<string>): void {
    for (const target of targets) {
      for (const { from_id } of this.statements.exclusiveWritersTo.all(this.root, target) as { from_id: string }[]) this.markDirty(from_id);
    }
  }

  private chain(start: string | null, skip: string): string[] | null {
    const out: string[] = [];
    const seen = new Set<string>([skip]);
    let current = start;
    while (current !== null) {
      if (seen.has(current)) return null;
      const row = this.statements.partOf.get(this.root, current) as { part_of: string | null } | undefined;
      if (row === undefined) break;
      seen.add(current);
      out.push(current);
      current = row.part_of;
    }
    return out;
  }

  private cycle = false;

  private addAlong(start: string | null, skip: string, amount: number): void {
    if (amount === 0 || this.cycle) return;
    const ids = this.chain(start, skip);
    if (ids === null) {
      this.cycle = true;
      return;
    }
    for (const id of ids) this.statements.addDriftBelow.run(amount, this.root, id);
  }

  private syncHolon(id: string): boolean {
    const winner = this.statements.winner.get(this.root, id) as { path: string; holon_json: string } | undefined;
    const current = this.statements.holon.get(this.root, id) as HolonRow | undefined;
    this.partOfCache.clear();
    if (winner === undefined) {
      if (current === undefined) return false;
      const old = JSON.parse(current.holon_json) as Holon;
      this.addAlong(current.part_of, id, -current.drift_below);
      this.statements.deleteHolon.run(this.root, id);
      this.statements.deleteSeams.run(this.root, id);
      this.markExclusiveWriters(old.seams.map((seam) => seam.to));
      return true;
    }
    const holon = JSON.parse(winner.holon_json) as Holon;
    let structural = false;
    let oldSeams: { to_id: string; read_only: number; exclusive: number }[] = [];
    if (current === undefined) {
      const below = (this.statements.childBelowSum.get(this.root, id) as { total: number }).total;
      this.statements.insertHolon.run(this.root, id, winner.path, holon.partOf, winner.holon_json, JSON.stringify(openEvaluation()), below);
      this.addAlong(holon.partOf, id, below);
      structural = true;
    } else {
      if (current.holon_json === winner.holon_json && current.path === winner.path) return false;
      oldSeams = this.statements.seamsFrom.all(this.root, id) as { to_id: string; read_only: number; exclusive: number }[];
      if (current.part_of !== holon.partOf) {
        this.addAlong(current.part_of, id, -current.drift_below);
        this.statements.updateHolonSource.run(winner.path, holon.partOf, winner.holon_json, this.root, id);
        this.addAlong(holon.partOf, id, current.drift_below);
        structural = true;
      } else {
        this.statements.updateHolonSource.run(winner.path, holon.partOf, winner.holon_json, this.root, id);
      }
    }
    this.statements.deleteSeams.run(this.root, id);
    holon.seams.forEach((seam, index) => {
      this.statements.insertSeam.run(this.root, id, index, seam.to, seam.readOnly ? 1 : 0, seam.exclusive ? 1 : 0);
    });
    const signature = (seams: readonly { to: string; readOnly: boolean; exclusive: boolean }[]) =>
      seams.map((seam) => `${seam.to}\u0000${seam.readOnly ? 1 : 0}${seam.exclusive ? 1 : 0}`).join("\u0001");
    const before = oldSeams.map((row) => ({ to: row.to_id, readOnly: row.read_only === 1, exclusive: row.exclusive === 1 }));
    if (signature(before) !== signature(holon.seams)) this.markExclusiveWriters(new Set([...before.map((seam) => seam.to), ...holon.seams.map((seam) => seam.to)]));
    this.markDirty(id);
    return structural;
  }

  private settle(env: EvalEnv, scanned: number, reparsed: number, structural: boolean): RefreshStats {
    const previous = this.statements.model.get(this.root) as { now_ms: number; commit_sha: string } | undefined;
    if (structural) {
      for (const { from_id } of this.statements.exclusiveWriters.all(this.root) as { from_id: string }[]) this.markDirty(from_id);
      for (const { holon } of this.statements.confirmedHolons.all(this.root) as { holon: string }[]) this.markDirty(holon);
    }
    if (previous === undefined || previous.now_ms !== env.nowMs) {
      for (const { id } of this.statements.expiredWindow.all(this.root, env.nowMs, env.nowMs) as { id: string }[]) this.markDirty(id);
    }
    if (previous === undefined || previous.commit_sha !== env.commit) {
      for (const { id } of this.statements.usingCommit.all(this.root) as { id: string }[]) this.markDirty(id);
    }
    const ctx = this.context();
    let evaluated = 0;
    for (const { holon: id } of this.statements.dirty.all(this.root) as { holon: string }[]) {
      const row = this.statements.holon.get(this.root, id) as HolonRow | undefined;
      if (row === undefined) continue;
      const evaluation = evaluateHolon(JSON.parse(row.holon_json) as Holon, ctx, env);
      evaluated += 1;
      const stored: StoredEvaluation = { light: evaluation.light, sides: evaluation.sides, seams: evaluation.seams, drift: evaluation.drift };
      this.statements.updateEvaluation.run(
        evaluation.light, JSON.stringify(stored), evaluation.drift.length,
        evaluation.validFromMs, evaluation.validUntilMs, evaluation.usesCommit ? 1 : 0, this.root, id,
      );
      const delta = evaluation.drift.length - row.drift_count;
      if (delta !== 0) {
        this.statements.addDriftBelow.run(delta, this.root, id);
        this.addAlong(row.part_of, id, delta);
      }
    }
    this.statements.clearDirty.run(this.root);
    const fullRollUp = this.cycle;
    if (this.cycle) this.rollUpAll();
    this.cycle = false;
    this.statements.upsertModel.run(this.root, env.nowMs, env.commit, Date.now());
    return { scanned, reparsed, evaluated, fullRollUp };
  }

  private rollUpAll(): void {
    const rows = this.statements.allStructure.all(this.root) as { id: string; part_of: string | null; drift_count: number }[];
    const parents = new Map(rows.map((row) => [row.id, row.part_of]));
    const own = new Map(rows.map((row) => [row.id, row.drift_count]));
    const totals = rollUp(parents.keys(), (id) => parents.get(id), (id) => own.get(id)!);
    for (const [id, total] of totals) this.statements.setDriftBelow.run(total, this.root, id);
  }

  private context(): EvalContext {
    this.partOfCache.clear();
    return {
      partOf: (id) => {
        if (this.partOfCache.has(id)) return this.partOfCache.get(id);
        const row = this.statements.partOf.get(this.root, id) as { part_of: string | null } | undefined;
        const value = row === undefined ? undefined : row.part_of;
        this.partOfCache.set(id, value);
        return value;
      },
      latestEvidence: (holon: string, side: EvidenceSide) => {
        const row = this.statements.latestEvidence.get(this.root, holon, side) as { record_json: string } | undefined;
        return row === undefined ? null : (JSON.parse(row.record_json) as Evidence);
      },
      latestConfirmation: (holon: string, side: EvidenceSide) => {
        const row = this.statements.latestConfirmation.get(this.root, holon, side) as { confirmation_json: string } | undefined;
        return row === undefined ? null : (JSON.parse(row.confirmation_json) as Confirmation);
      },
      writersTo: (target) =>
        (this.statements.seamsTo.all(this.root, target) as { from_id: string; read_only: number }[]).map((row) => ({
          from: row.from_id,
          readOnly: row.read_only === 1,
        })),
    };
  }

  private computed(row: HolonRow): ComputedHolon {
    return {
      holon: JSON.parse(row.holon_json) as Holon,
      evaluation: JSON.parse(row.evaluation_json) as StoredEvaluation,
      driftBelow: row.drift_below,
      childCount: (this.statements.childCount.get(this.root, row.id) as { n: number }).n,
    };
  }

  get(id: string): ComputedHolon | null {
    const row = this.statements.holon.get(this.root, id) as HolonRow | undefined;
    return row === undefined ? null : this.computed(row);
  }

  children(id: string): ComputedHolon[] {
    return (this.statements.children.all(this.root, id) as HolonRow[]).map((row) => this.computed(row));
  }

  seamsTo(id: string): { from: string; index: number }[] {
    return (this.statements.seamsTo.all(this.root, id) as { from_id: string; idx: number }[]).map((row) => ({ from: row.from_id, index: row.idx }));
  }

  size(): number {
    return (this.statements.countHolons.get(this.root) as { n: number }).n;
  }

  view(id: string): ViewOutput | null {
    const model = this.statements.model.get(this.root) as { now_ms: number; commit_sha: string } | undefined;
    if (model === undefined) return null;
    return viewOutput(this, id, model.now_ms, model.commit_sha);
  }

  drift(): DriftOutput {
    const model = this.statements.model.get(this.root) as { now_ms: number; commit_sha: string } | undefined;
    const rows = this.statements.withDrift.all(this.root) as { id: string; evaluation_json: string }[];
    return driftOutput(
      rows.map((row) => ({ id: row.id, drift: (JSON.parse(row.evaluation_json) as StoredEvaluation).drift })),
      model?.now_ms ?? 0,
      model?.commit_sha ?? "",
    );
  }

  check(): CheckOutput {
    const files = this.db
      .prepare("SELECT path, holon_id AS id, error FROM holon_files WHERE root = ? ORDER BY path")
      .all(this.root) as { path: string; id: string | null; error: string | null }[];
    const holons = (this.statements.allHolons.all(this.root) as { id: string; path: string; holon_json: string }[]).map((row) => {
      const holon = JSON.parse(row.holon_json) as Holon;
      return { id: row.id, path: row.path, partOf: holon.partOf, carriedBy: holon.carriedBy, seamTargets: holon.seams.map((seam) => seam.to) };
    });
    const confirmations = this.db
      .prepare("SELECT path, holon, error FROM confirmation_files WHERE root = ? ORDER BY path")
      .all(this.root) as { path: string; holon: string | null; error: string | null }[];
    return checkModel(files, holons, confirmations);
  }
}
