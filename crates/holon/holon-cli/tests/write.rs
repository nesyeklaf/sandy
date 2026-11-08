use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const AT: [&str; 4] = ["--now", "2026-11-08T12:00:00Z", "--commit", "fixture"];

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/designs/holons/fixtures/shop")
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("create dir");
    for entry in fs::read_dir(from).expect("read dir") {
        let entry = entry.expect("entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).expect("copy");
        }
    }
}

struct Workspace {
    dir: PathBuf,
}

impl Workspace {
    fn new(name: &str) -> Workspace {
        let dir = std::env::temp_dir().join(format!("holon-write-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        copy_tree(&fixture(), &dir.join("shop"));
        Workspace { dir }
    }

    fn root(&self) -> PathBuf {
        self.dir.join("shop")
    }

    fn run(&self, args: &[&str]) -> Output {
        let db = self.dir.join("state.db");
        Command::new(env!("CARGO_BIN_EXE_holon"))
            .current_dir(self.root())
            .args(args)
            .args(["--root", "."])
            .args(["--db", db.to_str().expect("utf8 path")])
            .output()
            .expect("holon runs")
    }

    fn stdout(&self, args: &[&str]) -> String {
        let output = self.run(args);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).expect("utf8")
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn with(args: &[&'static str], extra: &[&'static str]) -> Vec<&'static str> {
    args.iter().chain(extra).copied().collect()
}

#[test]
fn recorded_evidence_counts_like_an_evidence_file() {
    let space = Workspace::new("record");
    let recorded = space.stdout(&with(
        &["evidence", "record", "--file", "evidence.jsonl", "--json"],
        &AT,
    ));
    assert!(
        recorded.contains("\"format\": \"holon-evidence-recorded/v0\""),
        "{recorded}"
    );
    for slug in ["password-reset", "account", "sign-in"] {
        let view = space.stdout(&with(&["view", slug, "--json"], &AT));
        let wanted =
            fs::read_to_string(fixture().join("expected").join(format!("view-{slug}.json")))
                .expect("expected view");
        assert_eq!(view, wanted, "{slug}");
    }
}

#[test]
fn export_returns_what_import_replaced() {
    let space = Workspace::new("export");
    space.stdout(&with(
        &["evidence", "record", "--file", "evidence.jsonl"],
        &AT,
    ));
    space.stdout(&with(
        &["evidence", "record", "--file", "evidence.jsonl"],
        &AT,
    ));
    let doubled = space.stdout(&["evidence", "export"]);
    fs::write(space.root().join("export.jsonl"), &doubled).expect("write export");
    space.stdout(&with(
        &["evidence", "import", "export.jsonl", "--replace"],
        &AT,
    ));
    assert_eq!(space.stdout(&["evidence", "export"]), doubled);
    let original = fs::read_to_string(space.root().join("evidence.jsonl")).expect("evidence");
    assert_eq!(
        doubled.lines().count(),
        2 * original
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count()
    );
}

#[test]
fn confirm_writes_one_file_per_holon_side_person_and_day() {
    let space = Workspace::new("confirm");
    let args = with(
        &[
            "confirm",
            "sign-in",
            "--side",
            "I",
            "--by",
            "agent:x",
            "--answer",
            "works",
            "--hesitation",
            "a",
        ],
        &AT,
    );
    let text = space.stdout(&args);
    let path = ".holons/confirmations/sign-in/2026-11-08-I-agent_x.json";
    assert!(
        text.starts_with(&format!("● wrote {path}; I is now ")),
        "{text}"
    );
    let written = fs::read_to_string(space.root().join(path)).expect("confirmation file");
    assert!(
        written
            .starts_with("{\n  \"format\": \"holon-confirmation/v0\",\n  \"holon\": \"sign-in\","),
        "{written}"
    );
    assert!(written.contains("\"expires\": \"2027-02-06\""), "{written}");
    let again = space.run(&with(&args, &["--json"]));
    assert_eq!(again.status.code(), Some(1));
    let failure = String::from_utf8(again.stdout).expect("utf8");
    assert!(
        failure.contains("\"code\": \"confirmation_exists\""),
        "{failure}"
    );
}
