import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { contentDoneMs, HARNESS } from "./analyze-switch.mjs";

const { values } = parseArgs({ options: { run: { type: "string" }, out: { type: "string" } } });
if (!values.run || !values.out) throw new Error("usage: report.mjs --run <dir with rounds.json> --out <dir>");
const data = JSON.parse(readFileSync(join(values.run, "rounds.json"), "utf8"));

const median = (list) => {
  const sorted = list.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const random = (() => {
  let seed = 0x2545f491;
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };
})();

const resample = (list) => list.map(() => list[Math.floor(random() * list.length)]);

const bootstrap = (statistic, lists, iterations = 4000) => {
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const value = statistic(...lists.map(resample));
    if (value !== null) values.push(value);
  }
  values.sort((a, b) => a - b);
  return [values[Math.floor(values.length * 0.025)], values[Math.ceil(values.length * 0.975) - 1]];
};

const round1 = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);
const fmt = (value) => (value === null || value === undefined ? "–" : String(Math.round(value)));
const withCi = (list) => {
  const clean = list.filter((value) => typeof value === "number");
  if (clean.length === 0) return { median: null, ci: [null, null], n: 0 };
  const ci = clean.length >= 3 ? bootstrap(median, [clean]) : [null, null];
  return { median: round1(median(clean)), ci: ci.map(round1), n: clean.length };
};
const cellText = (stat) => (stat.median === null ? "–" : stat.ci[0] === null ? fmt(stat.median) : fmt(stat.median) + " [" + fmt(stat.ci[0]) + "–" + fmt(stat.ci[1]) + "]");

const samples = data.results.flatMap((result) => (result.valid === false ? [] : result.samples));
const invalidRounds = data.results.filter((result) => result.valid === false || result.error).map((result) => ({ variant: result.variant, round: result.round, error: result.error ?? null, validity: result.validity ?? null }));
const okSample = (sample) => sample.probe !== null && sample.probe.timedOut === false && sample.waitMs !== null;
const rejected = samples.filter((sample) => !okSample(sample)).map((sample) => ({ variant: sample.variant, round: sample.round, cell: sample.key + "-" + sample.visit, timedOut: sample.probe?.timedOut ?? null, waitMs: sample.waitMs }));
const valid = samples.filter(okSample);

const CELLS = ["9xa-first", "9xa-revisit", "s9b-first", "s9b-revisit", "yks-first", "yks-revisit"];
const cellOf = (sample) => sample.key + "-" + sample.visit;
const pick = (variant, cell) => valid.filter((sample) => sample.variant === variant && cellOf(sample) === cell);

const MILESTONES = [
  ["collectorMs", "field-latency switch (replica)"],
  ["waitMs", "lab ready (rows + paint)"],
  ["cardsPaintMs", "all genui cards painted"],
  ["contentDoneMs", "last write outside the sidebar painted"],
  ["pluginDoneMs", "last plugin DOM write painted"],
  ["allDoneMs", "last DOM write painted"],
];
const sidebarLateBurst = (sample) => sample.probe.batches.some((batch) => batch.owners["sandy-sidebar-delegate"] && batch.at > sample.waitMs + 300);
const milestoneValue = (sample, key) => (key === "waitMs" ? sample.waitMs : key === "contentDoneMs" ? contentDoneMs(sample.probe) : sample.probe?.[key] ?? null);

const variants = Object.keys(data.variants);
const milestones = {};
for (const variant of variants)
  for (const cell of CELLS)
    for (const [key] of MILESTONES) {
      milestones[variant] ??= {};
      milestones[variant][cell] ??= {};
      milestones[variant][cell][key] = withCi(pick(variant, cell).map((sample) => milestoneValue(sample, key)));
    }

const genuiDelta = {};
for (const cell of CELLS) {
  genuiDelta[cell] = {};
  for (const [key] of MILESTONES) {
    const on = pick("prod~bare", cell).map((sample) => milestoneValue(sample, key)).filter((value) => typeof value === "number");
    const off = pick("genui-off~bare", cell).map((sample) => milestoneValue(sample, key)).filter((value) => typeof value === "number");
    if (on.length < 3 || off.length < 3) continue;
    const diff = (a, b) => median(a) - median(b);
    genuiDelta[cell][key] = { median: round1(diff(on, off)), ci: bootstrap(diff, [on, off]).map(round1), n: [on.length, off.length] };
  }
}

const traced = (variant, cell) => pick(variant, cell).filter((sample) => sample.analysis && !sample.analysis.error);

const leaves = (analysis) => {
  const out = new Map();
  const put = (path, value) => out.set(path, (out.get(path) ?? 0) + value);
  for (const [key, value] of Object.entries(analysis.jsModules)) {
    const [owner, module] = key.split("\u0000");
    put((owner === "host" ? "host (app)" : owner === HARNESS ? HARNESS : "plugin " + owner) + "/js " + module, value);
  }
  for (const [category, value] of Object.entries(analysis.browser)) put("browser engine/" + category, value);
  for (const [name, value] of Object.entries(analysis.native)) put("browser engine/" + name.replace(/[()]/g, ""), value);
  const counted = [...out.values()].reduce((sum, value) => sum + value, 0);
  put("idle or unsampled/main thread idle", Math.max(0, analysis.idleMs));
  put("idle or unsampled/busy but unattributed", Math.max(0, analysis.busyMs - counted));
  return out;
};

const ownerTotals = (analysis) => {
  const out = new Map();
  for (const [path, value] of leaves(analysis)) {
    const owner = path.split("/")[0];
    out.set(owner, (out.get(owner) ?? 0) + value);
  }
  return out;
};

const MIN_LEAF_MS = 0.5;
const attribution = [];
const ownerSummary = {};
for (const variant of ["prod", "genui-off", "profiling"]) {
  ownerSummary[variant] = {};
  for (const cell of CELLS) {
    const list = traced(variant, cell);
    if (list.length === 0) continue;
    const perSample = list.map((sample) => leaves(sample.analysis));
    const paths = new Set(perSample.flatMap((map) => [...map.keys()]));
    if (variant === "prod") {
      const rest = new Map();
      for (const path of paths) {
        const size = median(perSample.map((map) => map.get(path) ?? 0));
        const owner = path.split("/")[0];
        if (size >= MIN_LEAF_MS) attribution.push({ path: "switch/" + cell + "/" + path, size: round1(size) });
        else rest.set(owner, (rest.get(owner) ?? 0) + size);
      }
      for (const [owner, size] of rest) if (size >= 0.05) attribution.push({ path: "switch/" + cell + "/" + owner + "/(small modules)", size: round1(size) });
    }
    const totals = list.map((sample) => ownerTotals(sample.analysis));
    const owners = new Set(totals.flatMap((map) => [...map.keys()]));
    ownerSummary[variant][cell] = Object.fromEntries(
      [...owners]
        .map((owner) => [owner, withCi(totals.map((map) => map.get(owner) ?? 0))])
        .sort((a, b) => b[1].median - a[1].median),
    );
    ownerSummary[variant][cell]["(trace window)"] = withCi(list.map((sample) => sample.analysis.windowMs));
  }
}
writeFileSync(join(values.out, "attribution.json"), JSON.stringify(attribution, null, 1));

const pluginJs = {};
for (const cell of CELLS) {
  const list = traced("prod", cell);
  const owners = new Set(list.flatMap((sample) => Object.keys(sample.analysis.jsByStackOwner)));
  pluginJs[cell] = Object.fromEntries(
    [...owners]
      .map((owner) => [owner, { stack: withCi(list.map((sample) => sample.analysis.jsByStackOwner[owner] ?? 0)), leaf: withCi(list.map((sample) => sample.analysis.jsByLeafOwner[owner] ?? 0)), beforeReady: withCi(list.map((sample) => sample.analysis.jsBeforeReadyByOwner[owner] ?? 0)) }])
      .sort((a, b) => b[1].stack.median - a[1].stack.median),
  );
}

const functionsTop = {};
for (const cell of CELLS) {
  const list = traced("prod", cell);
  const keys = new Set(list.flatMap((sample) => Object.keys(sample.analysis.jsFunctions)));
  functionsTop[cell] = [...keys]
    .map((key) => ({ key: key.replace("\u0000", " :: "), ms: round1(median(list.map((sample) => sample.analysis.jsFunctions[key] ?? 0))) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 25);
}

const reactAttribution = [];
const reactTop = {};
for (const cell of CELLS) {
  const list = pick("profiling", cell).filter((sample) => sample.probe?.react?.length > 0);
  if (list.length === 0) continue;
  const maps = list.map((sample) => new Map(sample.probe.react.map((entry) => [entry.owner + "/" + entry.component, entry.ms])));
  const keys = new Set(maps.flatMap((map) => [...map.keys()]));
  const rows = [...keys].map((key) => ({ key, ms: median(maps.map((map) => map.get(key) ?? 0)) })).sort((a, b) => b.ms - a.ms);
  for (const row of rows) if (row.ms >= 0.3) reactAttribution.push({ path: "react/" + cell + "/" + row.key, size: round1(row.ms) });
  const owners = new Map();
  for (const map of maps)
    for (const [key, value] of map) {
      const owner = key.split("/")[0];
      owners.set(owner, [...(owners.get(owner) ?? []), [map, value]]);
    }
  const ownerTotal = (map, owner) => [...map.entries()].filter(([key]) => key.split("/")[0] === owner).reduce((sum, [, value]) => sum + value, 0);
  reactTop[cell] = {
    components: rows.slice(0, 20).map((row) => ({ component: row.key, ms: round1(row.ms) })),
    owners: Object.fromEntries([...owners.keys()].map((owner) => [owner, withCi(maps.map((map) => ownerTotal(map, owner)))]).sort((a, b) => b[1].median - a[1].median)),
    commits: withCi(list.map((sample) => sample.probe.commits.length)),
    renderTotal: withCi(list.map((sample) => sample.probe.commits.reduce((sum, commit) => sum + commit.renderMs, 0))),
  };
}
writeFileSync(join(values.out, "attribution-react.json"), JSON.stringify(reactAttribution, null, 1));

const medianSample = (variant, cell) => {
  const list = traced(variant, cell).filter((sample) => sample.doneMs !== null).sort((a, b) => a.doneMs - b.doneMs);
  return list[(list.length - 1) >> 1] ?? null;
};
const waterfallOf = (sample) => {
  const probe = sample.probe;
  const rows = [];
  const phase = (name, from, to) => {
    if (from === null || to === null || to < from) return;
    rows.push({ name, start: round1(from), duration: round1(to - from), depth: 0 });
  };
  phase("pointerdown → field-latency switch done", 0, probe.collectorMs);
  phase("field-latency done → lab ready painted", probe.collectorMs, sample.waitMs);
  phase("ready → all genui cards painted", Math.max(sample.waitMs, probe.collectorMs ?? 0), probe.cardsPaintMs);
  phase("cards → last plugin write painted", probe.cardsPaintMs ?? sample.waitMs, probe.pluginDoneMs);
  for (const request of sample.analysis.network) {
    if (request.end === null) continue;
    rows.push({ name: "net " + request.path, start: request.start, duration: round1(Math.max(0.1, request.end - request.start)), depth: 1 });
  }
  for (const row of sample.analysis.waterfall) rows.push({ ...row, depth: row.depth + 1 });
  return rows.sort((a, b) => a.depth - b.depth || a.start - b.start);
};
const waterfallMeta = {};
for (const cell of ["9xa-revisit", "9xa-first"]) {
  const sample = medianSample("prod", cell);
  if (!sample) continue;
  writeFileSync(join(values.out, "waterfall-" + cell + ".json"), JSON.stringify(waterfallOf(sample), null, 1));
  waterfallMeta[cell] = { round: sample.round, doneMs: round1(sample.doneMs), waitMs: round1(sample.waitMs), trace: sample.tracePath };
}

const forcedSummary = {};
const styleSummary = {};
for (const cell of CELLS) {
  const list = traced("prod", cell);
  const byOwner = list.map((sample) => {
    const map = new Map();
    for (const entry of sample.analysis.forced) map.set((entry.owner ?? "?") + " " + (entry.stack[0] ? entry.stack[0].url + " " + entry.stack[0].fn : "(no stack)"), (map.get((entry.owner ?? "?") + " " + (entry.stack[0] ? entry.stack[0].url + " " + entry.stack[0].fn : "(no stack)")) ?? 0) + entry.ms);
    return map;
  });
  const keys = new Set(byOwner.flatMap((map) => [...map.keys()]));
  forcedSummary[cell] = [...keys].map((key) => ({ key, ms: round1(median(byOwner.map((map) => map.get(key) ?? 0))) })).filter((row) => row.ms >= 0.5).sort((a, b) => b.ms - a.ms).slice(0, 10);
  const biggest = list.map((sample) => [...sample.analysis.styleRecalcs].sort((a, b) => b.ms - a.ms).slice(0, 3));
  styleSummary[cell] = {
    recalcCount: withCi(list.map((sample) => sample.analysis.styleRecalcs.length)),
    biggest: biggest[(biggest.length - 1) >> 1] ?? [],
    longTasks: withCi(list.map((sample) => sample.analysis.longTasks.length)),
    longestTask: withCi(list.map((sample) => Math.max(0, ...sample.analysis.longTasks.map((task) => task.ms)))),
  };
}

const overhead = {};
const sidebarBursts = {};
for (const cell of CELLS) {
  const bare = median(pick("prod~bare", cell).map((sample) => sample.waitMs));
  const tracedReady = median(pick("prod", cell).map((sample) => sample.waitMs));
  overhead[cell] = bare && tracedReady ? Math.round((tracedReady / bare) * 100) / 100 : null;
  sidebarBursts[cell] = Object.fromEntries(variants.map((variant) => [variant, pick(variant, cell).filter(sidebarLateBurst).length + "/" + pick(variant, cell).length]));
}

const summary = { node: data.node, variants: data.variants, invalidRounds, rejected, n: valid.length, milestones, genuiDelta, ownerSummary, pluginJs, functionsTop, reactTop, forcedSummary, styleSummary, overhead, sidebarBursts, waterfallMeta };
writeFileSync(join(values.out, "summary.json"), JSON.stringify(summary, null, 1));

const lines = [];
lines.push("# Switch milestones (ms from pointerdown, median [95% bootstrap CI]); ~bare = untraced, others under CPU profiler + trace", "");
for (const variant of ["prod~bare", "genui-off~bare", "prod", "genui-off", "profiling"]) {
  if (!milestones[variant]) continue;
  lines.push("## " + variant, "", "| cell | n | " + MILESTONES.map(([, label]) => label).join(" | ") + " |", "|---|---|" + MILESTONES.map(() => "---").join("|") + "|");
  for (const cell of CELLS) lines.push("| " + cell + " | " + milestones[variant][cell].waitMs.n + " | " + MILESTONES.map(([key]) => cellText(milestones[variant][cell][key])).join(" | ") + " |");
  lines.push("");
}
lines.push("## genui cost on wall time (prod~bare minus genui-off~bare, median difference [95% CI])", "", "| cell | " + MILESTONES.map(([, label]) => label).join(" | ") + " |", "|---|" + MILESTONES.map(() => "---").join("|") + "|");
for (const cell of CELLS) lines.push("| " + cell + " | " + MILESTONES.map(([key]) => (genuiDelta[cell][key] ? cellText(genuiDelta[cell][key]) : "–")).join(" | ") + " |");
lines.push("", "Late sandy-sidebar-delegate write bursts (> 300 ms after ready), switches with burst / switches: " + JSON.stringify(sidebarBursts));
lines.push("", "# Main-thread time by owner, prod traced (ms, median [95% CI]); trace overhead factor on lab ready (traced / bare): " + JSON.stringify(overhead), "");
const ownerNames = [...new Set(CELLS.flatMap((cell) => Object.keys(ownerSummary.prod[cell] ?? {})))];
lines.push("| owner | " + CELLS.join(" | ") + " |", "|---|" + CELLS.map(() => "---").join("|") + "|");
for (const owner of ownerNames) lines.push("| " + owner + " | " + CELLS.map((cell) => (ownerSummary.prod[cell]?.[owner] ? cellText(ownerSummary.prod[cell][owner]) : "–")).join(" | ") + " |");
lines.push("", "# JS self time by plugin (nearest plugin frame on the stack), prod traced", "");
const pluginNames = [...new Set(CELLS.flatMap((cell) => Object.keys(pluginJs[cell] ?? {})))];
lines.push("| plugin | " + CELLS.join(" | ") + " |", "|---|" + CELLS.map(() => "---").join("|") + "|");
for (const plugin of pluginNames) lines.push("| " + plugin + " | " + CELLS.map((cell) => (pluginJs[cell]?.[plugin] ? cellText(pluginJs[cell][plugin].stack) : "–")).join(" | ") + " |");
lines.push("", "# React render self time by owner, profiling build (ms, median [95% CI])", "");
const reactOwners = [...new Set(CELLS.flatMap((cell) => Object.keys(reactTop[cell]?.owners ?? {})))];
lines.push("| owner | " + CELLS.join(" | ") + " |", "|---|" + CELLS.map(() => "---").join("|") + "|");
for (const owner of reactOwners) lines.push("| " + owner + " | " + CELLS.map((cell) => (reactTop[cell]?.owners[owner] ? cellText(reactTop[cell].owners[owner]) : "–")).join(" | ") + " |");
lines.push("| (all commits) | " + CELLS.map((cell) => (reactTop[cell] ? cellText(reactTop[cell].renderTotal) : "–")).join(" | ") + " |");
writeFileSync(join(values.out, "summary.md"), lines.join("\n") + "\n");
console.log("valid", valid.length, "rejected", rejected.length, "invalid rounds", invalidRounds.length, "attribution", attribution.length, "react", reactAttribution.length);
