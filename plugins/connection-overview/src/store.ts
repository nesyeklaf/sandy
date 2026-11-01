import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import type { ConnectionState, Direction } from "./classify.js";

type Database = ReturnType<SandyPluginApi["storage"]["database"]>;

export const KEY_LIMIT = 100_000;
export const RETENTION_MS = 7 * 24 * 60 * 60_000;
export const ATTRIBUTION_LIMIT = 5;

export const MIGRATIONS = [
  `CREATE TABLE destinations (
    key TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    proto TEXT NOT NULL,
    port INTEGER NOT NULL,
    hostname TEXT,
    ip TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    count INTEGER NOT NULL,
    attributions TEXT NOT NULL
  )`,
  "CREATE INDEX destinations_last_seen ON destinations(last_seen)",
  `CREATE TABLE gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    reason TEXT NOT NULL
  )`,
  "CREATE INDEX gaps_end ON gaps(end)",
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE alert_claims (key TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL)",
];

export interface Attribution {
  pid: number;
  startTime: number;
  comm: string;
}

export interface Observation {
  sourceId: string;
  direction: Direction;
  proto: "tcp" | "udp";
  port: number;
  hostname: string | null;
  ip: string;
  state: ConnectionState;
  reason: string;
  seenAt: number;
  newSocket: boolean;
  attribution: Attribution;
}

export interface DestinationRow {
  key: string;
  sourceId: string;
  direction: Direction;
  proto: "tcp" | "udp";
  port: number;
  hostname: string | null;
  ip: string;
  state: ConnectionState;
  reason: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  attributions: Attribution[];
}

interface RawRow {
  key: string;
  source_id: string;
  direction: Direction;
  proto: "tcp" | "udp";
  port: number;
  hostname: string | null;
  ip: string;
  state: ConnectionState;
  reason: string;
  first_seen: number;
  last_seen: number;
  count: number;
  attributions: string;
}

function toRow(raw: RawRow): DestinationRow {
  return {
    key: raw.key,
    sourceId: raw.source_id,
    direction: raw.direction,
    proto: raw.proto,
    port: raw.port,
    hostname: raw.hostname,
    ip: raw.ip,
    state: raw.state,
    reason: raw.reason,
    firstSeen: raw.first_seen,
    lastSeen: raw.last_seen,
    count: raw.count,
    attributions: JSON.parse(raw.attributions) as Attribution[],
  };
}

export function destinationKey(
  observation: Pick<
    Observation,
    "sourceId" | "direction" | "proto" | "port" | "hostname" | "ip"
  >,
): string {
  const target =
    observation.hostname === null
      ? "ip:" + observation.ip
      : "host:" + observation.hostname;
  return [
    observation.sourceId,
    observation.direction,
    observation.proto,
    observation.port,
    target,
  ].join("|");
}

export function createStore(
  db: Database,
  migrate: (db: Database, statements: string[]) => void,
) {
  migrate(db, MIGRATIONS);
  const selectOne = db.prepare("SELECT * FROM destinations WHERE key = ?");
  const insert = db.prepare(
    `INSERT INTO destinations (key, source_id, direction, proto, port, hostname, ip, state, reason, first_seen, last_seen, count, attributions)
     VALUES (@key, @sourceId, @direction, @proto, @port, @hostname, @ip, @state, @reason, @seenAt, @seenAt, 1, @attributions)`,
  );
  const update = db.prepare(
    `UPDATE destinations SET state = @state, reason = @reason, last_seen = MAX(last_seen, @seenAt), count = count + @increment, attributions = @attributions, ip = @ip WHERE key = @key`,
  );
  const countKeys = db.prepare("SELECT COUNT(*) AS n FROM destinations");
  const metaGet = db.prepare("SELECT value FROM meta WHERE key = ?");
  const metaSet = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const insertGap = db.prepare(
    "INSERT INTO gaps (source_id, start, end, reason) VALUES (?, ?, ?, ?)",
  );
  const unclaimedRed = db.prepare(
    "SELECT key FROM destinations WHERE state = 'red' AND key NOT IN (SELECT key FROM alert_claims) ORDER BY first_seen, key",
  );
  const claim = db.prepare(
    "INSERT OR IGNORE INTO alert_claims (key, claimed_at) VALUES (?, ?)",
  );
  const claimUnclaimedRed = db.transaction((now: number): string[] => {
    const keys = (unclaimedRed.all() as { key: string }[]).map(
      (row) => row.key,
    );
    for (const key of keys) claim.run(key, now);
    return keys;
  });
  let keyCount = (countKeys.get() as { n: number }).n;

  function capReached(): boolean {
    return metaGet.get("capReachedAt") !== undefined;
  }

  const record = db.transaction((observations: readonly Observation[]) => {
    const keysAdded: DestinationRow[] = [];
    for (const observation of observations) {
      const key = destinationKey(observation);
      const existing = selectOne.get(key) as RawRow | undefined;
      if (existing === undefined) {
        if (keyCount >= KEY_LIMIT) {
          if (!capReached())
            metaSet.run("capReachedAt", String(observation.seenAt));
          continue;
        }
        insert.run({
          key,
          sourceId: observation.sourceId,
          direction: observation.direction,
          proto: observation.proto,
          port: observation.port,
          hostname: observation.hostname,
          ip: observation.ip,
          state: observation.state,
          reason: observation.reason,
          seenAt: observation.seenAt,
          attributions: JSON.stringify([observation.attribution]),
        });
        keyCount += 1;
        keysAdded.push(toRow(selectOne.get(key) as RawRow));
        continue;
      }
      const attributions = (
        JSON.parse(existing.attributions) as Attribution[]
      ).filter(
        (entry) =>
          entry.pid !== observation.attribution.pid ||
          entry.startTime !== observation.attribution.startTime,
      );
      attributions.unshift(observation.attribution);
      update.run({
        key,
        state: observation.state,
        reason: observation.reason,
        seenAt: observation.seenAt,
        increment: observation.newSocket ? 1 : 0,
        ip: observation.ip,
        attributions: JSON.stringify(attributions.slice(0, ATTRIBUTION_LIMIT)),
      });
    }
    return keysAdded;
  });

  return {
    record: (observations: readonly Observation[]) => record(observations),
    atomically<T>(work: () => T): T {
      return db.transaction(work)();
    },
    recordGap(sourceId: string, start: number, end: number, reason: string) {
      insertGap.run(sourceId, Math.round(start), Math.round(end), reason);
    },
    list(filter: {
      since: number;
      states?: readonly ConnectionState[];
      direction?: Direction;
    }): DestinationRow[] {
      const clauses = ["last_seen >= ?"];
      const params: (string | number)[] = [filter.since];
      if (filter.states !== undefined && filter.states.length > 0) {
        clauses.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
        params.push(...filter.states);
      }
      if (filter.direction !== undefined) {
        clauses.push("direction = ?");
        params.push(filter.direction);
      }
      return (
        db
          .prepare(
            `SELECT * FROM destinations WHERE ${clauses.join(" AND ")} ORDER BY last_seen DESC`,
          )
          .all(...params) as RawRow[]
      ).map(toRow);
    },
    gaps(since: number) {
      return db
        .prepare(
          "SELECT source_id AS sourceId, start, end, reason FROM gaps WHERE end >= ? ORDER BY start",
        )
        .all(since) as {
        sourceId: string;
        start: number;
        end: number;
        reason: string;
      }[];
    },
    reclassify(options: {
      isAllowed: (hostname: string) => boolean;
      thirdPartyProcesses: ReadonlySet<string>;
    }) {
      const rows = db
        .prepare(
          "SELECT key, hostname, state, reason, attributions FROM destinations WHERE direction = 'out' AND (hostname IS NOT NULL OR state IN ('red', 'yellow'))",
        )
        .all() as {
        key: string;
        hostname: string | null;
        state: ConnectionState;
        reason: string;
        attributions: string;
      }[];
      const set = db.prepare(
        "UPDATE destinations SET state = ?, reason = ? WHERE key = ?",
      );
      db.transaction(() => {
        for (const row of rows) {
          let state = row.state;
          let reason = row.reason;
          if (row.hostname !== null) {
            const allowed = options.isAllowed(row.hostname);
            state = allowed ? "allowed" : "red";
            reason = allowed ? "listed host" : "unlisted host";
          }
          const comms = [
            ...new Set(
              (JSON.parse(row.attributions) as Attribution[]).map(
                (entry) => entry.comm,
              ),
            ),
          ];
          if (
            (state === "red" || state === "yellow") &&
            comms.length > 0 &&
            comms.every((comm) => options.thirdPartyProcesses.has(comm))
          ) {
            state = "third-party";
            reason = comms.join(",") + " is not sandy: " + reason;
          }
          if (state !== row.state || reason !== row.reason)
            set.run(state, reason, row.key);
        }
      })();
    },
    releaseClaims(keys: readonly string[]) {
      const release = db.prepare("DELETE FROM alert_claims WHERE key = ?");
      db.transaction(() => {
        for (const key of keys) release.run(key);
      })();
    },
    capReached,
    claimUnclaimedRed: (now: number) => claimUnclaimedRed(now),
    loadCursor(sourceId: string): unknown {
      const row = metaGet.get("cursor:" + sourceId) as
        | { value: string }
        | undefined;
      return row === undefined ? null : JSON.parse(row.value);
    },
    saveCursor(sourceId: string, cursor: unknown) {
      metaSet.run("cursor:" + sourceId, JSON.stringify(cursor));
    },
    prune(now: number) {
      const cutoff = now - RETENTION_MS;
      db.prepare("DELETE FROM destinations WHERE last_seen < ?").run(cutoff);
      db.prepare("DELETE FROM gaps WHERE end < ?").run(cutoff);
      keyCount = (countKeys.get() as { n: number }).n;
      if (keyCount < KEY_LIMIT && capReached()) {
        const since = Number(
          (metaGet.get("capReachedAt") as { value: string }).value,
        );
        if (now - since > RETENTION_MS)
          db.prepare("DELETE FROM meta WHERE key = 'capReachedAt'").run();
      }
    },
  };
}

export type Store = ReturnType<typeof createStore>;
