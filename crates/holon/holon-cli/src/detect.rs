use crate::snapshot::{
    changed_dirs, changed_files, clock_ns, read, stat, stat_file, DirEntry, FileEntry, Snapshot,
};
use holon_core::model::{decode_text, read_confirmation_file, read_holon_file, HolonFile};
use holon_core::scan::{list_confirmation_dir, list_holon_dir, walk_confirmations, walk_holons};
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
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

#[derive(Default)]
struct Children {
    files: Vec<String>,
    dirs: Vec<String>,
}

struct Work {
    files: HashMap<String, FileEntry>,
    dirs: HashMap<String, DirEntry>,
    removed: Vec<FileEntry>,
    added: Vec<(String, bool)>,
}

impl Work {
    fn remove_subtree(&mut self, dir: &str, index: &HashMap<String, Children>) {
        self.dirs.remove(dir);
        let Some(children) = index.get(dir) else {
            return;
        };
        for file in &children.files {
            if let Some(entry) = self.files.remove(file) {
                self.removed.push(entry);
            }
        }
        for sub in &children.dirs {
            self.remove_subtree(sub, index);
        }
    }

    fn add_dir(&mut self, path: String, confirmation: bool) {
        self.dirs.insert(
            path.clone(),
            DirEntry {
                path,
                confirmation,
                stat: None,
            },
        );
    }
}

fn relist(root: &Path, work: &mut Work, dir: &DirEntry, index: &HashMap<String, Children>) {
    let listing = if dir.confirmation {
        list_confirmation_dir(root, &dir.path)
    } else {
        list_holon_dir(root, &dir.path)
    };
    let listed_files: HashSet<&String> = listing.files.iter().collect();
    let listed_dirs: HashSet<&String> = listing.dirs.iter().collect();
    if let Some(children) = index.get(&dir.path) {
        for file in &children.files {
            if !listed_files.contains(file) {
                if let Some(entry) = work.files.remove(file) {
                    work.removed.push(entry);
                }
            }
        }
        for sub in &children.dirs {
            if !listed_dirs.contains(sub) {
                work.remove_subtree(sub, index);
            }
        }
    }
    for file in listing.files {
        if !work.files.contains_key(&file) {
            work.added.push((file, dir.confirmation));
        }
    }
    for sub in listing.dirs {
        if work.dirs.contains_key(&sub) {
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
            work.add_dir(path, dir.confirmation);
        }
        work.added
            .extend(files.into_iter().map(|file| (file, dir.confirmation)));
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

pub fn detect(root: &Path, old: Snapshot) -> Result<Detected, String> {
    let taken_ns = clock_ns();
    let dirty_dirs = changed_dirs(root, &old);
    let dirty_files = changed_files(root, &old);
    let mut detected = Detected {
        snapshot: Snapshot::default(),
        changed: !dirty_dirs.is_empty() || !dirty_files.is_empty(),
        files_changed: false,
        holon_ids: HashSet::new(),
        confirmation_ids: HashSet::new(),
        parsed: HashMap::new(),
    };
    if !detected.changed {
        detected.snapshot = old;
        return Ok(detected);
    }
    let mut index: HashMap<String, Children> = HashMap::new();
    if !dirty_dirs.is_empty() {
        for file in &old.files {
            index
                .entry(parent(&file.path).to_string())
                .or_default()
                .files
                .push(file.path.clone());
        }
        for dir in old.dirs.iter().filter(|dir| !dir.path.is_empty()) {
            index
                .entry(parent(&dir.path).to_string())
                .or_default()
                .dirs
                .push(dir.path.clone());
        }
    }
    let mut relisted: Vec<DirEntry> = dirty_dirs.iter().map(|at| old.dirs[*at].clone()).collect();
    relisted.sort_by_key(|dir| dir.path.matches('/').count() + usize::from(!dir.path.is_empty()));
    let dirty_paths: Vec<(String, bool)> = dirty_files
        .iter()
        .map(|at| (old.files[*at].path.clone(), old.files[*at].confirmation))
        .collect();
    let mut work = Work {
        files: old
            .files
            .into_iter()
            .map(|file| (file.path.clone(), file))
            .collect(),
        dirs: old
            .dirs
            .into_iter()
            .map(|dir| (dir.path.clone(), dir))
            .collect(),
        removed: Vec::new(),
        added: Vec::new(),
    };
    for dir in &relisted {
        if work.dirs.contains_key(&dir.path) {
            relist(root, &mut work, dir, &index);
        }
    }
    let mut targets: Vec<(String, bool)> = dirty_paths
        .into_iter()
        .filter(|(path, _)| work.files.contains_key(path))
        .collect();
    targets.append(&mut work.added);
    let outcomes: Vec<Result<Outcome, String>> = targets
        .par_iter()
        .map(|(path, confirmation)| reread(root, path, *confirmation, work.files.get(path)))
        .collect();
    for ((path, confirmation), outcome) in targets.into_iter().zip(outcomes) {
        let previous = match outcome? {
            Outcome::Gone => work.files.remove(&path),
            Outcome::Same(entry) => {
                work.files.insert(path, entry);
                continue;
            }
            Outcome::New(entry, file) => {
                let ids = if confirmation {
                    &mut detected.confirmation_ids
                } else {
                    &mut detected.holon_ids
                };
                ids.extend(entry.id.clone());
                if let Some(file) = file {
                    detected.parsed.insert(path.clone(), *file);
                }
                work.files.insert(path, entry)
            }
        };
        detected.files_changed = true;
        if let Some(previous) = previous {
            let ids = if previous.confirmation {
                &mut detected.confirmation_ids
            } else {
                &mut detected.holon_ids
            };
            ids.extend(previous.id);
        }
    }
    for removed in work.removed {
        detected.files_changed = true;
        let ids = if removed.confirmation {
            &mut detected.confirmation_ids
        } else {
            &mut detected.holon_ids
        };
        ids.extend(removed.id);
    }
    let mut dirs: Vec<DirEntry> = work.dirs.into_values().collect();
    let stale: HashSet<&str> = relisted.iter().map(|dir| dir.path.as_str()).collect();
    let stats: Vec<_> = dirs
        .par_iter()
        .map(|dir| {
            (dir.stat.is_none() || stale.contains(dir.path.as_str()))
                .then(|| stat(&root.join(&dir.path)))
        })
        .collect();
    for (dir, fresh) in dirs.iter_mut().zip(stats) {
        if let Some(fresh) = fresh {
            dir.stat = fresh;
        }
    }
    dirs.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let mut files: Vec<FileEntry> = work.files.into_values().collect();
    files.par_sort_unstable_by(|a, b| a.path.cmp(&b.path));
    detected.snapshot = Snapshot {
        taken_ns,
        files,
        dirs,
    };
    Ok(detected)
}
