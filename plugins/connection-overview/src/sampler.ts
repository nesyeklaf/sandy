import {
  TCP_LISTEN,
  descendants,
  parseProcNet,
  parseProcStat,
  socketInodeFromLink,
  type ProcNetEntry,
  type ProcStat,
} from "./proc-net.js";
import type { SampleGap, SampleReply, SocketRow } from "./contract.js";
import { PROVIDER_BRIDGE_PROCESS } from "./allowlist.js";

const PROVIDER_BRIDGE_ENTRY = "sandy-provider-bridge-worker.mjs";

export interface ProcFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
}

export const QUEUE_LIMIT = 10_000;
export const PAGE_SIZE = 1_000;
export const HEARTBEAT_MS = 30_000;
export const TICK_MS = 1_000;
export const STALL_GAP_MS = 2_500;
export const GAP_LIMIT = 1_000;

const NET_TABLES = [
  ["tcp", "tcp"],
  ["tcp6", "tcp"],
  ["udp", "udp"],
  ["udp6", "udp"],
] as const;

interface OpenSocket {
  lastEmittedAt: number;
}

export interface TickResult {
  treeSize: number;
  unreadablePids: number;
}

async function readTree(
  fs: ProcFs,
  rootPid: number,
  excluded: ReadonlySet<number>,
): Promise<ProcStat[]> {
  const names = await fs.readdir("/proc");
  const stats: ProcStat[] = [];
  await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          const stat = parseProcStat(await fs.readFile(`/proc/${name}/stat`));
          if (stat !== null) stats.push(stat);
        } catch {}
      }),
  );
  const tree = descendants(rootPid, stats, excluded);
  await Promise.all(
    tree.map(async (proc) => {
      if (!proc.comm.startsWith("node")) return;
      try {
        const cmdline = await fs.readFile(`/proc/${proc.pid}/cmdline`);
        if (cmdline.includes(PROVIDER_BRIDGE_ENTRY))
          proc.comm = PROVIDER_BRIDGE_PROCESS;
      } catch {}
    }),
  );
  return tree;
}

export function createSampler(options: {
  fs: ProcFs;
  rootPid: number;
  generation: string;
  now?: () => number;
  excludedRoots?: () => ReadonlySet<number>;
}) {
  const now = options.now ?? Date.now;
  const queue: SocketRow[] = [];
  const gaps: SampleGap[] = [];
  let nextGapId = 1;
  function addGap(gap: Omit<SampleGap, "id">) {
    gaps.push({ ...gap, id: nextGapId });
    nextGapId += 1;
    if (gaps.length > GAP_LIMIT) gaps.splice(0, gaps.length - GAP_LIMIT);
  }
  const open = new Map<string, OpenSocket>();
  let nextSeq = 1;
  let sampledAt: number | null = null;
  let lastTick: TickResult = { treeSize: 0, unreadablePids: 0 };

  function push(row: Omit<SocketRow, "seq">) {
    queue.push({ ...row, seq: nextSeq });
    nextSeq += 1;
    if (queue.length > QUEUE_LIMIT) {
      const dropped = queue.splice(0, queue.length - QUEUE_LIMIT);
      const start = dropped[0]!.sampledAt;
      const end = dropped[dropped.length - 1]!.sampledAt;
      const last = gaps[gaps.length - 1];
      if (
        last !== undefined &&
        last.reason === "queue-overflow" &&
        last.end >= start &&
        last.id === nextGapId - 1
      )
        last.end = Math.max(last.end, end);
      else addGap({ start, end, reason: "queue-overflow" });
    }
  }

  async function holdsNoSockets(fs: ProcFs, pid: number): Promise<boolean> {
    try {
      const text = await fs.readFile(`/proc/${pid}/stat`);
      return text.slice(text.lastIndexOf(")") + 2).startsWith("Z");
    } catch {
      return true;
    }
  }

  async function tick(): Promise<TickResult> {
    const startedAt = now();
    if (sampledAt !== null && startedAt - sampledAt > STALL_GAP_MS)
      addGap({ start: sampledAt, end: startedAt, reason: "sampler-stalled" });
    const tree = await readTree(
      options.fs,
      options.rootPid,
      options.excludedRoots?.() ?? new Set(),
    );
    const owners = new Map<number, ProcStat>();
    const netnsPids = new Map<string, number>();
    let unreadablePids = 0;
    await Promise.all(
      tree.map(async (proc) => {
        try {
          const netns = await options.fs.readlink(`/proc/${proc.pid}/ns/net`);
          if (!netnsPids.has(netns)) netnsPids.set(netns, proc.pid);
          const fds = await options.fs.readdir(`/proc/${proc.pid}/fd`);
          await Promise.all(
            fds.map(async (fd) => {
              try {
                const inode = socketInodeFromLink(
                  await options.fs.readlink(`/proc/${proc.pid}/fd/${fd}`),
                );
                if (inode !== null && !owners.has(inode))
                  owners.set(inode, proc);
              } catch {}
            }),
          );
        } catch {
          if (await holdsNoSockets(options.fs, proc.pid)) return;
          unreadablePids += 1;
        }
      }),
    );
    const entries: ProcNetEntry[] = [];
    for (const pid of netnsPids.values())
      for (const [file, proto] of NET_TABLES) {
        try {
          entries.push(
            ...parseProcNet(
              await options.fs.readFile(`/proc/${pid}/net/${file}`),
              proto,
            ),
          );
        } catch {}
      }
    const listening = new Set<number>();
    for (const entry of entries)
      if (
        entry.proto === "tcp" &&
        entry.state === TCP_LISTEN &&
        owners.has(entry.inode)
      )
        listening.add(entry.localPort);
    const tickAt = now();
    const seen = new Set<string>();
    for (const entry of entries) {
      const owner = owners.get(entry.inode);
      if (owner === undefined || entry.inode === 0) continue;
      if (entry.proto === "tcp" && entry.state === TCP_LISTEN) continue;
      if (entry.proto === "udp" && entry.remotePort === 0) continue;
      const key = `${owner.pid}:${owner.startTime}:${entry.inode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const known = open.get(key);
      if (known !== undefined && tickAt - known.lastEmittedAt < HEARTBEAT_MS)
        continue;
      open.set(key, { lastEmittedAt: tickAt });
      push({
        pid: owner.pid,
        startTime: owner.startTime,
        comm: owner.comm,
        inode: entry.inode,
        proto: entry.proto,
        localIp: entry.localIp,
        localPort: entry.localPort,
        remoteIp: entry.remoteIp,
        remotePort: entry.remotePort,
        tcpState: entry.state,
        localListening: listening.has(entry.localPort),
        continued: known !== undefined,
        sampledAt: tickAt,
      });
    }
    for (const key of open.keys()) if (!seen.has(key)) open.delete(key);
    sampledAt = tickAt;
    lastTick = { treeSize: tree.length, unreadablePids };
    return lastTick;
  }

  function read(input: {
    generation: string | null;
    cursor: number;
    gapCursor: number;
  }): SampleReply {
    if (input.generation === options.generation) {
      const acknowledged = queue.findIndex((row) => row.seq > input.cursor);
      queue.splice(0, acknowledged === -1 ? queue.length : acknowledged);
    }
    const oldest = queue[0]?.seq ?? nextSeq;
    const reset =
      input.generation !== options.generation || input.cursor < oldest - 1;
    const after = reset ? oldest - 1 : input.cursor;
    const rows = queue.filter((row) => row.seq > after).slice(0, PAGE_SIZE);
    const reply: SampleReply = {
      generation: options.generation,
      cursor: rows.length === 0 ? after : rows[rows.length - 1]!.seq,
      reset,
      more: queue.some(
        (row) => row.seq > (rows[rows.length - 1]?.seq ?? after),
      ),
      rows,
      gaps: gaps.filter((gap) => reset || gap.id > input.gapCursor),
      gapCursor: nextGapId - 1,
      sampledAt,
      hostNow: now(),
      treeSize: lastTick.treeSize,
      unreadablePids: lastTick.unreadablePids,
      rootPid: options.rootPid,
    };
    return reply;
  }

  return { tick, read };
}

export type Sampler = ReturnType<typeof createSampler>;
