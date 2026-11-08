mod args;
mod cache;
mod detect;
mod git;
mod render;
mod snapshot;
mod store;

use args::{choice, flag, list, stdin, usage_line, value, ArgError, Parsed, Spec};
use git::GitCodeChanges;
use holon_core::evaluate::SideLight;
use holon_core::format::{
    confirmation_path, is_human_kind, parse_confirmation, parse_evidence, parse_evidence_lines,
    Confirmation, Evidence, Holon, Side, HUMAN_MAX_DAYS, MACHINE_PROOF_KINDS,
};
use holon_core::outputs::to_json;
use holon_core::time::{
    contract_hash, format_date, format_instant, is_calendar_date, is_iso_timestamp, parse_instant,
    DAY_MS,
};
use holon_core::{EvalEnv, Model};
use serde_json::{json, Map, Value};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};
use store::Store;

pub struct Failure {
    message: String,
    code: &'static str,
    hint: Option<String>,
    usage: Option<String>,
}

pub fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        message: message.into(),
        code,
        hint: None,
        usage: None,
    }
}

impl Failure {
    fn hint(mut self, hint: impl Into<String>) -> Failure {
        self.hint = Some(hint.into());
        self
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Failure {
        fail(INTERNAL, message)
    }
}

const INTERNAL: &str = "internal";

const COMMON: [Spec; 7] = [
    flag("json"),
    value("root"),
    value("now"),
    value("commit"),
    value("db"),
    value("evidence"),
    flag("no-cache"),
];

const WRITE_COMMON: [Spec; 5] = [
    flag("json"),
    value("root"),
    value("now"),
    value("commit"),
    value("db"),
];

const RECORD: [Spec; 15] = [
    value("file"),
    stdin("jsonl"),
    flag("replace"),
    value("holon"),
    value("side"),
    choice("kind", &MACHINE_PROOF_KINDS),
    value("source"),
    choice("result", &["pass", "fail"]),
    value("contract-hash"),
    value("build"),
    value("environment"),
    value("at"),
    value("expires"),
    value("detail"),
    flag("no-cache"),
];

const IMPORT: [Spec; 2] = [flag("replace"), flag("no-cache")];

const EXPORT: [Spec; 2] = [value("root"), value("db")];

const CONFIRM: [Spec; 9] = [
    value("side").required(),
    value("by").required(),
    value("recorded-by"),
    stdin("answer").required(),
    list("hesitation"),
    choice("result", &["confirmed", "refuted"]),
    value("at"),
    value("expires"),
    flag("no-cache"),
];

struct Command {
    path: &'static str,
    positional: Option<&'static str>,
}

const COMMANDS: [Command; 7] = [
    Command {
        path: "check",
        positional: None,
    },
    Command {
        path: "drift",
        positional: None,
    },
    Command {
        path: "view",
        positional: Some("slug"),
    },
    Command {
        path: "evidence record",
        positional: None,
    },
    Command {
        path: "evidence import",
        positional: Some("file"),
    },
    Command {
        path: "evidence export",
        positional: None,
    },
    Command {
        path: "confirm",
        positional: Some("slug"),
    },
];

fn specs(path: &str) -> Vec<Spec> {
    match path {
        "check" | "drift" | "view" => COMMON.to_vec(),
        "evidence record" => [&WRITE_COMMON[..], &RECORD[..]].concat(),
        "evidence import" => [&WRITE_COMMON[..], &IMPORT[..]].concat(),
        "evidence export" => EXPORT.to_vec(),
        _ => [&WRITE_COMMON[..], &CONFIRM[..]].concat(),
    }
}

struct Invocation {
    command: &'static Command,
    parsed: Parsed,
    argument: Option<String>,
}

fn usage_failure(command: &Command, code: &'static str, message: String) -> Failure {
    Failure {
        usage: Some(format!(
            "Usage:\n  {}",
            usage_line(command.path, command.positional, &specs(command.path))
        )),
        ..fail(code, message)
    }
}

fn resolve(tokens: &[String]) -> Result<Invocation, Failure> {
    let words: Vec<&str> = tokens
        .iter()
        .take_while(|token| !token.starts_with("--"))
        .map(String::as_str)
        .collect();
    let (path, used) = match words.as_slice() {
        [] => {
            return Err(fail("missing_command", "missing command")
                .hint("Run `holon --help` for the command list."))
        }
        ["evidence"] => {
            return Err(fail("missing_command", "missing command after 'evidence'")
                .hint("Expected one of: record, import, export"))
        }
        ["evidence", sub, ..] => (format!("evidence {sub}"), 2),
        [word, ..] => (word.to_string(), 1),
    };
    let Some(command) = COMMANDS.iter().find(|command| command.path == path) else {
        return Err(fail("unknown_command", format!("unknown command '{path}'")));
    };
    let owned = specs(command.path);
    let mut parsed = args::parse(&tokens[used..], &owned).map_err(|error: ArgError| Failure {
        hint: error.hint,
        ..usage_failure(command, error.code, error.message)
    })?;
    let mut positionals = std::mem::take(&mut parsed.positionals).into_iter();
    let argument = positionals.next();
    if command.positional.is_none() {
        if let Some(extra) = argument {
            return Err(usage_failure(
                command,
                "unexpected_argument",
                format!("unexpected argument '{extra}'"),
            ));
        }
    } else if let Some(extra) = positionals.next() {
        return Err(usage_failure(
            command,
            "unexpected_argument",
            format!("unexpected argument '{extra}'"),
        ));
    }
    let mut missing = Vec::new();
    if let (Some(name), None) = (command.positional, &argument) {
        missing.push(format!("missing required arguments: <{name}>"));
    }
    let absent: Vec<String> = owned
        .iter()
        .filter(|spec| spec.required)
        .filter(|spec| !parsed.given(spec.name) && !parsed.stdin.contains(&spec.name))
        .map(|spec| format!("--{}", spec.name))
        .collect();
    if !absent.is_empty() {
        missing.push(format!("missing required options: {}", absent.join(", ")));
    }
    if !missing.is_empty() {
        return Err(usage_failure(
            command,
            "missing_required",
            missing.join("; "),
        ));
    }
    if command.path == "evidence record" {
        let present = |name: &str| parsed.given(name) || parsed.stdin.contains(&name);
        let given: Vec<&str> = ["file", "jsonl", "holon"]
            .into_iter()
            .filter(|name| present(name))
            .collect();
        if given.len() > 1 {
            let mut failure = usage_failure(
                command,
                "unexpected_argument",
                format!(
                    "{} cannot be combined",
                    given
                        .iter()
                        .map(|name| format!("--{name}"))
                        .collect::<Vec<_>>()
                        .join(" and ")
                ),
            );
            failure.hint = Some("Pass exactly one of: --file, --jsonl, --holon".to_string());
            return Err(failure);
        }
        if given.is_empty() {
            return Err(usage_failure(
                command,
                "missing_required",
                "missing required options: one of --file, --jsonl, --holon".to_string(),
            ));
        }
        if present("holon") {
            let absent: Vec<String> = ["side", "result"]
                .into_iter()
                .filter(|name| !present(name))
                .map(|name| format!("--{name}"))
                .collect();
            if !absent.is_empty() {
                return Err(usage_failure(
                    command,
                    "missing_required",
                    format!("--holon requires {}", absent.join(", ")),
                ));
            }
        }
    }
    for name in parsed.stdin.clone() {
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|error| fail("command_failed", format!("cannot read stdin: {error}")))?;
        parsed.values.insert(name, text);
    }
    Ok(Invocation {
        command,
        parsed,
        argument,
    })
}

fn resolve_root(root: Option<&str>, cwd: &Path) -> Result<PathBuf, Failure> {
    if let Some(root) = root {
        let absolute = normalize(&cwd.join(root));
        if !absolute.is_dir() {
            return Err(fail(
                "root_not_found",
                format!("--root {root} is no directory"),
            ));
        }
        return Ok(absolute);
    }
    Ok(git::top_level(cwd).map_or_else(|| cwd.to_path_buf(), PathBuf::from))
}

fn normalize(path: &Path) -> PathBuf {
    let mut normal = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normal.pop();
            }
            other => normal.push(other),
        }
    }
    normal
}

fn clock_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

struct Context {
    cwd: PathBuf,
    root: PathBuf,
    now_ms: i64,
    commit: String,
}

fn context(parsed: &Parsed) -> Result<Context, Failure> {
    let cwd = std::env::current_dir().map_err(|error| fail("command_failed", error.to_string()))?;
    let root = resolve_root(parsed.value("root"), &cwd)?;
    let now_ms = match parsed.value("now") {
        Some(now) if !is_iso_timestamp(now) => {
            return Err(
                fail("invalid_now", format!("--now {now} is no ISO timestamp"))
                    .hint("Use a form like 2026-11-08T12:00:00Z"),
            )
        }
        Some(now) => parse_instant(now).expect("validated timestamp"),
        None => clock_ms(),
    };
    let commit = parsed
        .value("commit")
        .map(str::to_string)
        .or_else(|| git::head(&root))
        .unwrap_or_else(|| "none".to_string());
    Ok(Context {
        cwd,
        root,
        now_ms,
        commit,
    })
}

fn open_store(parsed: &Parsed, ctx: &Context) -> Result<Store, Failure> {
    let path = match parsed.value("db") {
        Some(db) => ctx.cwd.join(db),
        None => {
            let top = git::top_level(&ctx.root).map_or_else(|| ctx.root.clone(), PathBuf::from);
            store::default_db_path(&top).ok_or_else(|| {
                fail("no_data_dir", "no data directory for the holon database")
                    .hint("Pass --db <path>")
            })?
        }
    };
    Ok(Store::open(&path, &ctx.root)?)
}

fn read_evidence_file(base: &Path, file: &str) -> Result<Vec<Evidence>, Failure> {
    let text = std::fs::read_to_string(base.join(file))
        .map_err(|_| fail("file_not_found", format!("cannot read {file}")))?;
    parse_evidence_text(&text)
}

fn parse_evidence_text(text: &str) -> Result<Vec<Evidence>, Failure> {
    parse_evidence_lines(text).map_err(|message| fail("invalid_evidence", message))
}

fn load(parsed: &Parsed, ctx: &Context) -> Result<Model, Failure> {
    let evidence = match parsed.value("evidence") {
        Some(file) => read_evidence_file(&ctx.cwd, file)?,
        None => open_store(parsed, ctx)?.evidence()?,
    };
    Ok(Model::load(&ctx.root, evidence)?)
}

fn output<T: serde::Serialize>(
    parsed: &Parsed,
    value: &T,
    text: impl FnOnce(&T) -> String,
) -> String {
    if parsed.flag("json") {
        to_json(value)
    } else {
        text(value)
    }
}

fn holon_not_found(id: &str, root: &Path) -> Failure {
    fail(
        "holon_not_found",
        format!("no holon {id} under {}", root.display()),
    )
    .hint("List them with holon check")
}

fn cached_read(invocation: &Invocation, ctx: &Context) -> Result<(String, u8), Failure> {
    let parsed = &invocation.parsed;
    let store = open_store(parsed, ctx)?;
    let code = GitCodeChanges::new(&ctx.root);
    let env = EvalEnv {
        now_ms: ctx.now_ms,
        commit: ctx.commit.clone(),
        code: &code,
    };
    let path = invocation.command.path;
    cache::sync(&store, &ctx.root, &env, path == "check")?;
    match path {
        "check" => {
            let check = cache::check(&store)?;
            let code = u8::from(!check.errors.is_empty());
            Ok((output(parsed, &check, render::render_check), code))
        }
        "drift" => Ok((
            output(parsed, &cache::drift(&store, &env)?, render::render_drift),
            0,
        )),
        _ => {
            let slug = invocation.argument.as_deref().expect("checked slug");
            let view = cache::view(&store, &ctx.root, &env, slug)?
                .ok_or_else(|| holon_not_found(slug, &ctx.root))?;
            Ok((output(parsed, &view, render::render_view), 0))
        }
    }
}

fn read_command(invocation: &Invocation) -> Result<(String, u8), Failure> {
    let parsed = &invocation.parsed;
    let ctx = context(parsed)?;
    if !parsed.flag("no-cache") && parsed.value("evidence").is_none() {
        return cached_read(invocation, &ctx);
    }
    let model = &load(parsed, &ctx)?;
    if invocation.command.path == "check" {
        let check = model.check();
        let code = u8::from(!check.errors.is_empty());
        return Ok((output(parsed, &check, render::render_check), code));
    }
    let code = GitCodeChanges::new(&ctx.root);
    let env = EvalEnv {
        now_ms: ctx.now_ms,
        commit: ctx.commit.clone(),
        code: &code,
    };
    let evaluated = model.evaluate(&env);
    if invocation.command.path == "drift" {
        return Ok((output(parsed, &evaluated.drift(), render::render_drift), 0));
    }
    let slug = invocation.argument.as_deref().expect("checked slug");
    let view = evaluated
        .view(slug)
        .ok_or_else(|| holon_not_found(slug, &ctx.root))?;
    Ok((output(parsed, &view, render::render_view), 0))
}

fn side_proof<'h>(
    holon: &'h Holon,
    side: &str,
) -> Option<(Option<&'h holon_core::format::Proof>, &'h str)> {
    if let Some(target) = side.strip_prefix("seam:") {
        let seam = holon.seams.iter().find(|seam| seam.to == target)?;
        return Some((seam.proof.as_ref(), &seam.contract));
    }
    let proof = Side::ALL
        .into_iter()
        .find(|candidate| candidate.as_str() == side)
        .and_then(|side| holon.proof(side));
    Some((proof, &holon.contract))
}

fn complete_evidence(
    parsed: &Parsed,
    holon: Option<&Holon>,
    ctx: &Context,
) -> Result<Evidence, Failure> {
    let id = parsed.value("holon").expect("required holon");
    let side = parsed.value("side").expect("required side");
    let declared = holon.and_then(|holon| side_proof(holon, side));
    let proof = declared.and_then(|(proof, _)| proof);
    let mut record = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            record.insert(key.to_string(), value);
        }
    };
    put("holon", Some(json!(id)));
    put("side", Some(json!(side)));
    put(
        "kind",
        parsed
            .value("kind")
            .or(proof.map(|proof| proof.kind))
            .map(|kind| json!(kind)),
    );
    put(
        "source",
        parsed
            .value("source")
            .map(str::to_string)
            .or_else(|| proof.and_then(|proof| proof.source.clone()))
            .map(Value::String),
    );
    put("result", parsed.value("result").map(|result| json!(result)));
    put(
        "contractHash",
        parsed
            .value("contract-hash")
            .map(str::to_string)
            .or_else(|| declared.map(|(_, contract)| contract_hash(contract)))
            .map(Value::String),
    );
    put(
        "build",
        Some(json!(parsed.value("build").unwrap_or(&ctx.commit))),
    );
    put(
        "environment",
        Some(json!(parsed.value("environment").unwrap_or("local"))),
    );
    put(
        "at",
        Some(json!(parsed
            .value("at")
            .map_or_else(|| format_instant(ctx.now_ms), str::to_string))),
    );
    put(
        "expires",
        Some(
            parsed
                .value("expires")
                .map_or(Value::Null, |expires| json!(expires)),
        ),
    );
    put("detail", Some(json!(parsed.value("detail").unwrap_or(""))));
    parse_evidence(&Value::Object(record)).map_err(|message| {
        let failure = fail("invalid_evidence", message);
        if holon.is_none() {
            failure.hint(format!(
                "No holon {id} in the index: pass --kind, --source and --contract-hash"
            ))
        } else {
            failure
        }
    })
}

fn record_command(invocation: &Invocation) -> Result<(String, u8), Failure> {
    let parsed = &invocation.parsed;
    let ctx = context(parsed)?;
    let store = open_store(parsed, &ctx)?;
    let model = Model::load(&ctx.root, Vec::new())?;
    let records = if invocation.command.path == "evidence import" {
        read_evidence_file(
            &ctx.cwd,
            invocation.argument.as_deref().expect("checked file"),
        )?
    } else if let Some(file) = parsed.value("file") {
        read_evidence_file(&ctx.cwd, file)?
    } else if let Some(text) = parsed.value("jsonl") {
        parse_evidence_text(text)?
    } else {
        let holon = model.get(parsed.value("holon").expect("required holon"));
        vec![complete_evidence(parsed, holon, &ctx)?]
    };
    let evaluated = store.transaction(|| {
        let mut touched: Vec<String> = Vec::new();
        if parsed.flag("replace") {
            touched.extend(store.evidence_holons()?);
            store.clear_evidence()?;
        }
        store.insert_evidence(&records)?;
        touched.extend(records.iter().map(|record| record.holon.clone()));
        touched.sort();
        touched.dedup();
        Ok(touched.iter().filter(|id| model.get(id).is_some()).count())
    })?;
    let mut unknown: Vec<String> = records
        .iter()
        .map(|record| record.holon.clone())
        .filter(|id| model.get(id).is_none())
        .collect();
    unknown.sort();
    unknown.dedup();
    let result = Recorded {
        format: "holon-evidence-recorded/v0",
        recorded: records.len(),
        reevaluated: evaluated,
        unknown_holons: unknown.clone(),
    };
    let text = |_: &Recorded| {
        let mut lines = vec![format!(
            "● recorded {} evidence record{}, {evaluated} holons re-evaluated",
            records.len(),
            if records.len() == 1 { "" } else { "s" }
        )];
        lines.extend(unknown.iter().map(|id| {
            format!(
                "! no holon {id} under {}; kept for when it appears",
                ctx.root.display()
            )
        }));
        format!("{}\n", lines.join("\n"))
    };
    Ok((output(parsed, &result, text), 0))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Recorded {
    format: &'static str,
    recorded: usize,
    reevaluated: usize,
    unknown_holons: Vec<String>,
}

#[derive(serde::Serialize)]
struct ConfirmationDocument<'c> {
    format: &'static str,
    #[serde(flatten)]
    confirmation: &'c Confirmation,
}

#[derive(serde::Serialize)]
struct Confirmed {
    format: &'static str,
    path: String,
    confirmation: Confirmation,
    light: SideLight,
}

fn date_option(parsed: &Parsed, name: &str, code: &'static str) -> Result<Option<String>, Failure> {
    match parsed.value(name) {
        Some(date) if !is_calendar_date(date) => {
            Err(fail(code, format!("--{name} {date} is no date")).hint("Use yyyy-mm-dd"))
        }
        other => Ok(other.map(str::to_string)),
    }
}

fn confirm_command(invocation: &Invocation) -> Result<(String, u8), Failure> {
    let parsed = &invocation.parsed;
    let ctx = context(parsed)?;
    let store = open_store(parsed, &ctx)?;
    let model = Model::load(&ctx.root, Vec::new())?;
    let id = invocation.argument.as_deref().expect("checked slug");
    let side = parsed.value("side").expect("required side");
    let by = parsed.value("by").expect("required by");
    let holon = model
        .get(id)
        .ok_or_else(|| holon_not_found(id, &ctx.root))?;
    let (proof, contract) = side_proof(holon, side)
        .ok_or_else(|| fail("invalid_side", format!("{id} has no seam for side {side}")))?;
    if let Some(proof) = proof.filter(|proof| !is_human_kind(proof.kind)) {
        return Err(fail(
            "machine_side",
            format!("{id} proves {side} with {}, a machine kind", proof.kind),
        )
        .hint("Record machine runs with holon evidence record"));
    }
    let at = date_option(parsed, "at", "invalid_at")?;
    let expires = date_option(parsed, "expires", "invalid_expires")?;
    let at = at.unwrap_or_else(|| format_date(ctx.now_ms));
    let every_days = proof
        .and_then(|proof| proof.every_days)
        .unwrap_or(HUMAN_MAX_DAYS);
    let limit_ms = parse_instant(&at).expect("calendar date").saturating_add(
        i64::try_from(every_days)
            .unwrap_or(i64::MAX)
            .saturating_mul(DAY_MS),
    );
    let expires = expires.unwrap_or_else(|| format_date(limit_ms));
    if parse_instant(&expires).expect("calendar date") > limit_ms {
        return Err(fail(
            "expires_too_late",
            format!("--expires {expires} is after {}", format_date(limit_ms)),
        )
        .hint(format!("Human proofs last at most {HUMAN_MAX_DAYS} days")));
    }
    let draft_value = Confirmation {
        holon: id.to_string(),
        side: side.to_string(),
        by: by.to_string(),
        recorded_by: parsed.value("recorded-by").unwrap_or(by).to_string(),
        at,
        expires,
        contract_hash: contract_hash(contract),
        answer: parsed.value("answer").expect("required answer").to_string(),
        hesitation: parsed.list("hesitation"),
        result: if parsed.value("result") == Some("refuted") {
            "refuted"
        } else {
            "confirmed"
        },
    };
    let draft = to_json(&ConfirmationDocument {
        format: "holon-confirmation/v0",
        confirmation: &draft_value,
    });
    let confirmation =
        parse_confirmation(&draft).map_err(|message| fail("invalid_confirmation", message))?;
    let path = confirmation_path(
        &confirmation.holon,
        &confirmation.at,
        &confirmation.side,
        &confirmation.by,
    );
    let absolute = ctx.root.join(&path);
    if absolute.exists() {
        return Err(
            fail("confirmation_exists", format!("{path} exists already"))
                .hint("One confirmation per holon, side, person and day"),
        );
    }
    if let Some(parent) = absolute.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| fail("command_failed", error.to_string()))?;
    }
    std::fs::write(&absolute, &draft).map_err(|error| fail("command_failed", error.to_string()))?;
    let model = Model::load(&ctx.root, store.evidence()?)?;
    let code = GitCodeChanges::new(&ctx.root);
    let env = EvalEnv {
        now_ms: ctx.now_ms,
        commit: ctx.commit.clone(),
        code: &code,
    };
    let view = model
        .evaluate(&env)
        .view(&confirmation.holon)
        .ok_or_else(|| holon_not_found(id, &ctx.root))?;
    let light = match confirmation.side.strip_prefix("seam:") {
        Some(target) => view
            .seams
            .iter()
            .find(|seam| seam.from == confirmation.holon && seam.to == target)
            .map_or(SideLight::Open, |seam| seam.light),
        None => {
            let side = Side::ALL
                .into_iter()
                .find(|candidate| candidate.as_str() == confirmation.side)
                .expect("parsed side");
            view.focus.sides.get(side).light
        }
    };
    let result = Confirmed {
        format: "holon-confirmed/v0",
        path,
        confirmation,
        light,
    };
    let text = |result: &Confirmed| {
        let light = serde_json::to_value(result.light).expect("light serializes");
        format!(
            "● wrote {}; {} is now {}\n",
            result.path,
            result.confirmation.side,
            light.as_str().unwrap_or_default()
        )
    };
    Ok((output(parsed, &result, text), 0))
}

fn export_command(invocation: &Invocation) -> Result<(String, u8), Failure> {
    let parsed = &invocation.parsed;
    let cwd = std::env::current_dir().map_err(|error| fail("command_failed", error.to_string()))?;
    let root = resolve_root(parsed.value("root"), &cwd)?;
    let ctx = Context {
        cwd,
        root,
        now_ms: 0,
        commit: String::new(),
    };
    let store = open_store(parsed, &ctx)?;
    Ok((store::export_lines(&store.evidence()?), 0))
}

fn run(invocation: &Invocation) -> Result<(String, u8), Failure> {
    match invocation.command.path {
        "check" | "drift" | "view" => read_command(invocation),
        "evidence record" | "evidence import" => record_command(invocation),
        "evidence export" => export_command(invocation),
        _ => confirm_command(invocation),
    }
}

#[derive(serde::Serialize)]
struct ErrorDetail<'f> {
    code: &'static str,
    message: &'f str,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
}

#[derive(serde::Serialize)]
struct ErrorBody<'f> {
    ok: bool,
    error: ErrorDetail<'f>,
}

fn render_failure(failure: &Failure, json_output: bool) -> (String, String) {
    let mut blocks = vec![match &failure.hint {
        Some(hint) => format!("error: {} ({hint})", failure.message),
        None => format!("error: {}", failure.message),
    }];
    blocks.extend(failure.usage.clone());
    let stderr = format!("{}\n", blocks.join("\n\n"));
    if !json_output || failure.code == INTERNAL {
        return (String::new(), stderr);
    }
    let hint = failure.hint.clone().or_else(|| {
        failure
            .usage
            .as_ref()
            .map(|usage| usage.trim_start_matches("Usage:\n  ").to_string())
    });
    let body = ErrorBody {
        ok: false,
        error: ErrorDetail {
            code: failure.code,
            message: &failure.message,
            hint,
        },
    };
    (to_json(&body), stderr)
}

fn main() -> ExitCode {
    let tokens: Vec<String> = std::env::args().skip(1).collect();
    let json_output = tokens.iter().any(|token| token == "--json");
    match resolve(&tokens).and_then(|invocation| run(&invocation)) {
        Ok((text, code)) => {
            print!("{text}");
            ExitCode::from(code)
        }
        Err(failure) => {
            let (stdout, stderr) = render_failure(&failure, json_output);
            print!("{stdout}");
            eprint!("{stderr}");
            ExitCode::from(if failure.code == INTERNAL { 2 } else { 1 })
        }
    }
}
