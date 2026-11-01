import { describe, expect, it } from "vitest";
import fixture from "./fixtures/proc-host-daemon.json" with { type: "json" };
import { classify, type ClassifyContext } from "./classify.js";
import { INFERENCE_PROCESSES, THIRD_PARTY_PROCESSES } from "./allowlist.js";
import { createSampler, type ProcFs } from "./sampler.js";

interface FixtureProc {
  stat: string;
  cmdline: string | null;
  netns: string | null;
  fds: string[] | null;
}

const procs = fixture.procs as Record<string, FixtureProc>;
const net = fixture.net as Record<string, Record<string, string>>;

function missing(path: string): never {
  throw new Error(`ENOENT ${path}`);
}

const fixtureFs: ProcFs = {
  async readdir(path) {
    if (path === "/proc") return [...Object.keys(procs), "self", "net"];
    const pid = /^\/proc\/(\d+)\/fd$/.exec(path)?.[1];
    const fds = pid === undefined ? null : procs[pid]?.fds;
    if (fds === null || fds === undefined) return missing(path);
    return fds.map((_, index) => String(index));
  },
  async readFile(path) {
    const match = /^\/proc\/(\d+)\/(stat|cmdline|net\/\w+)$/.exec(path);
    if (match === null) return missing(path);
    const [, pid, file] = match;
    if (file === "stat") return procs[pid!]?.stat ?? missing(path);
    if (file === "cmdline") return procs[pid!]?.cmdline ?? missing(path);
    return net[pid!]?.[file!.slice(4)] ?? missing(path);
  },
  async readlink(path) {
    const ns = /^\/proc\/(\d+)\/ns\/net$/.exec(path);
    if (ns !== null) return procs[ns[1]!]?.netns ?? missing(path);
    const fd = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path);
    const link = fd === null ? undefined : procs[fd[1]!]?.fds?.[Number(fd[2])];
    return link ?? missing(path);
  },
};

function commOf(pid: string): string {
  const stat = procs[pid]!.stat;
  return stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
}

describe("sampler on a captured host-daemon /proc", () => {
  it("reads the whole tree, skips zombies and names every bridge worker", async () => {
    const zombies = Object.values(procs).filter((proc) =>
      proc.stat.slice(proc.stat.lastIndexOf(")") + 2).startsWith("Z"),
    );
    const bridges = Object.entries(procs)
      .filter(([, proc]) =>
        proc.cmdline?.includes("sandy-provider-bridge-worker.mjs"),
      )
      .map(([pid]) => Number(pid));
    expect(zombies.length).toBeGreaterThan(0);
    expect(bridges.length).toBeGreaterThan(0);

    const sampler = createSampler({
      fs: fixtureFs,
      rootPid: fixture.rootPid,
      generation: "fixture",
      now: () => 1_000,
    });
    expect(await sampler.tick()).toEqual({
      treeSize: Object.keys(procs).length,
      unreadablePids: 0,
    });
    const rows = sampler.read({ generation: null, cursor: 0, gapCursor: 0 }).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (bridges.includes(row.pid)) expect(row.comm).toBe("sandy-provider-bridge");
      else expect(row.comm).toBe(commOf(String(row.pid)));
    }
  });

  it("never reports a provider bridge worker as red", async () => {
    const sampler = createSampler({
      fs: fixtureFs,
      rootPid: fixture.rootPid,
      generation: "fixture",
      now: () => 1_000,
    });
    await sampler.tick();
    const rows = sampler.read({ generation: null, cursor: 0, gapCursor: 0 }).rows;
    const context: ClassifyContext = {
      allowedHosts: new Set(["api.openai.com"]),
      resolvers: new Set(),
      bindSubnets: [],
      inferenceProcesses: INFERENCE_PROCESSES,
      thirdPartyProcesses: THIRD_PARTY_PROCESSES,
      resolutionsFor: (ip) => [{ name: "api.openai.com", ip, at: 1_000 }],
      now: 1_000,
    };
    const bridgeStates = rows
      .filter((row) => row.comm === "sandy-provider-bridge")
      .map((row) => classify(row, null, context).state);
    expect(bridgeStates.length).toBeGreaterThan(0);
    expect(bridgeStates).not.toContain("red");
  });
});
