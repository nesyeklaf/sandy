use std::path::Path;
use std::process::Command;

fn cold_report(threads: &str) -> serde_json::Value {
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/designs/holons/fixtures/shop");
    let output = Command::new(env!("CARGO_BIN_EXE_holon-bench"))
        .env("RAYON_NUM_THREADS", threads)
        .arg("cold")
        .arg(&fixture)
        .arg("account")
        .output()
        .expect("holon-bench runs");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("json report")
}

#[test]
fn reports_the_threads_rayon_runs_on() {
    assert_eq!(cold_report("1")["threads"], 1);
    assert_eq!(cold_report("3")["threads"], 3);
    let cpus = cold_report("1")["cpus"].as_u64().expect("cpus");
    assert!(cpus >= 1);
}
