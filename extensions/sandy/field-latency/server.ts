import { PluginCliError, cliCommand, defineCli, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { AUTOMATED_USER_AGENT_MARKER, clientSchema, isAutomatedBrowser, rpcContract, sampleSchema, type Sample } from "./contract.ts";
import { UNKNOWN_RELEASE, releaseKey } from "./release.ts";
import { compareLastTwo, formatCompare, formatReleases, formatReleaseTable, releaseTitle, summarizeReleases } from "./releases.ts";
import { formatGroups, formatWriters, primaryMs, reportTitle, formatReport, summarize, summarizeWriters, type DeviceInfo } from "./stats.ts";
import { formatDeviceTable, formatSectionTitle, matchDevices, partitionByDevice, profileFromClient, type DeviceMatch } from "./devices.ts";
import { loadCounts } from "./load.ts";
import { shortDeviceId } from "./device.ts";

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
  "ALTER TABLE samples ADD COLUMN device TEXT",
  "CREATE INDEX IF NOT EXISTS samples_device ON samples (device)",
];

const DAY_MS = 86400000;

interface DeviceSampleRow {
  sample: string;
  release: string | null;
  device: string | null;
}

interface ClientRow {
  client: string;
  at: number;
}

interface FirstSeenRow {
  release: string;
  firstSeen: number;
}

interface Item {
  device: string | null;
  release: string;
  sample: Sample;
}

function parseItems(rows: readonly DeviceSampleRow[]): Item[] {
  const items: Item[] = [];
  for (const row of rows) {
    const parsed = sampleSchema.safeParse(JSON.parse(row.sample));
    if (parsed.success) items.push({ device: row.device, release: row.release ?? UNKNOWN_RELEASE, sample: parsed.data });
  }
  return items;
}

function parseProfiles(rows: readonly ClientRow[]): DeviceInfo[] {
  const profiles: DeviceInfo[] = [];
  for (const row of rows) {
    const parsed = clientSchema.safeParse(JSON.parse(row.client));
    if (parsed.success) profiles.push(profileFromClient(parsed.data, row.at));
  }
  return profiles;
}

function contentText(sample: Sample): string {
  if (sample.contentDone === "settled" && sample.contentDoneMs !== null) return `${Math.round(sample.contentDoneMs)} ms`;
  if (sample.contentDone === "capped") return sample.contentDoneMs === null ? "capped" : `>${Math.round(sample.contentDoneMs)} ms (capped)`;
  return sample.contentDone ?? "-";
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
  const insert = db.prepare("INSERT INTO samples (at, kind, label, sample, client, release, device) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const firstSeen = db.prepare<[], FirstSeenRow>(
    "SELECT COALESCE(release, 'unknown') AS release, MIN(at) AS firstSeen FROM field_samples GROUP BY COALESCE(release, 'unknown')",
  );
  const knownDevices = db.prepare<[number], ClientRow>(
    `SELECT client, MAX(at) AS at FROM field_samples WHERE at >= ? AND device IS NOT NULL GROUP BY device ORDER BY at DESC`,
  );
  const legacyDevices = db.prepare<[number], ClientRow>(
    `SELECT client, MAX(at) AS at FROM field_samples
     WHERE at >= ? AND device IS NULL AND json_extract(client, '$.benchmarkIndex') IS NOT NULL
     GROUP BY json_extract(client, '$.userAgent'), json_extract(client, '$.cores')
     ORDER BY at DESC`,
  );
  const recent = db.prepare<[number], DeviceSampleRow>("SELECT sample, release, device FROM field_samples ORDER BY at DESC LIMIT ?");

  function selectItems(from: number, kind: string | undefined, match: DeviceMatch | null): Item[] {
    const conditions = ["at >= ?"];
    const params: (number | string)[] = [from];
    if (kind) {
      conditions.push("kind = ?");
      params.push(kind);
    }
    if (match !== null) {
      const parts: string[] = [];
      if (match.ids.length > 0) {
        parts.push(`device IN (${match.ids.map(() => "?").join(", ")})`);
        params.push(...match.ids);
      }
      if (match.unknown) parts.push("device IS NULL");
      conditions.push(`(${parts.join(" OR ")})`);
    }
    const rows = db
      .prepare<(number | string)[], DeviceSampleRow>(`SELECT sample, release, device FROM field_samples WHERE ${conditions.join(" AND ")} ORDER BY at`)
      .all(...params);
    return parseItems(rows);
  }

  sandy.rpc.register(rpcContract, {
    record({ client, samples }) {
      if (isAutomatedBrowser(client.userAgent, false)) return { stored: 0 };
      const clientJson = JSON.stringify(client);
      const release = releaseKey(client);
      const store = db.transaction((items: readonly Sample[]) => {
        for (const sample of items) insert.run(sample.at, sample.kind, sample.label, JSON.stringify(sample), clientJson, release, client.deviceId);
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
          summary: "Percentiles per interaction and device, slowest first; --by-release groups p75 by sandy release and compares the last two",
          options: {
            since: { type: "duration", defaultUnit: "h", default: 7 * DAY_MS, description: "How far back (default 7d)" },
            kind: { type: "enum", values: ["open", "switch", "slow", "scroll"], description: "Only this kind" },
            device: { type: "string", description: "Only this device: id prefix or part of its label (for example firefox, 'windows firefox', a1b2c3, unknown)" },
            merged: { type: "boolean", description: "One table over all devices instead of one section per device" },
            "by-release": { type: "boolean", description: "Group p75 per release (first seen, release key, n) and compare the last two releases" },
            "by-device": { type: "boolean", description: "With --by-release: one release table per device" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run(input) {
            const from = Date.now() - input.options.since;
            const sinceLabel = sinceText(input.options.since);
            const known = parseProfiles(knownDevices.all(from));
            const filter = input.options.device;
            const match = filter === undefined ? null : matchDevices(known, filter);
            if (match !== null && match.ids.length === 0 && !match.unknown) {
              throw new PluginCliError(
                `No device matches "${filter}". Seen: ${known.map((profile) => `${profile.label} #${shortDeviceId(profile.id)}`).join(", ") || "none"}`,
                { code: "device_not_found" },
              );
            }
            const selectedKnown = match === null ? known : known.filter((profile) => profile.id !== null && match.ids.includes(profile.id));
            const legacy = match === null || match.unknown ? parseProfiles(legacyDevices.all(from)) : [];
            const deviceList = [...selectedKnown, ...legacy];
            const device = (selectedKnown.length === 1 && match !== null ? selectedKnown[0] : deviceList.find((entry) => entry.benchmarkIndex !== null)) ?? null;
            const profiles = new Map(known.flatMap((profile) => (profile.id === null ? [] : [[profile.id, profile] as const])));
            const items = selectItems(from, input.options.kind, match);
            const sections = partitionByDevice(items, (item) => item.device, profiles);
            if (input.options["by-release"]) {
              const seen = new Map(firstSeen.all().map((row) => [row.release, row.firstSeen]));
              const byRelease = (list: readonly Item[]) => {
                const releases = summarizeReleases(list, seen);
                return { releases, compare: compareLastTwo(releases) };
              };
              const total = byRelease(items);
              const perDevice = input.options["by-device"] ? sections.map((section) => ({ device: section.device, n: section.items.length, ...byRelease(section.items) })) : null;
              if (input.options.json) {
                const body = { since: sinceLabel, device, devices: deviceList, ...total };
                return { exitCode: 0, stdout: JSON.stringify(perDevice === null ? body : { ...body, byDevice: perDevice }, null, 2) };
              }
              if (perDevice === null) return { exitCode: 0, stdout: formatReleases(total.releases, total.compare, sinceLabel, device) };
              if (items.length === 0) return { exitCode: 0, stdout: `No samples since ${sinceLabel}.` };
              const lines = [releaseTitle(sinceLabel), ""];
              sections.forEach((section, index) => {
                const entry = perDevice[index];
                if (entry === undefined) return;
                lines.push(formatSectionTitle(section), ...formatReleaseTable(entry.releases), ...formatCompare(entry.compare), "");
              });
              return { exitCode: 0, stdout: lines.join("\n").trimEnd() };
            }
            const groups = summarize(items.map((item) => item.sample));
            const perDevice = sections.map((section) => ({
              device: section.device,
              n: section.items.length,
              load: loadCounts(section.items.map((item) => item.sample)),
              groups: summarize(section.items.map((item) => item.sample)),
              writers: summarizeWriters(section.items.map((item) => item.sample)),
            }));
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ since: sinceLabel, device, devices: deviceList, groups, byDevice: perDevice }, null, 2) };
            }
            if (input.options.merged) return { exitCode: 0, stdout: formatReport(groups, sinceLabel, device) };
            if (items.length === 0) return { exitCode: 0, stdout: `No samples since ${sinceLabel}.` };
            const lines = [reportTitle(sinceLabel)];
            if (sections.length > 1) lines.push(...formatDeviceTable(sections.map((section) => ({ device: section.device, items: section.items.map((item) => item.sample) }))));
            sections.forEach((section, index) => {
              const entry = perDevice[index];
              if (entry === undefined) return;
              lines.push("", formatSectionTitle(section), ...formatGroups(entry.groups), ...formatWriters(entry.writers));
            });
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        recent: cliCommand({
          summary: "The latest samples, newest first",
          options: {
            limit: { type: "integer", min: 1, max: 500, default: 20, description: "How many" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run(input) {
            const items = parseItems(recent.all(input.options.limit));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(items.map((item) => ({ device: item.device, release: item.release, ...item.sample })), null, 2) };
            const lines = items.map(({ sample, device }) => {
              const where = `  [#${shortDeviceId(device)} load ${sample.load?.busyPct ?? "-"}%]`;
              if (sample.scroll !== null) {
                const time = new Date(sample.at).toISOString().slice(11, 19);
                const scroll = sample.scroll;
                return `${time}  scroll ${String(scroll.smoothnessPct).padStart(7)}%  dropped ${scroll.dropped}/${scroll.frames}  p95 frame ${scroll.p95FrameMs} ms (refresh ${scroll.refreshMs})  ${sample.label}${where}`;
              }
              const time = new Date(sample.at).toISOString().slice(11, 19);
              const main = primaryMs(sample);
              const value = sample.timedOut ? "timeout" : main === null ? "-" : `${Math.round(main)} ms`;
              const visit = sample.visit ? ` (${sample.visit})` : "";
              const content = sample.kind === "switch" && sample.contentDone !== null ? `  content ${contentText(sample)}` : "";
              return `${time}  ${sample.kind.padEnd(6)} ${value.padStart(8)}${content}  event ${sample.eventMs ?? "-"}  style+layout ${sample.styleLayoutMs}  ${sample.label}${visit}${where}`;
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
