// Linux /proc reader: finds the pi processes SANDY runs for its sessions and measures them.
// Pure over a proc root so tests can feed a fake tree.
import { readFileSync, readdirSync } from "node:fs";

const CLK_TCK = 100;
const PAGE = 4096;
const BRIDGE = "sandy-provider-bridge-worker";

type Stat = { pid: number; comm: string; ppid: number; ticks: number; startTicks: number; rssPages: number };

/** Parses /proc/<pid>/stat; the command name sits in parentheses and may itself contain spaces or ')'. */
export function parseStat(text: string): Stat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(" ");
  const num = (index: number) => Number(rest[index]);
  const stat = {
    pid: Number(text.slice(0, open).trim()),
    comm: text.slice(open + 1, close),
    ppid: num(1),
    ticks: num(11) + num(12),
    startTicks: num(19),
    rssPages: num(21),
  };
  return Object.values(stat).some((value) => typeof value === "number" && Number.isNaN(value)) ? null : stat;
}

const read = (file: string): string | null => {
  try {
    return readFileSync(file, "latin1");
  } catch {
    return null;
  }
};

export function readStats(root: string): Map<number, Stat> {
  const stats = new Map<number, Stat>();
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    const text = read(`${root}/${name}/stat`);
    const stat = text === null ? null : parseStat(text);
    if (stat) stats.set(stat.pid, stat);
  }
  return stats;
}

function envOf(root: string, pid: number, key: string): string | null {
  const text = read(`${root}/${pid}/environ`);
  if (text === null) return null;
  const prefix = `${key}=`;
  const entry = text.split("\0").find((item) => item.startsWith(prefix));
  return entry === undefined ? null : entry.slice(prefix.length);
}

function descendants(stats: Map<number, Stat>, root: number): number[] {
  const byParent = new Map<number, number[]>();
  for (const stat of stats.values()) byParent.set(stat.ppid, [...(byParent.get(stat.ppid) ?? []), stat.pid]);
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

export type Measured = {
  threadId: string;
  pid: number;
  startedAt: number;
  rssBytes: number;
  cpuPercent: number;
  children: number;
};

/** pi processes that SANDY's provider bridge started; sub-processes (subagents, bash) count towards their pi. */
export function findPi(root: string, stats: Map<number, Stat>): Array<{ pid: number; threadId: string }> {
  const found: Array<{ pid: number; threadId: string }> = [];
  for (const stat of stats.values()) {
    if (stat.comm !== "pi") continue;
    if (!(read(`${root}/${stat.ppid}/cmdline`) ?? "").includes(BRIDGE)) continue;
    const threadId = envOf(root, stat.pid, "SANDY_THREAD_ID");
    if (threadId) found.push({ pid: stat.pid, threadId });
  }
  return found;
}

const treeStats = (stats: Map<number, Stat>, pid: number) =>
  [pid, ...descendants(stats, pid)].map((id) => stats.get(id)).filter((stat): stat is Stat => stat !== undefined);

export async function measure(root = "/proc", sampleMs = 400, now = Date.now()): Promise<Measured[]> {
  const first = readStats(root);
  const pis = findPi(root, first);
  if (pis.length === 0) return [];
  const bootMs = now - Number(/^\S+/.exec(read(`${root}/uptime`) ?? "0")![0]) * 1000;
  const t0 = performance.now();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const second = readStats(root);
  const seconds = (performance.now() - t0) / 1000;
  return pis.flatMap(({ pid, threadId }) => {
    const before = treeStats(first, pid);
    const after = treeStats(second, pid);
    const main = second.get(pid);
    if (!main) return [];
    const ticksBefore = new Map(before.map((stat) => [stat.pid, stat.ticks]));
    const delta = after.reduce((sum, stat) => sum + Math.max(0, stat.ticks - (ticksBefore.get(stat.pid) ?? stat.ticks)), 0);
    return [{
      threadId,
      pid,
      startedAt: Math.round(bootMs + (main.startTicks / CLK_TCK) * 1000),
      rssBytes: after.reduce((sum, stat) => sum + stat.rssPages * PAGE, 0),
      cpuPercent: Math.round((delta / CLK_TCK / seconds) * 1000) / 10,
      children: after.length - 1,
    }];
  });
}
