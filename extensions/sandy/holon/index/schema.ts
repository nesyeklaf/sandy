export const MIGRATIONS: string[] = [
  `CREATE TABLE models (
    root TEXT PRIMARY KEY,
    now_ms REAL NOT NULL,
    commit_sha TEXT NOT NULL,
    scanned_at_ms REAL NOT NULL
  );
  CREATE TABLE holon_files (
    root TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    hash TEXT NOT NULL,
    holon_id TEXT,
    holon_json TEXT,
    error TEXT,
    PRIMARY KEY (root, path)
  );
  CREATE INDEX holon_files_by_id ON holon_files (root, holon_id, path);
  CREATE TABLE confirmation_files (
    root TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    hash TEXT NOT NULL,
    holon TEXT,
    side TEXT,
    at TEXT,
    confirmation_json TEXT,
    error TEXT,
    PRIMARY KEY (root, path)
  );
  CREATE INDEX confirmation_files_by_side ON confirmation_files (root, holon, side, at, path);
  CREATE TABLE holons (
    root TEXT NOT NULL,
    id TEXT NOT NULL,
    path TEXT NOT NULL,
    part_of TEXT,
    holon_json TEXT NOT NULL,
    light TEXT NOT NULL,
    evaluation_json TEXT NOT NULL,
    drift_count INTEGER NOT NULL,
    drift_below INTEGER NOT NULL,
    valid_from REAL,
    valid_until REAL,
    uses_commit INTEGER NOT NULL,
    PRIMARY KEY (root, id)
  );
  CREATE INDEX holons_by_parent ON holons (root, part_of, id);
  CREATE INDEX holons_by_valid_until ON holons (root, valid_until) WHERE valid_until IS NOT NULL;
  CREATE INDEX holons_by_valid_from ON holons (root, valid_from) WHERE valid_from IS NOT NULL;
  CREATE INDEX holons_using_commit ON holons (root, id) WHERE uses_commit = 1;
  CREATE INDEX holons_with_drift ON holons (root, id) WHERE drift_count > 0;
  CREATE TABLE seams (
    root TEXT NOT NULL,
    from_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    to_id TEXT NOT NULL,
    read_only INTEGER NOT NULL,
    exclusive INTEGER NOT NULL,
    PRIMARY KEY (root, from_id, idx)
  );
  CREATE INDEX seams_by_target ON seams (root, to_id);
  CREATE INDEX seams_exclusive ON seams (root, to_id, from_id) WHERE exclusive = 1;
  CREATE TABLE evidence (
    id INTEGER PRIMARY KEY,
    root TEXT NOT NULL,
    holon TEXT NOT NULL,
    side TEXT NOT NULL,
    at_ms REAL NOT NULL,
    record_json TEXT NOT NULL
  );
  CREATE INDEX evidence_by_side ON evidence (root, holon, side, at_ms, id);
  CREATE TABLE dirty (
    root TEXT NOT NULL,
    holon TEXT NOT NULL,
    PRIMARY KEY (root, holon)
  );`,
];
