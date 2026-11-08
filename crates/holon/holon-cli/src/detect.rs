use crate::snapshot::{read, stat, stat_file, DirEntry, Dirty, FileEntry, Snapshot};
use holon_core::model::{decode_text, read_confirmation_file, read_holon_file, HolonFile};
use holon_core::scan::{list_confirmation_dir, list_holon_dir, walk_confirmations, walk_holons};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::path::Path;

pub struct Detected {
    pub snapshot: Snapshot,
    pub changed: bool,
    pub files_changed: bool,
    pub holon_ids: HashSet<String>,
    pub confirmation_ids: HashSet<String>,
    pub parsed: HashMap<String, HolonFile>,
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

fn subtree<T>(entries: &[T], path: impl Fn(&T) -> &str, dir: &str) -> Range<usize> {
    if dir.is_empty() {
        return 0..entries.len();
    }
    let low = format!("{dir}/");
    let high = format!("{dir}0");
    let start = entries.partition_point(|entry| path(entry) < low.as_str());
    let end = entries.partition_point(|entry| path(entry) < high.as_str());
    start..end.max(start)
}

fn position<T>(entries: &[T], path: impl Fn(&T) -> &str, wanted: &str) -> Option<usize> {
    entries
        .binary_search_by(|entry| path(entry).cmp(wanted))
        .ok()
}

fn file_path(file: &FileEntry) -> &str {
    &file.path
}

fn dir_path(dir: &DirEntry) -> &str {
    &dir.path
}

struct Work<'s> {
    old: &'s Snapshot,
    removed_files: HashSet<usize>,
    removed_dirs: HashSet<usize>,
    added: Vec<(String, bool)>,
    added_dirs: Vec<DirEntry>,
}

impl Work<'_> {
    fn remove_subtree(&mut self, at: usize) {
        let dir = &self.old.dirs[at].path;
        self.removed_dirs.insert(at);
        self.removed_dirs
            .extend(subtree(&self.old.dirs, dir_path, dir));
        self.removed_files
            .extend(subtree(&self.old.files, file_path, dir));
    }

    fn known_dir(&self, path: &str) -> bool {
        position(&self.old.dirs, dir_path, path).is_some()
            || self.added_dirs.iter().any(|dir| dir.path == path)
    }

    fn relist(&mut self, root: &Path, dir: &DirEntry) {
        let listing = if dir.confirmation {
            list_confirmation_dir(root, &dir.path)
        } else {
            list_holon_dir(root, &dir.path)
        };
        let listed_files: HashSet<&String> = listing.files.iter().collect();
        let listed_dirs: HashSet<&String> = listing.dirs.iter().collect();
        let old = self.old;
        for at in subtree(&old.files, file_path, &dir.path) {
            let file = &old.files[at].path;
            if parent(file) == dir.path && !listed_files.contains(file) {
                self.removed_files.insert(at);
            }
        }
        for at in subtree(&old.dirs, dir_path, &dir.path) {
            let sub = &old.dirs[at].path;
            if !sub.is_empty()
                && parent(sub) == dir.path
                && !listed_dirs.contains(sub)
                && !self.removed_dirs.contains(&at)
            {
                self.remove_subtree(at);
            }
        }
        for file in listing.files {
            let known = position(&old.files, file_path, &file).is_some()
                || self.added.iter().any(|(added, _)| *added == file);
            if !known {
                self.added.push((file, dir.confirmation));
            }
        }
        for sub in listing.dirs {
            if self.known_dir(&sub) {
                continue;
            }
            let mut dirs = Vec::new();
            let files = if dir.confirmation {
                let mut files = Vec::new();
                walk_confirmations(root, &sub, &mut files, &mut dirs);
                files
            } else {
                walk_holons(root, &sub, &mut dirs)
            };
            for path in dirs {
                if !self.known_dir(&path) {
                    self.added_dirs.push(DirEntry {
                        path,
                        confirmation: dir.confirmation,
                        stat: None,
                    });
                }
            }
            self.added
                .extend(files.into_iter().map(|file| (file, dir.confirmation)));
        }
    }
}

enum Outcome {
    Gone,
    Same(FileEntry),
    New(FileEntry, Option<Box<HolonFile>>),
}

fn reread(
    root: &Path,
    path: &str,
    confirmation: bool,
    old: Option<&FileEntry>,
) -> Result<Outcome, String> {
    if stat_file(&root.join(path)).is_none() {
        return Ok(Outcome::Gone);
    }
    let read = read(root, path)?;
    let mut entry = FileEntry {
        path: path.to_string(),
        confirmation,
        stat: read.stat,
        hash: read.hash,
        id: None,
    };
    if let Some(old) = old.filter(|old| old.hash == read.hash) {
        entry.id.clone_from(&old.id);
        return Ok(Outcome::Same(entry));
    }
    let text = decode_text(read.bytes);
    if confirmation {
        entry.id = read_confirmation_file(path.to_string(), &text)
            .confirmation
            .map(|confirmation| confirmation.holon);
        return Ok(Outcome::New(entry, None));
    }
    let file = read_holon_file(path.to_string(), &text);
    entry.id = file.holon.as_ref().map(|holon| holon.id.clone());
    Ok(Outcome::New(entry, Some(Box::new(file))))
}

impl Detected {
    fn record(&mut self, confirmation: bool, id: Option<String>) {
        let ids = if confirmation {
            &mut self.confirmation_ids
        } else {
            &mut self.holon_ids
        };
        ids.extend(id);
    }
}

pub fn detect(root: &Path, old: Snapshot, dirty: &Dirty) -> Result<Detected, String> {
    let detected = Detected {
        snapshot: Snapshot::default(),
        changed: !dirty.is_empty(),
        files_changed: false,
        holon_ids: HashSet::new(),
        confirmation_ids: HashSet::new(),
        parsed: HashMap::new(),
    };
    if !detected.changed {
        return Ok(Detected {
            snapshot: old,
            ..detected
        });
    }
    if dirty.dirs.is_empty() {
        let outcomes: Vec<Result<Outcome, String>> = dirty
            .files
            .par_iter()
            .map(|at| {
                let file = &old.files[*at];
                reread(root, &file.path, file.confirmation, Some(file))
            })
            .collect();
        let outcomes = outcomes.into_iter().collect::<Result<Vec<_>, String>>()?;
        if !outcomes
            .iter()
            .any(|outcome| matches!(outcome, Outcome::Gone))
        {
            return Ok(in_place(old, dirty, outcomes, detected));
        }
    }
    detect_tree(root, old, dirty, detected)
}

fn in_place(
    mut old: Snapshot,
    dirty: &Dirty,
    outcomes: Vec<Outcome>,
    mut detected: Detected,
) -> Detected {
    for (at, outcome) in dirty.files.iter().zip(outcomes) {
        let slot = &mut old.files[*at];
        match outcome {
            Outcome::Gone => unreachable!("gone files take the tree path"),
            Outcome::Same(entry) => *slot = entry,
            Outcome::New(entry, file) => {
                let previous = std::mem::replace(slot, entry);
                detected.files_changed = true;
                detected.record(previous.confirmation, previous.id);
                detected.record(slot.confirmation, slot.id.clone());
                if let Some(file) = file {
                    detected.parsed.insert(slot.path.clone(), *file);
                }
            }
        }
    }
    old.taken_ns = dirty.taken_ns;
    Detected {
        snapshot: old,
        ..detected
    }
}

fn detect_tree(
    root: &Path,
    old: Snapshot,
    dirty: &Dirty,
    mut detected: Detected,
) -> Result<Detected, String> {
    let mut relisted: Vec<usize> = dirty.dirs.clone();
    relisted.sort_by_key(|at| {
        let path = &old.dirs[*at].path;
        path.matches('/').count() + usize::from(!path.is_empty())
    });
    let mut work = Work {
        old: &old,
        removed_files: HashSet::new(),
        removed_dirs: HashSet::new(),
        added: Vec::new(),
        added_dirs: Vec::new(),
    };
    for at in &relisted {
        if !work.removed_dirs.contains(at) {
            work.relist(root, &old.dirs[*at]);
        }
    }
    let Work {
        mut removed_files,
        removed_dirs,
        added,
        added_dirs,
        ..
    } = work;
    let existing: Vec<usize> = dirty
        .files
        .iter()
        .copied()
        .filter(|at| !removed_files.contains(at))
        .collect();
    let existing_outcomes: Vec<Result<Outcome, String>> = existing
        .par_iter()
        .map(|at| {
            let file = &old.files[*at];
            reread(root, &file.path, file.confirmation, Some(file))
        })
        .collect();
    let added_outcomes: Vec<Result<Outcome, String>> = added
        .par_iter()
        .map(|(path, confirmation)| reread(root, path, *confirmation, None))
        .collect();
    let mut replaced: HashMap<usize, FileEntry> = HashMap::new();
    for (at, outcome) in existing.into_iter().zip(existing_outcomes) {
        match outcome? {
            Outcome::Same(entry) => {
                replaced.insert(at, entry);
            }
            Outcome::Gone => {
                removed_files.insert(at);
            }
            Outcome::New(entry, file) => {
                let previous = &old.files[at];
                detected.files_changed = true;
                detected.record(previous.confirmation, previous.id.clone());
                detected.record(entry.confirmation, entry.id.clone());
                if let Some(file) = file {
                    detected.parsed.insert(entry.path.clone(), *file);
                }
                replaced.insert(at, entry);
            }
        }
    }
    let mut fresh_files = Vec::new();
    for outcome in added_outcomes {
        detected.files_changed = true;
        match outcome? {
            Outcome::Gone => {}
            Outcome::Same(entry) => fresh_files.push(entry),
            Outcome::New(entry, file) => {
                detected.record(entry.confirmation, entry.id.clone());
                if let Some(file) = file {
                    detected.parsed.insert(entry.path.clone(), *file);
                }
                fresh_files.push(entry);
            }
        }
    }
    for at in &removed_files {
        let previous = &old.files[*at];
        detected.files_changed = true;
        detected.record(previous.confirmation, previous.id.clone());
    }
    let stale: HashSet<usize> = relisted.iter().copied().collect();
    let Snapshot {
        files: old_files,
        dirs: old_dirs,
        ..
    } = old;
    let mut files: Vec<FileEntry> = old_files
        .into_iter()
        .enumerate()
        .filter(|(at, _)| !removed_files.contains(at))
        .map(|(at, file)| replaced.remove(&at).unwrap_or(file))
        .collect();
    let mut dirs: Vec<(bool, DirEntry)> = old_dirs
        .into_iter()
        .enumerate()
        .filter(|(at, _)| !removed_dirs.contains(at))
        .map(|(at, dir)| (stale.contains(&at) || dir.stat.is_none(), dir))
        .chain(added_dirs.into_iter().map(|dir| (true, dir)))
        .collect();
    dirs.par_iter_mut().for_each(|(refresh, dir)| {
        if *refresh {
            dir.stat = stat(&root.join(&dir.path));
        }
    });
    let mut dirs: Vec<DirEntry> = dirs.into_iter().map(|(_, dir)| dir).collect();
    if !fresh_files.is_empty() {
        files.append(&mut fresh_files);
        files.par_sort_unstable_by(|a, b| a.path.cmp(&b.path));
    }
    dirs.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    detected.snapshot = Snapshot {
        taken_ns: dirty.taken_ns,
        files,
        dirs,
    };
    Ok(detected)
}
