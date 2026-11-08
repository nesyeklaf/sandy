use holon_core::format::parse_evidence_lines;
use holon_core::model::read_sources;
use holon_core::outputs::to_json;
use holon_core::scan::scan_root;
use holon_core::time::{contract_hash, parse_instant};
use holon_core::{EvalEnv, Model, UnchangedCode};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::Instant;

const BRANCH: usize = 7;
const DEPTH: usize = 7;
const KIND_AT_DEPTH: [&str; 7] = [
    "context",
    "system",
    "container",
    "component",
    "operation",
    "task",
    "step",
];
const NOW: &str = "2026-11-08T12:00:00Z";
const COMMIT: &str = "bench";

struct Planned {
    id: String,
    part_of: Option<String>,
    depth: usize,
    path: String,
    contract: String,
}

struct Lcg(f64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = (self.0 * 1_103_515_245.0 + 12_345.0) % 2_147_483_648.0;
        self.0 / 2_147_483_648.0
    }
}

fn plan(planned: &mut Vec<Planned>, parent: Option<usize>, depth: usize, dir: &str) {
    let id = format!("h{}", planned.len());
    let path = format!("{dir}/{id}.holon");
    let contract = format!("{id} works once, for 30 minutes, for the address it was sent to.");
    let part_of = parent.map(|parent| planned[parent].id.clone());
    let index = planned.len();
    planned.push(Planned {
        id: id.clone(),
        part_of,
        depth,
        path,
        contract,
    });
    if depth < DEPTH - 1 {
        let child_dir = if depth < 3 {
            format!("{dir}/{id}")
        } else {
            dir.to_string()
        };
        for _ in 0..BRANCH {
            plan(planned, Some(index), depth + 1, &child_dir);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeamOut<'a> {
    to: &'a str,
    contract: &'a str,
    read_only: bool,
}

#[derive(Serialize)]
struct ProofOut {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

#[derive(Serialize)]
struct ProofsOut {
    #[serde(rename = "It")]
    it: ProofOut,
    #[serde(rename = "I")]
    i: ProofOut,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HolonOut<'a> {
    format: &'static str,
    id: &'a str,
    kind: &'static str,
    part_of: Option<&'a str>,
    title: String,
    status: &'static str,
    why: String,
    contract: &'a str,
    carried_by: [&'a str; 0],
    code: [String; 1],
    seams: Vec<SeamOut<'a>>,
    proofs: ProofsOut,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvidenceOut<'a> {
    holon: &'a str,
    side: &'static str,
    kind: &'static str,
    source: String,
    result: &'static str,
    contract_hash: String,
    build: &'static str,
    environment: &'static str,
    at: &'static str,
    expires: Option<&'static str>,
    detail: &'static str,
}

fn generate(root: &Path) -> String {
    let mut planned = Vec::new();
    plan(&mut planned, None, 0, "tree");
    let mut random = Lcg(42.0);
    let mut evidence = String::new();
    for item in &planned {
        let file = root.join(&item.path);
        fs::create_dir_all(file.parent().expect("parent")).expect("create dir");
        let pick = (random.next() * planned.len() as f64).floor() as usize;
        let target = &planned[pick];
        let holon = HolonOut {
            format: "holon/v0",
            id: &item.id,
            kind: KIND_AT_DEPTH[item.depth],
            part_of: item.part_of.as_deref(),
            title: format!("Holon {}", item.id),
            status: "active",
            why: format!(
                "Serves {} so that users can do something useful without friction.",
                item.part_of.as_deref().unwrap_or("the world")
            ),
            contract: &item.contract,
            carried_by: [],
            code: [format!("src/{}.ts", item.id)],
            seams: if target.id == item.id {
                Vec::new()
            } else {
                vec![SeamOut {
                    to: &target.id,
                    contract: "Reads what it needs",
                    read_only: true,
                }]
            },
            proofs: ProofsOut {
                it: ProofOut {
                    kind: "ci",
                    source: Some(format!("src/{}.test.ts", item.id)),
                },
                i: ProofOut {
                    kind: "interview",
                    source: None,
                },
            },
        };
        fs::write(
            &file,
            serde_json::to_string_pretty(&holon).expect("holon json"),
        )
        .expect("write holon");
        let roll = random.next();
        if roll < 0.9 {
            let record = EvidenceOut {
                holon: &item.id,
                side: "It",
                kind: "ci",
                source: format!("src/{}.test.ts", item.id),
                result: if roll < 0.89 { "pass" } else { "fail" },
                contract_hash: contract_hash(&item.contract),
                build: COMMIT,
                environment: "ci",
                at: "2026-11-01T00:00:00Z",
                expires: if roll < 0.8 {
                    None
                } else {
                    Some("2026-11-05T00:00:00Z")
                },
                detail: "",
            };
            evidence.push_str(&serde_json::to_string(&record).expect("evidence json"));
            evidence.push('\n');
        }
    }
    fs::write(root.join("evidence.jsonl"), &evidence).expect("write evidence");
    let component = planned
        .iter()
        .find(|item| item.depth == 3)
        .expect("component");
    format!("{} holons, view {}", planned.len(), component.id)
}

fn ms(start: Instant) -> f64 {
    (start.elapsed().as_secs_f64() * 1_000_000.0).round() / 1000.0
}

fn cold(root: &Path, view_id: &str, out: Option<&Path>) {
    let total = Instant::now();
    let start = Instant::now();
    let scan = scan_root(root);
    let scan_ms = ms(start);
    let start = Instant::now();
    let (files, confirmations) = read_sources(root, scan);
    let read_parse_ms = ms(start);
    let start = Instant::now();
    let text = fs::read_to_string(root.join("evidence.jsonl")).expect("evidence");
    let evidence = parse_evidence_lines(&text).expect("valid evidence");
    let evidence_ms = ms(start);
    let start = Instant::now();
    let model = Model::new(files, confirmations, evidence);
    let model_ms = ms(start);
    let env = EvalEnv {
        now_ms: parse_instant(NOW).expect("now"),
        commit: COMMIT.to_string(),
        code: &UnchangedCode,
    };
    let start = Instant::now();
    let evaluated = model.evaluate(&env);
    let evaluate_ms = ms(start);
    let start = Instant::now();
    let view = evaluated.view(view_id).expect("view holon");
    let view_ms = ms(start);
    let cold_ms = ms(total);
    let start = Instant::now();
    let drift = evaluated.drift();
    let drift_ms = ms(start);
    let start = Instant::now();
    let check = model.check();
    let check_ms = ms(start);
    if let Some(out) = out {
        fs::write(out.join("rust-view.json"), to_json(&view)).expect("write view");
        fs::write(out.join("rust-drift.json"), to_json(&drift)).expect("write drift");
        fs::write(out.join("rust-check.json"), to_json(&check)).expect("write check");
    }
    println!(
        "{}",
        serde_json::json!({
            "holons": model.len(),
            "threads": std::thread::available_parallelism().map_or(1, |count| count.get()),
            "scanMs": scan_ms,
            "readParseMs": read_parse_ms,
            "evidenceMs": evidence_ms,
            "modelMs": model_ms,
            "evaluateMs": evaluate_ms,
            "viewMs": view_ms,
            "coldViewMs": cold_ms,
            "driftMs": drift_ms,
            "checkMs": check_ms,
            "driftEntries": drift.drift.len(),
        })
    );
}

fn io_floor(root: &Path) {
    let start = Instant::now();
    let scan = scan_root(root);
    let scan_ms = ms(start);
    let start = Instant::now();
    let bytes: usize = scan
        .holon_files
        .iter()
        .map(|path| fs::read(root.join(path)).map_or(0, |data| data.len()))
        .sum();
    let read_ms = ms(start);
    let start = Instant::now();
    let texts: Vec<String> = scan
        .holon_files
        .iter()
        .map(|path| fs::read_to_string(root.join(path)).unwrap_or_default())
        .collect();
    let reread_ms = ms(start);
    let start = Instant::now();
    let parsed = texts
        .iter()
        .filter(|text| holon_core::format::parse_holon(text).is_ok())
        .count();
    let parse_ms = ms(start);
    println!(
        "{}",
        serde_json::json!({
            "files": scan.holon_files.len(),
            "bytes": bytes,
            "scanMs": scan_ms,
            "sequentialReadMs": read_ms,
            "sequentialRereadMs": reread_ms,
            "sequentialParseMs": parse_ms,
            "parsed": parsed,
        })
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["gen", dir] => println!("{}", generate(Path::new(dir))),
        ["io", dir] => io_floor(Path::new(dir)),
        ["cold", dir, view] => cold(Path::new(dir), view, None),
        ["cold", dir, view, out] => cold(Path::new(dir), view, Some(Path::new(out))),
        _ => {
            eprintln!(
                "usage: holon-bench gen <dir> | holon-bench io <dir> | holon-bench cold <dir> <view-id> [<out-dir>]"
            );
            std::process::exit(2);
        }
    }
}
