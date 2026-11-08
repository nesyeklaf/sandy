use crate::evaluate::{compare_drift, evaluate_holon, EvalContext, EvalEnv, HolonEvaluation};
use crate::format::{
    confirmation_path, parse_confirmation, parse_holon, Confirmation, Evidence, Holon,
};
use crate::order::js_cmp;
use crate::outputs::{
    child_warning, Carrier, CheckError, CheckOutput, CheckWarning, DriftEntry, DriftOutput,
    ViewFocus, ViewNode, ViewOutput, ViewSeam, ViewSides,
};
use crate::scan::{scan_root, ScanResult};
use crate::time::{format_instant, parse_instant};
use rayon::prelude::*;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct HolonFile {
    pub path: String,
    pub holon: Option<Holon>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConfirmationFile {
    pub path: String,
    pub confirmation: Option<Confirmation>,
    pub holon: Option<String>,
    pub error: Option<String>,
}

pub fn read_holon_file(path: String, text: &str) -> HolonFile {
    match parse_holon(text) {
        Ok(holon) => HolonFile {
            path,
            holon: Some(holon),
            error: None,
        },
        Err(error) => HolonFile {
            path,
            holon: None,
            error: Some(error),
        },
    }
}

fn confirmation_folder(path: &str) -> Option<String> {
    let rest = path.strip_prefix(".holons/confirmations/")?;
    let (folder, _) = rest.split_once('/')?;
    (!folder.is_empty()).then(|| folder.to_string())
}

pub fn read_confirmation_file(path: String, text: &str) -> ConfirmationFile {
    let confirmation = match parse_confirmation(text) {
        Ok(confirmation) => confirmation,
        Err(error) => {
            return ConfirmationFile {
                holon: confirmation_folder(&path),
                path,
                confirmation: None,
                error: Some(error),
            }
        }
    };
    let expected = confirmation_path(
        &confirmation.holon,
        &confirmation.at,
        &confirmation.side,
        &confirmation.by,
    );
    if expected != path {
        return ConfirmationFile {
            path,
            holon: Some(confirmation.holon),
            confirmation: None,
            error: Some(format!(
                "file name does not match its holon, at, side and by: expected {expected}"
            )),
        };
    }
    ConfirmationFile {
        path,
        holon: Some(confirmation.holon.clone()),
        confirmation: Some(confirmation),
        error: None,
    }
}

fn node_read_error(error: &std::io::Error, path: &Path) -> String {
    let known = match error.raw_os_error() {
        Some(1) => Some(("EPERM", "operation not permitted")),
        Some(2) => Some(("ENOENT", "no such file or directory")),
        Some(5) => Some(("EIO", "i/o error")),
        Some(13) => Some(("EACCES", "permission denied")),
        Some(20) => Some(("ENOTDIR", "not a directory")),
        Some(21) => Some(("EISDIR", "illegal operation on a directory")),
        Some(24) => Some(("EMFILE", "too many open files")),
        _ => None,
    };
    match known {
        Some((code, description)) => format!("{code}: {description}, open '{}'", path.display()),
        None => format!("{error}, open '{}'", path.display()),
    }
}

fn read_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|error| node_read_error(&error, path))?;
    Ok(match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    })
}

pub struct Model {
    pub files: Vec<HolonFile>,
    pub confirmation_files: Vec<ConfirmationFile>,
    winners: Vec<usize>,
    by_id: HashMap<String, usize>,
    parents: Vec<Option<usize>>,
    children: Vec<Vec<usize>>,
    incoming: HashMap<String, Vec<(usize, usize, bool)>>,
    evidence: HashMap<String, Vec<Evidence>>,
    confirmations: HashMap<String, HashMap<String, usize>>,
}

fn newer_evidence(a: &Evidence, b: &Evidence) -> bool {
    parse_instant(&a.at) >= parse_instant(&b.at)
}

impl Model {
    pub fn new(
        files: Vec<HolonFile>,
        confirmation_files: Vec<ConfirmationFile>,
        evidence: Vec<Evidence>,
    ) -> Model {
        let mut winners: Vec<usize> = Vec::new();
        let mut by_id: HashMap<String, usize> = HashMap::new();
        for (index, file) in files.iter().enumerate() {
            let Some(holon) = &file.holon else { continue };
            match by_id.get(&holon.id) {
                None => {
                    by_id.insert(holon.id.clone(), winners.len());
                    winners.push(index);
                }
                Some(&position) => {
                    if js_cmp(&file.path, &files[winners[position]].path) == Ordering::Less {
                        winners[position] = index;
                    }
                }
            }
        }
        let holon_at = |position: usize| {
            files[winners[position]]
                .holon
                .as_ref()
                .expect("winner parsed")
        };
        let parents: Vec<Option<usize>> = (0..winners.len())
            .map(|position| {
                holon_at(position)
                    .part_of
                    .as_ref()
                    .and_then(|parent| by_id.get(parent).copied())
            })
            .collect();
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); winners.len()];
        let mut incoming: HashMap<String, Vec<(usize, usize, bool)>> = HashMap::new();
        for (position, parent) in parents.iter().enumerate() {
            if let Some(parent) = *parent {
                children[parent].push(position);
            }
            for (index, seam) in holon_at(position).seams.iter().enumerate() {
                incoming.entry(seam.to.clone()).or_default().push((
                    position,
                    index,
                    seam.read_only,
                ));
            }
        }
        for list in &mut children {
            list.sort_by(|a, b| js_cmp(&holon_at(*a).id, &holon_at(*b).id));
        }
        let mut latest: HashMap<String, Vec<Evidence>> = HashMap::with_capacity(evidence.len());
        for record in evidence {
            let sides = latest.entry(record.holon.clone()).or_default();
            match sides.iter_mut().find(|current| current.side == record.side) {
                Some(current) => {
                    if newer_evidence(&record, current) {
                        *current = record;
                    }
                }
                None => sides.push(record),
            }
        }
        let mut confirmations: HashMap<String, HashMap<String, usize>> = HashMap::new();
        for (index, file) in confirmation_files.iter().enumerate() {
            let Some(confirmation) = &file.confirmation else {
                continue;
            };
            let sides = confirmations.entry(confirmation.holon.clone()).or_default();
            let replace = match sides.get(&confirmation.side) {
                None => true,
                Some(&current) => {
                    let other = &confirmation_files[current];
                    let other_at = &other
                        .confirmation
                        .as_ref()
                        .expect("indexed confirmation")
                        .at;
                    match js_cmp(&confirmation.at, other_at) {
                        Ordering::Greater => true,
                        Ordering::Equal => js_cmp(&file.path, &other.path) == Ordering::Greater,
                        Ordering::Less => false,
                    }
                }
            };
            if replace {
                sides.insert(confirmation.side.clone(), index);
            }
        }
        Model {
            files,
            confirmation_files,
            winners,
            by_id,
            parents,
            children,
            incoming,
            evidence: latest,
            confirmations,
        }
    }

    pub fn load(root: &Path, evidence: Vec<Evidence>) -> Result<Model, String> {
        let (files, confirmation_files) = read_sources(root, scan_root(root))?;
        Ok(Model::new(files, confirmation_files, evidence))
    }
}

pub type Sources = (Vec<HolonFile>, Vec<ConfirmationFile>);

pub fn read_sources(root: &Path, scan: ScanResult) -> Result<Sources, String> {
    let files: Vec<Result<HolonFile, String>> = scan
        .holon_files
        .into_par_iter()
        .map(|path| {
            let text = read_text(&root.join(&path))?;
            Ok(read_holon_file(path, &text))
        })
        .collect();
    let files = files.into_iter().collect::<Result<Vec<_>, _>>()?;
    let confirmation_files: Vec<Result<ConfirmationFile, String>> = scan
        .confirmation_files
        .into_par_iter()
        .map(|path| {
            let text = read_text(&root.join(&path))?;
            Ok(read_confirmation_file(path, &text))
        })
        .collect();
    let confirmation_files = confirmation_files
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    Ok((files, confirmation_files))
}

impl Model {
    pub fn len(&self) -> usize {
        self.winners.len()
    }

    pub fn is_empty(&self) -> bool {
        self.winners.is_empty()
    }

    fn holon_at(&self, position: usize) -> &Holon {
        self.files[self.winners[position]]
            .holon
            .as_ref()
            .expect("winner parsed")
    }

    fn path_at(&self, position: usize) -> &str {
        &self.files[self.winners[position]].path
    }

    pub fn get(&self, id: &str) -> Option<&Holon> {
        self.by_id.get(id).map(|position| self.holon_at(*position))
    }

    pub fn check(&self) -> CheckOutput {
        let mut errors: Vec<CheckError> = Vec::new();
        let mut warnings: Vec<CheckWarning> = Vec::new();
        for file in &self.files {
            if let Some(error) = &file.error {
                errors.push(CheckError {
                    holon: None,
                    file: file.path.clone(),
                    message: error.clone(),
                });
                continue;
            }
            let Some(holon) = &file.holon else { continue };
            if let Some(&position) = self.by_id.get(&holon.id) {
                let winner = self.path_at(position);
                if winner != file.path {
                    errors.push(CheckError {
                        holon: Some(holon.id.clone()),
                        file: file.path.clone(),
                        message: format!("duplicate id {}, also in {winner}", holon.id),
                    });
                }
            }
        }
        let mut child_counts: Vec<(usize, usize)> = Vec::new();
        let mut counted: HashMap<usize, usize> = HashMap::new();
        for position in 0..self.winners.len() {
            let holon = self.holon_at(position);
            let path = self.path_at(position);
            let error = |message: String| CheckError {
                holon: Some(holon.id.clone()),
                file: path.to_string(),
                message,
            };
            let name = basename(path);
            if name != holon.id {
                errors.push(error(format!(
                    "id {} differs from the file name {name}.holon",
                    holon.id
                )));
            }
            if let Some(parent) = &holon.part_of {
                match self.by_id.get(parent) {
                    Some(&parent_position) => match counted.get(&parent_position) {
                        Some(&slot) => child_counts[slot].1 += 1,
                        None => {
                            counted.insert(parent_position, child_counts.len());
                            child_counts.push((parent_position, 1));
                        }
                    },
                    None => errors.push(error(format!("partOf names unknown holon {parent}"))),
                }
            }
            for seam in &holon.seams {
                if !self.by_id.contains_key(&seam.to) {
                    errors.push(error(format!("seam to unknown holon {}", seam.to)));
                }
            }
            for carrier in &holon.carried_by {
                if !self.by_id.contains_key(carrier) {
                    errors.push(error(format!("carriedBy names unknown holon {carrier}")));
                }
            }
        }
        let mut state = vec![0u8; self.winners.len()];
        for start in 0..self.winners.len() {
            if state[start] != 0 {
                continue;
            }
            let mut path: Vec<usize> = Vec::new();
            let mut current = Some(start);
            while let Some(position) = current {
                if state[position] != 0 {
                    break;
                }
                state[position] = 1;
                path.push(position);
                current = self.parents[position];
            }
            if let Some(position) = current.filter(|position| state[*position] == 1) {
                let from = path
                    .iter()
                    .position(|item| *item == position)
                    .expect("on path");
                let cycle: Vec<&str> = path[from..]
                    .iter()
                    .map(|item| self.holon_at(*item).id.as_str())
                    .collect();
                let first = cycle
                    .iter()
                    .copied()
                    .min_by(|a, b| js_cmp(a, b))
                    .expect("cycle not empty");
                let at = cycle.iter().position(|id| *id == first).expect("member");
                let mut rotated: Vec<&str> = cycle[at..]
                    .iter()
                    .chain(cycle[..at].iter())
                    .copied()
                    .collect();
                rotated.push(first);
                errors.push(CheckError {
                    holon: Some(first.to_string()),
                    file: self.path_at(self.by_id[first]).to_string(),
                    message: format!("partOf cycle: {}", rotated.join(" -> ")),
                });
            }
            for item in path {
                state[item] = 2;
            }
        }
        for (position, count) in child_counts {
            let id = &self.holon_at(position).id;
            if let Some(message) = child_warning(id, count) {
                warnings.push(CheckWarning {
                    holon: id.clone(),
                    message,
                });
            }
        }
        for file in &self.confirmation_files {
            if let Some(error) = &file.error {
                errors.push(CheckError {
                    holon: file.holon.clone(),
                    file: file.path.clone(),
                    message: error.clone(),
                });
            } else if let Some(holon) = file
                .holon
                .as_ref()
                .filter(|holon| !self.by_id.contains_key(*holon))
            {
                warnings.push(CheckWarning {
                    holon: holon.clone(),
                    message: format!("{} confirms unknown holon {holon}", file.path),
                });
            }
        }
        errors
            .sort_by(|a, b| js_cmp(&a.file, &b.file).then_with(|| js_cmp(&a.message, &b.message)));
        warnings.sort_by(|a, b| {
            js_cmp(&a.holon, &b.holon).then_with(|| js_cmp(&a.message, &b.message))
        });
        CheckOutput {
            format: "holon-check/v0",
            holons: self.winners.len(),
            errors,
            warnings,
        }
    }

    pub fn evaluate<'m>(&'m self, env: &EvalEnv) -> Evaluated<'m> {
        let evaluations: Vec<HolonEvaluation> = (0..self.winners.len())
            .into_par_iter()
            .map(|position| evaluate_holon(self.holon_at(position), self, env))
            .collect();
        let mut drift_below: Vec<usize> = evaluations
            .iter()
            .map(|evaluation| evaluation.drift.len())
            .collect();
        for (position, evaluation) in evaluations.iter().enumerate() {
            let amount = evaluation.drift.len();
            if amount == 0 {
                continue;
            }
            let mut seen: HashSet<usize> = HashSet::from([position]);
            let mut current = self.parents[position];
            while let Some(parent) = current {
                if !seen.insert(parent) {
                    break;
                }
                drift_below[parent] += amount;
                current = self.parents[parent];
            }
        }
        Evaluated {
            model: self,
            evaluations,
            drift_below,
            now_ms: env.now_ms,
            commit: env.commit.clone(),
        }
    }
}

fn basename(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".holon").unwrap_or(name)
}

impl EvalContext for Model {
    fn part_of(&self, id: &str) -> Option<Option<&str>> {
        self.by_id
            .get(id)
            .map(|position| self.holon_at(*position).part_of.as_deref())
    }

    fn latest_evidence(&self, holon: &str, side: &str) -> Option<&Evidence> {
        self.evidence
            .get(holon)?
            .iter()
            .find(|record| record.side == side)
    }

    fn latest_confirmation(&self, holon: &str, side: &str) -> Option<&Confirmation> {
        let index = *self.confirmations.get(holon)?.get(side)?;
        self.confirmation_files[index].confirmation.as_ref()
    }

    fn writers_to(&self, target: &str) -> Vec<(&str, bool)> {
        self.incoming.get(target).map_or_else(Vec::new, |list| {
            list.iter()
                .map(|(from, _, read_only)| (self.holon_at(*from).id.as_str(), *read_only))
                .collect()
        })
    }
}

pub struct Evaluated<'m> {
    model: &'m Model,
    evaluations: Vec<HolonEvaluation>,
    drift_below: Vec<usize>,
    now_ms: i64,
    commit: String,
}

impl<'m> Evaluated<'m> {
    pub fn evaluation(&self, id: &str) -> Option<&HolonEvaluation> {
        self.model
            .by_id
            .get(id)
            .map(|position| &self.evaluations[*position])
    }

    pub fn drift_below(&self, id: &str) -> Option<usize> {
        self.model
            .by_id
            .get(id)
            .map(|position| self.drift_below[*position])
    }

    pub fn drift(&self) -> DriftOutput {
        let mut drift: Vec<DriftEntry> = Vec::new();
        for (position, evaluation) in self.evaluations.iter().enumerate() {
            let id = &self.model.holon_at(position).id;
            for item in &evaluation.drift {
                drift.push(DriftEntry {
                    holon: id.clone(),
                    drift: item.clone(),
                });
            }
        }
        drift.sort_by(|a, b| {
            js_cmp(&a.holon, &b.holon).then_with(|| compare_drift(&a.drift, &b.drift))
        });
        DriftOutput {
            format: "holon-drift/v0",
            drift,
            computed_at: format_instant(self.now_ms),
            commit: self.commit.clone(),
        }
    }

    fn node(&self, position: usize, role: &'static str, with_children: bool) -> ViewNode {
        let holon = self.model.holon_at(position);
        ViewNode {
            id: holon.id.clone(),
            kind: holon.kind,
            role,
            title: holon.title.clone(),
            status: holon.status,
            light: self.evaluations[position].light,
            drift_below: self.drift_below[position],
            child_count: with_children.then(|| self.model.children[position].len()),
        }
    }

    pub fn view(&self, id: &str) -> Option<ViewOutput> {
        let model = self.model;
        let position = *model.by_id.get(id)?;
        let holon = model.holon_at(position);
        let evaluation = &self.evaluations[position];
        let title = |other: &str| {
            model
                .get(other)
                .map_or_else(|| other.to_string(), |found| found.title.clone())
        };
        let parent = holon
            .part_of
            .as_ref()
            .and_then(|parent| model.by_id.get(parent).copied());
        let children = &model.children[position];
        let mut seams: Vec<ViewSeam> = holon
            .seams
            .iter()
            .zip(&evaluation.seams)
            .map(|(seam, result)| ViewSeam {
                from: holon.id.clone(),
                from_title: holon.title.clone(),
                to: seam.to.clone(),
                to_title: title(&seam.to),
                contract: seam.contract.clone(),
                light: result.light,
                read_only: seam.read_only,
                exclusive: seam.exclusive,
                drift: result.drift,
            })
            .collect();
        let mut incoming: Vec<(usize, usize)> = model
            .incoming
            .get(id)
            .map_or_else(Vec::new, |list| {
                list.iter()
                    .map(|(from, index, _)| (*from, *index))
                    .collect()
            })
            .into_iter()
            .filter(|(from, _)| *from != position)
            .collect();
        incoming.sort_by(|a, b| {
            js_cmp(&model.holon_at(a.0).id, &model.holon_at(b.0).id).then_with(|| a.1.cmp(&b.1))
        });
        for (from, index) in incoming {
            let source = model.holon_at(from);
            let seam = &source.seams[index];
            let result = &self.evaluations[from].seams[index];
            seams.push(ViewSeam {
                from: source.id.clone(),
                from_title: source.title.clone(),
                to: holon.id.clone(),
                to_title: holon.title.clone(),
                contract: seam.contract.clone(),
                light: result.light,
                read_only: seam.read_only,
                exclusive: seam.exclusive,
                drift: result.drift,
            });
        }
        let warnings: Vec<String> = std::iter::once(position)
            .chain(parent)
            .chain(children.iter().copied())
            .filter_map(|item| child_warning(&model.holon_at(item).id, model.children[item].len()))
            .collect();
        let [i, it, we, they] = evaluation.sides.clone();
        Some(ViewOutput {
            format: "holon-view/v0",
            focus: ViewFocus {
                id: holon.id.clone(),
                kind: holon.kind,
                role: "system",
                title: holon.title.clone(),
                status: holon.status,
                why: holon.why.clone(),
                contract: holon.contract.clone(),
                carried_by: holon
                    .carried_by
                    .iter()
                    .map(|carrier| Carrier {
                        id: carrier.clone(),
                        title: title(carrier),
                    })
                    .collect(),
                light: evaluation.light,
                drift: evaluation.drift.clone(),
                drift_below: self.drift_below[position],
                sides: ViewSides { i, it, we, they },
                code: holon.code.clone(),
            },
            parent: parent.map(|parent| self.node(parent, "environment", false)),
            children: children
                .iter()
                .map(|child| self.node(*child, "part", true))
                .collect(),
            seams,
            warnings,
            computed_at: format_instant(self.now_ms),
            commit: self.commit.clone(),
        })
    }
}
