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

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Listing {
    pub nested_project: bool,
    pub files: Vec<String>,
    pub dirs: Vec<String>,
}

pub fn list_holon_dir(root: &Path, relative: &str) -> Listing {
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
        return Listing {
            nested_project: true,
            ..Listing::default()
        };
    }
    let mut listing = Listing::default();
    for entry in list {
        let path = child(relative, &entry.name);
        if entry.is_dir {
            if !SKIPPED.contains(&entry.name.as_str()) {
                listing.dirs.push(path);
            }
        } else if entry.name.ends_with(".holon")
            && entry.is_file_or_link
            && is_file(&root.join(&path))
        {
            listing.files.push(path);
        }
    }
    listing
}

pub fn walk_holons(root: &Path, relative: &str, dirs: &mut Vec<String>) -> Vec<String> {
    dirs.push(relative.to_string());
    let listing = list_holon_dir(root, relative);
    let mut files = listing.files;
    let nested: Vec<(Vec<String>, Vec<String>)> = listing
        .dirs
        .par_iter()
        .map(|path| {
            let mut dirs = Vec::new();
            let files = walk_holons(root, path, &mut dirs);
            (files, dirs)
        })
        .collect();
    for (list, visited) in nested {
        files.extend(list);
        dirs.extend(visited);
    }
    files
}

pub fn list_confirmation_dir(root: &Path, relative: &str) -> Listing {
    let mut listing = Listing::default();
    for entry in entries(&root.join(relative)) {
        let path = format!("{relative}/{}", entry.name);
        if entry.is_dir {
            listing.dirs.push(path);
        } else if entry.name.ends_with(".json") && is_file(&root.join(&path)) {
            listing.files.push(path);
        }
    }
    listing
}

pub fn walk_confirmations(
    root: &Path,
    relative: &str,
    out: &mut Vec<String>,
    dirs: &mut Vec<String>,
) {
    dirs.push(relative.to_string());
    let listing = list_confirmation_dir(root, relative);
    out.extend(listing.files);
    for path in listing.dirs {
        walk_confirmations(root, &path, out, dirs);
    }
}

pub fn scan_confirmations(root: &Path, dirs: &mut Vec<String>) -> Vec<String> {
    let mut files = Vec::new();
    walk_confirmations(root, CONFIRMATIONS, &mut files, dirs);
    files.sort_unstable_by(|a, b| js_cmp(a, b));
    files
}

pub fn scan_root(root: &Path) -> ScanResult {
    let mut dirs = Vec::new();
    let mut holon_files = walk_holons(root, "", &mut dirs);
    holon_files.par_sort_unstable_by(|a, b| js_cmp(a, b));
    ScanResult {
        holon_files,
        confirmation_files: scan_confirmations(root, &mut dirs),
    }
}
