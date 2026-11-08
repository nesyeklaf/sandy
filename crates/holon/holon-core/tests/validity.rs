use holon_core::format::parse_evidence_lines;
use holon_core::model::read_holon_file;
use holon_core::time::{contract_hash, parse_instant};
use holon_core::{EvalEnv, Model, UnchangedCode};

fn model(evidence_at: &str, contract: &str) -> Model {
    let holon = format!(
        "{{\"format\":\"holon/v0\",\"id\":\"a\",\"kind\":\"component\",\"partOf\":null,\"title\":\"A\",\"status\":\"active\",\"why\":\"w\",\"contract\":\"{contract}\",\"carriedBy\":[],\"code\":[\"src/a.ts\"],\"seams\":[],\"proofs\":{{\"It\":{{\"kind\":\"ci\",\"source\":\"t\",\"every\":\"10d\"}}}}}}"
    );
    let line = format!(
        "{{\"holon\":\"a\",\"side\":\"It\",\"kind\":\"ci\",\"source\":\"t\",\"result\":\"pass\",\"contractHash\":\"{}\",\"build\":\"b1\",\"environment\":\"ci\",\"at\":\"{evidence_at}\",\"expires\":null,\"detail\":\"\"}}",
        contract_hash("c")
    );
    Model::new(
        vec![read_holon_file("a.holon".to_string(), &holon)],
        Vec::new(),
        parse_evidence_lines(&line).expect("evidence"),
    )
}

fn validity(model: &Model, now: &str, commit: &str) -> holon_core::evaluate::Validity {
    let env = EvalEnv {
        now_ms: parse_instant(now).expect("now"),
        commit: commit.to_string(),
        code: &UnchangedCode,
    };
    model.evaluate(&env).evaluation("a").expect("a").validity
}

#[test]
fn fresh_machine_evidence_holds_until_it_expires_and_depends_on_the_commit() {
    let model = model("2026-11-01T00:00:00Z", "c");
    let validity = validity(&model, "2026-11-05T00:00:00Z", "b2");
    assert_eq!(validity.until_ms, parse_instant("2026-11-11T00:00:00Z"));
    assert_eq!(validity.from_ms, None);
    assert!(validity.uses_commit);
    assert!(validity.holds_at(parse_instant("2026-11-10T23:59:59Z").expect("t")));
    assert!(!validity.holds_at(parse_instant("2026-11-11T00:00:00Z").expect("t")));
}

#[test]
fn expired_evidence_holds_from_its_expiry_and_ignores_the_commit() {
    let model = model("2026-10-01T00:00:00Z", "c");
    let validity = validity(&model, "2026-11-05T00:00:00Z", "b2");
    assert_eq!(validity.from_ms, parse_instant("2026-10-11T00:00:00Z"));
    assert_eq!(validity.until_ms, None);
    assert!(!validity.uses_commit);
    assert!(!validity.holds_at(parse_instant("2026-10-10T00:00:00Z").expect("t")));
}

#[test]
fn evidence_against_an_older_contract_depends_on_nothing() {
    let model = model("2026-11-01T00:00:00Z", "changed");
    let validity = validity(&model, "2026-11-05T00:00:00Z", "b2");
    assert_eq!(validity, holon_core::evaluate::Validity::default());
}
