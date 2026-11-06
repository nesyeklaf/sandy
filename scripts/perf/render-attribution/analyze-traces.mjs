import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { cpuProfiles, frameUrls } from "../lib/attribution.mjs";
import { loadSourceMaps, sourceResolver } from "../lib/sourcemap.mjs";
import { analyzeSwitch, contentDoneMs, pluginAssetHash } from "./analyze-switch.mjs";
import { GENUI_HASH, VARIANTS } from "./proxy.mjs";

const repoRelative = (resolveSource) => (url, line, column) => {
  const mapped = resolveSource(url, line, column);
  if (!mapped) return mapped;
  return { ...mapped, source: mapped.source.replace(/^.*?\/worktrees\/[^/]+\/sandy\//, "") };
};

export const analyzeEvents = async (events, { labDir, variant, pluginByHash, cache, probe }) => {
  const config = VARIANTS[variant];
  const urls = frameUrls(cpuProfiles(events));
  const genuiUrls = urls.filter((url) => pluginAssetHash(url) === GENUI_HASH);
  const hostUrls = urls.filter((url) => pluginAssetHash(url) === null);
  await loadSourceMaps(hostUrls, { directory: join(labDir, config.host, "assets"), cache });
  if (config.genui) await loadSourceMaps(genuiUrls, { directory: join(labDir, config.genui), cache });
  for (const url of urls) if (!cache.has(url)) cache.set(url, null);
  const endMs = probe ? Math.max(contentDoneMs(probe) ?? 0, probe.collectorMs ?? 0) || null : null;
  return analyzeSwitch(events, { pluginByHash, resolve: repoRelative(sourceResolver(cache)), endMs });
};

const main = async () => {
  const { values } = parseArgs({ options: { run: { type: "string" }, lab: { type: "string" } } });
  if (!values.run || !values.lab) throw new Error("usage: analyze-traces.mjs --run <dir> --lab <dir>");
  const path = join(values.run, "rounds.json");
  const data = JSON.parse(readFileSync(path, "utf8"));
  const caches = new Map();
  let count = 0;
  for (const result of data.results)
    for (const sample of result.samples) {
      if (!sample.tracePath) continue;
      const served = sample.variant.split("~")[0];
      const [labName, variant] = served.includes(":") ? served.split(":") : ["", served];
      const labDir = data.labs?.find((lab) => (lab.name ?? "") === labName)?.dir ?? values.lab;
      const cache = caches.get(served) ?? caches.set(served, new Map()).get(served);
      const events = JSON.parse(gunzipSync(readFileSync(sample.tracePath)).toString("utf8"));
      try {
        sample.analysis = await analyzeEvents(events, { labDir, variant, pluginByHash: data.pluginByHash, cache, probe: sample.probe });
      } catch (error) {
        sample.analysis = { error: String(error?.stack ?? error).slice(0, 500) };
      }
      count += 1;
    }
  writeFileSync(path, JSON.stringify(data, null, 1));
  console.log("reanalyzed", count);
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
