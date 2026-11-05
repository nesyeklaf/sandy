import { execHostFile } from "./host-process.js";
import path from "node:path";

const execFileAsync = execHostFile;

export interface ProcessIdentity {
  command: string | null;
  startedAt: number | null;
}

export async function readProcessIdentity(
  pid: number,
): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return readWindowsProcess(pid);
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "etime=", "-o", "command="],
      {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const match = stdout.trim().match(/^(\S+)\s+([\s\S]+)$/u);
    if (match === null) return null;
    const elapsed = parseElapsedSeconds(match[1] ?? "");
    return {
      command: match[2] ?? null,
      startedAt: elapsed === null ? null : Date.now() - elapsed * 1_000,
    };
  } catch {
    return null;
  }
}

async function readWindowsProcess(pid: number) {
  try {
    const pending = execFileAsync(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
          `foreach ($p in ([wmisearcher]'select CommandLine,CreationDate from Win32_Process where ProcessId = ${pid}').Get()) { $started = ([DateTimeOffset][Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate)).ToUnixTimeMilliseconds(); [Console]::Out.Write([string]$started + [char]10 + $p.CommandLine); break }`,
        ].join("; "),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    pending.child.stdin?.end();
    const { stdout } = await pending;
    const separator = stdout.indexOf("\n");
    if (separator < 0) return null;
    const startedAt = Number(stdout.slice(0, separator));
    if (!Number.isFinite(startedAt)) return null;
    const command = stdout.slice(separator + 1).trim();
    return { command: command === "" ? null : command, startedAt };
  } catch {
    return null;
  }
}

export function parseElapsedSeconds(rawElapsed: string): number | null {
  const match = rawElapsed
    .trim()
    .match(/^(?:(?:(\d+)-)?(\d+):)?(\d{1,2}):(\d{2})$/u);
  if (match === null) {
    return null;
  }
  const days = Number(match[1] ?? "0");
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}
