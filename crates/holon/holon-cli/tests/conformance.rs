use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/designs/holons/fixtures/shop")
}

fn holon(dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_holon"))
        .current_dir(dir)
        .args(args)
        .output()
        .expect("holon runs")
}

fn fixture_run(args: &[&str]) -> Output {
    let mut all = args.to_vec();
    all.extend([
        "--json",
        "--root",
        ".",
        "--now",
        "2026-11-08T12:00:00Z",
        "--commit",
        "fixture",
        "--evidence",
        "evidence.jsonl",
    ]);
    holon(&fixture(), &all)
}

fn assert_matches(args: &[&str], expected: &str) {
    let output = fixture_run(args);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let wanted =
        fs::read_to_string(fixture().join("expected").join(expected)).expect("expected file");
    assert_eq!(
        String::from_utf8(output.stdout).expect("utf8"),
        wanted,
        "{expected}"
    );
}

#[test]
fn check_matches_the_fixture() {
    assert_matches(&["check"], "check.json");
}

#[test]
fn drift_matches_the_fixture() {
    assert_matches(&["drift"], "drift.json");
}

#[test]
fn views_match_the_fixture() {
    for slug in ["password-reset", "account", "sign-in"] {
        assert_matches(&["view", slug], &format!("view-{slug}.json"));
    }
}

#[test]
fn unknown_holon_fails_with_its_id() {
    let output = fixture_run(&["view", "nope"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("no holon nope under"));
}

#[test]
fn rejects_a_now_that_is_no_timestamp() {
    let output = holon(
        &fixture(),
        &["drift", "--root", ".", "--now", "2026-13-01T00:00:00Z"],
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("--now 2026-13-01T00:00:00Z is no ISO timestamp"));
}

fn holon_json(id: &str, part_of: Option<&str>) -> String {
    let part_of = part_of.map_or_else(|| "null".to_string(), |parent| format!("\"{parent}\""));
    format!(
        "{{\"format\":\"holon/v0\",\"id\":\"{id}\",\"kind\":\"system\",\"partOf\":{part_of},\"title\":\"{id}\",\"status\":\"active\",\"why\":\"w\",\"contract\":\"c\",\"carriedBy\":[],\"code\":[],\"seams\":[],\"proofs\":{{}}}}"
    )
}

#[cfg(unix)]
#[test]
fn fails_on_an_unreadable_holon_file_like_node() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("holon-unreadable-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("temp dir");
    let file = root.join("a.holon");
    fs::write(&file, holon_json("a", None)).expect("write holon");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).expect("chmod");
    let readable = fs::read(&file).is_ok();
    let output = holon(
        &root,
        &["check", "--json", "--root", root.to_str().expect("utf8")],
    );
    fs::remove_dir_all(&root).expect("clean up");
    if readable {
        return;
    }
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        format!(
            "error: EACCES: permission denied, open '{}'\n",
            file.display()
        )
    );
}

#[test]
fn check_reports_broken_models_and_exits_1() {
    let root = std::env::temp_dir().join(format!("holon-check-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("b")).expect("temp dir");
    let files = [
        ("a.holon", holon_json("a", Some("c"))),
        ("c.holon", holon_json("c", Some("a"))),
        ("b/a.holon", holon_json("a", None)),
        ("lost.holon", holon_json("lost", Some("missing"))),
        ("named.holon", holon_json("other", None)),
        ("bad.holon", "{".to_string()),
    ];
    for (path, text) in files {
        fs::write(root.join(path), text).expect("write holon");
    }
    let output = holon(&root, &["check", "--json", "--root", "."]);
    fs::remove_dir_all(&root).expect("clean up");
    assert_eq!(output.status.code(), Some(1));
    let check: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    let errors: Vec<(String, String)> = check["errors"]
        .as_array()
        .expect("errors")
        .iter()
        .map(|error| {
            (
                error["file"].as_str().expect("file").to_string(),
                error["message"].as_str().expect("message").to_string(),
            )
        })
        .collect();
    assert_eq!(check["holons"], 4);
    let messages: Vec<&str> = errors
        .iter()
        .map(|(file, message)| {
            assert!(!file.is_empty());
            message.as_str()
        })
        .collect();
    assert!(
        messages.contains(&"partOf cycle: a -> c -> a"),
        "{messages:?}"
    );
    assert!(
        messages.contains(&"duplicate id a, also in a.holon"),
        "{messages:?}"
    );
    assert!(
        messages.contains(&"partOf names unknown holon missing"),
        "{messages:?}"
    );
    assert!(
        messages.contains(&"id other differs from the file name named.holon"),
        "{messages:?}"
    );
    assert!(
        errors.iter().any(|(file, _)| file == "bad.holon"),
        "{errors:?}"
    );
}
