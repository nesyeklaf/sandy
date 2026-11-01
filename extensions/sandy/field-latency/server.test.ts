import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fieldLatency from "./server.ts";
import { sample } from "./fixtures.ts";
import { isAutomatedBrowser, type Client, type Sample } from "./contract.ts";

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

const baseClient: Client = {
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
  assert.match(await report(), /device: benchmark 210 iterations\/s/);
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
