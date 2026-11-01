import type { OpenPort, OwnedPortTarget, PortCloseScope, ClosePortsResult } from "./contract";

/**
 * Recheck each process against live ownership, never just a cached PID.
 * "thread" stops only processes the thread started; "workspace" also stops
 * any process still listening inside the thread's workspace, for a user who
 * picked that one port by hand.
 */
export async function closeOwnedPortProcesses(
  threadId: string,
  targets: OwnedPortTarget[],
  scan: () => Promise<OpenPort[]>,
  terminate: (pid: number) => void,
  scope: PortCloseScope = "thread",
) {
  const result: ClosePortsResult = { signalled: [], skipped: [], failed: [] };
  for (const pid of new Set(targets.map((target) => target.pid))) {
    const requested = targets.filter((target) => target.pid === pid);
    let current: OpenPort[];
    try {
      current = await scan();
    } catch {
      result.failed.push(...requested.map((target) => target.port));
      continue;
    }
    const owned = current.filter(
      (port) =>
        port.pid === pid && port.source === "process" && (scope === "workspace" || port.ownerThreadId === threadId),
    );
    const matched = requested.filter((target) =>
      owned.some(
        (port) =>
          port.port === target.port && (!target.processStartedAt || port.processStartedAt === target.processStartedAt),
      ),
    );
    result.skipped.push(...requested.filter((target) => !matched.includes(target)).map((target) => target.port));
    if (matched.length === 0) continue;
    try {
      terminate(pid);
      result.signalled.push(...matched.map((target) => target.port));
    } catch {
      result.failed.push(...matched.map((target) => target.port));
    }
  }
  return result;
}
