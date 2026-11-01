import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_MS,
  QUEUE_LIMIT,
  STALL_GAP_MS,
  createSampler,
  type ProcFs,
} from "./sampler.js";

function stat(pid: number, ppid: number, comm: string, state = "S"): string {
  const rest = Array.from({ length: 50 }, () => "0");
  rest[0] = String(ppid);
  rest[18] = String(pid * 100);
  return `${pid} (${comm}) ${state} ${rest.join(" ")}`;
}

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

function tcpLine(
  local: string,
  remote: string,
  state: string,
  inode: number,
): string {
  return `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0 20 4 0 10 -1\n`;
}

function fakeFs(state: {
  tcp: string;
  fds: Record<number, number[]>;
  extra?: Record<number, string>;
  cmdlines?: Record<number, string>;
}): ProcFs {
  const procs: Record<number, string> = {
    1: stat(1, 0, "init"),
    10: stat(10, 1, "node"),
    11: stat(11, 10, "claude"),
    20: stat(20, 1, "other"),
    ...state.extra,
  };
  return {
    async readdir(path) {
      if (path === "/proc") return [...Object.keys(procs), "self", "net"];
      const pid = Number(/\/proc\/(\d+)\/fd/.exec(path)?.[1]);
      if (state.fds[pid] === undefined) throw new Error("EACCES");
      return state.fds[pid]!.map((_, index) => String(index));
    },
    async readFile(path) {
      const statPid = /\/proc\/(\d+)\/stat$/.exec(path)?.[1];
      if (statPid !== undefined) return procs[Number(statPid)]!;
      const cmdlinePid = /\/proc\/(\d+)\/cmdline$/.exec(path)?.[1];
      if (cmdlinePid !== undefined) {
        const cmdline = state.cmdlines?.[Number(cmdlinePid)];
        if (cmdline === undefined) throw new Error("ENOENT");
        return cmdline;
      }
      if (path.endsWith("/net/tcp")) return HEADER + state.tcp;
      return HEADER;
    },
    async readlink(path) {
      if (path.endsWith("/ns/net")) {
        const pid = Number(/\/proc\/(\d+)\//.exec(path)?.[1]);
        if (state.extra?.[pid]?.includes(" Z ")) throw new Error("ENOENT");
        return "net:[1]";
      }
      const match = /\/proc\/(\d+)\/fd\/(\d+)/.exec(path)!;
      return `socket:[${state.fds[Number(match[1])]![Number(match[2])]}]`;
    },
  };
}

const OUT = tcpLine("0100007F:C000", "06797A8C:01BB", "01", 501);

describe("createSampler", () => {
  it("attributes sockets to processes in the tree and skips others", async () => {
    let now = 1_000;
    const state = {
      tcp: OUT + tcpLine("0100007F:C001", "06797A8C:01BB", "01", 900),
      fds: { 10: [], 11: [501], 20: [900] },
    };
    const sampler = createSampler({
      fs: fakeFs(state),
      rootPid: 10,
      generation: "g1",
      now: () => now,
    });
    expect(await sampler.tick()).toEqual({ treeSize: 2, unreadablePids: 0 });
    const reply = sampler.read({ generation: null, cursor: 0, gapCursor: 0 });
    expect(reply.reset).toBe(true);
    expect(reply.rows).toHaveLength(1);
    expect(reply.rows[0]).toMatchObject({
      pid: 11,
      comm: "claude",
      remoteIp: "140.122.121.6",
      remotePort: 443,
      continued: false,
    });
  });

  it("names a provider bridge worker after its role, not its node thread", async () => {
    const state = {
      tcp: OUT + tcpLine("0100007F:C001", "06797A8C:01BB", "01", 502),
      fds: { 10: [], 11: [], 12: [501], 13: [502] },
      extra: {
        12: stat(12, 10, "node-MainThread"),
        13: stat(13, 10, "node-MainThread"),
      },
      cmdlines: {
        12: "/usr/bin/node\0--use-system-ca\0/opt/sandy-app/host-daemon/dist/sandy-provider-bridge-worker.mjs\0/plugins/provider-codex/host.js\0",
        13: "/usr/bin/node\0/opt/sandy-app/host-daemon/dist/daemon-bundle.mjs\0",
      },
    };
    const sampler = createSampler({
      fs: fakeFs(state),
      rootPid: 10,
      generation: "g1",
      now: () => 1_000,
    });
    await sampler.tick();
    const reply = sampler.read({ generation: null, cursor: 0, gapCursor: 0 });
    expect(reply.rows.map((row) => [row.pid, row.comm]).sort()).toEqual([
      [12, "sandy-provider-bridge"],
      [13, "node-MainThread"],
    ]);
  });

  it("emits an open socket once, then again as a continued heartbeat", async () => {
    let now = 1_000;
    const sampler = createSampler({
      fs: fakeFs({ tcp: OUT, fds: { 10: [], 11: [501] } }),
      rootPid: 10,
      generation: "g1",
      now: () => now,
    });
    await sampler.tick();
    now += 1_000;
    await sampler.tick();
    const first = sampler.read({ generation: null, cursor: 0, gapCursor: 0 });
    expect(first.rows).toHaveLength(1);
    now += HEARTBEAT_MS;
    await sampler.tick();
    const second = sampler.read({
      generation: "g1",
      cursor: first.cursor,
      gapCursor: first.gapCursor,
    });
    expect(second.reset).toBe(false);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.continued).toBe(true);
  });

  it("does not count zombie children as unreadable", async () => {
    const sampler = createSampler({
      fs: fakeFs({
        tcp: OUT,
        fds: { 10: [], 11: [501] },
        extra: { 12: stat(12, 10, "sh", "Z") },
      }),
      rootPid: 10,
      generation: "g1",
    });
    expect(await sampler.tick()).toEqual({ treeSize: 3, unreadablePids: 0 });
  });

  it("marks sockets of listening ports as incoming and counts unreadable pids", async () => {
    const tcp =
      tcpLine("00000000:1F90", "00000000:0000", "0A", 600) +
      tcpLine("4AE47364:1F90", "0101A8C0:D000", "01", 601);
    const sampler = createSampler({
      fs: fakeFs({ tcp, fds: { 10: [600, 601] } }),
      rootPid: 10,
      generation: "g1",
    });
    expect(await sampler.tick()).toEqual({ treeSize: 2, unreadablePids: 1 });
    const reply = sampler.read({ generation: null, cursor: 0, gapCursor: 0 });
    expect(reply.rows).toHaveLength(1);
    expect(reply.rows[0]).toMatchObject({
      localListening: true,
      localPort: 8080,
      remoteIp: "192.168.1.1",
    });
  });

  it("does not report a gap when acknowledged rows exceed the queue limit", async () => {
    let now = 1_000;
    const state = { tcp: "", fds: { 10: [] as number[], 11: [] as number[] } };
    const sampler = createSampler({
      fs: fakeFs(state),
      rootPid: 10,
      generation: "g1",
      now: () => now,
    });
    let cursor = { generation: null as string | null, cursor: 0, gapCursor: 0 };
    for (let round = 0; round < 3; round += 1) {
      const inodes = Array.from(
        { length: QUEUE_LIMIT / 2 + 1 },
        (_, index) => 10_000 * (round + 1) + index,
      );
      state.tcp = inodes
        .map((inode) => tcpLine("0100007F:C000", "06797A8C:01BB", "01", inode))
        .join("");
      state.fds[11] = inodes;
      now += 1_000;
      await sampler.tick();
      for (;;) {
        const reply = sampler.read(cursor);
        expect(reply.gaps).toEqual([]);
        cursor = {
          generation: reply.generation,
          cursor: reply.cursor,
          gapCursor: reply.gapCursor,
        };
        if (!reply.more) break;
      }
    }
  });

  it("reports queue overflow and stalls as gaps", async () => {
    let now = 1_000;
    const state = { tcp: "", fds: { 10: [] as number[], 11: [] as number[] } };
    const sampler = createSampler({
      fs: fakeFs(state),
      rootPid: 10,
      generation: "g1",
      now: () => now,
    });
    const inodes = Array.from(
      { length: QUEUE_LIMIT + 5 },
      (_, index) => 50_000 + index,
    );
    state.tcp = inodes
      .map((inode) => tcpLine("0100007F:C000", "06797A8C:01BB", "01", inode))
      .join("");
    state.fds[11] = inodes;
    await sampler.tick();
    now += STALL_GAP_MS + 1;
    await sampler.tick();
    const reply = sampler.read({ generation: null, cursor: 0, gapCursor: 0 });
    expect(reply.gaps.map((gap) => gap.reason)).toEqual([
      "queue-overflow",
      "sampler-stalled",
    ]);
  });

  it("asks for a reset when the worker generation changed", async () => {
    const sampler = createSampler({
      fs: fakeFs({ tcp: OUT, fds: { 10: [], 11: [501] } }),
      rootPid: 10,
      generation: "g2",
    });
    await sampler.tick();
    const reply = sampler.read({ generation: "g1", cursor: 99, gapCursor: 0 });
    expect(reply.reset).toBe(true);
    expect(reply.rows).toHaveLength(1);
  });
});
