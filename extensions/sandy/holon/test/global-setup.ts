import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export default function setup(): () => Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "holon-pids-"));
  const log = join(dir, "pids");
  process.env.FAKE_PID_LOG = log;
  return async () => {
    let pids: number[] = [];
    try {
      pids = readFileSync(log, "utf8").split("\n").filter((line) => line !== "").map(Number);
    } catch {
      pids = [];
    }
    const deadline = Date.now() + 3000;
    while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const leaked = pids.filter(alive);
    for (const pid of leaked) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    if (leaked.length > 0) throw new Error(`fake-serve processes still running after the tests: ${leaked.join(", ")}`);
  };
}
