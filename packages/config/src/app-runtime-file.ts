import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { isProcessRunning } from "./verified-process-stop.js";

const SANDY_APP_RUNTIME_FILE_NAME = "sandy-app-runtime.json";

const sandyAppRuntimeFileSchema = z.object({
  entryPath: z.string().min(1),
  pid: z.number().int().positive(),
  surface: z.string().min(1),
  serverUrl: z.string().min(1),
  startedAt: z.string().min(1),
  version: z.string().min(1),
});

export type SandyAppRuntimeFile = z.infer<typeof sandyAppRuntimeFileSchema>;

interface WriteSandyAppRuntimeFileArgs {
  dataDir: string;
  entryPath: string;
  pid: number;
  serverUrl: string;
  startedAt: string;
  surface: string;
  version: string;
}

export function formatSandyAppRuntimeFilePath(dataDir: string): string {
  return join(dataDir, SANDY_APP_RUNTIME_FILE_NAME);
}

export async function writeSandyAppRuntimeFile(
  args: WriteSandyAppRuntimeFileArgs,
): Promise<void> {
  const runtimeFile: SandyAppRuntimeFile = {
    entryPath: args.entryPath,
    pid: args.pid,
    serverUrl: args.serverUrl,
    startedAt: args.startedAt,
    surface: args.surface,
    version: args.version,
  };
  await mkdir(args.dataDir, { recursive: true });
  await writeFile(
    formatSandyAppRuntimeFilePath(args.dataDir),
    `${JSON.stringify(runtimeFile, null, 2)}\n`,
    "utf8",
  );
}

export async function claimSandyAppRuntimeFile(
  args: WriteSandyAppRuntimeFileArgs & { isRunning?: (pid: number) => boolean },
): Promise<boolean> {
  const isRunning = args.isRunning ?? isProcessRunning;
  const existing = await readSandyAppRuntimeFile(args.dataDir);
  if (
    existing !== null &&
    existing.pid !== args.pid &&
    isRunning(existing.pid)
  ) {
    return false;
  }
  await writeSandyAppRuntimeFile(args);
  return true;
}

async function clearSandyAppRuntimeFile(dataDir: string): Promise<void> {
  await rm(formatSandyAppRuntimeFilePath(dataDir), { force: true });
}

export async function clearOwnSandyAppRuntimeFile(args: {
  dataDir: string;
  pid: number;
}): Promise<boolean> {
  const runtimeFile = await readSandyAppRuntimeFile(args.dataDir);
  if (runtimeFile === null || runtimeFile.pid !== args.pid) {
    return false;
  }
  await clearSandyAppRuntimeFile(args.dataDir);
  return true;
}

export function sandyAppRuntimeVerifyTokens(entryPath: string): string[] {
  return [entryPath, basename(entryPath)];
}

export async function readSandyAppRuntimeFile(
  dataDir: string,
): Promise<SandyAppRuntimeFile | null> {
  let rawContents: string;
  try {
    rawContents = await readFile(formatSandyAppRuntimeFilePath(dataDir), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = sandyAppRuntimeFileSchema.safeParse(JSON.parse(rawContents));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
