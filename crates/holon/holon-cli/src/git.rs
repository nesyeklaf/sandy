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

fn git_dir(cwd: &Path) -> Option<PathBuf> {
    if std::env::var_os("GIT_DIR").is_some() || std::env::var_os("GIT_WORK_TREE").is_some() {
        return None;
    }
    let mut dir = Some(cwd);
    while let Some(current) = dir {
        let dot = current.join(".git");
        if dot.is_dir() {
            return Some(dot);
        }
        if dot.is_file() {
            let text = std::fs::read_to_string(&dot).ok()?;
            let target = text.strip_prefix("gitdir:")?.trim();
            return Some(current.join(target));
        }
        dir = current.parent();
    }
    None
}

fn is_object_name(text: &str) -> bool {
    matches!(text.len(), 40 | 64)
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn read_ref(git_dir: &Path, common: &Path, name: &str) -> Option<String> {
    if !name.starts_with("refs/") || name.split('/').any(|part| part.is_empty() || part == "..") {
        return None;
    }
    for base in [git_dir, common] {
        if let Ok(text) = std::fs::read_to_string(base.join(name)) {
            let value = text.trim_end_matches(['\n', '\r']);
            return is_object_name(value).then(|| value.to_string());
        }
    }
    let packed = std::fs::read_to_string(common.join("packed-refs")).ok()?;
    packed
        .lines()
        .filter(|line| !line.starts_with('#') && !line.starts_with('^'))
        .find_map(|line| {
            let (sha, reference) = line.split_once(' ')?;
            (reference == name && is_object_name(sha)).then(|| sha.to_string())
        })
}

fn read_head(cwd: &Path) -> Option<String> {
    let git_dir = git_dir(cwd)?;
    let common = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(text) => git_dir.join(text.trim_end_matches(['\n', '\r'])),
        Err(_) => git_dir.clone(),
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim_end_matches(['\n', '\r']);
    match head.strip_prefix("ref: ") {
        Some(name) => read_ref(&git_dir, &common, name),
        None => is_object_name(head).then(|| head.to_string()),
    }
}

pub fn head(cwd: &Path) -> Option<String> {
    read_head(cwd).or_else(|| trimmed(git(cwd, &["rev-parse", "HEAD"])))
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
    use std::io::Write;

    fn run_with(dir: &Path, args: &[&str], input: &[u8]) -> String {
        let mut child = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("git runs");
        child
            .stdin
            .take()
            .expect("stdin")
            .write_all(input)
            .expect("write stdin");
        let output = child.wait_with_output().expect("git finishes");
        assert!(output.status.success(), "git {args:?}");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn run(dir: &Path, args: &[&str]) -> String {
        run_with(dir, args, b"")
    }

    fn temp_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("holon-git-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).expect("temp dir");
        std::fs::write(dir.join("src/code.ts"), "original").expect("write");
        run(&dir, &["init", "-q"]);
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-q", "-m", "original"]);
        dir
    }

    #[test]
    fn keeps_changed_paths_when_an_unrelated_name_is_no_utf8() {
        let dir = temp_repo("utf8");
        let build = run(&dir, &["rev-parse", "HEAD"]);
        let blob = run_with(&dir, &["hash-object", "-w", "--stdin"], b"test");
        let mut entry = format!("100644 blob {blob}\t").into_bytes();
        entry.extend_from_slice(b"unrelated-\xff.txt\n");
        run_with(&dir, &["update-index", "--index-info"], &entry);
        run(&dir, &["commit", "-q", "-m", "invalid name"]);
        let commit = run(&dir, &["rev-parse", "HEAD"]);
        let changes = GitCodeChanges::new(&dir).changed_paths(&build, &commit);
        std::fs::remove_dir_all(&dir).expect("cleanup");
        assert_eq!(
            changes.as_deref(),
            Some(&vec!["unrelated-\u{fffd}.txt".to_string()])
        );
    }

    #[test]
    fn reads_head_like_rev_parse() {
        let dir = temp_repo("head");
        let nested = dir.join("src");
        let first = run(&dir, &["rev-parse", "HEAD"]);
        assert_eq!(read_head(&nested), Some(first.clone()));
        std::fs::write(dir.join("src/code.ts"), "changed").expect("write");
        run(&dir, &["commit", "-q", "-am", "second"]);
        run(&dir, &["pack-refs", "--all"]);
        let second = run(&dir, &["rev-parse", "HEAD"]);
        assert_ne!(first, second);
        assert_eq!(read_head(&dir), Some(second.clone()));
        run(&dir, &["checkout", "-q", "--detach", &first]);
        assert_eq!(read_head(&dir), Some(first.clone()));
        let tree = dir.with_extension("worktree");
        let _ = std::fs::remove_dir_all(&tree);
        let tree_arg = tree.to_string_lossy().into_owned();
        run(
            &dir,
            &["worktree", "add", "-q", "-b", "side", &tree_arg, &second],
        );
        assert_eq!(read_head(&tree), Some(second.clone()));
        assert_eq!(head(&tree), Some(second));
        run(&dir, &["worktree", "remove", "--force", &tree_arg]);
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
