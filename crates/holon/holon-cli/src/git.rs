use holon_core::order::js_trim;
use holon_core::CodeChanges;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|text| js_trim(&text).to_string())
        .filter(|text| !text.is_empty())
}

pub fn head(cwd: &Path) -> Option<String> {
    trimmed(git(cwd, &["rev-parse", "HEAD"]))
}

pub fn top_level(cwd: &Path) -> Option<String> {
    trimmed(git(cwd, &["rev-parse", "--show-toplevel"]))
}

type Changes = Option<Arc<Vec<String>>>;

pub struct GitCodeChanges {
    root: PathBuf,
    cache: Mutex<HashMap<String, Changes>>,
}

impl GitCodeChanges {
    pub fn new(root: &Path) -> GitCodeChanges {
        GitCodeChanges {
            root: root.to_path_buf(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn compute(&self, build: &str, commit: &str) -> Changes {
        let known = |sha: &str| {
            git(
                &self.root,
                &["cat-file", "-e", &format!("{sha}^{{commit}}")],
            )
            .is_some()
        };
        if !known(build) || !known(commit) {
            return None;
        }
        let output = git(
            &self.root,
            &[
                "diff",
                "--name-only",
                "-z",
                "--relative",
                "--no-renames",
                build,
                commit,
            ],
        )?;
        Some(Arc::new(
            output
                .split('\0')
                .filter(|path| !path.is_empty())
                .map(str::to_string)
                .collect(),
        ))
    }
}

impl CodeChanges for GitCodeChanges {
    fn changed_paths(&self, build: &str, commit: &str) -> Changes {
        let key = format!("{build}..{commit}");
        if let Some(cached) = self.cache.lock().expect("git cache").get(&key) {
            return cached.clone();
        }
        let result = self.compute(build, commit);
        self.cache
            .lock()
            .expect("git cache")
            .insert(key, result.clone());
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    fn run(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
            .args(args)
            .output()
            .expect("git runs");
        assert!(output.status.success(), "git {args:?}");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn keeps_changed_paths_when_an_unrelated_name_is_no_utf8() {
        let dir = std::env::temp_dir().join(format!("holon-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).expect("temp dir");
        std::fs::write(dir.join("src/code.ts"), "original").expect("write");
        run(&dir, &["init", "-q"]);
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-q", "-m", "original"]);
        let build = run(&dir, &["rev-parse", "HEAD"]);
        let invalid = OsStr::from_bytes(b"unrelated-\xff.txt");
        std::fs::write(dir.join(invalid), "test").expect("write");
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-q", "-m", "invalid name"]);
        let commit = run(&dir, &["rev-parse", "HEAD"]);
        let changes = GitCodeChanges::new(&dir).changed_paths(&build, &commit);
        std::fs::remove_dir_all(&dir).expect("cleanup");
        assert_eq!(
            changes.as_deref(),
            Some(&vec!["unrelated-\u{fffd}.txt".to_string()])
        );
    }
}
