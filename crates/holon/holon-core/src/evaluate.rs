use crate::format::{is_human_kind, Confirmation, Evidence, Holon, Proof, Side};
use crate::order::{is_js_blank, js_cmp};
use crate::time::{contract_hash, format_date, format_instant, parse_instant, DAY_MS};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SideLight {
    Refuted,
    Expired,
    Open,
    Claimed,
    Soft,
    Hard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HolonLight {
    Drift,
    Open,
    Claimed,
    Soft,
    Hard,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DriftKind {
    Break,
    Contradiction,
    Expired,
    OrphanAbove,
    OrphanBelow,
}

impl SideLight {
    pub fn as_str(self) -> &'static str {
        match self {
            SideLight::Refuted => "refuted",
            SideLight::Expired => "expired",
            SideLight::Open => "open",
            SideLight::Claimed => "claimed",
            SideLight::Soft => "soft",
            SideLight::Hard => "hard",
        }
    }

    pub fn glyph(self) -> &'static str {
        match self {
            SideLight::Hard => "●",
            SideLight::Soft => "◐",
            SideLight::Claimed => "◌",
            SideLight::Open => "○",
            SideLight::Refuted => "✕",
            SideLight::Expired => "◇",
        }
    }
}

impl HolonLight {
    pub fn glyph(self) -> &'static str {
        match self {
            HolonLight::Hard => "●",
            HolonLight::Soft => "◐",
            HolonLight::Claimed => "◌",
            HolonLight::Open => "○",
            HolonLight::Drift => "◇",
        }
    }
}

impl DriftKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DriftKind::Break => "break",
            DriftKind::Contradiction => "contradiction",
            DriftKind::Expired => "expired",
            DriftKind::OrphanAbove => "orphan-above",
            DriftKind::OrphanBelow => "orphan-below",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Drift {
    pub kind: DriftKind,
    pub side: Option<Side>,
    pub seam: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SideView {
    pub light: SideLight,
    pub kind: Option<&'static str>,
    pub source: Option<String>,
    pub at: Option<String>,
    pub expires: Option<String>,
    pub by: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeamEvaluation {
    pub light: SideLight,
    pub drift: Option<DriftKind>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Validity {
    pub from_ms: Option<i64>,
    pub until_ms: Option<i64>,
    pub uses_commit: bool,
    pub unknown_build: bool,
}

impl Validity {
    fn expiry(&mut self, expiry: i64, now_ms: i64) {
        if expiry <= now_ms {
            self.from_ms = Some(self.from_ms.map_or(expiry, |from| from.max(expiry)));
        } else {
            self.until_ms = Some(self.until_ms.map_or(expiry, |until| until.min(expiry)));
        }
    }

    pub fn holds_at(&self, now_ms: i64) -> bool {
        self.from_ms.is_none_or(|from| from <= now_ms)
            && self.until_ms.is_none_or(|until| now_ms < until)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct HolonEvaluation {
    pub light: HolonLight,
    pub sides: [SideView; 4],
    pub seams: Vec<SeamEvaluation>,
    pub drift: Vec<Drift>,
    pub validity: Validity,
}

pub trait CodeChanges: Sync {
    fn changed_paths(&self, build: &str, commit: &str) -> Option<Arc<Vec<String>>>;
}

pub struct NoCodeChanges;

impl CodeChanges for NoCodeChanges {
    fn changed_paths(&self, _build: &str, _commit: &str) -> Option<Arc<Vec<String>>> {
        None
    }
}

pub struct UnchangedCode;

impl CodeChanges for UnchangedCode {
    fn changed_paths(&self, _build: &str, _commit: &str) -> Option<Arc<Vec<String>>> {
        Some(Arc::new(Vec::new()))
    }
}

pub struct EvalEnv<'a> {
    pub now_ms: i64,
    pub commit: String,
    pub code: &'a dyn CodeChanges,
}

pub trait EvalContext: Sync {
    fn part_of(&self, id: &str) -> Option<Option<&str>>;
    fn latest_evidence(&self, holon: &str, side: &str) -> Option<&Evidence>;
    fn latest_confirmation(&self, holon: &str, side: &str) -> Option<&Confirmation>;
    fn writers_to(&self, target: &str) -> Vec<(&str, bool)>;
}

pub fn weakest_side(lights: impl IntoIterator<Item = SideLight>) -> SideLight {
    lights.into_iter().min().unwrap_or(SideLight::Hard)
}

pub fn compare_drift(a: &Drift, b: &Drift) -> Ordering {
    a.kind
        .cmp(&b.kind)
        .then_with(|| {
            let rank = |side: Option<Side>| side.map_or(-1, |side| side.index() as i32);
            rank(a.side).cmp(&rank(b.side))
        })
        .then_with(|| {
            js_cmp(
                a.seam.as_deref().unwrap_or(""),
                b.seam.as_deref().unwrap_or(""),
            )
        })
}

fn walks_to(start: &str, targets: &[&str], ctx: &dyn EvalContext) -> bool {
    let mut seen: Vec<&str> = Vec::new();
    let mut current = Some(start);
    while let Some(id) = current {
        if seen.contains(&id) {
            return false;
        }
        if targets.contains(&id) {
            return true;
        }
        seen.push(id);
        current = ctx.part_of(id).flatten();
    }
    false
}

pub fn is_descendant(id: &str, ancestor: &str, ctx: &dyn EvalContext) -> bool {
    match ctx.part_of(id).flatten() {
        Some(parent) => walks_to(parent, &[ancestor], ctx),
        None => false,
    }
}

fn code_touched<'a>(code: &[String], changed: &'a [String]) -> Option<&'a str> {
    changed.iter().map(String::as_str).find(|path| {
        code.iter().any(|entry| {
            if entry.ends_with('/') {
                path.starts_with(entry.as_str())
            } else {
                path == entry
            }
        })
    })
}

fn earliest(values: [Option<i64>; 2]) -> Option<i64> {
    values.into_iter().flatten().min()
}

fn instant(value: &str) -> i64 {
    parse_instant(value).unwrap_or_else(|| panic!("not a timestamp: {value}"))
}

fn evaluate_proof(
    holon: &Holon,
    side: &str,
    proof: Option<&Proof>,
    current_hash: &str,
    ctx: &dyn EvalContext,
    env: &EvalEnv,
    validity: &mut Validity,
) -> SideView {
    let Some(proof) = proof else {
        return SideView {
            light: SideLight::Open,
            kind: None,
            source: None,
            at: None,
            expires: None,
            by: None,
            detail: "No proof declared".to_string(),
        };
    };
    let view =
        |light, at: Option<String>, expires: Option<String>, by: Option<String>, detail: String| {
            SideView {
                light,
                kind: Some(proof.kind),
                source: proof.source.clone(),
                at,
                expires,
                by,
                detail,
            }
        };
    let never_checked = || {
        view(
            SideLight::Open,
            None,
            None,
            None,
            "Declared, never checked".to_string(),
        )
    };
    let every_ms = proof.every_days.map(|days| {
        i64::try_from(days)
            .unwrap_or(i64::MAX)
            .saturating_mul(DAY_MS)
    });
    let after = |at_ms: i64| every_ms.map(|every| at_ms.saturating_add(every));
    if is_human_kind(proof.kind) {
        let Some(confirmation) = ctx.latest_confirmation(&holon.id, side) else {
            return never_checked();
        };
        let at_ms = instant(&confirmation.at);
        let expiry = earliest([Some(instant(&confirmation.expires)), after(at_ms)]);
        let at = Some(confirmation.at.clone());
        let expires = expiry.map(format_date);
        let by = Some(confirmation.by.clone());
        let expired = if confirmation.contract_hash != current_hash {
            Some("Checked against an older contract".to_string())
        } else {
            if let Some(expiry) = expiry {
                validity.expiry(expiry, env.now_ms);
            }
            expiry
                .filter(|expiry| env.now_ms >= *expiry)
                .map(|expiry| format!("Expired on {}", format_date(expiry)))
        };
        if let Some(detail) = expired {
            return view(SideLight::Expired, at, expires, by, detail);
        }
        if confirmation.result == "refuted" {
            let detail = format!("Refuted by {}: {}", confirmation.by, confirmation.answer);
            return view(SideLight::Refuted, at, expires, by, detail);
        }
        let carriers: Vec<&str> = holon.carried_by.iter().map(String::as_str).collect();
        let own =
            !confirmation.by.starts_with("agent:") && walks_to(&confirmation.by, &carriers, ctx);
        if own {
            return view(
                SideLight::Claimed,
                at,
                expires,
                by,
                "Confirmed by its own carrier".to_string(),
            );
        }
        let detail = format!("Confirmed by {}", confirmation.by);
        return view(SideLight::Soft, at, expires, by, detail);
    }
    let Some(evidence) = ctx.latest_evidence(&holon.id, side) else {
        return never_checked();
    };
    let at_ms = instant(&evidence.at);
    let expiry = earliest([evidence.expires.as_deref().map(instant), after(at_ms)]);
    let at = Some(evidence.at.clone());
    let expires = expiry.map(format_instant);
    let mut expired = None;
    if evidence.contract_hash != current_hash {
        expired = Some("Checked against an older contract".to_string());
    } else if let Some(expiry) = expiry
        .inspect(|expiry| validity.expiry(*expiry, env.now_ms))
        .filter(|expiry| env.now_ms >= *expiry)
    {
        expired = Some(format!("Expired on {}", format_date(expiry)));
    } else if evidence.build != env.commit {
        validity.uses_commit = true;
        match env.code.changed_paths(&evidence.build, &env.commit) {
            None => {
                validity.unknown_build = true;
                expired = Some(format!("Build {} is no known commit", evidence.build));
            }
            Some(changed) => {
                if let Some(touched) = code_touched(&holon.code, &changed) {
                    let short: String = evidence.build.chars().take(12).collect();
                    expired = Some(format!("Code changed since build {short}: {touched}"));
                }
            }
        }
    } else {
        validity.uses_commit = true;
    }
    if let Some(detail) = expired {
        return view(SideLight::Expired, at, expires, None, detail);
    }
    let light = if evidence.result == "pass" {
        SideLight::Hard
    } else {
        SideLight::Refuted
    };
    view(light, at, expires, None, evidence.detail.clone())
}

fn contradiction_writers<'a>(
    holon: &Holon,
    target: &str,
    ctx: &'a dyn EvalContext,
) -> Vec<&'a str> {
    let mut writers: Vec<&str> = Vec::new();
    for (from, read_only) in ctx.writers_to(target) {
        if read_only || from == holon.id || is_descendant(from, &holon.id, ctx) {
            continue;
        }
        if !writers.contains(&from) {
            writers.push(from);
        }
    }
    writers.sort_by(|a, b| js_cmp(a, b));
    writers
}

fn list_writers(writers: &[&str]) -> String {
    match writers {
        [one] => format!("{one} writes"),
        [rest @ .., last] => format!("{} and {last} write", rest.join(", ")),
        [] => String::new(),
    }
}

pub fn evaluate_holon(holon: &Holon, ctx: &dyn EvalContext, env: &EvalEnv) -> HolonEvaluation {
    let hash = contract_hash(&holon.contract);
    let mut drift = Vec::new();
    let mut validity = Validity::default();
    let sides = Side::ALL.map(|side| {
        let view = evaluate_proof(
            holon,
            side.as_str(),
            holon.proof(side),
            &hash,
            ctx,
            env,
            &mut validity,
        );
        let kind = match view.light {
            SideLight::Refuted => Some(DriftKind::Break),
            SideLight::Expired => Some(DriftKind::Expired),
            _ => None,
        };
        if let Some(kind) = kind {
            drift.push(Drift {
                kind,
                side: Some(side),
                seam: None,
                detail: view.detail.clone(),
            });
        }
        view
    });
    let seams = holon
        .seams
        .iter()
        .map(|seam| {
            let side = format!("seam:{}", seam.to);
            let view = evaluate_proof(
                holon,
                &side,
                seam.proof.as_ref(),
                &contract_hash(&seam.contract),
                ctx,
                env,
                &mut validity,
            );
            let mut kinds = Vec::new();
            let lit = match view.light {
                SideLight::Refuted => Some(DriftKind::Break),
                SideLight::Expired => Some(DriftKind::Expired),
                _ => None,
            };
            if let Some(kind) = lit {
                kinds.push(kind);
                drift.push(Drift {
                    kind,
                    side: None,
                    seam: Some(seam.to.clone()),
                    detail: format!("Seam to {}: {}", seam.to, view.detail),
                });
            }
            if seam.exclusive {
                let writers = contradiction_writers(holon, &seam.to, ctx);
                if !writers.is_empty() {
                    kinds.push(DriftKind::Contradiction);
                    drift.push(Drift {
                        kind: DriftKind::Contradiction,
                        side: None,
                        seam: Some(seam.to.clone()),
                        detail: format!(
                            "Promises to be the only writer to {}, but {} to it too",
                            seam.to,
                            list_writers(&writers)
                        ),
                    });
                }
            }
            SeamEvaluation {
                light: view.light,
                drift: kinds.into_iter().min(),
            }
        })
        .collect();
    if holon.status == "proposed" {
        drift.push(Drift {
            kind: DriftKind::OrphanBelow,
            side: None,
            seam: None,
            detail: "Proposed: a Why nothing fulfils yet".to_string(),
        });
    }
    if is_js_blank(&holon.why) {
        drift.push(Drift {
            kind: DriftKind::OrphanAbove,
            side: None,
            seam: None,
            detail: "No Why: nothing above asks for it".to_string(),
        });
    }
    drift.sort_by(compare_drift);
    let weakest = weakest_side(sides.iter().map(|side| side.light));
    let light = if !drift.is_empty() {
        HolonLight::Drift
    } else {
        match weakest {
            SideLight::Refuted | SideLight::Expired => HolonLight::Drift,
            SideLight::Open => HolonLight::Open,
            SideLight::Claimed => HolonLight::Claimed,
            SideLight::Soft => HolonLight::Soft,
            SideLight::Hard => HolonLight::Hard,
        }
    };
    HolonEvaluation {
        light,
        sides,
        seams,
        drift,
        validity,
    }
}
