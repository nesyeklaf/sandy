import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

export interface ScannedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  holonFiles: ScannedFile[];
  confirmationFiles: ScannedFile[];
}

const SKIPPED = new Set(["node_modules", ".git", ".holons"]);

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function stat(absolute: string, path: string): ScannedFile | null {
  try {
    const info = statSync(absolute);
    return info.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

function walkHolons(root: string, relative: string, out: ScannedFile[]): void {
  const dir = relative === "" ? root : join(root, relative);
  const list = entries(dir);
  if (relative !== "" && list.some((entry) => entry.name === ".holons" && entry.isDirectory())) return;
  for (const entry of list) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) walkHolons(root, path, out);
    } else if (entry.name.endsWith(".holon") && (entry.isFile() || entry.isSymbolicLink())) {
      const file = stat(join(root, path), path);
      if (file !== null) out.push(file);
    }
  }
}

function walkConfirmations(root: string, relative: string, out: ScannedFile[]): void {
  for (const entry of entries(join(root, relative))) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) walkConfirmations(root, path, out);
    else if (entry.name.endsWith(".json")) {
      const file = stat(join(root, path), path);
      if (file !== null) out.push(file);
    }
  }
}

export function scanRoot(root: string): ScanResult {
  const holonFiles: ScannedFile[] = [];
  const confirmationFiles: ScannedFile[] = [];
  walkHolons(root, "", holonFiles);
  walkConfirmations(root, ".holons/confirmations", confirmationFiles);
  holonFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  confirmationFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { holonFiles, confirmationFiles };
}
