import { readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const CONFIRMATIONS = ".holons/confirmations";

function insideModel(root: string, segments: readonly string[]): boolean {
  let dir = "";
  for (const segment of segments) {
    if (SKIPPED.has(segment)) return false;
    dir = dir === "" ? segment : `${dir}/${segment}`;
    if (isDirectory(join(root, dir, ".holons"))) return false;
  }
  return true;
}

export function isConfirmationPath(path: string): boolean {
  return path.startsWith(`${CONFIRMATIONS}/`) && path.endsWith(".json") && !path.split("/").includes("..");
}

export function belongsToModel(root: string, path: string): boolean {
  if (isConfirmationPath(path)) return true;
  if (!path.endsWith(".holon")) return false;
  const segments = path.split("/");
  if (segments.includes("..") || segments.includes("")) return false;
  return insideModel(root, segments.slice(0, -1));
}

export function isNestedModelBoundary(path: string): boolean {
  const segments = path.split("/");
  return segments.length > 1 && segments.at(-1) === ".holons" && !segments.some((segment) => SKIPPED.has(segment) && segment !== ".holons");
}

export function scanUnder(root: string, path: string): ScanResult {
  const holonFiles: ScannedFile[] = [];
  const confirmationFiles: ScannedFile[] = [];
  if (isDirectory(join(root, path))) {
    if (path === ".holons") walkConfirmations(root, CONFIRMATIONS, confirmationFiles);
    else if (path === CONFIRMATIONS || path.startsWith(`${CONFIRMATIONS}/`)) walkConfirmations(root, path, confirmationFiles);
    else if (insideModel(root, path.split("/").slice(0, -1)) && !SKIPPED.has(path.split("/").at(-1)!)) walkHolons(root, path, holonFiles);
  }
  return { holonFiles, confirmationFiles };
}

export function modelRootOf(file: string, bound: string): string {
  const top = resolve(bound);
  let dir = dirname(resolve(file));
  if (relative(top, dir).startsWith("..")) return dir;
  while (dir !== top) {
    if (isDirectory(join(dir, ".holons"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return top;
}

export function scanRoot(root: string): ScanResult {
  const holonFiles: ScannedFile[] = [];
  const confirmationFiles: ScannedFile[] = [];
  walkHolons(root, "", holonFiles);
  walkConfirmations(root, CONFIRMATIONS, confirmationFiles);
  holonFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  confirmationFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { holonFiles, confirmationFiles };
}
