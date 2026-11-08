use crate::order::js_cmp;
use rayon::prelude::*;
use std::fs;
use std::path::Path;

const SKIPPED: [&str; 3] = ["node_modules", ".git", ".holons"];
pub const CONFIRMATIONS: &str = ".holons/confirmations";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ScanResult {
    pub holon_files: Vec<String>,
    pub confirmation_files: Vec<String>,
}

struct Entry {
    name: String,
    is_dir: bool,
    is_file_or_link: bool,
}

fn entries(dir: &Path) -> Vec<Entry> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(Result::ok)
        .filter_map(|entry| {
            let kind = entry.file_type().ok()?;
            Some(Entry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_dir: kind.is_dir(),
                is_file_or_link: kind.is_file() || kind.is_symlink(),
            })
        })
        .collect()
}

fn is_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|info| info.is_file())
}

fn child(relative: &str, name: &str) -> String {
    if relative.is_empty() {
        name.to_string()
    } else {
        format!("{relative}/{name}")
    }
}

fn walk_holons(root: &Path, relative: &str) -> Vec<String> {
    let dir = if relative.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    let list = entries(&dir);
    if !relative.is_empty()
        && list
            .iter()
            .any(|entry| entry.name == ".holons" && entry.is_dir)
    {
        return Vec::new();
    }
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for entry in list {
        let path = child(relative, &entry.name);
        if entry.is_dir {
            if !SKIPPED.contains(&entry.name.as_str()) {
                dirs.push(path);
            }
        } else if entry.name.ends_with(".holon")
            && entry.is_file_or_link
            && is_file(&root.join(&path))
        {
            files.push(path);
        }
    }
    let nested: Vec<Vec<String>> = dirs
        .par_iter()
        .map(|path| walk_holons(root, path))
        .collect();
    for list in nested {
        files.extend(list);
    }
    files
}

fn walk_confirmations(root: &Path, relative: &str, out: &mut Vec<String>) {
    for entry in entries(&root.join(relative)) {
        let path = format!("{relative}/{}", entry.name);
        if entry.is_dir {
            walk_confirmations(root, &path, out);
        } else if entry.name.ends_with(".json") && is_file(&root.join(&path)) {
            out.push(path);
        }
    }
}

pub fn scan_root(root: &Path) -> ScanResult {
    let mut holon_files = walk_holons(root, "");
    let mut confirmation_files = Vec::new();
    walk_confirmations(root, CONFIRMATIONS, &mut confirmation_files);
    holon_files.par_sort_unstable_by(|a, b| js_cmp(a, b));
    confirmation_files.sort_unstable_by(|a, b| js_cmp(a, b));
    ScanResult {
        holon_files,
        confirmation_files,
    }
}
