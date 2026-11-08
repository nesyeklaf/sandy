use crate::time::{is_calendar_date, is_iso_timestamp};
use serde::Serialize;
use serde_json::{Map, Value};

pub const KINDS: [&str; 22] = [
    "context",
    "system",
    "container",
    "component",
    "operation",
    "initiative",
    "project",
    "task",
    "step",
    "field",
    "topic",
    "concept",
    "claim",
    "source",
    "vision",
    "area",
    "goal",
    "habit",
    "data-point",
    "organisation",
    "team",
    "person",
];
pub const STATUSES: [&str; 3] = ["proposed", "active", "retired"];
pub const MACHINE_PROOF_KINDS: [&str; 6] = ["ci", "metric", "alert", "file", "ticket", "formal"];
pub const HUMAN_PROOF_KINDS: [&str; 3] = ["interview", "confirmation", "ai-review"];
const PROOF_KINDS: [&str; 9] = [
    "ci",
    "metric",
    "alert",
    "file",
    "ticket",
    "formal",
    "interview",
    "confirmation",
    "ai-review",
];
pub const HUMAN_MAX_DAYS: u64 = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Side {
    I,
    It,
    We,
    They,
}

impl Side {
    pub const ALL: [Side; 4] = [Side::I, Side::It, Side::We, Side::They];

    pub fn as_str(self) -> &'static str {
        match self {
            Side::I => "I",
            Side::It => "It",
            Side::We => "We",
            Side::They => "They",
        }
    }

    pub fn index(self) -> usize {
        self as usize
    }
}

pub fn is_human_kind(kind: &str) -> bool {
    HUMAN_PROOF_KINDS.contains(&kind)
}

pub fn is_slug(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn is_seam_side(value: &str) -> bool {
    value.strip_prefix("seam:").is_some_and(is_slug)
}

fn is_agent(value: &str) -> bool {
    value.strip_prefix("agent:").is_some_and(is_slug)
}

fn is_every(value: &str) -> bool {
    let Some(number) = value.strip_suffix('d') else {
        return false;
    };
    let bytes = number.as_bytes();
    !bytes.is_empty() && bytes[0] != b'0' && bytes.iter().all(u8::is_ascii_digit)
}

fn is_contract_hash(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Proof {
    pub kind: &'static str,
    pub source: Option<String>,
    pub every_days: Option<u64>,
    pub by: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Seam {
    pub to: String,
    pub contract: String,
    pub read_only: bool,
    pub exclusive: bool,
    pub proof: Option<Proof>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Holon {
    pub id: String,
    pub kind: &'static str,
    pub part_of: Option<String>,
    pub title: String,
    pub status: &'static str,
    pub why: String,
    pub contract: String,
    pub carried_by: Vec<String>,
    pub code: Vec<String>,
    pub seams: Vec<Seam>,
    pub proofs: [Option<Proof>; 4],
}

impl Holon {
    pub fn proof(&self, side: Side) -> Option<&Proof> {
        self.proofs[side.index()].as_ref()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub holon: String,
    pub side: String,
    pub by: String,
    pub recorded_by: String,
    pub at: String,
    pub expires: String,
    pub contract_hash: String,
    pub answer: String,
    pub hesitation: Vec<String>,
    pub result: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub holon: String,
    pub side: String,
    pub kind: &'static str,
    pub source: String,
    pub result: &'static str,
    pub contract_hash: String,
    pub build: String,
    pub environment: String,
    pub at: String,
    pub expires: Option<String>,
    pub detail: String,
}

struct Issues {
    list: Vec<(String, String)>,
}

fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn quoted_options(options: &[&str]) -> String {
    options
        .iter()
        .map(|option| format!("\"{option}\""))
        .collect::<Vec<_>>()
        .join("|")
}

impl Issues {
    fn new() -> Self {
        Issues { list: Vec::new() }
    }

    fn push(&mut self, path: &str, message: impl Into<String>) {
        self.list.push((path.to_string(), message.into()));
    }

    fn expected(&mut self, path: &str, kind: &str, value: Option<&Value>) {
        self.push(
            path,
            format!(
                "Invalid input: expected {kind}, received {}",
                received(value)
            ),
        );
    }

    fn string<'a>(&mut self, path: &str, value: Option<&'a Value>) -> Option<&'a str> {
        match value {
            Some(Value::String(text)) => Some(text),
            other => {
                self.expected(path, "string", other);
                None
            }
        }
    }

    fn non_empty(&mut self, path: &str, value: Option<&Value>) -> Option<String> {
        let text = self.string(path, value)?;
        if text.is_empty() {
            self.push(path, "Too small: expected string to have >=1 characters");
            return None;
        }
        Some(text.to_string())
    }

    fn matching(
        &mut self,
        path: &str,
        value: Option<&Value>,
        test: fn(&str) -> bool,
        message: &str,
    ) -> Option<String> {
        let text = self.string(path, value)?;
        if !test(text) {
            self.push(path, message);
            return None;
        }
        Some(text.to_string())
    }

    fn slug(&mut self, path: &str, value: Option<&Value>) -> Option<String> {
        self.matching(path, value, is_slug, "must be a slug like password-reset")
    }

    fn option(
        &mut self,
        path: &str,
        value: Option<&Value>,
        options: &[&'static str],
    ) -> Option<&'static str> {
        let found = match value {
            Some(Value::String(text)) => options.iter().find(|option| **option == text.as_str()),
            _ => None,
        };
        if found.is_none() {
            self.push(
                path,
                format!(
                    "Invalid option: expected one of {}",
                    quoted_options(options)
                ),
            );
        }
        found.copied()
    }

    fn boolean(&mut self, path: &str, value: Option<&Value>) -> Option<bool> {
        match value {
            Some(Value::Bool(flag)) => Some(*flag),
            other => {
                self.expected(path, "boolean", other);
                None
            }
        }
    }

    fn array<'a>(&mut self, path: &str, value: Option<&'a Value>) -> Option<&'a Vec<Value>> {
        match value {
            Some(Value::Array(items)) => Some(items),
            other => {
                self.expected(path, "array", other);
                None
            }
        }
    }

    fn object<'a>(
        &mut self,
        path: &str,
        value: Option<&'a Value>,
    ) -> Option<&'a Map<String, Value>> {
        match value {
            Some(Value::Object(map)) => Some(map),
            other => {
                self.expected(path, "object", other);
                None
            }
        }
    }

    fn strict(&mut self, path: &str, map: &Map<String, Value>, known: &[&str]) {
        let unknown: Vec<String> = map
            .keys()
            .filter(|key| !known.contains(&key.as_str()))
            .map(|key| format!("\"{key}\""))
            .collect();
        if unknown.is_empty() {
            return;
        }
        let at = if path.is_empty() { "" } else { path };
        let noun = if unknown.len() == 1 { "key" } else { "keys" };
        self.push(at, format!("Unrecognized {noun}: {}", unknown.join(", ")));
    }

    fn array_of<T>(
        &mut self,
        path: &str,
        value: Option<&Value>,
        mut item: impl FnMut(&mut Self, &str, Option<&Value>) -> Option<T>,
    ) -> Option<Vec<T>> {
        let items = self.array(path, value)?;
        let mut out = Vec::with_capacity(items.len());
        let mut ok = true;
        for (index, element) in items.iter().enumerate() {
            match item(self, &join(path, &index.to_string()), Some(element)) {
                Some(parsed) => out.push(parsed),
                None => ok = false,
            }
        }
        ok.then_some(out)
    }

    fn describe(&self) -> String {
        self.list
            .iter()
            .map(|(path, message)| {
                let shown = if path.is_empty() { "(root)" } else { path };
                format!("{shown}: {message}")
            })
            .collect::<Vec<_>>()
            .join("; ")
    }
}

fn optional<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    map.get(key)
}

fn parse_proof(issues: &mut Issues, path: &str, value: Option<&Value>) -> Option<Proof> {
    let map = issues.object(path, value)?;
    let before = issues.list.len();
    let kind = issues.option(&join(path, "kind"), map.get("kind"), &PROOF_KINDS);
    let source = optional(map, "source")
        .and_then(|value| issues.non_empty(&join(path, "source"), Some(value)));
    let every = optional(map, "every").and_then(|value| {
        issues.matching(
            &join(path, "every"),
            Some(value),
            is_every,
            "must look like 90d",
        )
    });
    let by = optional(map, "by").and_then(|value| issues.non_empty(&join(path, "by"), Some(value)));
    issues.strict(path, map, &["kind", "source", "every", "by"]);
    if issues.list.len() != before {
        return None;
    }
    let kind = kind?;
    let declared = every.map(|text| text[..text.len() - 1].parse::<u64>().unwrap_or(u64::MAX));
    let every_days = if is_human_kind(kind) {
        Some(declared.unwrap_or(HUMAN_MAX_DAYS).min(HUMAN_MAX_DAYS))
    } else {
        declared
    };
    Some(Proof {
        kind,
        source,
        every_days,
        by,
    })
}

fn parse_seam(issues: &mut Issues, path: &str, value: Option<&Value>) -> Option<Seam> {
    let map = issues.object(path, value)?;
    let before = issues.list.len();
    let to = issues.slug(&join(path, "to"), map.get("to"));
    let contract = issues.string(&join(path, "contract"), map.get("contract"));
    let read_only =
        optional(map, "readOnly").map(|value| issues.boolean(&join(path, "readOnly"), Some(value)));
    let exclusive = optional(map, "exclusive")
        .map(|value| issues.boolean(&join(path, "exclusive"), Some(value)));
    let proof =
        optional(map, "proof").map(|value| parse_proof(issues, &join(path, "proof"), Some(value)));
    issues.strict(
        path,
        map,
        &["to", "contract", "readOnly", "exclusive", "proof"],
    );
    if issues.list.len() != before {
        return None;
    }
    Some(Seam {
        to: to?,
        contract: contract?.to_string(),
        read_only: read_only.flatten().unwrap_or(false),
        exclusive: exclusive.flatten().unwrap_or(false),
        proof: proof.flatten(),
    })
}

fn parse_json(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|error| format!("invalid JSON: {error}"))
}

pub fn parse_holon(text: &str) -> Result<Holon, String> {
    let value = parse_json(text)?;
    parse_holon_value(&value).map_err(|issues| format!("invalid holon/v0: {issues}"))
}

fn parse_holon_value(value: &Value) -> Result<Holon, String> {
    let mut issues = Issues::new();
    let Some(map) = issues.object("", Some(value)) else {
        return Err(issues.describe());
    };
    if map.get("format").and_then(Value::as_str) != Some("holon/v0") {
        issues.push("format", "Invalid input: expected \"holon/v0\"");
    }
    let id = issues.slug("id", map.get("id"));
    let kind = issues.option("kind", map.get("kind"), &KINDS);
    let part_of = match map.get("partOf") {
        Some(Value::Null) => Some(None),
        other => issues.slug("partOf", other).map(Some),
    };
    let title = issues.non_empty("title", map.get("title"));
    let status = issues.option("status", map.get("status"), &STATUSES);
    let why = issues.string("why", map.get("why")).map(str::to_string);
    let contract = issues
        .string("contract", map.get("contract"))
        .map(str::to_string);
    let carried_by = issues.array_of("carriedBy", map.get("carriedBy"), |issues, path, value| {
        issues.slug(path, value)
    });
    let code = issues.array_of("code", map.get("code"), |issues, path, value| {
        issues.non_empty(path, value)
    });
    let seams = issues.array_of("seams", map.get("seams"), parse_seam);
    let mut proofs: [Option<Proof>; 4] = [None, None, None, None];
    if let Some(proof_map) = issues.object("proofs", map.get("proofs")) {
        for side in Side::ALL {
            if let Some(value) = proof_map.get(side.as_str()) {
                proofs[side.index()] =
                    parse_proof(&mut issues, &join("proofs", side.as_str()), Some(value));
            }
        }
        issues.strict("proofs", proof_map, &["I", "It", "We", "They"]);
    }
    issues.strict(
        "",
        map,
        &[
            "format",
            "id",
            "kind",
            "partOf",
            "title",
            "status",
            "why",
            "contract",
            "carriedBy",
            "code",
            "seams",
            "proofs",
        ],
    );
    if !issues.list.is_empty() {
        return Err(issues.describe());
    }
    match (
        id, kind, part_of, title, status, why, contract, carried_by, code, seams,
    ) {
        (
            Some(id),
            Some(kind),
            Some(part_of),
            Some(title),
            Some(status),
            Some(why),
            Some(contract),
            Some(carried_by),
            Some(code),
            Some(seams),
        ) => Ok(Holon {
            id,
            kind,
            part_of,
            title,
            status,
            why,
            contract,
            carried_by,
            code,
            seams,
            proofs,
        }),
        _ => Err(issues.describe()),
    }
}

fn evidence_side(issues: &mut Issues, path: &str, value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if Side::ALL.iter().any(|side| side.as_str() == text) => {
            Some(text.clone())
        }
        Some(Value::String(text)) => {
            if is_seam_side(text) {
                Some(text.clone())
            } else {
                issues.push(
                    path,
                    "Invalid string: must match pattern /^seam:[a-z0-9]+(-[a-z0-9]+)*$/",
                );
                None
            }
        }
        _ => {
            issues.push(path, "Invalid input");
            None
        }
    }
}

fn confirmer(issues: &mut Issues, path: &str, value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if is_slug(text) || is_agent(text) => Some(text.clone()),
        _ => {
            issues.push(path, "Invalid input");
            None
        }
    }
}

fn calendar_date(issues: &mut Issues, path: &str, value: Option<&Value>) -> Option<String> {
    let text = issues.string(path, value)?;
    let shaped = text.len() == 10
        && text.bytes().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
    if !shaped {
        issues.push(path, "must be yyyy-mm-dd");
    }
    if !is_calendar_date(text) {
        issues.push(path, "is no calendar date");
        return None;
    }
    Some(text.to_string())
}

fn iso(issues: &mut Issues, path: &str, value: Option<&Value>) -> Option<String> {
    issues.matching(
        path,
        value,
        is_iso_timestamp,
        "must be an ISO timestamp with a time zone",
    )
}

fn contract_hash_field(issues: &mut Issues, path: &str, value: Option<&Value>) -> Option<String> {
    issues.matching(path, value, is_contract_hash, "must be sha256:<64 hex>")
}

pub fn parse_confirmation(text: &str) -> Result<Confirmation, String> {
    let value = parse_json(text)?;
    let mut issues = Issues::new();
    let fail = |issues: &Issues| format!("invalid holon-confirmation/v0: {}", issues.describe());
    let Some(map) = issues.object("", Some(&value)) else {
        return Err(fail(&issues));
    };
    if map.get("format").and_then(Value::as_str) != Some("holon-confirmation/v0") {
        issues.push(
            "format",
            "Invalid input: expected \"holon-confirmation/v0\"",
        );
    }
    let holon = issues.slug("holon", map.get("holon"));
    let side = evidence_side(&mut issues, "side", map.get("side"));
    let by = confirmer(&mut issues, "by", map.get("by"));
    let recorded_by = confirmer(&mut issues, "recordedBy", map.get("recordedBy"));
    let at = calendar_date(&mut issues, "at", map.get("at"));
    let expires = calendar_date(&mut issues, "expires", map.get("expires"));
    let contract_hash = contract_hash_field(&mut issues, "contractHash", map.get("contractHash"));
    let answer = issues
        .string("answer", map.get("answer"))
        .map(str::to_string);
    let hesitation = issues.array_of(
        "hesitation",
        map.get("hesitation"),
        |issues, path, value| issues.string(path, value).map(str::to_string),
    );
    let result = issues.option("result", map.get("result"), &["confirmed", "refuted"]);
    issues.strict(
        "",
        map,
        &[
            "format",
            "holon",
            "side",
            "by",
            "recordedBy",
            "at",
            "expires",
            "contractHash",
            "answer",
            "hesitation",
            "result",
        ],
    );
    if !issues.list.is_empty() {
        return Err(fail(&issues));
    }
    match (
        holon,
        side,
        by,
        recorded_by,
        at,
        expires,
        contract_hash,
        answer,
        hesitation,
        result,
    ) {
        (
            Some(holon),
            Some(side),
            Some(by),
            Some(recorded_by),
            Some(at),
            Some(expires),
            Some(contract_hash),
            Some(answer),
            Some(hesitation),
            Some(result),
        ) => Ok(Confirmation {
            holon,
            side,
            by,
            recorded_by,
            at,
            expires,
            contract_hash,
            answer,
            hesitation,
            result,
        }),
        _ => Err(fail(&issues)),
    }
}

pub fn parse_evidence(value: &Value) -> Result<Evidence, String> {
    let mut issues = Issues::new();
    let fail = |issues: &Issues| format!("invalid evidence: {}", issues.describe());
    let Some(map) = issues.object("", Some(value)) else {
        return Err(fail(&issues));
    };
    let holon = issues.slug("holon", map.get("holon"));
    let side = evidence_side(&mut issues, "side", map.get("side"));
    let kind = issues.option("kind", map.get("kind"), &MACHINE_PROOF_KINDS);
    let source = issues
        .string("source", map.get("source"))
        .map(str::to_string);
    let result = issues.option("result", map.get("result"), &["pass", "fail"]);
    let contract_hash = contract_hash_field(&mut issues, "contractHash", map.get("contractHash"));
    let build = issues.non_empty("build", map.get("build"));
    let environment = issues.non_empty("environment", map.get("environment"));
    let at = iso(&mut issues, "at", map.get("at"));
    let expires = match map.get("expires") {
        Some(Value::Null) => Some(None),
        other => iso(&mut issues, "expires", other).map(Some),
    };
    let detail = issues
        .string("detail", map.get("detail"))
        .map(str::to_string);
    issues.strict(
        "",
        map,
        &[
            "holon",
            "side",
            "kind",
            "source",
            "result",
            "contractHash",
            "build",
            "environment",
            "at",
            "expires",
            "detail",
        ],
    );
    if !issues.list.is_empty() {
        return Err(fail(&issues));
    }
    match (
        holon,
        side,
        kind,
        source,
        result,
        contract_hash,
        build,
        environment,
        at,
        expires,
        detail,
    ) {
        (
            Some(holon),
            Some(side),
            Some(kind),
            Some(source),
            Some(result),
            Some(contract_hash),
            Some(build),
            Some(environment),
            Some(at),
            Some(expires),
            Some(detail),
        ) => Ok(Evidence {
            holon,
            side,
            kind,
            source,
            result,
            contract_hash,
            build,
            environment,
            at,
            expires,
            detail,
        }),
        _ => Err(fail(&issues)),
    }
}

pub fn parse_evidence_lines(text: &str) -> Result<Vec<Evidence>, String> {
    let mut records = Vec::new();
    for (index, line) in text.split('\n').enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value = parse_json(line).map_err(|error| format!("line {}: {error}", index + 1))?;
        records
            .push(parse_evidence(&value).map_err(|error| format!("line {}: {error}", index + 1))?);
    }
    Ok(records)
}

pub fn confirmation_path(holon: &str, at: &str, side: &str, by: &str) -> String {
    let name = format!("{at}-{side}-{by}").replace(':', "_");
    format!(".holons/confirmations/{holon}/{name}.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Value {
        serde_json::json!({ "format": "holon/v0", "id": "a", "kind": "component", "partOf": null, "title": "A", "status": "active", "why": "", "contract": "", "carriedBy": [], "code": [], "seams": [], "proofs": {} })
    }

    fn with(changes: Value) -> String {
        let mut value = base();
        for (key, inner) in changes.as_object().unwrap() {
            value[key] = inner.clone();
        }
        value.to_string()
    }

    #[test]
    fn fills_defaults_once() {
        let holon = parse_holon(&with(serde_json::json!({
            "seams": [{ "to": "b", "contract": "c" }],
            "proofs": { "I": { "kind": "interview", "every": "120d" }, "It": { "kind": "ci", "every": "7d" }, "We": { "kind": "metric" } }
        })))
        .unwrap();
        assert!(!holon.seams[0].read_only);
        assert!(!holon.seams[0].exclusive);
        assert_eq!(holon.proof(Side::I).unwrap().every_days, Some(90));
        assert_eq!(holon.proof(Side::It).unwrap().every_days, Some(7));
        assert_eq!(holon.proof(Side::We).unwrap().every_days, None);
        assert!(holon.proof(Side::They).is_none());
    }

    #[test]
    fn reports_every_issue_like_zod() {
        let error = parse_holon(&with(serde_json::json!({
            "seams": [{ "to": "b", "contract": "c", "readOnly": null, "exclusive": "x", "proof": { "kind": "ci", "every": "0d", "by": "", "z": 1 } }],
            "proofs": { "I": { "kind": "nope" }, "X": {} }
        })))
        .unwrap_err();
        assert_eq!(
            error,
            "invalid holon/v0: seams.0.readOnly: Invalid input: expected boolean, received null; seams.0.exclusive: Invalid input: expected boolean, received string; seams.0.proof.every: must look like 90d; seams.0.proof.by: Too small: expected string to have >=1 characters; seams.0.proof: Unrecognized key: \"z\"; proofs.I.kind: Invalid option: expected one of \"ci\"|\"metric\"|\"alert\"|\"file\"|\"ticket\"|\"formal\"|\"interview\"|\"confirmation\"|\"ai-review\"; proofs: Unrecognized key: \"X\""
        );
        let error = parse_holon(&with(serde_json::json!({ "format": "holon/v1", "id": "A_b", "partOf": 3, "title": "", "why": null, "extra": 1, "more": 2 }))).unwrap_err();
        assert_eq!(
            error,
            "invalid holon/v0: format: Invalid input: expected \"holon/v0\"; id: must be a slug like password-reset; partOf: Invalid input: expected string, received number; title: Too small: expected string to have >=1 characters; why: Invalid input: expected string, received null; (root): Unrecognized keys: \"extra\", \"more\""
        );
        assert_eq!(
            parse_holon("[]").unwrap_err(),
            "invalid holon/v0: (root): Invalid input: expected object, received array"
        );
    }

    #[test]
    fn validates_confirmations_like_zod() {
        let text = serde_json::json!({ "format": "holon-confirmation/v0", "holon": "a", "side": "seam:X", "by": "Agent:x", "recordedBy": "agent:x", "at": "2026/01/01", "expires": "2026-02-30", "contractHash": "sha256:00", "answer": "", "hesitation": [1], "result": "ok" }).to_string();
        assert_eq!(
            parse_confirmation(&text).unwrap_err(),
            "invalid holon-confirmation/v0: side: Invalid string: must match pattern /^seam:[a-z0-9]+(-[a-z0-9]+)*$/; by: Invalid input; at: must be yyyy-mm-dd; at: is no calendar date; expires: is no calendar date; contractHash: must be sha256:<64 hex>; hesitation.0: Invalid input: expected string, received number; result: Invalid option: expected one of \"confirmed\"|\"refuted\""
        );
    }

    #[test]
    fn numbers_evidence_lines() {
        let error = parse_evidence_lines("{\"a\":1}\n\nnot json").unwrap_err();
        assert!(error.starts_with("line 1: invalid evidence: holon: Invalid input: expected string, received undefined; side: Invalid input;"));
        assert!(error.ends_with("(root): Unrecognized key: \"a\""));
    }
}
