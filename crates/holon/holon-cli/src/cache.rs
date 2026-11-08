use crate::detect::{detect, Detected};
use crate::snapshot::{self, clock_ns, encode, read, stat, DirEntry, FileEntry, Snapshot};
use crate::store::{store_error, Store};
use holon_core::evaluate::{evaluate_holon, EvalContext, HolonEvaluation};
use holon_core::format::{Confirmation, Evidence, Holon, KINDS, STATUSES};
use holon_core::model::{
    build_view, decode_text, newer_confirmation, newer_evidence, read_confirmation_file,
    read_holon_file, read_text, ConfirmationFile, HolonFile, IncomingSeam, NodeFacts, ViewParts,
};
use holon_core::order::js_cmp;
use holon_core::outputs::{
    CheckError, CheckOutput, CheckWarning, DriftEntry, DriftOutput, ViewOutput,
};
use holon_core::scan::{scan_confirmations, walk_holons};
use holon_core::time::format_instant;
use holon_core::{EvalEnv, Model};
use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const VERSION: i64 = 2;
const REBUILD_ABOVE: usize = 10_000;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS cache_meta (
    key INTEGER PRIMARY KEY CHECK (key = 0),
    version INTEGER NOT NULL,
    root TEXT NOT NULL,
    generation INTEGER NOT NULL,
    commit_sha TEXT NOT NULL,
    stats BLOB NOT NULL,
    details BLOB NOT NULL,
    check_json TEXT
);
CREATE TABLE IF NOT EXISTS cache_holons (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    part_of TEXT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    light TEXT NOT NULL,
    drift_count INTEGER NOT NULL,
    drift_below INTEGER NOT NULL,
    eval_json TEXT NOT NULL,
    valid_from INTEGER,
    valid_until INTEGER,
    uses_commit INTEGER NOT NULL,
    unknown_build INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cache_holons_part_of ON cache_holons (part_of);
CREATE INDEX IF NOT EXISTS cache_holons_from ON cache_holons (valid_from) WHERE valid_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS cache_holons_until ON cache_holons (valid_until) WHERE valid_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS cache_holons_drift ON cache_holons (drift_count) WHERE drift_count > 0;
CREATE INDEX IF NOT EXISTS cache_holons_commit ON cache_holons (uses_commit) WHERE uses_commit = 1;
CREATE INDEX IF NOT EXISTS cache_holons_unknown ON cache_holons (unknown_build) WHERE unknown_build = 1;
CREATE TABLE IF NOT EXISTS cache_seams (
    holon TEXT NOT NULL,
    idx INTEGER NOT NULL,
    target TEXT NOT NULL,
    contract TEXT NOT NULL,
    read_only INTEGER NOT NULL,
    exclusive INTEGER NOT NULL,
    light TEXT NOT NULL,
    drift TEXT,
    PRIMARY KEY (holon, idx)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cache_seams_target ON cache_seams (target);
CREATE TABLE IF NOT EXISTS cache_code (
    entry TEXT NOT NULL,
    holon TEXT NOT NULL,
    PRIMARY KEY (entry, holon)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cache_code_holon ON cache_code (holon);
";

fn db<T>(result: rusqlite::Result<T>) -> Result<T, String> {
    result.map_err(store_error)
}

fn text<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value).expect("serializes") {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    }
}

fn from_text<T: DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_value(serde_json::Value::String(value.to_string()))
        .map_err(|error| format!("holon cache: {error}"))
}

fn from_json<T: DeserializeOwned>(value: &str) -> Result<T, String> {
    serde_json::from_str(value).map_err(|error| format!("holon cache: {error}"))
}

fn known(list: &[&'static str], value: &str) -> Result<&'static str, String> {
    list.iter()
        .copied()
        .find(|known| *known == value)
        .ok_or_else(|| format!("holon cache: unknown {value}"))
}

struct Meta {
    generation: i64,
    commit: String,
    stats: Vec<u8>,
    check_json: Option<String>,
}

fn read_meta(store: &Store) -> Result<Option<Meta>, String> {
    db(store.conn.execute_batch(SCHEMA))?;
    db(store
        .conn
        .query_row(
            "SELECT version, root, generation, commit_sha, stats, check_json FROM cache_meta WHERE key = 0",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    Meta {
                        generation: row.get(2)?,
                        commit: row.get(3)?,
                        stats: row.get(4)?,
                        check_json: row.get(5)?,
                    },
                ))
            },
        )
        .optional())
    .map(|found| {
        found
            .filter(|(version, root, _)| *version == VERSION && *root == store.root)
            .map(|(_, _, meta)| meta)
    })
}

fn read_details(store: &Store) -> Result<Vec<u8>, String> {
    db(store
        .conn
        .query_row("SELECT details FROM cache_meta WHERE key = 0", [], |row| {
            row.get(0)
        }))
}

fn put_holon(
    conn: &Connection,
    path: &str,
    holon: &Holon,
    evaluation: &HolonEvaluation,
    drift_below: usize,
) -> Result<(), String> {
    let validity = &evaluation.validity;
    db(conn
        .prepare_cached(
            "INSERT INTO cache_holons (id, path, part_of, title, kind, status, light, drift_count, drift_below, eval_json, valid_from, valid_until, uses_commit, unknown_build)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT (id) DO UPDATE SET path = excluded.path, part_of = excluded.part_of, title = excluded.title, kind = excluded.kind, status = excluded.status, light = excluded.light, drift_count = excluded.drift_count, eval_json = excluded.eval_json, valid_from = excluded.valid_from, valid_until = excluded.valid_until, uses_commit = excluded.uses_commit, unknown_build = excluded.unknown_build",
        )
        .and_then(|mut statement| {
            statement.execute(params![
                holon.id,
                path,
                holon.part_of,
                holon.title,
                holon.kind,
                holon.status,
                text(&evaluation.light),
                evaluation.drift.len() as i64,
                drift_below as i64,
                serde_json::to_string(evaluation).expect("evaluation serializes"),
                validity.from_ms,
                validity.until_ms,
                validity.uses_commit,
                validity.unknown_build,
            ])
        }))?;
    db(conn
        .prepare_cached("DELETE FROM cache_seams WHERE holon = ?")
        .and_then(|mut statement| statement.execute([&holon.id])))?;
    let mut seams = db(conn.prepare_cached(
        "INSERT INTO cache_seams (holon, idx, target, contract, read_only, exclusive, light, drift) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ))?;
    for (index, (seam, result)) in holon.seams.iter().zip(&evaluation.seams).enumerate() {
        db(seams.execute(params![
            holon.id,
            index as i64,
            seam.to,
            seam.contract,
            seam.read_only,
            seam.exclusive,
            text(&result.light),
            result.drift.map(|drift| text(&drift)),
        ]))?;
    }
    db(conn
        .prepare_cached("DELETE FROM cache_code WHERE holon = ?")
        .and_then(|mut statement| statement.execute([&holon.id])))?;
    let mut code =
        db(conn.prepare_cached("INSERT OR IGNORE INTO cache_code (entry, holon) VALUES (?, ?)"))?;
    for entry in &holon.code {
        db(code.execute(params![entry, holon.id]))?;
    }
    Ok(())
}

fn delete_holon(conn: &Connection, id: &str) -> Result<(), String> {
    for sql in [
        "DELETE FROM cache_holons WHERE id = ?",
        "DELETE FROM cache_seams WHERE holon = ?",
        "DELETE FROM cache_code WHERE holon = ?",
    ] {
        db(conn
            .prepare_cached(sql)
            .and_then(|mut statement| statement.execute([id])))?;
    }
    Ok(())
}

fn put_meta(
    store: &Store,
    commit: &str,
    snapshot: Option<&Snapshot>,
    check: Option<Option<&CheckOutput>>,
) -> Result<(), String> {
    let conn = &store.conn;
    let generation: i64 = db(conn.query_row(
        "SELECT coalesce(max(generation), 0) + 1 FROM cache_meta",
        [],
        |row| row.get(0),
    ))?;
    let exists: bool = db(conn.query_row(
        "SELECT count(*) FROM cache_meta WHERE key = 0",
        [],
        |row| row.get::<_, i64>(0),
    ))? > 0;
    if !exists {
        db(conn.execute(
            "INSERT INTO cache_meta (key, version, root, generation, commit_sha, stats, details) VALUES (0, ?, ?, 0, '', x'', x'')",
            params![VERSION, store.root],
        ))?;
    }
    db(conn.execute(
        "UPDATE cache_meta SET version = ?, root = ?, generation = ?, commit_sha = ? WHERE key = 0",
        params![VERSION, store.root, generation, commit],
    ))?;
    if let Some(snapshot) = snapshot {
        let encoded = encode(snapshot);
        db(conn.execute(
            "UPDATE cache_meta SET stats = ?, details = ? WHERE key = 0",
            params![encoded.stats, encoded.details],
        ))?;
    }
    if let Some(check) = check {
        db(conn.execute(
            "UPDATE cache_meta SET check_json = ? WHERE key = 0",
            [check.map(|check| serde_json::to_string(check).expect("check serializes"))],
        ))?;
    }
    db(conn.execute("DELETE FROM cache_dirty WHERE root = ?", [&store.root]))?;
    Ok(())
}

fn read_file(root: &Path, path: String, confirmation: bool) -> Result<(FileEntry, String), String> {
    let read = read(root, &path)?;
    Ok((
        FileEntry {
            path,
            confirmation,
            stat: read.stat,
            hash: read.hash,
            id: None,
        },
        decode_text(read.bytes),
    ))
}

fn rebuild(store: &Store, root: &Path, env: &EvalEnv) -> Result<(), String> {
    let taken_ns = clock_ns();
    let mut dirs = Vec::new();
    let mut holon_paths = walk_holons(root, "", &mut dirs);
    holon_paths.par_sort_unstable_by(|a, b| js_cmp(a, b));
    let mut confirmation_dirs = Vec::new();
    let confirmation_paths = scan_confirmations(root, &mut confirmation_dirs);
    let holons: Vec<Result<(FileEntry, HolonFile), String>> = holon_paths
        .into_par_iter()
        .map(|path| {
            let (mut entry, text) = read_file(root, path.clone(), false)?;
            let file = read_holon_file(path, &text);
            entry.id = file.holon.as_ref().map(|holon| holon.id.clone());
            Ok((entry, file))
        })
        .collect();
    let confirmations: Vec<Result<(FileEntry, ConfirmationFile), String>> = confirmation_paths
        .into_par_iter()
        .map(|path| {
            let (mut entry, text) = read_file(root, path.clone(), true)?;
            let file = read_confirmation_file(path, &text);
            entry.id = file
                .confirmation
                .as_ref()
                .map(|confirmation| confirmation.holon.clone());
            Ok((entry, file))
        })
        .collect();
    let mut entries = Vec::new();
    let mut files = Vec::new();
    for item in holons {
        let (entry, file) = item?;
        entries.push(entry);
        files.push(file);
    }
    let mut confirmation_files = Vec::new();
    for item in confirmations {
        let (entry, file) = item?;
        entries.push(entry);
        confirmation_files.push(file);
    }
    let dir_entries: Vec<DirEntry> = dirs
        .into_iter()
        .map(|path| (path, false))
        .chain(confirmation_dirs.into_iter().map(|path| (path, true)))
        .collect::<Vec<_>>()
        .into_par_iter()
        .map(|(path, confirmation)| DirEntry {
            stat: stat(&root.join(&path)),
            path,
            confirmation,
        })
        .collect();
    let model = Model::new(files, confirmation_files, store.evidence()?);
    let evaluated = model.evaluate(env);
    let check = model.check();
    let snapshot = Snapshot {
        taken_ns,
        files: entries,
        dirs: dir_entries,
    };
    store.transaction(|| {
        db(store.conn.execute_batch(
            "DELETE FROM cache_holons; DELETE FROM cache_seams; DELETE FROM cache_code;",
        ))?;
        for (path, holon) in model.winners() {
            let evaluation = evaluated.evaluation(&holon.id).expect("evaluated winner");
            let below = evaluated.drift_below(&holon.id).expect("evaluated winner");
            put_holon(&store.conn, path, holon, evaluation, below)?;
        }
        put_meta(store, &env.commit, Some(&snapshot), Some(Some(&check)))
    })
}

struct Partial {
    part_of: HashMap<String, Option<String>>,
    evidence: HashMap<String, Vec<Evidence>>,
    confirmations: HashMap<String, Vec<Confirmation>>,
    writers: HashMap<String, Vec<(String, bool)>>,
}

impl EvalContext for Partial {
    fn part_of(&self, id: &str) -> Option<Option<&str>> {
        self.part_of.get(id).map(Option::as_deref)
    }

    fn latest_evidence(&self, holon: &str, side: &str) -> Option<&Evidence> {
        self.evidence
            .get(holon)?
            .iter()
            .find(|record| record.side == side)
    }

    fn latest_confirmation(&self, holon: &str, side: &str) -> Option<&Confirmation> {
        self.confirmations
            .get(holon)?
            .iter()
            .find(|confirmation| confirmation.side == side)
    }

    fn writers_to(&self, target: &str) -> Vec<(&str, bool)> {
        self.writers.get(target).map_or_else(Vec::new, |list| {
            list.iter()
                .map(|(from, read_only)| (from.as_str(), *read_only))
                .collect()
        })
    }
}

enum Applied {
    Done,
    Raced,
    Rebuild,
}

fn column_strings(
    conn: &Connection,
    sql: &str,
    value: &dyn rusqlite::ToSql,
) -> Result<Vec<String>, String> {
    let mut statement = db(conn.prepare_cached(sql))?;
    let rows = db(statement.query_map([value], |row| row.get::<_, String>(0)))?;
    rows.map(db).collect()
}

fn seam_targets(conn: &Connection, id: &str) -> Result<Vec<(String, bool)>, String> {
    let mut statement = db(conn
        .prepare_cached("SELECT target, read_only FROM cache_seams WHERE holon = ? ORDER BY idx"))?;
    let rows = db(statement.query_map([id], |row| Ok((row.get(0)?, row.get(1)?))))?;
    rows.map(db).collect()
}

struct Changes<'p> {
    pending: HashMap<String, Option<(String, Holon)>>,
    detected: &'p Detected,
}

impl Changes<'_> {
    fn part_of(&self, conn: &Connection, id: &str) -> Result<Option<Option<String>>, String> {
        if let Some(pending) = self.pending.get(id) {
            return Ok(pending.as_ref().map(|(_, holon)| holon.part_of.clone()));
        }
        db(conn
            .prepare_cached("SELECT part_of FROM cache_holons WHERE id = ?")
            .and_then(|mut statement| {
                statement
                    .query_row([id], |row| row.get::<_, Option<String>>(0))
                    .optional()
            }))
    }

    fn writers(&self, conn: &Connection, target: &str) -> Result<Vec<(String, bool)>, String> {
        let mut statement =
            db(conn.prepare_cached("SELECT holon, read_only FROM cache_seams WHERE target = ?"))?;
        let rows = db(statement.query_map([target], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        }))?;
        let mut writers = Vec::new();
        for row in rows {
            let (from, read_only) = db(row)?;
            if !self.pending.contains_key(&from) {
                writers.push((from, read_only));
            }
        }
        for (_, holon) in self.pending.values().flatten() {
            for seam in holon.seams.iter().filter(|seam| seam.to == target) {
                writers.push((holon.id.clone(), seam.read_only));
            }
        }
        Ok(writers)
    }
}

fn winner_paths(snapshot: &Snapshot, ids: &HashSet<String>) -> HashMap<String, String> {
    let mut winners: HashMap<String, String> = HashMap::new();
    for file in snapshot.files.iter().filter(|file| !file.confirmation) {
        let Some(id) = file.id.as_ref().filter(|id| ids.contains(*id)) else {
            continue;
        };
        match winners.get_mut(id) {
            Some(path) => {
                if js_cmp(&file.path, path).is_lt() {
                    path.clone_from(&file.path);
                }
            }
            None => {
                winners.insert(id.clone(), file.path.clone());
            }
        }
    }
    winners
}

fn parse_at(root: &Path, path: &str) -> Result<Option<Holon>, String> {
    let text = read_text(&root.join(path))?;
    Ok(read_holon_file(path.to_string(), &text).holon)
}

fn prefixes(path: &str) -> impl Iterator<Item = String> + '_ {
    path.match_indices('/')
        .map(|(at, _)| path[..=at].to_string())
        .chain(std::iter::once(path.to_string()))
}

fn apply(
    store: &Store,
    root: &Path,
    env: &EvalEnv,
    meta: &Meta,
    detected: &Detected,
) -> Result<Applied, String> {
    let conn = &store.conn;
    let generation: i64 = db(conn.query_row(
        "SELECT generation FROM cache_meta WHERE key = 0",
        [],
        |row| row.get(0),
    ))?;
    if generation != meta.generation {
        return Ok(Applied::Raced);
    }
    let snapshot = &detected.snapshot;
    let winners = winner_paths(snapshot, &detected.holon_ids);
    let mut changes = Changes {
        pending: HashMap::new(),
        detected,
    };
    let mut structural = false;
    let mut targets: HashSet<String> = HashSet::new();
    let mut dirty: HashSet<String> = HashSet::new();
    for id in &detected.holon_ids {
        let fresh = match winners.get(id) {
            None => None,
            Some(path) => {
                let parsed = match changes.detected.parsed.get(path) {
                    Some(file) => file.holon.clone(),
                    None => parse_at(root, path)?,
                };
                match parsed {
                    Some(holon) if holon.id == *id => Some((path.clone(), holon)),
                    _ => return Ok(Applied::Rebuild),
                }
            }
        };
        let previous = changes.part_of(conn, id)?;
        let previous_seams = seam_targets(conn, id)?;
        let fresh_seams: Vec<(String, bool)> =
            fresh.as_ref().map_or_else(Vec::new, |(_, holon)| {
                holon
                    .seams
                    .iter()
                    .map(|seam| (seam.to.clone(), seam.read_only))
                    .collect()
            });
        let fresh_part_of = fresh.as_ref().map(|(_, holon)| holon.part_of.clone());
        if previous != fresh_part_of {
            structural = true;
        }
        if previous_seams != fresh_seams {
            targets.extend(previous_seams.into_iter().map(|(target, _)| target));
            targets.extend(fresh_seams.into_iter().map(|(target, _)| target));
        }
        if fresh.is_some() {
            dirty.insert(id.clone());
        }
        changes.pending.insert(id.clone(), fresh);
    }
    let exclusive_pending = |target: Option<&str>| -> Vec<String> {
        changes
            .pending
            .values()
            .flatten()
            .filter(|(_, holon)| {
                holon
                    .seams
                    .iter()
                    .any(|seam| seam.exclusive && target.is_none_or(|target| seam.to == target))
            })
            .map(|(_, holon)| holon.id.clone())
            .collect()
    };
    if structural {
        dirty.extend(column_strings(
            conn,
            "SELECT DISTINCT holon FROM cache_seams WHERE exclusive = ?",
            &true,
        )?);
        dirty.extend(exclusive_pending(None));
        dirty.extend(
            snapshot
                .files
                .iter()
                .filter(|file| file.confirmation)
                .filter_map(|file| file.id.clone()),
        );
    }
    for target in &targets {
        dirty.extend(column_strings(
            conn,
            "SELECT holon FROM cache_seams WHERE target = ? AND exclusive = 1",
            target,
        )?);
        dirty.extend(exclusive_pending(Some(target)));
    }
    dirty.extend(detected.confirmation_ids.iter().cloned());
    dirty.extend(column_strings(
        conn,
        "SELECT holon FROM cache_dirty WHERE root = ?",
        &store.root,
    )?);
    dirty.extend(column_strings(
        conn,
        "SELECT id FROM cache_holons WHERE valid_until <= ?1 UNION SELECT id FROM cache_holons WHERE valid_from > ?1",
        &env.now_ms,
    )?);
    if meta.commit != env.commit {
        match env.code.changed_paths(&meta.commit, &env.commit) {
            None => dirty.extend(column_strings(
                conn,
                "SELECT id FROM cache_holons WHERE uses_commit = ?",
                &true,
            )?),
            Some(paths) => {
                for path in paths.iter() {
                    for entry in prefixes(path) {
                        dirty.extend(column_strings(
                            conn,
                            "SELECT holon FROM cache_code WHERE entry = ?",
                            &entry,
                        )?);
                    }
                }
            }
        }
        dirty.extend(column_strings(
            conn,
            "SELECT id FROM cache_holons WHERE unknown_build = ?",
            &true,
        )?);
    }
    if dirty.len() > REBUILD_ABOVE {
        return Ok(Applied::Rebuild);
    }
    let mut work: Vec<(String, Holon, Option<i64>)> = Vec::new();
    for id in &dirty {
        let row: Option<(String, i64)> = db(conn
            .prepare_cached("SELECT path, drift_count FROM cache_holons WHERE id = ?")
            .and_then(|mut statement| {
                statement
                    .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
                    .optional()
            }))?;
        let previous = row.as_ref().map(|(_, count)| *count);
        let holon = match changes.pending.get(id) {
            Some(None) => continue,
            Some(Some((path, holon))) => (path.clone(), holon.clone()),
            None => {
                let Some((path, _)) = row else { continue };
                match parse_at(root, &path)? {
                    Some(holon) if holon.id == *id => (path, holon),
                    _ => return Ok(Applied::Rebuild),
                }
            }
        };
        work.push((holon.0, holon.1, previous));
    }
    let partial = context(store, root, &changes, &work)?;
    let results: Vec<HolonEvaluation> = work
        .par_iter()
        .map(|(_, holon, _)| evaluate_holon(holon, &partial, env))
        .collect();
    for (id, fresh) in &changes.pending {
        if fresh.is_none() {
            delete_holon(conn, id)?;
        }
    }
    let mut deltas: Vec<(String, i64)> = Vec::new();
    for ((path, holon, previous), evaluation) in work.iter().zip(&results) {
        let count = evaluation.drift.len();
        put_holon(conn, path, holon, evaluation, count)?;
        let delta = count as i64 - previous.unwrap_or(0);
        if delta != 0 {
            deltas.push((holon.id.clone(), delta));
        }
    }
    if structural {
        roll_up(conn)?;
    } else {
        for (id, delta) in deltas {
            add_below(conn, &changes, &id, delta)?;
        }
    }
    let check = detected.files_changed.then_some(None);
    let snapshot = detected.changed.then_some(snapshot);
    put_meta(store, &env.commit, snapshot, check)?;
    Ok(Applied::Done)
}

fn add_below(conn: &Connection, changes: &Changes, id: &str, delta: i64) -> Result<(), String> {
    let mut seen: HashSet<String> = HashSet::from([id.to_string()]);
    let mut statement =
        db(conn
            .prepare_cached("UPDATE cache_holons SET drift_below = drift_below + ? WHERE id = ?"))?;
    db(statement.execute(params![delta, id]))?;
    let mut current = changes.part_of(conn, id)?.flatten();
    while let Some(parent) = current {
        let Some(next) = changes.part_of(conn, &parent)? else {
            break;
        };
        if !seen.insert(parent.clone()) {
            break;
        }
        db(statement.execute(params![delta, parent]))?;
        current = next;
    }
    Ok(())
}

fn roll_up(conn: &Connection) -> Result<(), String> {
    let mut statement =
        db(conn.prepare("SELECT id, part_of, drift_count, drift_below FROM cache_holons"))?;
    let rows = db(statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    }))?;
    let rows: Vec<(String, Option<String>, i64, i64)> = rows.map(db).collect::<Result<_, _>>()?;
    let by_id: HashMap<&str, usize> = rows
        .iter()
        .enumerate()
        .map(|(position, row)| (row.0.as_str(), position))
        .collect();
    let parents: Vec<Option<usize>> = rows
        .iter()
        .map(|row| {
            row.1
                .as_deref()
                .and_then(|parent| by_id.get(parent).copied())
        })
        .collect();
    let mut below: Vec<i64> = rows.iter().map(|row| row.2).collect();
    for (position, row) in rows.iter().enumerate() {
        if row.2 == 0 {
            continue;
        }
        let mut seen: HashSet<usize> = HashSet::from([position]);
        let mut current = parents[position];
        while let Some(parent) = current {
            if !seen.insert(parent) {
                break;
            }
            below[parent] += row.2;
            current = parents[parent];
        }
    }
    let mut update =
        db(conn.prepare_cached("UPDATE cache_holons SET drift_below = ? WHERE id = ?"))?;
    for (row, value) in rows.iter().zip(below) {
        if row.3 != value {
            db(update.execute(params![value, row.0]))?;
        }
    }
    Ok(())
}

fn context(
    store: &Store,
    root: &Path,
    changes: &Changes,
    work: &[(String, Holon, Option<i64>)],
) -> Result<Partial, String> {
    let conn = &store.conn;
    let ids: HashSet<&str> = work.iter().map(|(_, holon, _)| holon.id.as_str()).collect();
    let mut evidence: HashMap<String, Vec<Evidence>> = HashMap::new();
    for id in &ids {
        let mut latest: Vec<Evidence> = Vec::new();
        for record in store.holon_evidence(id)? {
            match latest
                .iter_mut()
                .find(|current| current.side == record.side)
            {
                Some(current) => {
                    if newer_evidence(&record, current) {
                        *current = record;
                    }
                }
                None => latest.push(record),
            }
        }
        evidence.insert((*id).to_string(), latest);
    }
    let mut confirmation_paths: HashMap<&str, Vec<&str>> = HashMap::new();
    for file in changes
        .detected
        .snapshot
        .files
        .iter()
        .filter(|file| file.confirmation)
    {
        if let Some(id) = file.id.as_deref().filter(|id| ids.contains(id)) {
            confirmation_paths.entry(id).or_default().push(&file.path);
        }
    }
    let mut confirmations: HashMap<String, Vec<Confirmation>> = HashMap::new();
    let mut starts: Vec<String> = Vec::new();
    for (id, paths) in confirmation_paths {
        let mut latest: Vec<(String, Confirmation)> = Vec::new();
        for path in paths {
            let text = read_text(&root.join(path))?;
            let Some(confirmation) = read_confirmation_file(path.to_string(), &text).confirmation
            else {
                continue;
            };
            if confirmation.holon != id {
                continue;
            }
            match latest
                .iter_mut()
                .find(|(_, current)| current.side == confirmation.side)
            {
                Some(current) => {
                    if newer_confirmation((path, &confirmation), (&current.0, &current.1)) {
                        *current = (path.to_string(), confirmation);
                    }
                }
                None => latest.push((path.to_string(), confirmation)),
            }
        }
        starts.extend(
            latest
                .iter()
                .map(|(_, confirmation)| confirmation.by.clone()),
        );
        confirmations.insert(
            id.to_string(),
            latest
                .into_iter()
                .map(|(_, confirmation)| confirmation)
                .collect(),
        );
    }
    let mut writers: HashMap<String, Vec<(String, bool)>> = HashMap::new();
    for (_, holon, _) in work {
        for seam in holon.seams.iter().filter(|seam| seam.exclusive) {
            if writers.contains_key(&seam.to) {
                continue;
            }
            let list = changes.writers(conn, &seam.to)?;
            starts.extend(list.iter().map(|(from, _)| from.clone()));
            writers.insert(seam.to.clone(), list);
        }
    }
    let mut part_of: HashMap<String, Option<String>> = HashMap::new();
    let mut missing: HashSet<String> = HashSet::new();
    while let Some(id) = starts.pop() {
        if part_of.contains_key(&id) || missing.contains(&id) {
            continue;
        }
        match changes.part_of(conn, &id)? {
            None => {
                missing.insert(id);
            }
            Some(parent) => {
                starts.extend(parent.clone());
                part_of.insert(id, parent);
            }
        }
    }
    Ok(Partial {
        part_of,
        evidence,
        confirmations,
        writers,
    })
}

pub fn sync(store: &Store, root: &Path, env: &EvalEnv, need_check: bool) -> Result<(), String> {
    for _ in 0..3 {
        let Some(meta) = read_meta(store)? else {
            return rebuild(store, root, env);
        };
        if meta.commit == env.commit
            && !(need_check && meta.check_json.is_none())
            && snapshot::unchanged(root, &meta.stats)
            && !needs_work(store, env.now_ms)?
        {
            return Ok(());
        }
        let details = read_details(store)?;
        let Some(old) = snapshot::decode(&meta.stats, &details) else {
            return rebuild(store, root, env);
        };
        let detected = detect(root, old)?;
        if need_check && (meta.check_json.is_none() || detected.files_changed) {
            return rebuild(store, root, env);
        }
        if !detected.changed && meta.commit == env.commit && !needs_work(store, env.now_ms)? {
            return Ok(());
        }
        match store.transaction(|| apply(store, root, env, &meta, &detected))? {
            Applied::Done => return Ok(()),
            Applied::Raced => continue,
            Applied::Rebuild => return rebuild(store, root, env),
        }
    }
    rebuild(store, root, env)
}

fn needs_work(store: &Store, now_ms: i64) -> Result<bool, String> {
    db(store.conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM cache_dirty WHERE root = ?1)
             OR EXISTS (SELECT 1 FROM cache_holons WHERE valid_until <= ?2)
             OR EXISTS (SELECT 1 FROM cache_holons WHERE valid_from > ?2)",
        params![store.root, now_ms],
        |row| row.get(0),
    ))
}

#[derive(Deserialize)]
struct StoredCheck {
    holons: usize,
    errors: Vec<CheckError>,
    warnings: Vec<CheckWarning>,
}

pub fn check(store: &Store) -> Result<CheckOutput, String> {
    let json: Option<String> = db(store.conn.query_row(
        "SELECT check_json FROM cache_meta WHERE key = 0",
        [],
        |row| row.get(0),
    ))?;
    let stored: StoredCheck = from_json(&json.ok_or("holon cache: check is stale")?)?;
    Ok(CheckOutput {
        format: "holon-check/v0",
        holons: stored.holons,
        errors: stored.errors,
        warnings: stored.warnings,
    })
}

pub fn drift(store: &Store, env: &EvalEnv) -> Result<DriftOutput, String> {
    let mut statement = db(store
        .conn
        .prepare("SELECT id, eval_json FROM cache_holons WHERE drift_count > 0"))?;
    let rows = db(statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }))?;
    let mut drift: Vec<DriftEntry> = Vec::new();
    for row in rows {
        let (id, json) = db(row)?;
        let evaluation: HolonEvaluation = from_json(&json)?;
        drift.extend(evaluation.drift.into_iter().map(|item| DriftEntry {
            holon: id.clone(),
            drift: item,
        }));
    }
    drift.sort_by(|a, b| {
        js_cmp(&a.holon, &b.holon)
            .then_with(|| holon_core::evaluate::compare_drift(&a.drift, &b.drift))
    });
    Ok(DriftOutput {
        format: "holon-drift/v0",
        drift,
        computed_at: format_instant(env.now_ms),
        commit: env.commit.clone(),
    })
}

fn facts(conn: &Connection, id: &str) -> Result<Option<NodeFacts>, String> {
    let row = db(conn
        .prepare_cached(
            "SELECT kind, title, status, light, drift_below, (SELECT count(*) FROM cache_holons c WHERE c.part_of = h.id) FROM cache_holons h WHERE id = ?",
        )
        .and_then(|mut statement| {
            statement
                .query_row([id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })
                .optional()
        }))?;
    let Some((kind, title, status, light, below, children)) = row else {
        return Ok(None);
    };
    Ok(Some(NodeFacts {
        id: id.to_string(),
        kind: known(&KINDS, &kind)?,
        title,
        status: known(&STATUSES, &status)?,
        light: from_text(&light)?,
        drift_below: below as usize,
        child_count: children as usize,
    }))
}

pub fn view(
    store: &Store,
    root: &Path,
    env: &EvalEnv,
    id: &str,
) -> Result<Option<ViewOutput>, String> {
    let conn = &store.conn;
    let row: Option<(String, String, i64)> = db(conn
        .prepare_cached("SELECT path, eval_json, drift_below FROM cache_holons WHERE id = ?")
        .and_then(|mut statement| {
            statement
                .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .optional()
        }))?;
    let Some((path, json, below)) = row else {
        return Ok(None);
    };
    let holon = parse_at(root, &path)?
        .filter(|holon| holon.id == id)
        .ok_or_else(|| format!("holon cache: {path} changed while reading"))?;
    let evaluation: HolonEvaluation = from_json(&json)?;
    let parent = match &holon.part_of {
        Some(parent) => facts(conn, parent)?,
        None => None,
    };
    let mut child_ids = column_strings(conn, "SELECT id FROM cache_holons WHERE part_of = ?", &id)?;
    child_ids.sort_by(|a, b| js_cmp(a, b));
    let mut children = Vec::with_capacity(child_ids.len());
    for child in &child_ids {
        children.extend(facts(conn, child)?);
    }
    let mut statement = db(conn.prepare_cached(
        "SELECT s.holon, s.idx, h.title, s.contract, s.read_only, s.exclusive, s.light, s.drift FROM cache_seams s JOIN cache_holons h ON h.id = s.holon WHERE s.target = ?1 AND s.holon != ?1",
    ))?;
    let rows = db(statement.query_map([id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, bool>(4)?,
            row.get::<_, bool>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, Option<String>>(7)?,
        ))
    }))?;
    let mut incoming = Vec::new();
    for row in rows {
        let (from, index, from_title, contract, read_only, exclusive, light, drift) = db(row)?;
        incoming.push((
            index,
            IncomingSeam {
                from,
                from_title,
                contract,
                read_only,
                exclusive,
                light: from_text(&light)?,
                drift: drift.as_deref().map(from_text).transpose()?,
            },
        ));
    }
    incoming.sort_by(|a, b| js_cmp(&a.1.from, &b.1.from).then_with(|| a.0.cmp(&b.0)));
    let parts = ViewParts {
        holon: &holon,
        evaluation,
        drift_below: below as usize,
        parent,
        children,
        incoming: incoming.into_iter().map(|(_, seam)| seam).collect(),
    };
    let title = |other: &str| -> Option<String> {
        conn.prepare_cached("SELECT title FROM cache_holons WHERE id = ?")
            .and_then(|mut statement| statement.query_row([other], |row| row.get(0)).optional())
            .ok()
            .flatten()
    };
    Ok(Some(build_view(parts, &title, env.now_ms, &env.commit)))
}
