import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { EvalEnv } from "../core/evaluate.ts";
import type { Evidence } from "../core/format.ts";
import { contractHash } from "../core/time.ts";
import { HolonIndex } from "../index/holon-index.ts";
import { MIGRATIONS } from "../index/schema.ts";

const BRANCH = 7;
const DEPTH = 7;
const KIND_AT_DEPTH = ["context", "system", "container", "component", "operation", "task", "step"];
const NOW = "2026-11-08T12:00:00Z";
const env: EvalEnv = { nowMs: Date.parse(NOW), commit: "bench", code: { changedPaths: () => [] } };

let seed = 42;
function random(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

interface Planned {
  id: string;
  partOf: string | null;
  depth: number;
  path: string;
  contract: string;
}

const root = mkdtempSync(join(tmpdir(), "holon-bench-"));
const planned: Planned[] = [];
const evidence: Evidence[] = [];

function plan(parent: Planned | null, depth: number, dir: string): void {
  const id = `h${planned.length}`;
  const path = `${dir}/${id}.holon`;
  const item = { id, partOf: parent?.id ?? null, depth, path, contract: `${id} works once, for 30 minutes, for the address it was sent to.` };
  planned.push(item);
  if (depth < DEPTH - 1) {
    const childDir = depth < 3 ? `${dir}/${id}` : dir;
    for (let index = 0; index < BRANCH; index += 1) plan(item, depth + 1, childDir);
  }
}

function measure<T>(label: string, run: () => T, results: Record<string, number>): T {
  const start = performance.now();
  const value = run();
  results[label] = Math.round((performance.now() - start) * 1000) / 1000;
  return value;
}

const results: Record<string, number> = {};
plan(null, 0, "tree");
measure(
  "writeFilesMs",
  () => {
    for (const item of planned) {
      mkdirSync(join(root, item.path, ".."), { recursive: true });
      const target = planned[Math.floor(random() * planned.length)]!;
      writeFileSync(
        join(root, item.path),
        JSON.stringify(
          {
            format: "holon/v0",
            id: item.id,
            kind: KIND_AT_DEPTH[item.depth],
            partOf: item.partOf,
            title: `Holon ${item.id}`,
            status: "active",
            why: `Serves ${item.partOf ?? "the world"} so that users can do something useful without friction.`,
            contract: item.contract,
            carriedBy: [],
            code: [`src/${item.id}.ts`],
            seams: target.id === item.id ? [] : [{ to: target.id, contract: "Reads what it needs", readOnly: true }],
            proofs: { It: { kind: "ci", source: `src/${item.id}.test.ts` }, I: { kind: "interview" } },
          },
          null,
          2,
        ),
      );
      const roll = random();
      if (roll < 0.9) {
        evidence.push({
          holon: item.id,
          side: "It",
          kind: "ci",
          source: `src/${item.id}.test.ts`,
          result: roll < 0.89 ? "pass" : "fail",
          contractHash: contractHash(item.contract),
          build: "bench",
          environment: "ci",
          at: "2026-11-01T00:00:00Z",
          expires: roll < 0.8 ? null : "2026-11-05T00:00:00Z",
          detail: "",
        });
      }
    }
  },
  results,
);

const db = new Database(join(root, "data.db"));
db.pragma("journal_mode = WAL");
for (const statement of MIGRATIONS) db.exec(statement);
const index = new HolonIndex(db, root);
measure("recordEvidenceMs", () => index.recordEvidence(evidence, env), results);
const cold = measure("coldIndexMs", () => index.refresh(env), results);
const warm = measure("refreshUnchangedMs", () => index.refresh(env), results);

const leaf = planned[planned.length - 1]!;
writeFileSync(
  join(root, leaf.path),
  JSON.stringify({
    format: "holon/v0",
    id: leaf.id,
    kind: KIND_AT_DEPTH[leaf.depth],
    partOf: leaf.partOf,
    title: `Holon ${leaf.id}`,
    status: "active",
    why: "Changed for the benchmark.",
    contract: `${leaf.contract} Changed.`,
    carriedBy: [],
    code: [],
    seams: [],
    proofs: { It: { kind: "ci", source: `src/${leaf.id}.test.ts` } },
  }),
);
const beforeTop = index.get("h0")!.driftBelow;
const one = measure("reindexOneFileMs", () => index.reindexPaths([leaf.path], env), results);
const afterTop = index.get("h0")!.driftBelow;
writeFileSync(join(root, leaf.path), JSON.stringify({ format: "holon/v0", id: leaf.id, kind: "step", partOf: leaf.partOf, title: "again", status: "active", why: "x", contract: "y", carriedBy: [], code: [], seams: [], proofs: {} }));
const scanned = measure("refreshAfterOneEditMs", () => index.refresh(env), results);

const component = planned.find((item) => item.depth === 3)!;
const reps = 1000;
measure("view1000Ms", () => {
  for (let index_ = 0; index_ < reps; index_ += 1) index.view(component.id);
}, results);
results.viewMs = Math.round((results.view1000Ms! / reps) * 1000) / 1000;
const drift = measure("driftListMs", () => index.drift(), results);
measure("rollupTopMs", () => index.get("h0")!.driftBelow, results);

console.log(
  JSON.stringify(
    {
      holons: planned.length,
      depth: DEPTH,
      branch: BRANCH,
      evidence: evidence.length,
      ...results,
      cold,
      warm,
      reindexOne: one,
      refreshAfterOneEdit: scanned,
      driftEntries: drift.drift.length,
      driftBelowTop: { before: beforeTop, after: afterTop },
    },
    null,
    1,
  ),
);
db.close();
rmSync(root, { recursive: true, force: true });
