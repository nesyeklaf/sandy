// Finds and reads Claude Code's subagent transcripts on this machine. The only
// module that touches ~/.claude.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { completeLines, subagentCallsOf, type SubagentCall } from "./subagents.js";

function projectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rebuilds the index at most this often when a session is not in it. */
const REINDEX_MS = 60_000;

let index: Map<string, string> | null = null;
let indexedAt = 0;

/**
 * Every session on this machine that has a subagents directory, by session
 * id. Claude Code keeps one directory per working directory, and there can be
 * hundreds, so this lists them once rather than once per thread.
 */
async function buildIndex(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let projects: string[];
  try {
    projects = await readdir(projectsDir());
  } catch {
    return found;
  }
  for (const project of projects) {
    let entries: string[];
    try {
      entries = await readdir(join(projectsDir(), project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!SESSION_ID.test(entry)) continue;
      const dir = join(projectsDir(), project, entry, "subagents");
      try {
        if ((await stat(dir)).isDirectory()) found.set(entry.toLowerCase(), dir);
      } catch {
        // This session ran no subagents.
      }
    }
  }
  return found;
}

/** The session's subagents directory, or null when it has none on this machine. */
export async function subagentsDir(sessionId: string, now = Date.now()): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const key = sessionId.toLowerCase();
  if (index === null || (!index.has(key) && now - indexedAt > REINDEX_MS)) {
    index = await buildIndex();
    indexedAt = now;
  }
  return index.get(key) ?? null;
}

export interface TranscriptRead {
  path: string;
  agentId: string;
  description: string | null;
  calls: SubagentCall[];
  /** Where the next read starts. */
  offset: number;
}

/** Each transcript in `dir` that has grown past the offset last read from it. */
export async function readTranscripts(dir: string, offsets: Map<string, number>): Promise<TranscriptRead[]> {
  const reads: TranscriptRead[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const from = offsets.get(path) ?? 0;
    const { size } = await stat(path);
    if (size <= from) continue;
    const handle = await open(path, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(size - from);
      await handle.read(buffer, 0, buffer.length, from);
      text = completeLines(buffer.toString("utf8"));
    } finally {
      await handle.close();
    }
    if (text === "") continue;
    let description: string | null = null;
    try {
      const meta = JSON.parse(await readFile(path.replace(/\.jsonl$/, ".meta.json"), "utf8")) as { description?: string };
      description = meta.description ?? null;
    } catch {
      // No meta file for this subagent.
    }
    reads.push({
      path,
      agentId: basename(name, ".jsonl").replace(/^agent-/, ""),
      description,
      calls: subagentCallsOf(text),
      offset: from + Buffer.byteLength(text, "utf8"),
    });
  }
  return reads;
}
