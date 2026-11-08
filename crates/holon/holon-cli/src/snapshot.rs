use holon_core::model::read_bytes;
use rayon::prelude::*;
use sha1::{Digest, Sha1};
use std::fs::Metadata;
use std::path::{Path, PathBuf};
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

fn join_into<'b>(buffer: &'b mut PathBuf, root: &Path, relative: &str) -> &'b Path {
    buffer.clear();
    buffer.push(root);
    if !relative.is_empty() {
        buffer.push(relative);
    }
    buffer
}

fn put_u32(out: &mut Vec<u8>, value: usize) {
    let value = u32::try_from(value).expect("snapshot entry fits u32");
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_str(out: &mut Vec<u8>, value: &str) {
    put_u32(out, value.len());
    out.extend_from_slice(value.as_bytes());
}

fn put_stat(out: &mut Vec<u8>, stat: Option<Stat>) {
    match stat {
        None => out.push(0),
        Some(stat) => {
            out.push(1);
            out.extend_from_slice(&stat.size.to_le_bytes());
            out.extend_from_slice(&stat.mtime_ns.to_le_bytes());
            out.extend_from_slice(&stat.ino.to_le_bytes());
        }
    }
}

const MAGIC: &[u8; 8] = b"holsnap2";

pub struct Encoded {
    pub stats: Vec<u8>,
    pub details: Vec<u8>,
}

pub fn encode(snapshot: &Snapshot) -> Encoded {
    let mut stats = Vec::with_capacity(32 + snapshot.files.len() * 56);
    let mut details = Vec::with_capacity(snapshot.files.len() * 40);
    stats.extend_from_slice(MAGIC);
    stats.extend_from_slice(&snapshot.taken_ns.to_le_bytes());
    put_u32(&mut stats, snapshot.files.len());
    put_u32(&mut stats, snapshot.dirs.len());
    for file in &snapshot.files {
        put_str(&mut stats, &file.path);
        put_stat(&mut stats, file.stat);
        details.push(u8::from(file.confirmation));
        details.extend_from_slice(&file.hash);
        match &file.id {
            None => details.push(0),
            Some(id) => {
                details.push(1);
                put_str(&mut details, id);
            }
        }
    }
    for dir in &snapshot.dirs {
        put_str(&mut stats, &dir.path);
        put_stat(&mut stats, dir.stat);
        details.push(u8::from(dir.confirmation));
    }
    Encoded { stats, details }
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

    fn u32(&mut self) -> Option<usize> {
        usize::try_from(u32::from_le_bytes(self.take(4)?.try_into().ok()?)).ok()
    }

    fn i64(&mut self) -> Option<i64> {
        Some(i64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    fn text(&mut self) -> Option<&'b str> {
        let length = self.u32()?;
        std::str::from_utf8(self.take(length)?).ok()
    }

    fn stat(&mut self) -> Option<Option<Stat>> {
        match self.byte()? {
            0 => Some(None),
            1 => Some(Some(Stat {
                size: self.u64()?,
                mtime_ns: self.i64()?,
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

    fn done(&self) -> bool {
        self.at == self.bytes.len()
    }
}

struct Stats<'b> {
    taken_ns: i64,
    files: Vec<(&'b str, Option<Stat>)>,
    dirs: Vec<(&'b str, Option<Stat>)>,
}

fn sorted(entries: &[(&str, Option<Stat>)]) -> bool {
    entries.windows(2).all(|pair| pair[0].0 < pair[1].0)
}

fn read_stats(bytes: &[u8]) -> Option<Stats<'_>> {
    let mut reader = Reader { bytes, at: 0 };
    if reader.take(MAGIC.len())? != MAGIC {
        return None;
    }
    let taken_ns = reader.i64()?;
    let file_count = reader.u32()?;
    let dir_count = reader.u32()?;
    let mut entry = || Some((reader.text()?, reader.stat()?));
    let files = (0..file_count)
        .map(|_| entry())
        .collect::<Option<Vec<_>>>()?;
    let dirs = (0..dir_count)
        .map(|_| entry())
        .collect::<Option<Vec<_>>>()?;
    (reader.done() && sorted(&files) && sorted(&dirs)).then_some(Stats {
        taken_ns,
        files,
        dirs,
    })
}

pub struct Dirty {
    pub taken_ns: i64,
    pub files: Vec<usize>,
    pub dirs: Vec<usize>,
}

impl Dirty {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.dirs.is_empty()
    }
}

fn dirty_entries(
    root: &Path,
    entries: &[(&str, Option<Stat>)],
    file: bool,
    taken_ns: i64,
) -> Vec<usize> {
    entries
        .par_iter()
        .enumerate()
        .map_init(PathBuf::new, |buffer, (index, (path, before))| {
            let path = join_into(buffer, root, path);
            let now = if file { stat_file(path) } else { stat(path) };
            (*before != now || is_racy(*before, taken_ns)).then_some(index)
        })
        .flatten()
        .collect()
}

pub fn dirty(root: &Path, stats: &[u8]) -> Option<Dirty> {
    let taken_ns = clock_ns();
    let stats = read_stats(stats)?;
    Some(Dirty {
        taken_ns,
        files: dirty_entries(root, &stats.files, true, stats.taken_ns),
        dirs: dirty_entries(root, &stats.dirs, false, stats.taken_ns),
    })
}

pub fn decode(stats: &[u8], details: &[u8]) -> Option<Snapshot> {
    let stats = read_stats(stats)?;
    let mut reader = Reader {
        bytes: details,
        at: 0,
    };
    let files = stats
        .files
        .iter()
        .map(|(path, stat)| {
            let confirmation = reader.flag()?;
            let hash: [u8; 20] = reader.take(20)?.try_into().ok()?;
            let id = if reader.flag()? {
                Some(reader.text()?.to_string())
            } else {
                None
            };
            Some(FileEntry {
                path: (*path).to_string(),
                confirmation,
                stat: *stat,
                hash,
                id,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let dirs = stats
        .dirs
        .iter()
        .map(|(path, stat)| {
            Some(DirEntry {
                path: (*path).to_string(),
                confirmation: reader.flag()?,
                stat: *stat,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    reader.done().then_some(Snapshot {
        taken_ns: stats.taken_ns,
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
                    path: ".holons/confirmations/b/x.json".to_string(),
                    confirmation: true,
                    stat: None,
                    hash: [0; 20],
                    id: None,
                },
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
            ],
            dirs: vec![DirEntry {
                path: String::new(),
                confirmation: false,
                stat: None,
            }],
        };
        let snapshot_clone = snapshot.clone();
        let encoded = encode(&snapshot);
        assert_eq!(decode(&encoded.stats, &encoded.details), Some(snapshot));
        let details = &encoded.details[..encoded.details.len() - 1];
        assert_eq!(decode(&encoded.stats, details), None);
        let mut swapped = snapshot_clone.clone();
        swapped.files.swap(0, 1);
        let unsorted = encode(&swapped);
        assert_eq!(decode(&unsorted.stats, &unsorted.details), None);
        let stats = &encoded.stats[..encoded.stats.len() - 1];
        assert_eq!(decode(stats, &encoded.details), None);
        assert!(dirty(Path::new("."), stats).is_none());
    }
}
