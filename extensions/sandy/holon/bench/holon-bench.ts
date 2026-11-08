import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { EvalEnv } from "../core/evaluate.ts";
import type { Evidence } from "../core/format.ts";
import { contractHash } from "../core/time.ts";
import { HolonIndex } from "../index/holon-index.ts";
import { MIGRATIONS } from "../index/schema.ts";
import { HolonService } from "../service.ts";

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

async function measureAsync<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const value = await run();
  results[label] = Math.round((performance.now() - start) * 1000) / 1000;
  return value;
}

const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, "-c", "user.name=bench", "-c", "user.email=bench@bench", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
measure("gitCommitAllMs", () => {
  git("init", "-q", "-b", "main");
  git("add", "-A", "tree");
  git("commit", "-qm", "bench");
}, results);

const serviceDb = new Database(join(root, "service.db"));
serviceDb.pragma("journal_mode = WAL");
for (const statement of MIGRATIONS) serviceDb.exec(statement);
const service = new HolonService(serviceDb);
const serviceCold = await measureAsync("serviceColdOpenMs", () => service.open(root, {}));
serviceCold.index.recordEvidence(evidence, serviceCold.env);
const viewThroughService = async (id: string) => {
  const { index: opened, stats } = await service.open(root, {});
  return { view: opened.view(id), stats };
};
await viewThroughService(component.id);
const viewReps = 200;
let unchangedStats = null;
await measureAsync("serviceView200UnchangedMs", async () => {
  for (let rep = 0; rep < viewReps; rep += 1) unchangedStats = (await viewThroughService(component.id)).stats;
});
results.serviceViewUnchangedMs = Math.round((results.serviceView200UnchangedMs! / viewReps) * 1000) / 1000;

const edited = planned.find((item) => item.partOf === component.id)!;
const editedText = (title: string) =>
  JSON.stringify({ format: "holon/v0", id: edited.id, kind: KIND_AT_DEPTH[edited.depth], partOf: edited.partOf, title, status: "active", why: "x", contract: "y", carriedBy: [], code: [], seams: [], proofs: {} });
writeFileSync(join(root, edited.path), editedText("Edited for the service benchmark"));
const afterEdit = await measureAsync("serviceViewAfterOneEditMs", () => viewThroughService(component.id));
const reflectsEdit = afterEdit.view!.children.find((child) => child.id === edited.id)?.title === "Edited for the service benchmark";

rmSync(join(root, edited.path));
const afterDelete = await measureAsync("serviceViewAfterDeleteMs", () => viewThroughService(component.id));
const seesDelete = afterDelete.view!.children.every((child) => child.id !== edited.id);
mkdirSync(join(root, "tree/new-dir"), { recursive: true });
writeFileSync(join(root, "tree/new-dir", `${edited.id}.holon`), editedText("Added in a new directory"));
const afterAdd = await measureAsync("serviceViewAfterNewFileMs", () => viewThroughService(component.id));
const seesNew = afterAdd.view!.children.find((child) => child.id === edited.id)?.title === "Added in a new directory";
git("commit", "-qam", "second");
const afterCommit = await measureAsync("serviceViewAfterCommitMs", () => viewThroughService(component.id));
const fullCheck = await measureAsync("serviceExplicitCheckMs", () => service.open(root, {}, "full"));
service.close();
serviceDb.close();

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
      service: {
        cold: serviceCold.stats,
        unchanged: unchangedStats,
        afterEdit: afterEdit.stats,
        reflectsEdit,
        afterDelete: afterDelete.stats,
        seesDelete,
        afterNewFile: afterAdd.stats,
        seesNew,
        afterCommit: afterCommit.stats,
        explicitCheck: fullCheck.stats,
      },
    },
    null,
    1,
  ),
);
db.close();
rmSync(root, { recursive: true, force: true });
