use holon_core::format::{parse_evidence, Evidence};
use holon_core::time::parse_instant;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

pub struct Store {
    pub conn: Connection,
    pub root: String,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS evidence (
    id INTEGER PRIMARY KEY,
    root TEXT NOT NULL,
    holon TEXT NOT NULL,
    side TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_by_side ON evidence (root, holon, side, at_ms, id);
";

pub fn default_db_path(top_level: &Path) -> Option<PathBuf> {
    let digest = holon_core::time::contract_hash(&top_level.to_string_lossy());
    let name: String = digest
        .trim_start_matches("sha256:")
        .chars()
        .take(16)
        .collect();
    Some(dirs::data_dir()?.join("holon").join(format!("{name}.db")))
}

fn store_error(error: rusqlite::Error) -> String {
    format!("holon database: {error}")
}

impl Store {
    pub fn open(path: &Path, root: &Path) -> Result<Store, String> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        }
        let conn = Connection::open(path).map_err(store_error)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(store_error)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .map_err(store_error)?;
        conn.execute_batch(SCHEMA).map_err(store_error)?;
        Ok(Store {
            conn,
            root: root.to_string_lossy().into_owned(),
        })
    }

    pub fn evidence(&self) -> Result<Vec<Evidence>, String> {
        let mut statement = self
            .conn
            .prepare_cached("SELECT record_json FROM evidence WHERE root = ? ORDER BY id")
            .map_err(store_error)?;
        let rows = statement
            .query_map([&self.root], |row| row.get::<_, String>(0))
            .map_err(store_error)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(decode_evidence(&row.map_err(store_error)?)?);
        }
        Ok(records)
    }

    pub fn evidence_holons(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .conn
            .prepare_cached("SELECT DISTINCT holon FROM evidence WHERE root = ?")
            .map_err(store_error)?;
        let rows = statement
            .query_map([&self.root], |row| row.get::<_, String>(0))
            .map_err(store_error)?;
        rows.collect::<Result<_, _>>().map_err(store_error)
    }

    pub fn clear_evidence(&self) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM evidence WHERE root = ?", [&self.root])
            .map_err(store_error)?;
        Ok(())
    }

    pub fn insert_evidence(&self, records: &[Evidence]) -> Result<(), String> {
        let mut statement = self
            .conn
            .prepare_cached(
                "INSERT INTO evidence (root, holon, side, at_ms, record_json) VALUES (?, ?, ?, ?, ?)",
            )
            .map_err(store_error)?;
        for record in records {
            let at_ms = parse_instant(&record.at).expect("validated evidence time");
            let json = serde_json::to_string(record).expect("evidence serializes");
            statement
                .execute(params![self.root, record.holon, record.side, at_ms, json])
                .map_err(store_error)?;
        }
        Ok(())
    }

    pub fn transaction<T>(&self, run: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(store_error)?;
        match run() {
            Ok(value) => {
                self.conn.execute_batch("COMMIT").map_err(store_error)?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }
}

fn decode_evidence(json: &str) -> Result<Evidence, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|error| format!("holon database: {error}"))?;
    parse_evidence(&value).map_err(|error| format!("holon database: {error}"))
}

pub fn export_lines(records: &[Evidence]) -> String {
    records
        .iter()
        .map(|record| {
            format!(
                "{}\n",
                serde_json::to_string(record).expect("evidence serializes")
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use holon_core::format::parse_evidence_lines;

    fn record(side: &str, at: &str, detail: &str) -> Evidence {
        let line = format!(
            "{{\"holon\":\"a\",\"side\":\"{side}\",\"kind\":\"ci\",\"source\":\"t\",\"result\":\"pass\",\"contractHash\":\"sha256:{}\",\"build\":\"b\",\"environment\":\"ci\",\"at\":\"{at}\",\"expires\":null,\"detail\":\"{detail}\"}}",
            "0".repeat(64)
        );
        parse_evidence_lines(&line).expect("valid").remove(0)
    }

    fn memory() -> Store {
        let dir = std::env::temp_dir().join(format!(
            "holon-store-{}-{}",
            std::process::id(),
            fastrand_suffix()
        ));
        let store = Store::open(&dir.join("x.db"), Path::new("/root")).expect("opens");
        store
    }

    fn fastrand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    }

    #[test]
    fn exports_what_it_imported_line_for_line() {
        let store = memory();
        let text = export_lines(&[
            record("It", "2026-11-02T00:00:00Z", "x"),
            record("We", "2026-11-03T00:00:00Z", "y"),
        ]);
        store
            .insert_evidence(&parse_evidence_lines(&text).expect("parse"))
            .expect("insert");
        assert_eq!(export_lines(&store.evidence().expect("all")), text);
    }
}
