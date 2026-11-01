import { execFile } from "node:child_process";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);

async function inspect(command, args, env, allowEmpty = false) {
  try {
    return (await execute(command, args, { env, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch (error) {
    // ps/lsof return 1 when a sampled process exited or has no matching socket.
    if (allowEmpty && error.code === 1 && !error.stderr) return "";
    throw new Error(`Isolation inspection failed: ${command}: ${error.code ?? error.message}`);
  }
}

export function outsideConnections(output) {
  let pid;
  const outside = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n")) continue;
    const remote = line.slice(1).split("->")[1];
    if (!remote) throw new Error("Cannot inspect established TCP peer");
    const host = remote.startsWith("[")
      ? remote.slice(1, remote.indexOf("]"))
      : remote.slice(0, remote.lastIndexOf(":"));
    const loopback = (isIP(host) === 4 && host.startsWith("127.")) || host === "::1" || /^::ffff:127\./.test(host);
    if (!loopback) outside.push({ pid, remote });
  }
  return outside;
}

export function scratchHome(home, scratch) {
  if (!home) throw new Error("Scratch child is missing HOME");
  const path = relative(realpathSync(scratch), realpathSync(home));
  if (path === ".." || path.startsWith(`..${sep}`) || path.startsWith(sep)) {
    throw new Error(`Child HOME is outside scratch: ${home}`);
  }
}

export function protectedFiles(output, roots) {
  let pid;
  const files = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n") || !line.slice(1).startsWith("/")) continue;
    const path = line.slice(1).replace(/ \(deleted\)$/, "");
    if (roots.some((root) => path === root || path.startsWith(`${root}/`))) files.push({ pid, path });
  }
  return files;
}

export function createIsolationGuard(rootPid, scratch, env, logPath, realHome) {
  const realRoot = realpathSync(realHome);
  const roots = [".codex", ".claude", ".cursor", ".config", ".sandy"].flatMap((name) => {
    const paths = [join(realRoot, name), resolve(realHome, name)];
    return [...paths, ...paths.filter(existsSync).map((path) => realpathSync(path))];
  });
  return async (stage) => {
    const output = await inspect("ps", ["-axo", "pid=,ppid=,comm="], env);
    const all = output
      .trim()
      .split("\n")
      .map((line) => {
        const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line) ?? [];
        return { pid: Number(pid), ppid: Number(ppid), command };
      });
    const ids = new Set([rootPid]);
    let previous;
    do {
      previous = ids.size;
      for (const process of all) if (ids.has(process.ppid)) ids.add(process.pid);
    } while (previous !== ids.size);
    const processes = [];
    for (const process of all.filter(({ pid }) => ids.has(pid))) {
      let environment = await inspect(
        "ps",
        ["eww", "-p", String(process.pid), "-o", "stat=", "-o", "command="],
        env,
        true,
      );
      // Provider discovery helpers can exit between the process and environment samples.
      for (
        let attempt = 0;
        environment && !/^\s*Z/.test(environment) && !/\sHOME=/.test(environment) && attempt < 8;
        attempt++
      ) {
        await delay(25);
        environment = await inspect(
          "ps",
          ["eww", "-p", String(process.pid), "-o", "stat=", "-o", "command="],
          env,
          true,
        );
      }
      if (!environment || /^\s*Z/.test(environment)) continue;
      // Never print raw environments; they could contain credentials if isolation regresses.
      const home = /(?:^|\s)HOME=([^\s]+)/.exec(environment)?.[1];
      if (home) scratchHome(home, scratch);
      const codexHome = /(?:^|\s)CODEX_HOME=([^\s]+)/.exec(environment)?.[1];
      if (codexHome) scratchHome(codexHome, scratch);
      const claudeConfigDir = /(?:^|\s)CLAUDE_CONFIG_DIR=([^\s]+)/.exec(environment)?.[1];
      if (claudeConfigDir) scratchHome(claudeConfigDir, scratch);
      processes.push({ ...process, home: home ?? null, codexHome, claudeConfigDir, environmentVisible: Boolean(home) });
    }
    if (!processes.some(({ pid }) => pid === rootPid)) throw new Error("Scratch server disappeared during inspection");
    const tcp = await inspect(
      "lsof",
      ["-nP", "-a", "-p", [...ids].join(","), "-iTCP", "-sTCP:ESTABLISHED", "-Fpn"],
      env,
      true,
    );
    const outside = outsideConnections(tcp);
    const openFiles = await inspect("lsof", ["-nP", "-a", "-p", [...ids].join(","), "-Fpn"], env, true);
    const forbiddenFiles = protectedFiles(openFiles, roots);
    appendFileSync(
      logPath,
      `${JSON.stringify({ stage, at: new Date().toISOString(), processes, tcp, outside, forbiddenFiles })}\n`,
    );
    if (forbiddenFiles.length)
      throw new Error(`Scratch processes hold real-home files: ${JSON.stringify(forbiddenFiles)}`);
    if (stage !== "monitor") {
      console.log(
        `ISOLATION GUARD: ${stage}; ${processes.length} processes checked; real-home open files: 0; outside TCP: ${outside.length}`,
      );
    }
  };
}
