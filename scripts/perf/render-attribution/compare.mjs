import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compareRounds } from "../lib/ab-stats.mjs";
import { contentDoneMs } from "./analyze-switch.mjs";

const { values } = parseArgs({ options: { run: { type: "string" }, out: { type: "string" }, baseline: { type: "string" } } });
if (!values.run || !values.out) throw new Error("usage: compare.mjs --run <dir with rounds.json> --out <dir> [--baseline <lab name>]");
const data = JSON.parse(readFileSync(join(values.run, "rounds.json"), "utf8"));
const labNames = data.labs.map((lab) => lab.name);
const baseline = values.baseline ?? labNames[0];

const CELLS = ["9xa-first", "9xa-revisit", "s9b-first", "s9b-revisit", "yks-first", "yks-revisit"];
const MILESTONES = [
  ["waitMs", "ready"],
  ["cardsPaintMs", "cards"],
  ["contentDoneMs", "content done"],
];
const TRACED = [
  ["sampledJsMs", "js", (analysis) => analysis.sampledJsMs],
  ["style", "style", (analysis) => analysis.browser?.style ?? 0],
  ["layout", "layout", (analysis) => analysis.browser?.layout ?? 0],
];

const okSample = (sample) => sample.probe !== null && sample.probe.timedOut === false && sample.waitMs !== null;
const results = data.results.filter((result) => result.valid !== false);
const milestoneValue = (sample, key) => (key === "waitMs" ? sample.waitMs : key === "contentDoneMs" ? contentDoneMs(sample.probe) : sample.probe?.[key] ?? null);
const numeric = (value) => typeof value === "number" && Number.isFinite(value);

const roundsOf = (variant, cell, value) =>
  [...new Set(results.map((result) => result.round))].map((round) =>
    results
      .filter((result) => result.round === round && result.variant === variant)
      .flatMap((result) => result.samples)
      .filter((sample) => okSample(sample) && sample.key + "-" + sample.visit === cell)
      .map(value)
      .filter(numeric),
  );

const compare = (variantA, variantB, cell, value) => {
  const a = roundsOf(variantA, cell, value);
  const b = roundsOf(variantB, cell, value);
  const rounds = a.map((list, index) => ({ a: list, b: b[index] }));
  return { n: [a.flat().length, b.flat().length], ...compareRounds(rounds) };
};

const metrics = [
  ...MILESTONES.map(([key, label]) => ({ label, kind: "bare", value: (sample) => milestoneValue(sample, key) })),
  ...TRACED.map(([, label, read]) => ({ label: label + " (traced)", kind: "traced", value: (sample) => (sample.analysis && !sample.analysis.error ? read(sample.analysis) : null) })),
];
const variantOf = (lab, kind) => lab + ":prod" + (kind === "bare" ? "~bare" : "");

const table = {};
for (const lab of labNames)
  for (const cell of CELLS)
    for (const metric of metrics) {
      const result = compare(variantOf(baseline, metric.kind), variantOf(lab, metric.kind), cell, metric.value);
      ((table[lab] ??= {})[cell] ??= {})[metric.label] = result;
    }

const fmt = (value) => (value === null || value === undefined ? "–" : String(Math.round(value)));
const deltaText = (result) =>
  result.delta === null ? "–" : (result.delta > 0 ? "+" : "") + fmt(result.delta) + " [" + fmt(result.low) + ", " + fmt(result.high) + "]";
const lines = ["# Interleaved comparison against " + baseline, "", "Medians in ms; delta is lab minus " + baseline + " with a 95% round-clustered bootstrap interval. n = valid samples per side.", ""];
for (const metric of metrics) {
  lines.push("## " + metric.label, "", "| cell | " + labNames.join(" | ") + " |", "|---|" + labNames.map(() => "---").join("|") + "|");
  for (const cell of CELLS)
    lines.push(
      "| " + cell + " | " +
        labNames
          .map((lab) => {
            const result = table[lab][cell][metric.label];
            return lab === baseline ? fmt(result.b) + " (n " + result.n[1] + ")" : fmt(result.b) + " " + deltaText(result) + " (n " + result.n[1] + ")";
          })
          .join(" | ") +
        " |",
    );
  lines.push("");
}
const final = labNames.at(-1);
const bench = CELLS.map((cell) => {
  const result = table[final][cell]["content done"];
  return { name: cell + " content done", before: result.a, after: result.b, unit: "ms", better: "lower" };
});
const invalid = data.results.filter((result) => result.valid === false || result.error).map((result) => ({ variant: result.variant, round: result.round, error: result.error ?? null }));
writeFileSync(join(values.out, "compare.md"), lines.join("\n") + "\n");
writeFileSync(join(values.out, "compare.json"), JSON.stringify({ baseline, labs: data.labs, invalid, table }, null, 1));
writeFileSync(join(values.out, "bench.json"), JSON.stringify(bench, null, 1));
console.log(lines.join("\n"));
console.log("invalid rounds", JSON.stringify(invalid));
