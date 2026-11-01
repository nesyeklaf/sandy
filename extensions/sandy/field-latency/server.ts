import { PluginCliError, cliCommand, defineCli, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { AUTOMATED_USER_AGENT_MARKER, clientSchema, isAutomatedBrowser, rpcContract, sampleSchema, type Sample } from "./contract.ts";
import { UNKNOWN_RELEASE, releaseKey } from "./release.ts";
import { compareLastTwo, formatReleases, summarizeReleases, type ReleaseSample } from "./releases.ts";
import { formatReport, primaryMs, summarize, type DeviceInfo } from "./stats.ts";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    sample TEXT NOT NULL,
    client TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS samples_at ON samples (at)",
  "ALTER TABLE samples ADD COLUMN release TEXT",
  "CREATE INDEX IF NOT EXISTS samples_release ON samples (release)",
];

const DAY_MS = 86400000;

interface Row {
  sample: string;
}

interface ReleaseRow {
  sample: string;
  release: string | null;
}

interface DeviceRow {
  client: string;
  at: number;
}

interface FirstSeenRow {
  release: string;
  firstSeen: number;
}

function parseRows(rows: readonly Row[]): Sample[] {
  const samples: Sample[] = [];
  for (const row of rows) {
    const parsed = sampleSchema.safeParse(JSON.parse(row.sample));
    if (parsed.success) samples.push(parsed.data);
  }
  return samples;
}

function parseReleaseRows(rows: readonly ReleaseRow[]): ReleaseSample[] {
  const items: ReleaseSample[] = [];
  for (const row of rows) {
    const parsed = sampleSchema.safeParse(JSON.parse(row.sample));
    if (parsed.success) items.push({ release: row.release ?? UNKNOWN_RELEASE, sample: parsed.data });
  }
  return items;
}

function parseDevices(rows: readonly DeviceRow[]): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const row of rows) {
    const parsed = clientSchema.safeParse(JSON.parse(row.client));
    if (!parsed.success) continue;
    const { benchmarkIndex, cores, deviceMemoryGb, devicePixelRatio, userAgent } = parsed.data;
    devices.push({ benchmarkIndex, cores, deviceMemoryGb, devicePixelRatio, userAgent, lastSeen: row.at });
  }
  return devices;
}

function sinceText(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace("T", " ").slice(0, 16);
}

export default function fieldLatency(sandy: SandyPluginApi) {
  const db = sandy.storage.database();
  sandy.storage.migrate(db, MIGRATIONS);
  db.exec(
    `CREATE TEMP VIEW IF NOT EXISTS field_samples AS SELECT * FROM samples
     WHERE COALESCE(json_extract(client, '$.userAgent'), '') NOT LIKE '%${AUTOMATED_USER_AGENT_MARKER}%'`,
  );
  const insert = db.prepare("INSERT INTO samples (at, kind, label, sample, client, release) VALUES (?, ?, ?, ?, ?, ?)");
  const since = db.prepare<[number], Row>("SELECT sample FROM field_samples WHERE at >= ? ORDER BY at");
  const sinceKind = db.prepare<[number, string], Row>("SELECT sample FROM field_samples WHERE at >= ? AND kind = ? ORDER BY at");
  const sinceRelease = db.prepare<[number], ReleaseRow>("SELECT sample, release FROM field_samples WHERE at >= ? ORDER BY at");
  const sinceKindRelease = db.prepare<[number, string], ReleaseRow>(
    "SELECT sample, release FROM field_samples WHERE at >= ? AND kind = ? ORDER BY at",
  );
  const firstSeen = db.prepare<[], FirstSeenRow>(
    "SELECT COALESCE(release, 'unknown') AS release, MIN(at) AS firstSeen FROM field_samples GROUP BY COALESCE(release, 'unknown')",
  );
  const devices = db.prepare<[number], DeviceRow>(
    `SELECT client, MAX(at) AS at FROM field_samples
     WHERE at >= ? AND json_extract(client, '$.benchmarkIndex') IS NOT NULL
     GROUP BY json_extract(client, '$.userAgent'), json_extract(client, '$.cores')
     ORDER BY at DESC`,
  );
  const recent = db.prepare<[number], Row>("SELECT sample FROM field_samples ORDER BY at DESC LIMIT ?");

  sandy.rpc.register(rpcContract, {
    record({ client, samples }) {
      if (isAutomatedBrowser(client.userAgent, false)) return { stored: 0 };
      const clientJson = JSON.stringify(client);
      const release = releaseKey(client);
      const store = db.transaction((items: readonly Sample[]) => {
        for (const sample of items) insert.run(sample.at, sample.kind, sample.label, JSON.stringify(sample), clientJson, release);
      });
      store(samples);
      return { stored: samples.length };
    },
  });

  sandy.cli.register(
    defineCli({
      name: "field-latency",
      summary: "Menu, popover, dialog and thread-switch latency measured in your own browser",
      commands: {
        report: cliCommand({
          summary: "Percentiles per interaction, slowest first; --by-release groups p75 by sandy release and compares the last two",
          options: {
            since: { type: "duration", defaultUnit: "h", default: 7 * DAY_MS, description: "How far back (default 7d)" },
            kind: { type: "enum", values: ["open", "switch", "slow", "scroll"], description: "Only this kind" },
            "by-release": { type: "boolean", description: "Group p75 per release (first seen, release key, n) and compare the last two releases" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run(input) {
            const from = Date.now() - input.options.since;
            const sinceLabel = sinceText(input.options.since);
            const deviceList = parseDevices(devices.all(from));
            const device = deviceList[0] ?? null;
            if (input.options["by-release"]) {
              const rows = input.options.kind ? sinceKindRelease.all(from, input.options.kind) : sinceRelease.all(from);
              const seen = new Map(firstSeen.all().map((row) => [row.release, row.firstSeen]));
              const releases = summarizeReleases(parseReleaseRows(rows), seen);
              const compare = compareLastTwo(releases);
              if (input.options.json) {
                return { exitCode: 0, stdout: JSON.stringify({ since: sinceLabel, device, devices: deviceList, releases, compare }, null, 2) };
              }
              return { exitCode: 0, stdout: formatReleases(releases, compare, sinceLabel, device) };
            }
            const rows = input.options.kind ? sinceKind.all(from, input.options.kind) : since.all(from);
            const groups = summarize(parseRows(rows));
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ since: sinceLabel, device, devices: deviceList, groups }, null, 2) };
            }
            return { exitCode: 0, stdout: formatReport(groups, sinceLabel, device) };
          },
        }),
        recent: cliCommand({
          summary: "The latest samples, newest first",
          options: {
            limit: { type: "integer", min: 1, max: 500, default: 20, description: "How many" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run(input) {
            const samples = parseRows(recent.all(input.options.limit));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(samples, null, 2) };
            const lines = samples.map((sample) => {
              if (sample.scroll !== null) {
                const time = new Date(sample.at).toISOString().slice(11, 19);
                const scroll = sample.scroll;
                return `${time}  scroll ${String(scroll.smoothnessPct).padStart(7)}%  dropped ${scroll.dropped}/${scroll.frames}  p95 frame ${scroll.p95FrameMs} ms (refresh ${scroll.refreshMs})  ${sample.label}`;
              }
              const time = new Date(sample.at).toISOString().slice(11, 19);
              const main = primaryMs(sample);
              const value = sample.timedOut ? "timeout" : main === null ? "-" : `${Math.round(main)} ms`;
              const visit = sample.visit ? ` (${sample.visit})` : "";
              return `${time}  ${sample.kind.padEnd(6)} ${value.padStart(8)}  event ${sample.eventMs ?? "-"}  style+layout ${sample.styleLayoutMs}  ${sample.label}${visit}`;
            });
            return { exitCode: 0, stdout: lines.length > 0 ? lines.join("\n") : "No samples yet." };
          },
        }),
        clear: cliCommand({
          summary: "Delete every stored sample",
          options: { yes: { type: "boolean", description: "Confirm" } },
          async run(input) {
            if (!input.options.yes) throw new PluginCliError("Pass --yes to delete every sample", { code: "confirmation_required" });
            const { changes } = db.prepare("DELETE FROM samples").run();
            return { exitCode: 0, stdout: `Deleted ${changes} samples` };
          },
        }),
      },
    }),
  );
}
