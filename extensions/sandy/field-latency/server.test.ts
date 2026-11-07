import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fieldLatency from "./server.ts";
import { sample } from "./fixtures.ts";
import { isAutomatedBrowser, type Client, type Load, type Sample } from "./contract.ts";

interface CliRegistration {
  run(argv: string[], ctx: unknown): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
}

function setup() {
  const db = new Database(":memory:");
  let record: (input: { client: Client; samples: Sample[] }) => unknown = () => null;
  let cli: CliRegistration | null = null;
  const sandy = {
    storage: {
      database: () => db,
      migrate: (target: Database.Database, statements: string[]) => {
        for (const statement of statements) target.exec(statement);
      },
    },
    rpc: { register: (_contract: unknown, handlers: { record: typeof record }) => void (record = handlers.record) },
    cli: { register: (registration: CliRegistration) => void (cli = registration) },
  };
  fieldLatency(sandy as never);
  const report = async (...flags: string[]) => {
    const result = await cli?.run(["report", "--since", "30d", ...flags], {});
    assert.equal(result?.exitCode, 0, result?.stderr ?? result?.stdout);
    return result?.stdout ?? "";
  };
  return { db, record: (input: { client: Client; samples: Sample[] }) => record(input), report };
}

const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0";
const FIREFOX_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0";

const idleLoad: Load = { windowMs: 5000, busyPct: 1, maxLagMs: 12, pressure: null, charging: null, batteryPct: null };
const busyLoad: Load = { windowMs: 5000, busyPct: 55, maxLagMs: 900, pressure: null, charging: null, batteryPct: null };

const baseClient: Client = {
  deviceId: null,
  platform: null,
  screen: null,
  refreshMs: null,
  gpu: null,
  userAgent: "UA",
  cores: 16,
  devicePixelRatio: 2,
  viewport: "1x1",
  deviceMemoryGb: 8,
  effectiveType: null,
  sandyVersion: null,
  appScript: null,
  benchmarkIndex: null,
};

test("records stamp each sample with its release and the report groups and compares by release", async () => {
  const { db, record, report } = setup();
  const now = Date.now();
  record({
    client: { ...baseClient, appScript: "aaa", benchmarkIndex: 180 },
    samples: [sample({ kind: "switch", visit: "first", readyMs: 300, at: now - 3000 })],
  });
  record({
    client: { ...baseClient, appScript: "bbb", benchmarkIndex: 190 },
    samples: [sample({ kind: "switch", visit: "first", readyMs: 240, at: now - 1000 })],
  });
  const releases = db.prepare("SELECT release FROM samples ORDER BY at").all();
  assert.deepEqual(releases, [{ release: "aaa" }, { release: "bbb" }]);

  const json = JSON.parse(await report("--by-release", "--json"));
  assert.deepEqual(json.releases.map((row: { release: string }) => row.release), ["aaa", "bbb"]);
  assert.equal(json.compare.deltas.find((entry: { metric: string }) => entry.metric === "switchFirstP75").delta, -60);
  assert.equal(json.device.benchmarkIndex, 190);

  const text = await report("--by-release");
  assert.match(text, /Compare aaa -> bbb/);
  assert.match(text, /benchmark 190 iterations\/s, 16 cores/);
});

test("the default report keeps its groups and now carries the device under device.benchmarkIndex", async () => {
  const { record, report } = setup();
  record({ client: { ...baseClient, benchmarkIndex: 210 }, samples: [sample({ at: Date.now() })] });
  const json = JSON.parse(await report("--json"));
  assert.equal(json.device.benchmarkIndex, 210);
  assert.equal(json.groups[0].kind, "open");
  assert.match(await report("--merged"), /device: benchmark 210 iterations\/s/);
});

test("rows stored before 0.3.0 report under the unknown release and no device", async () => {
  const { db, report } = setup();
  db.prepare("INSERT INTO samples (at, kind, label, sample, client) VALUES (?, 'open', 'More', ?, '{}')").run(
    Date.now(),
    JSON.stringify(Object.fromEntries(Object.entries(sample({ at: Date.now() })).filter(([key]) => key !== "scroll"))),
  );
  const json = JSON.parse(await report("--by-release", "--json"));
  assert.equal(json.releases[0].release, "unknown");
  assert.equal(json.compare, null);
  assert.equal(json.device, null);
});

test("samples from headless lab browsers are not recorded, and stored ones stay out of the report", async () => {
  const { db, record, report } = setup();
  const now = Date.now();
  const headless = { ...baseClient, userAgent: "Mozilla/5.0 HeadlessChrome/156.0.0.0", benchmarkIndex: 999 };
  record({ client: headless, samples: [sample({ at: now - 2000 })] });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM samples").get() as { n: number }).n, 0);
  db.prepare("INSERT INTO samples (at, kind, label, sample, client, release) VALUES (?, ?, ?, ?, ?, ?)").run(
    now - 1500,
    "open",
    "Menu",
    JSON.stringify(sample({ at: now - 1500 })),
    JSON.stringify(headless),
    null,
  );
  record({ client: { ...baseClient, benchmarkIndex: 210 }, samples: [sample({ at: now - 1000 })] });
  const json = JSON.parse(await report("--json"));
  assert.deepEqual(json.devices.map((device: { benchmarkIndex: number }) => device.benchmarkIndex), [210]);
  assert.equal(json.groups[0].n, 1);
  const releases = JSON.parse(await report("--by-release", "--json"));
  assert.equal(releases.releases.reduce((total: number, row: { n: number }) => total + row.n, 0), 1);
});

test("a headless or webdriver browser counts as automated", () => {
  assert.equal(isAutomatedBrowser("Mozilla/5.0 HeadlessChrome/156.0.0.0", false), true);
  assert.equal(isAutomatedBrowser("Mozilla/5.0 Chrome/156.0.0.0", true), true);
  assert.equal(isAutomatedBrowser("Mozilla/5.0 Firefox/157.0", false), false);
});

test("switch reports show content done next to ready, and samples stored without it still report", async () => {
  const { db, record, report } = setup();
  const now = Date.now();
  record({
    client: { ...baseClient, appScript: "aaa" },
    samples: [
      sample({ kind: "switch", visit: "revisit", label: "sidebar thread", readyMs: 324, contentDoneMs: 453, contentDone: "settled", at: now - 2000 }),
      sample({ kind: "switch", visit: "revisit", label: "sidebar thread", readyMs: 300, contentDoneMs: 4900, contentDone: "capped", at: now - 1000 }),
    ],
  });
  const legacy = Object.fromEntries(Object.entries(sample({ kind: "switch", visit: "revisit", label: "sidebar thread", readyMs: 280, at: now - 3000 })).filter(([key]) => !key.startsWith("contentDone")));
  db.prepare("INSERT INTO samples (at, kind, label, sample, client, release) VALUES (?, 'switch', 'sidebar thread', ?, '{}', NULL)").run(now - 3000, JSON.stringify(legacy));
  const json = JSON.parse(await report("--kind", "switch", "--json"));
  const group = json.groups[0];
  assert.deepEqual([group.n, group.p50, group.contentN, group.contentP50, group.contentCapped], [3, 300, 1, 453, 1]);
  assert.match(await report("--kind", "switch"), /sidebar thread \(revisit\)\s+3 \(1 capped\)\s+300\s+324\s+324\s+324\s+453 \(n 1\)/);
  const byRelease = JSON.parse(await report("--by-release", "--kind", "switch", "--json"));
  const release = byRelease.releases.find((row: { release: string }) => row.release === "unknown");
  assert.deepEqual(release.switchRevisitContentP75, { n: 0, value: null });
  assert.deepEqual(release.switchRevisitP75, { n: 1, value: 280 });
  const current = byRelease.releases.find((row: { release: string }) => row.release === "aaa");
  assert.deepEqual(current.switchRevisitContentP75, { n: 1, value: 453 });
});

const desktop: Client = { ...baseClient, userAgent: FIREFOX_LINUX, deviceId: "aaaaaaaaaaaaaaaa", cores: 12, benchmarkIndex: 260, screen: "2560x1440", refreshMs: 6.9, gpu: "Mesa Radeon" };
const laptop: Client = { ...baseClient, userAgent: FIREFOX_LINUX, deviceId: "bbbbbbbbbbbbbbbb", cores: 4, deviceMemoryGb: 4, benchmarkIndex: 90 };
const windows: Client = { ...baseClient, userAgent: FIREFOX_WINDOWS, deviceId: "cccccccccccccccc", cores: 16, benchmarkIndex: 435 };

function switchSample(readyMs: number, at: number, load: Load | null = null): Sample {
  return sample({ kind: "switch", label: "sidebar thread", visit: "revisit", readyMs, at, load });
}

function seedDevices(record: (input: { client: Client; samples: Sample[] }) => unknown) {
  const now = Date.now();
  record({ client: desktop, samples: [switchSample(100, now - 5000, idleLoad), switchSample(120, now - 4000, idleLoad), switchSample(400, now - 3000, busyLoad)] });
  record({ client: laptop, samples: [switchSample(600, now - 2000, idleLoad), switchSample(700, now - 1000, null)] });
  record({ client: windows, samples: [switchSample(80, now - 500, idleLoad)] });
  return now;
}

test("two devices with the same user agent stay separate and each shows its own hardware", async () => {
  const { record, report } = setup();
  seedDevices(record);
  const json = JSON.parse(await report("--json"));
  const byId = new Map<string, { device: { id: string; label: string; cores: number; benchmarkIndex: number }; n: number; groups: { p75: number }[] }>(
    json.byDevice.map((entry: { device: { id: string } }) => [entry.device.id, entry]),
  );
  assert.equal(byId.size, 3);
  assert.deepEqual([byId.get("aaaaaaaaaaaaaaaa")?.device.label, byId.get("bbbbbbbbbbbbbbbb")?.device.label], ["Linux Firefox 158", "Linux Firefox 158"]);
  assert.deepEqual([byId.get("aaaaaaaaaaaaaaaa")?.device.cores, byId.get("bbbbbbbbbbbbbbbb")?.device.cores], [12, 4]);
  assert.deepEqual([byId.get("aaaaaaaaaaaaaaaa")?.groups[0]?.p75, byId.get("bbbbbbbbbbbbbbbb")?.groups[0]?.p75], [400, 700]);
  assert.equal(json.groups[0].n, 6);
  assert.equal(json.devices.length, 3);
  const text = await report();
  assert.match(text, /== Linux Firefox 158 #aaaaaa, 3 samples — benchmark 260 iterations\/s, 12 cores.*2560x1440, 145 Hz, GPU Mesa Radeon ==/);
  assert.match(text, /== Linux Firefox 158 #bbbbbb, 2 samples — benchmark 90 iterations\/s, 4 cores, 4 GB/);
  assert.match(text, /== Windows Firefox 157 #cccccc, 1 samples/);
  assert.match(text, /aaaaaa\s+Linux Firefox 158\s+3\s+2\/1\/0/);
});

test("the group row puts the p75 of idle samples next to the p75 of busy ones", async () => {
  const { record, report } = setup();
  seedDevices(record);
  const json = JSON.parse(await report("--json", "--device", "aaaaaa"));
  const group = json.byDevice[0].groups[0];
  assert.deepEqual(group.load.idle, { n: 2, p75: 120 });
  assert.deepEqual(group.load.busy, { n: 1, p75: 400 });
  assert.deepEqual(group.load.unknown, { n: 0, p75: null });
  assert.match(await report("--device", "aaaaaa"), /sidebar thread \(revisit\)\s+3\s+120\s+400\s+400\s+400\s.*120 \(n 2\)\s+400 \(n 1\)/);
});

test("--device takes an id prefix or a part of the label, and says what it saw when nothing matches", async () => {
  const { record, report } = setup();
  seedDevices(record);
  const byLabel = JSON.parse(await report("--json", "--device", "windows"));
  assert.deepEqual(byLabel.byDevice.map((entry: { device: { id: string } }) => entry.device.id), ["cccccccccccccccc"]);
  assert.equal(byLabel.device.id, "cccccccccccccccc");
  assert.equal(byLabel.groups[0].n, 1);
  const byLinux = JSON.parse(await report("--json", "--device", "linux firefox"));
  assert.equal(byLinux.byDevice.length, 2);
  const byId = JSON.parse(await report("--json", "--device", "#bbbbbb"));
  assert.equal(byId.groups[0].n, 2);
  const cli = setup();
  const result = await (async () => {
    seedDevices(cli.record);
    try {
      await cli.report("--device", "opera");
      return "ok";
    } catch (error) {
      return String(error);
    }
  })();
  assert.match(result, /No device matches "opera"/);
});

test("samples without a device id report together as unknown device and stay out of a device filter", async () => {
  const { db, record, report } = setup();
  const now = seedDevices(record);
  db.prepare("INSERT INTO samples (at, kind, label, sample, client, release) VALUES (?, 'switch', 'sidebar thread', ?, ?, NULL)").run(
    now - 100,
    JSON.stringify(switchSample(900, now - 100)),
    JSON.stringify({ ...baseClient, userAgent: FIREFOX_LINUX, benchmarkIndex: 50 }),
  );
  const all = JSON.parse(await report("--json"));
  const unknown = all.byDevice.find((entry: { device: { id: string | null } }) => entry.device.id === null);
  assert.equal(unknown.device.label, "unknown device");
  assert.equal(unknown.n, 1);
  assert.match(await report(), /== unknown device, 1 samples ==/);
  const filtered = JSON.parse(await report("--json", "--device", "linux"));
  assert.equal(filtered.groups[0].n, 5);
  const onlyUnknown = JSON.parse(await report("--json", "--device", "unknown"));
  assert.equal(onlyUnknown.groups[0].n, 1);
  assert.equal(all.devices.some((entry: { id: string | null; benchmarkIndex: number }) => entry.id === null && entry.benchmarkIndex === 50), true);
});

test("--by-release works with a device filter and --by-device splits the release table per device", async () => {
  const { record, report } = setup();
  const now = Date.now();
  record({ client: { ...desktop, appScript: "aaa" }, samples: [switchSample(300, now - 3000, idleLoad)] });
  record({ client: { ...desktop, appScript: "bbb" }, samples: [switchSample(200, now - 2000, busyLoad)] });
  record({ client: { ...laptop, appScript: "bbb" }, samples: [switchSample(900, now - 1000)] });
  const filtered = JSON.parse(await report("--by-release", "--json", "--device", "aaaaaa"));
  assert.deepEqual(filtered.releases.map((row: { release: string; n: number }) => [row.release, row.n]), [["aaa", 1], ["bbb", 1]]);
  assert.equal(filtered.compare.deltas.find((entry: { metric: string }) => entry.metric === "switchRevisitP75").delta, -100);
  const split = JSON.parse(await report("--by-release", "--by-device", "--json"));
  assert.equal(split.releases.find((row: { release: string }) => row.release === "bbb").n, 2);
  assert.deepEqual(split.byDevice.map((entry: { n: number }) => entry.n), [2, 1]);
  assert.equal(split.byDevice[1].compare, null);
  assert.deepEqual(split.releases[0].load, { idle: 1, busy: 0, unknown: 0 });
  const text = await report("--by-release", "--by-device");
  assert.match(text, /== Linux Firefox 158 #aaaaaa, 2 samples/);
  assert.match(text, /== Linux Firefox 158 #bbbbbb, 1 samples/);
  assert.match(text, /Compare aaa -> bbb/);
});

test("the default text report without devices keeps the merged table via --merged and the legacy json keys", async () => {
  const { record, report } = setup();
  seedDevices(record);
  const merged = await report("--merged");
  assert.match(merged, /sidebar thread \(revisit\)\s+6\s+/);
  assert.doesNotMatch(merged, /==/);
  const json = JSON.parse(await report("--json"));
  assert.deepEqual(Object.keys(json).sort(), ["byDevice", "device", "devices", "groups", "since"]);
  assert.equal(json.device.benchmarkIndex, 435);
});

test("new client fields and per-sample load are stored, the sample row carries its device, and recent shows both", async () => {
  const { db, record, report } = setup();
  seedDevices(record);
  const rows = db.prepare("SELECT device FROM samples ORDER BY at").all() as { device: string }[];
  assert.deepEqual(rows.map((row) => row.device), ["aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"]);
  const stored = JSON.parse((db.prepare("SELECT client FROM samples WHERE device = 'aaaaaaaaaaaaaaaa'").get() as { client: string }).client);
  assert.deepEqual([stored.screen, stored.refreshMs, stored.gpu], ["2560x1440", 6.9, "Mesa Radeon"]);
  assert.ok(await report());
});
