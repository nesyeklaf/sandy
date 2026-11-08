use holon_core::model::read_bytes;
use rayon::prelude::*;
use sha1::{Digest, Sha1};
use std::fs::Metadata;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const RACY_NS: i64 = 2_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stat {
    pub size: u64,
    pub mtime_ns: i64,
    pub ino: u64,
}

#[cfg(unix)]
fn inode(meta: &Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(meta)
}

#[cfg(not(unix))]
fn inode(_meta: &Metadata) -> u64 {
    0
}

fn nanos(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |elapsed| {
        i64::try_from(elapsed.as_nanos()).unwrap_or(i64::MAX)
    })
}

pub fn clock_ns() -> i64 {
    nanos(SystemTime::now())
}

pub fn stat(path: &Path) -> Option<Stat> {
    std::fs::metadata(path).ok().map(|meta| from_meta(&meta))
}

pub fn stat_file(path: &Path) -> Option<Stat> {
    std::fs::metadata(path)
        .ok()
        .filter(Metadata::is_file)
        .map(|meta| from_meta(&meta))
}

fn from_meta(meta: &Metadata) -> Stat {
    Stat {
        size: meta.len(),
        mtime_ns: meta.modified().map_or(0, nanos),
        ino: inode(meta),
    }
}

pub fn blob_hash(bytes: &[u8]) -> [u8; 20] {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    hasher.finalize().into()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub confirmation: bool,
    pub stat: Option<Stat>,
    pub hash: [u8; 20],
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub path: String,
    pub confirmation: bool,
    pub stat: Option<Stat>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub taken_ns: i64,
    pub files: Vec<FileEntry>,
    pub dirs: Vec<DirEntry>,
}

pub fn is_racy(stat: Option<Stat>, taken_ns: i64) -> bool {
    stat.is_some_and(|stat| stat.mtime_ns >= taken_ns.saturating_sub(RACY_NS))
}

pub struct Read {
    pub stat: Option<Stat>,
    pub hash: [u8; 20],
    pub bytes: Vec<u8>,
}

pub fn read(root: &Path, path: &str) -> Result<Read, String> {
    let absolute = root.join(path);
    let stat = stat_file(&absolute);
    let bytes = read_bytes(&absolute)?;
    Ok(Read {
        stat,
        hash: blob_hash(&bytes),
        bytes,
    })
}

pub fn changed_files(root: &Path, snapshot: &Snapshot) -> Vec<usize> {
    snapshot
        .files
        .par_iter()
        .enumerate()
        .filter(|(_, file)| {
            file.stat != stat_file(&root.join(&file.path)) || is_racy(file.stat, snapshot.taken_ns)
        })
        .map(|(index, _)| index)
        .collect()
}

pub fn changed_dirs(root: &Path, snapshot: &Snapshot) -> Vec<usize> {
    snapshot
        .dirs
        .par_iter()
        .enumerate()
        .filter(|(_, dir)| {
            dir.stat != stat(&root.join(&dir.path)) || is_racy(dir.stat, snapshot.taken_ns)
        })
        .map(|(index, _)| index)
        .collect()
}

fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_str(out: &mut Vec<u8>, value: &str) {
    put_u64(out, value.len() as u64);
    out.extend_from_slice(value.as_bytes());
}

fn put_stat(out: &mut Vec<u8>, stat: Option<Stat>) {
    match stat {
        None => out.push(0),
        Some(stat) => {
            out.push(1);
            put_u64(out, stat.size);
            put_u64(out, stat.mtime_ns as u64);
            put_u64(out, stat.ino);
        }
    }
}

const MAGIC: &[u8; 8] = b"holsnap1";

pub fn encode(snapshot: &Snapshot) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + snapshot.files.len() * 96);
    out.extend_from_slice(MAGIC);
    put_u64(&mut out, snapshot.taken_ns as u64);
    put_u64(&mut out, snapshot.files.len() as u64);
    for file in &snapshot.files {
        out.push(u8::from(file.confirmation));
        put_str(&mut out, &file.path);
        put_stat(&mut out, file.stat);
        out.extend_from_slice(&file.hash);
        match &file.id {
            None => out.push(0),
            Some(id) => {
                out.push(1);
                put_str(&mut out, id);
            }
        }
    }
    put_u64(&mut out, snapshot.dirs.len() as u64);
    for dir in &snapshot.dirs {
        out.push(u8::from(dir.confirmation));
        put_str(&mut out, &dir.path);
        put_stat(&mut out, dir.stat);
    }
    out
}

struct Reader<'b> {
    bytes: &'b [u8],
    at: usize,
}

impl<'b> Reader<'b> {
    fn take(&mut self, count: usize) -> Option<&'b [u8]> {
        let end = self.at.checked_add(count)?;
        let slice = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(slice)
    }

    fn byte(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    fn string(&mut self) -> Option<String> {
        let length = usize::try_from(self.u64()?).ok()?;
        String::from_utf8(self.take(length)?.to_vec()).ok()
    }

    fn stat(&mut self) -> Option<Option<Stat>> {
        match self.byte()? {
            0 => Some(None),
            1 => Some(Some(Stat {
                size: self.u64()?,
                mtime_ns: self.u64()? as i64,
                ino: self.u64()?,
            })),
            _ => None,
        }
    }

    fn flag(&mut self) -> Option<bool> {
        match self.byte()? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }
}

pub fn decode(bytes: &[u8]) -> Option<Snapshot> {
    let mut reader = Reader { bytes, at: 0 };
    if reader.take(MAGIC.len())? != MAGIC {
        return None;
    }
    let taken_ns = reader.u64()? as i64;
    let count = usize::try_from(reader.u64()?).ok()?;
    let mut files = Vec::with_capacity(count.min(bytes.len()));
    for _ in 0..count {
        let confirmation = reader.flag()?;
        let path = reader.string()?;
        let stat = reader.stat()?;
        let hash: [u8; 20] = reader.take(20)?.try_into().ok()?;
        let id = if reader.flag()? {
            Some(reader.string()?)
        } else {
            None
        };
        files.push(FileEntry {
            path,
            confirmation,
            stat,
            hash,
            id,
        });
    }
    let count = usize::try_from(reader.u64()?).ok()?;
    let mut dirs = Vec::with_capacity(count.min(bytes.len()));
    for _ in 0..count {
        let confirmation = reader.flag()?;
        let path = reader.string()?;
        let stat = reader.stat()?;
        dirs.push(DirEntry {
            path,
            confirmation,
            stat,
        });
    }
    (reader.at == bytes.len()).then_some(Snapshot {
        taken_ns,
        files,
        dirs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_like_git_hash_object() {
        let hex: String = blob_hash(b"hello\n")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(hex, "ce013625030ba8dba906f756967f9e9ca394464a");
    }

    #[test]
    fn round_trips_a_snapshot_and_rejects_truncation() {
        let snapshot = Snapshot {
            taken_ns: 1_700_000_000_000_000_000,
            files: vec![
                FileEntry {
                    path: "a/b.holon".to_string(),
                    confirmation: false,
                    stat: Some(Stat {
                        size: 3,
                        mtime_ns: 42,
                        ino: 7,
                    }),
                    hash: [9; 20],
                    id: Some("b".to_string()),
                },
                FileEntry {
                    path: ".holons/confirmations/b/x.json".to_string(),
                    confirmation: true,
                    stat: None,
                    hash: [0; 20],
                    id: None,
                },
            ],
            dirs: vec![DirEntry {
                path: String::new(),
                confirmation: false,
                stat: None,
            }],
        };
        let bytes = encode(&snapshot);
        assert_eq!(decode(&bytes), Some(snapshot));
        assert_eq!(decode(&bytes[..bytes.len() - 1]), None);
    }
}
