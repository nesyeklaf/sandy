use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const DAY_MS: i64 = 86_400_000;
const START_MS: i64 = 1_794_139_200_000;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/designs/holons/fixtures/shop")
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("create dir");
    for entry in fs::read_dir(from).expect("read dir") {
        let entry = entry.expect("entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            if entry.file_name() != "expected" {
                copy_tree(&entry.path(), &target);
            }
        } else {
            fs::copy(entry.path(), target).expect("copy");
        }
    }
}

fn civil(ms: i64) -> String {
    let days = ms.div_euclid(DAY_MS);
    let seconds = ms.rem_euclid(DAY_MS) / 1000;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    )
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() {
            None
        } else {
            Some(&items[self.below(items.len())])
        }
    }
}

struct Repo {
    dir: PathBuf,
    now_ms: i64,
    added: usize,
}

impl Repo {
    fn new(seed: u64) -> Repo {
        let dir =
            std::env::temp_dir().join(format!("holon-differential-{seed}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        copy_tree(&fixture(), &dir.join("repo"));
        let repo = Repo {
            dir,
            now_ms: START_MS,
            added: 0,
        };
        repo.git(&["init", "-q"]);
        repo.commit();
        repo
    }

    fn root(&self) -> PathBuf {
        self.dir.join("repo")
    }

    fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(self.root())
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
            .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("utf8")
            .trim()
            .to_string()
    }

    fn commit(&self) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "--allow-empty", "-m", "step"]);
    }

    fn run(&self, args: &[&str], cache: bool) -> Output {
        let db = self.dir.join("state.db");
        let mut command = Command::new(env!("CARGO_BIN_EXE_holon"));
        command
            .current_dir(self.root())
            .args(args)
            .args(["--root", ".", "--now", &civil(self.now_ms)])
            .args(["--db", db.to_str().expect("utf8 path")]);
        if !cache {
            command.arg("--no-cache");
        }
        command.output().expect("holon runs")
    }

    fn files(&self, dir: &Path, extension: &str, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).expect("read dir") {
            let entry = entry.expect("entry");
            let path = entry.path();
            let name = entry.file_name();
            if entry.file_type().expect("file type").is_dir() {
                if name != ".git" {
                    self.files(&path, extension, out);
                }
            } else if path.extension().is_some_and(|found| found == extension) {
                out.push(path);
            }
        }
        out.sort();
    }

    fn holon_files(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        self.files(&self.root(), "holon", &mut out);
        out
    }

    fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .holon_files()
            .iter()
            .filter_map(|path| read_json(path))
            .filter_map(|value| value.get("id").and_then(Value::as_str).map(String::from))
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    fn dirs(&self) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = self
            .holon_files()
            .iter()
            .filter_map(|path| path.parent().map(Path::to_path_buf))
            .collect();
        dirs.sort();
        dirs.dedup();
        dirs
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn write_json(path: &Path, value: &Value) {
    fs::write(
        path,
        serde_json::to_string_pretty(value).expect("json") + "\n",
    )
    .expect("write");
}

const CODE: [&str; 6] = [
    "apps/account/sign-in.ts",
    "apps/account/reset.ts",
    "apps/mail/send.ts",
    "apps/search/",
    "apps/checkout/pay.ts",
    "platform/",
];

fn write_seam(repo: &Repo, rng: &mut Rng) -> String {
    let files = repo.holon_files();
    let Some(path) = rng.pick(&files) else {
        return "seam nothing".to_string();
    };
    let Some(mut value) = read_json(path) else {
        return "seam invalid".to_string();
    };
    let read_only = rng.below(3) == 0;
    let seams = if rng.below(3) == 0 {
        json!([])
    } else {
        json!([{"to": "user-db", "contract": "Writes", "readOnly": read_only}])
    };
    value
        .as_object_mut()
        .expect("object")
        .insert("seams".into(), seams);
    write_json(path, &value);
    format!("seam {} {read_only}", path.display())
}

fn edit(repo: &Repo, rng: &mut Rng, ids: &[String]) -> String {
    let files = repo.holon_files();
    let Some(path) = rng.pick(&files) else {
        return "edit nothing".to_string();
    };
    let Some(mut value) = read_json(path) else {
        return "edit invalid".to_string();
    };
    let other = rng.pick(ids).cloned().unwrap_or_default();
    let what = rng.below(7);
    let object = value.as_object_mut().expect("object");
    match what {
        0 => {
            object.insert(
                "title".into(),
                json!(format!("Title {}", rng.next() % 1000)),
            );
        }
        1 => {
            let status = ["proposed", "active", "retired"][rng.below(3)];
            object.insert("status".into(), json!(status));
        }
        2 => {
            object.insert("partOf".into(), json!(other));
        }
        3 => {
            let to = if rng.below(2) == 0 {
                "user-db".to_string()
            } else {
                other
            };
            let seam = json!({"to": to, "contract": "Writes", "exclusive": rng.below(2) == 0, "readOnly": rng.below(3) == 0});
            object.insert("seams".into(), json!([seam]));
        }
        4 => {
            object.insert("seams".into(), json!([]));
        }
        5 => {
            let code = CODE[rng.below(CODE.len())];
            object.insert("code".into(), json!([code]));
        }
        _ => {
            object.insert(
                "contract".into(),
                json!(format!("Contract {}", rng.next() % 1000)),
            );
        }
    }
    write_json(path, &value);
    format!("edit {} {what}", path.display())
}

fn add(repo: &mut Repo, rng: &mut Rng, ids: &[String]) -> String {
    repo.added += 1;
    let id = format!("added-{}", repo.added);
    let dirs = repo.dirs();
    let dir = rng.pick(&dirs).cloned().unwrap_or_else(|| repo.root());
    let dir = if rng.below(2) == 0 {
        dir.join(&id)
    } else {
        dir
    };
    fs::create_dir_all(&dir).expect("mkdir");
    let part_of = rng.pick(ids).cloned();
    let value = json!({
        "format": "holon/v0",
        "id": id,
        "kind": "component",
        "partOf": part_of,
        "title": format!("Added {}", repo.added),
        "status": "active",
        "why": "Testing.",
        "contract": "Does a thing.",
        "carriedBy": ["team-identity"],
        "code": [CODE[rng.below(CODE.len())]],
        "seams": [],
        "proofs": {"It": {"kind": "ci", "source": "added.test.ts"}, "We": {"kind": "confirmation", "every": "30d"}}
    });
    let path = dir.join(format!("{id}.holon"));
    write_json(&path, &value);
    format!("add {}", path.display())
}

const MACHINE: [&str; 6] = ["ci", "metric", "alert", "file", "ticket", "formal"];

fn proof_sides(repo: &Repo, machine: bool) -> Vec<(String, String)> {
    let wanted = |proof: &Value| {
        let kind = proof.get("kind").and_then(Value::as_str).unwrap_or("");
        MACHINE.contains(&kind) == machine
    };
    let mut sides = Vec::new();
    for value in repo.holon_files().iter().filter_map(|path| read_json(path)) {
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        if let Some(proofs) = value.get("proofs").and_then(Value::as_object) {
            sides.extend(
                proofs
                    .iter()
                    .filter(|(_, proof)| wanted(proof))
                    .map(|(side, _)| (id.to_string(), side.clone())),
            );
        }
        if let Some(seams) = value.get("seams").and_then(Value::as_array) {
            sides.extend(
                seams
                    .iter()
                    .filter(|seam| seam.get("proof").is_some_and(wanted))
                    .filter_map(|seam| seam.get("to").and_then(Value::as_str))
                    .map(|to| (id.to_string(), format!("seam:{to}"))),
            );
        }
    }
    sides
}

fn step(repo: &mut Repo, rng: &mut Rng) -> String {
    let ids = repo.ids();
    let files = repo.holon_files();
    match rng.below(13) {
        0 | 1 => edit(repo, rng, &ids),
        12 => write_seam(repo, rng),
        2 => add(repo, rng, &ids),
        3 => match rng.pick(&files) {
            Some(path) => {
                fs::remove_file(path).expect("delete");
                format!("delete {}", path.display())
            }
            None => "delete nothing".to_string(),
        },
        4 => {
            let dirs = repo.dirs();
            match (rng.pick(&files).cloned(), rng.pick(&dirs).cloned()) {
                (Some(path), Some(dir)) => {
                    let target = dir.join(format!("moved-{}.holon", rng.next() % 1000));
                    fs::rename(&path, &target).expect("move");
                    format!("move {} {}", path.display(), target.display())
                }
                _ => "move nothing".to_string(),
            }
        }
        5 => match rng.pick(&files) {
            Some(path) => {
                let target = path.with_file_name(format!("copy-{}.holon", rng.next() % 1000));
                fs::copy(path, &target).expect("copy");
                format!("duplicate {}", target.display())
            }
            None => "duplicate nothing".to_string(),
        },
        6 => match rng.pick(&files) {
            Some(path) if rng.below(3) == 0 => {
                fs::write(path, "{ not json").expect("write");
                format!("break {}", path.display())
            }
            Some(path) => {
                let text = fs::read(path).expect("read");
                fs::write(path, text).expect("write");
                format!("touch {}", path.display())
            }
            None => "touch nothing".to_string(),
        },
        7 => {
            let code = CODE[rng.below(CODE.len())];
            let file = if code.ends_with('/') {
                format!("{code}file.ts")
            } else {
                code.to_string()
            };
            let path = repo.root().join(&file);
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            fs::write(&path, format!("export const v = {};\n", rng.next())).expect("write");
            repo.commit();
            format!("commit {file}")
        }
        8 => {
            let Some((id, side)) = rng.pick(&proof_sides(repo, true)).cloned() else {
                return "record nothing".to_string();
            };
            let build = if rng.below(3) == 0 {
                "fixture".to_string()
            } else {
                repo.git(&["rev-parse", "HEAD"])
            };
            let result = ["pass", "fail"][rng.below(2)];
            let at = civil(repo.now_ms - DAY_MS);
            let expires = civil(repo.now_ms + rng.below(60) as i64 * DAY_MS);
            let output = repo.run(
                &[
                    "evidence",
                    "record",
                    "--holon",
                    &id,
                    "--side",
                    &side,
                    "--source",
                    "t.test.ts",
                    "--result",
                    result,
                    "--build",
                    &build,
                    "--at",
                    &at,
                    "--expires",
                    &expires,
                ],
                true,
            );
            format!(
                "record {id} {side} {result} {build} -> {}",
                outcome(&output)
            )
        }
        9 => {
            let Some((id, side)) = rng.pick(&proof_sides(repo, false)).cloned() else {
                return "confirm nothing".to_string();
            };
            let result = ["confirmed", "refuted"][rng.below(2)];
            let by = ["maria", "nesyeklaf"][rng.below(2)];
            let output = repo.run(
                &[
                    "confirm", &id, "--side", &side, "--by", by, "--answer", "Yes", "--result",
                    result,
                ],
                true,
            );
            format!("confirm {id} {side} {result} -> {}", outcome(&output))
        }
        10 => {
            let mut confirmations = Vec::new();
            let folder = repo.root().join(".holons");
            if folder.exists() {
                repo.files(&folder, "json", &mut confirmations);
            }
            match rng.pick(&confirmations) {
                Some(path) => {
                    fs::remove_file(path).expect("delete");
                    format!("unconfirm {}", path.display())
                }
                None => "unconfirm nothing".to_string(),
            }
        }
        _ => {
            repo.now_ms += rng.below(120) as i64 * DAY_MS + rng.below(1000) as i64;
            format!("time {}", civil(repo.now_ms))
        }
    }
}

fn outcome(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!(
        "{:?} {}",
        output.status.code(),
        stderr.lines().next().unwrap_or("")
    )
}

fn compare(repo: &Repo, rng: &mut Rng, log: &[String]) {
    let ids = repo.ids();
    let mut commands: Vec<Vec<String>> = vec![vec!["drift".into()]];
    for _ in 0..3 {
        if let Some(id) = rng.pick(&ids) {
            commands.push(vec!["view".into(), id.clone()]);
        }
    }
    commands.push(vec!["view".into(), "missing-holon".into()]);
    let at = rng.below(commands.len() + 1);
    commands.insert(at, vec!["drift".into()]);
    commands.push(vec!["check".into()]);
    for command in commands {
        let mut args: Vec<&str> = command.iter().map(String::as_str).collect();
        args.push("--json");
        let cached = repo.run(&args, true);
        let fresh = repo.run(&args, false);
        let shown = |output: &Output| {
            format!(
                "{:?}\n{}\n{}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        };
        assert_eq!(
            shown(&cached),
            shown(&fresh),
            "{command:?} after:\n{}",
            log.join("\n")
        );
    }
}

fn differential(seed: u64, steps: usize) {
    let mut repo = Repo::new(seed);
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut log = Vec::new();
    compare(&repo, &mut rng, &log);
    for _ in 0..steps {
        log.push(step(&mut repo, &mut rng));
        compare(&repo, &mut rng, &log);
    }
}

#[test]
fn cache_matches_fresh_recompute_seed_1() {
    differential(1, 60);
}

#[test]
fn cache_matches_fresh_recompute_seed_2() {
    differential(2, 60);
}

#[test]
fn cache_matches_fresh_recompute_seed_3() {
    differential(3, 60);
}

#[test]
fn cache_matches_fresh_recompute_seed_4() {
    differential(4, 60);
}
