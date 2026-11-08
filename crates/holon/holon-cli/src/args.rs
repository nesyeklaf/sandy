use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Flag,
    Value,
    Choice(&'static [&'static str]),
    List,
}

#[derive(Clone, Copy)]
pub struct Spec {
    pub name: &'static str,
    pub kind: Kind,
    pub stdin: bool,
    pub required: bool,
}

pub struct ArgError {
    pub code: &'static str,
    pub message: String,
    pub hint: Option<String>,
}

fn arg_error(code: &'static str, message: String) -> ArgError {
    ArgError {
        code,
        message,
        hint: None,
    }
}

impl Spec {
    pub const fn required(self) -> Spec {
        Spec {
            required: true,
            ..self
        }
    }

    fn signature(&self) -> String {
        match self.kind {
            Kind::Flag => format!("--{}", self.name),
            Kind::Choice(values) => format!("--{} <{}>", self.name, values.join("|")),
            Kind::Value | Kind::List => format!("--{} <value>", self.name),
        }
    }
}

pub fn usage_line(path: &str, positional: Option<&str>, specs: &[Spec]) -> String {
    let mut parts = vec![format!("holon {path}")];
    parts.extend(positional.map(|name| format!("<{name}>")));
    for spec in specs {
        let signature = spec.signature();
        parts.push(if spec.required && spec.kind != Kind::Flag {
            signature
        } else if spec.kind == Kind::List {
            format!("[{signature}]...")
        } else {
            format!("[{signature}]")
        });
    }
    parts.join(" ")
}

fn edit_distance(left: &str, right: &str) -> usize {
    let right: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for (row, left_char) in left.chars().enumerate() {
        let mut current = vec![row + 1];
        for (column, right_char) in right.iter().enumerate() {
            let substitution = previous[column] + usize::from(left_char != *right_char);
            current.push(
                substitution
                    .min(previous[column + 1] + 1)
                    .min(current[column] + 1),
            );
        }
        previous = current;
    }
    previous[right.len()]
}

fn nearest<'s>(input: &str, specs: &'s [Spec]) -> Option<&'s str> {
    let mut best: Option<(&str, usize)> = None;
    for spec in specs {
        let score = edit_distance(input, spec.name);
        let related = score <= 2
            || (input.chars().count() >= 3 && spec.name.starts_with(input))
            || (spec.name.chars().count() >= 3 && input.starts_with(spec.name));
        if related && best.is_none_or(|(_, best_score)| score < best_score) {
            best = Some((spec.name, score));
        }
    }
    best.map(|(name, _)| name)
}

fn names_declared_option(token: &str, specs: &[Spec]) -> bool {
    if token == "--" || token == "--help" || token == "-h" {
        return true;
    }
    let Some(spelled) = token.strip_prefix("--") else {
        return false;
    };
    let spelled = spelled.split('=').next().unwrap_or_default();
    specs
        .iter()
        .any(|spec| spec.name == spelled || spelled.strip_suffix("-stdin") == Some(spec.name))
}

pub const fn flag(name: &'static str) -> Spec {
    Spec {
        name,
        kind: Kind::Flag,
        stdin: false,
        required: false,
    }
}

pub const fn value(name: &'static str) -> Spec {
    Spec {
        name,
        kind: Kind::Value,
        stdin: false,
        required: false,
    }
}

pub const fn stdin(name: &'static str) -> Spec {
    Spec {
        name,
        kind: Kind::Value,
        stdin: true,
        required: false,
    }
}

pub const fn choice(name: &'static str, values: &'static [&'static str]) -> Spec {
    Spec {
        name,
        kind: Kind::Choice(values),
        stdin: false,
        required: false,
    }
}

pub const fn list(name: &'static str) -> Spec {
    Spec {
        name,
        kind: Kind::List,
        stdin: false,
        required: false,
    }
}

#[derive(Default, Debug)]
pub struct Parsed {
    pub flags: Vec<&'static str>,
    pub values: HashMap<&'static str, String>,
    pub lists: HashMap<&'static str, Vec<String>>,
    pub positionals: Vec<String>,
    pub stdin: Vec<&'static str>,
}

impl Parsed {
    pub fn flag(&self, name: &str) -> bool {
        self.flags.contains(&name)
    }

    pub fn value(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    pub fn list(&self, name: &str) -> Vec<String> {
        self.lists.get(name).cloned().unwrap_or_default()
    }

    pub fn given(&self, name: &str) -> bool {
        self.flag(name) || self.values.contains_key(name) || self.lists.contains_key(name)
    }
}

pub fn parse(tokens: &[String], specs: &[Spec]) -> Result<Parsed, ArgError> {
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        index += 1;
        let Some(spelled) = token.strip_prefix("--").filter(|rest| !rest.is_empty()) else {
            parsed.positionals.push(token.clone());
            continue;
        };
        let (name, inline) = match spelled.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (spelled, None),
        };
        let stdin_target = name
            .strip_suffix("-stdin")
            .and_then(|target| specs.iter().find(|spec| spec.name == target && spec.stdin));
        if let Some(spec) = stdin_target {
            if inline.is_some() {
                return Err(arg_error(
                    "invalid_value",
                    format!("--{name} takes no value"),
                ));
            }
            if parsed.values.contains_key(spec.name) || parsed.stdin.contains(&spec.name) {
                return Err(arg_error(
                    "unexpected_argument",
                    format!(
                        "--{} was given more than once; it takes a single value",
                        spec.name
                    ),
                ));
            }
            parsed.stdin.push(spec.name);
            continue;
        }
        let Some(spec) = specs.iter().find(|spec| spec.name == name) else {
            return Err(ArgError {
                hint: nearest(name, specs)
                    .map(|suggestion| format!("Did you mean --{suggestion}?")),
                ..arg_error("unknown_option", format!("unknown option '--{name}'"))
            });
        };
        if spec.kind == Kind::Flag {
            if let Some(inline) = inline
                .as_deref()
                .filter(|value| *value != "true" && *value != "false")
            {
                return Err(arg_error(
                    "invalid_value",
                    format!("invalid value '{inline}' for --{name}. Expected one of: true, false"),
                ));
            }
            if parsed.flags.contains(&spec.name) {
                return Err(arg_error(
                    "unexpected_argument",
                    format!("--{name} was given more than once"),
                ));
            }
            if inline.as_deref() != Some("false") {
                parsed.flags.push(spec.name);
            }
            continue;
        }
        let raw = match inline {
            Some(raw) => raw,
            None => match tokens.get(index) {
                Some(next) if !names_declared_option(next, specs) => {
                    index += 1;
                    next.clone()
                }
                _ => {
                    return Err(ArgError {
                        hint: Some(format!(
                            "Write --{name}=<value> when the value is itself an option name."
                        )),
                        ..arg_error("invalid_value", format!("--{name} requires a value"))
                    })
                }
            },
        };
        match spec.kind {
            Kind::List => parsed.lists.entry(spec.name).or_default().push(raw),
            Kind::Choice(values) if !values.contains(&raw.as_str()) => {
                return Err(arg_error(
                    "invalid_value",
                    format!(
                        "invalid value '{raw}' for --{name}. Expected one of: {}",
                        values.join(", ")
                    ),
                ))
            }
            _ => {
                if parsed.values.contains_key(spec.name) || parsed.stdin.contains(&spec.name) {
                    return Err(arg_error(
                        "unexpected_argument",
                        format!("--{name} was given more than once; it takes a single value"),
                    ));
                }
                parsed.values.insert(spec.name, raw);
            }
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPECS: [Spec; 4] = [
        flag("json"),
        value("root"),
        choice("kind", &["ci", "metric"]),
        list("hesitation"),
    ];

    fn run(tokens: &[&str]) -> Result<Parsed, String> {
        let tokens: Vec<String> = tokens.iter().map(|token| token.to_string()).collect();
        parse(&tokens, &SPECS).map_err(|error| error.message)
    }

    #[test]
    fn suggests_the_nearest_option_and_takes_dashed_values() {
        let tokens: Vec<String> = ["--roots", "x"]
            .iter()
            .map(|token| token.to_string())
            .collect();
        let error = parse(&tokens, &SPECS).expect_err("unknown");
        assert_eq!(
            (error.code, error.hint.as_deref()),
            ("unknown_option", Some("Did you mean --root?"))
        );
        assert_eq!(
            run(&["--root", "--other"]).unwrap().value("root"),
            Some("--other")
        );
        assert_eq!(
            run(&["--root", "--json"]).unwrap_err(),
            "--root requires a value"
        );
    }

    #[test]
    fn reports_usage_errors_like_the_plugin_sdk() {
        assert_eq!(run(&["--x"]).unwrap_err(), "unknown option '--x'");
        assert_eq!(run(&["--root"]).unwrap_err(), "--root requires a value");
        assert_eq!(
            run(&["--root", "a", "--root=b"]).unwrap_err(),
            "--root was given more than once; it takes a single value"
        );
        assert_eq!(
            run(&["--kind", "x"]).unwrap_err(),
            "invalid value 'x' for --kind. Expected one of: ci, metric"
        );
        assert_eq!(
            run(&["--json", "--json"]).unwrap_err(),
            "--json was given more than once"
        );
    }

    #[test]
    fn collects_values_lists_and_positionals() {
        let parsed = run(&[
            "view",
            "--hesitation",
            "a",
            "--json",
            "--hesitation=b",
            "shop",
        ])
        .unwrap();
        assert!(parsed.flag("json"));
        assert_eq!(parsed.list("hesitation"), ["a", "b"]);
        assert_eq!(parsed.positionals, ["view", "shop"]);
    }
}
