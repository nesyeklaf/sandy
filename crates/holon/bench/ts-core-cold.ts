import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalEnv } from "../../../extensions/sandy/holon/core/evaluate.ts";
import { parseEvidenceLines } from "../../../extensions/sandy/holon/core/format.ts";
import { Model, readConfirmationFile, readHolonFile } from "../../../extensions/sandy/holon/core/model.ts";
import { driftOutput, viewOutput } from "../../../extensions/sandy/holon/core/outputs.ts";
import { scanRoot } from "../../../extensions/sandy/holon/core/scan.ts";
import { contractHash } from "../../../extensions/sandy/holon/core/time.ts";

const [mode, root, viewId, out] = process.argv.slice(2);
if (root === undefined || (mode !== "cold" && mode !== "verify-tree")) {
  console.error("usage: ts-core-cold.ts cold <dir> <view-id> [<out-dir>] | ts-core-cold.ts verify-tree <dir>");
  process.exit(2);
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function verifyTree(dir: string): void {
  const BRANCH = 7;
  const DEPTH = 7;
  const KIND_AT_DEPTH = ["context", "system", "container", "component", "operation", "task", "step"];
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const planned: { id: string; partOf: string | null; depth: number; path: string; contract: string }[] = [];
  const plan = (parent: (typeof planned)[number] | null, depth: number, at: string): void => {
    const id = `h${planned.length}`;
    const item = { id, partOf: parent?.id ?? null, depth, path: `${at}/${id}.holon`, contract: `${id} works once, for 30 minutes, for the address it was sent to.` };
    planned.push(item);
    if (depth < DEPTH - 1) for (let index = 0; index < BRANCH; index += 1) plan(item, depth + 1, depth < 3 ? `${at}/${id}` : at);
  };
  plan(null, 0, "tree");
  const evidence: string[] = [];
  let mismatches = 0;
  for (const item of planned) {
    const target = planned[Math.floor(random() * planned.length)]!;
    const text = JSON.stringify(
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
    );
    if (readFileSync(join(dir, item.path), "utf8") !== text) mismatches += 1;
    const roll = random();
    if (roll < 0.9) {
      evidence.push(
        JSON.stringify({
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
        }),
      );
    }
  }
  const evidenceSame = readFileSync(join(dir, "evidence.jsonl"), "utf8") === evidence.map((line) => `${line}\n`).join("");
  console.log(JSON.stringify({ holons: planned.length, mismatchedFiles: mismatches, evidence: evidence.length, evidenceSame }));
}

function cold(dir: string, id: string, outDir: string | undefined): void {
  const env: EvalEnv = { nowMs: Date.parse("2026-11-08T12:00:00Z"), commit: "bench", code: { changedPaths: () => [] } };
  const results: Record<string, number> = {};
  const measure = <T>(label: string, run: () => T): T => {
    const start = performance.now();
    const value = run();
    results[label] = round(performance.now() - start);
    return value;
  };
  const total = performance.now();
  const scan = measure("scanMs", () => scanRoot(dir));
  const files = measure("readParseMs", () => ({
    holons: scan.holonFiles.map((file) => readHolonFile(file.path, readFileSync(join(dir, file.path), "utf8"))),
    confirmations: scan.confirmationFiles.map((file) => readConfirmationFile(file.path, readFileSync(join(dir, file.path), "utf8"))),
  }));
  const evidence = measure("evidenceMs", () => {
    const parsed = parseEvidenceLines(readFileSync(join(dir, "evidence.jsonl"), "utf8"));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  });
  const model = measure("modelMs", () => new Model(files.holons, files.confirmations, evidence));
  const evaluations = measure("evaluateMs", () => model.evaluate(env));
  const view = measure("viewMs", () => viewOutput(model, id, env.nowMs, env.commit));
  results.coldViewMs = round(performance.now() - total);
  const drift = measure("driftMs", () => driftOutput([...evaluations].map(([key, evaluation]) => ({ id: key, drift: evaluation.drift })), env.nowMs, env.commit));
  const check = measure("checkMs", () => model.check());
  if (outDir !== undefined) {
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(join(outDir, "ts-view.json"), json(view));
    writeFileSync(join(outDir, "ts-drift.json"), json(drift));
    writeFileSync(join(outDir, "ts-check.json"), json(check));
  }
  console.log(JSON.stringify({ holons: model.holons.size, ...results, driftEntries: drift.drift.length }));
}

if (mode === "verify-tree") verifyTree(root);
else cold(root, viewId!, out);
