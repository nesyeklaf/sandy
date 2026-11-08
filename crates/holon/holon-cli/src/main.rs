mod git;
mod render;

use git::GitCodeChanges;
use holon_core::format::{parse_evidence_lines, Evidence};
use holon_core::outputs::to_json;
use holon_core::time::{is_iso_timestamp, parse_instant};
use holon_core::{EvalEnv, Model};
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

const USAGE: &str = "usage: holon <check|drift|view <slug>> [--json] [--root <dir>] [--now <iso>] [--commit <sha>] [--evidence <jsonl>]";

#[derive(Default)]
struct Options {
    command: Option<String>,
    slug: Option<String>,
    json: bool,
    root: Option<String>,
    now: Option<String>,
    commit: Option<String>,
    evidence: Option<String>,
}

struct Failure {
    message: String,
    code: u8,
}

fn fail(message: impl Into<String>) -> Failure {
    Failure {
        message: message.into(),
        code: 2,
    }
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Options, Failure> {
    let mut options = Options::default();
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        if let Some(flag) = arg.strip_prefix("--") {
            let (name, inline) = match flag.split_once('=') {
                Some((name, value)) => (name.to_string(), Some(value.to_string())),
                None => (flag.to_string(), None),
            };
            if name == "json" {
                options.json = true;
                continue;
            }
            let slot = match name.as_str() {
                "root" => &mut options.root,
                "now" => &mut options.now,
                "commit" => &mut options.commit,
                "evidence" => &mut options.evidence,
                _ => return Err(fail(format!("unknown option --{name}\n{USAGE}"))),
            };
            let value = match inline {
                Some(value) => value,
                None => args
                    .next()
                    .ok_or_else(|| fail(format!("--{name} needs a value")))?,
            };
            *slot = Some(value);
        } else if options.command.is_none() {
            options.command = Some(arg);
        } else if options.slug.is_none() {
            options.slug = Some(arg);
        } else {
            return Err(fail(format!("unexpected argument {arg}\n{USAGE}")));
        }
    }
    Ok(options)
}

fn resolve_root(root: Option<&str>, cwd: &Path) -> Result<PathBuf, Failure> {
    if let Some(root) = root {
        let absolute = normalize(&cwd.join(root));
        if !absolute.is_dir() {
            return Err(fail(format!("--root {root} is no directory")));
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

fn read_evidence(path: Option<&str>, cwd: &Path) -> Result<Vec<Evidence>, Failure> {
    let Some(path) = path else {
        return Ok(Vec::new());
    };
    let text =
        std::fs::read_to_string(cwd.join(path)).map_err(|_| fail(format!("cannot read {path}")))?;
    parse_evidence_lines(&text).map_err(fail)
}

fn run(options: Options) -> Result<(String, u8), Failure> {
    let command = options.command.as_deref().ok_or_else(|| fail(USAGE))?;
    if !matches!(command, "check" | "drift" | "view") {
        return Err(fail(format!("unknown command {command}\n{USAGE}")));
    }
    if command == "view" && options.slug.is_none() {
        return Err(fail(format!("view needs a holon id\n{USAGE}")));
    }
    if command != "view" && options.slug.is_some() {
        return Err(fail(format!("{command} takes no arguments\n{USAGE}")));
    }
    let cwd = std::env::current_dir().map_err(|error| fail(error.to_string()))?;
    let root = resolve_root(options.root.as_deref(), &cwd)?;
    let now_ms = match options.now.as_deref() {
        Some(now) if !is_iso_timestamp(now) => {
            return Err(fail(format!(
                "--now {now} is no ISO timestamp\nhint: Use a form like 2026-11-08T12:00:00Z"
            )))
        }
        Some(now) => parse_instant(now).expect("validated timestamp"),
        None => clock_ms(),
    };
    let evidence = read_evidence(options.evidence.as_deref(), &cwd)?;
    let model = Model::load(&root, evidence).map_err(fail)?;
    if command == "check" {
        let output = model.check();
        let text = if options.json {
            to_json(&output)
        } else {
            render::render_check(&output)
        };
        return Ok((text, u8::from(!output.errors.is_empty())));
    }
    let commit = options
        .commit
        .clone()
        .or_else(|| git::head(&root))
        .unwrap_or_else(|| "none".to_string());
    let code = GitCodeChanges::new(&root);
    let env = EvalEnv {
        now_ms,
        commit,
        code: &code,
    };
    let evaluated = model.evaluate(&env);
    if command == "drift" {
        let output = evaluated.drift();
        let text = if options.json {
            to_json(&output)
        } else {
            render::render_drift(&output)
        };
        return Ok((text, 0));
    }
    let slug = options.slug.as_deref().expect("checked slug");
    let output = evaluated.view(slug).ok_or_else(|| {
        fail(format!(
            "no holon {slug} under {}\nhint: List them with holon check",
            root.display()
        ))
    })?;
    let text = if options.json {
        to_json(&output)
    } else {
        render::render_view(&output)
    };
    Ok((text, 0))
}

fn main() -> ExitCode {
    let result = parse_args(std::env::args().skip(1)).and_then(run);
    match result {
        Ok((text, code)) => {
            print!("{text}");
            ExitCode::from(code)
        }
        Err(failure) => {
            eprintln!("error: {}", failure.message);
            ExitCode::from(failure.code)
        }
    }
}
