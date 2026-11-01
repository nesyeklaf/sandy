// Host-side files of pi's agent directory that the plugin reads and writes.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Hook, Proc } from "./contract.ts";
import type { Measured } from "./procscan.ts";
import extensionSource from "./extension-source.ts";

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent");
}

const stateDir = (agent: string) => path.join(agent, "lifecycle");
export const extensionFile = (agent: string) => path.join(agent, "extensions", "lifecycle", "index.ts");

type StateFile = { startedAt: number; lastLoadAt: number; reason: string; lastReloadAt: number | null; reloadCount: number };

function readState(file: string): StateFile | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return typeof value?.startedAt === "number" && typeof value.lastLoadAt === "number" ? value : null;
  } catch {
    return null;
  }
}

/** Whether a state file belongs to the process measured with this start time (the clock tick of /proc is coarse). */
const sameProcess = (state: StateFile, startedAt: number) => Math.abs(state.startedAt - startedAt) <= 5000;
/** Whether a state file was written by the process whose state the scan read. A reload recomputes startedAt from
 * the uptime, which moves it by a few ms; a new pi on the same pid starts seconds later at the earliest. */
const sameWriter = (state: StateFile, startedAt: number) => Math.abs(state.startedAt - startedAt) <= 100;

/** Joins measured processes with the state their pi extension wrote; state of dead or reused pids is removed. */
export function withHooks(agent: string, measured: Measured[]): Proc[] {
  const dir = stateDir(agent);
  const live = new Map(measured.map((item) => [item.pid, item]));
  const hooks = new Map<number, Hook>();
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const state = readState(path.join(dir, name));
    const process = live.get(pid);
    if (!state || !process || !sameProcess(state, process.startedAt)) {
      if (!process) rmSync(path.join(dir, name), { force: true });
      continue;
    }
    hooks.set(pid, {
      startedAt: state.startedAt,
      lastLoadAt: state.lastLoadAt,
      reason: state.reason,
      lastReloadAt: state.lastReloadAt,
      reloadCount: state.reloadCount,
      reloadPending: existsSync(path.join(dir, `${pid}.reload-request`)),
    });
  }
  return measured.map((item) => ({ ...item, hook: hooks.get(item.pid) ?? null }));
}

/**
 * Asks the extensions of the given processes to reload; returns how many of them have the extension loaded.
 * startedAt is hook.startedAt from the scan, so a pi that took the pid after the scan is not asked.
 */
export function requestReload(agent: string, targets: { pid: number; startedAt: number }[]): number {
  const dir = stateDir(agent);
  let requested = 0;
  for (const { pid, startedAt } of targets) {
    const state = readState(path.join(dir, `${pid}.json`));
    if (!state || !sameWriter(state, startedAt)) continue;
    writeFileSync(path.join(dir, `${pid}.reload-request`), "");
    requested += 1;
  }
  return requested;
}

export function installExtension(agent: string): string {
  const file = extensionFile(agent);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, extensionSource);
  renameSync(`${file}.tmp`, file);
  return file;
}
