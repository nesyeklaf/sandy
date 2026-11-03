import { type Document, isMap, isScalar, parseDocument, Scalar, YAMLMap } from "yaml";
import { parseIo, type IoField } from "./io.ts";

export const DESCRIPTION_MAX = 200;
export const IO_KINDS = ["text", "url", "file", "choice"] as const;
export type IoKind = (typeof IO_KINDS)[number];
export const IO_KEYS = ["inputs", "outputs"] as const;
export type IoKey = (typeof IO_KEYS)[number];

export interface IoRow {
  name: string;
  optional: boolean;
  kind: IoKind;
  path: string;
  values: string;
}

export interface MetadataEntry {
  key: string;
  value: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  inputs: IoRow[];
  outputs: IoRow[];
  metadata: MetadataEntry[];
  keptMetadataKeys: string[];
  body: string;
}

export type SkillFileParse =
  | { ok: true; draft: SkillDraft; warnings: string[] }
  | { ok: false; error: string };

const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/u;
const IO_NAME = /^[A-Z][A-Za-z0-9]*$/u;
const TO_STRING = { lineWidth: 0 } as const;

interface SplitFile {
  doc: Document;
  header: string;
  body: string;
}

function split(content: string): SplitFile | string {
  const match = FRONTMATTER.exec(content);
  if (match === null) return "The file has no frontmatter block between --- lines.";
  const frontmatter = match[1] ?? "";
  const doc = parseDocument(frontmatter);
  if (doc.errors.length > 0) return "The frontmatter is not valid YAML: " + doc.errors[0]?.message;
  if (doc.contents !== null && !isMap(doc.contents)) return "The frontmatter is not a key: value map.";
  return { doc, header: match[0], body: content.slice(match[0].length) };
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export function ioRow(field: IoField): IoRow {
  return {
    name: field.name,
    optional: field.optional,
    kind: field.type.kind,
    path: field.type.kind === "file" ? (field.type.path ?? "") : "",
    values: field.type.kind === "choice" ? field.type.values.join(", ") : "",
  };
}

export function emptyIoRow(): IoRow {
  return { name: "", optional: false, kind: "text", path: "", values: "" };
}

function rowType(row: IoRow): string {
  if (row.kind === "file") return row.path.trim() === "" ? "file" : "file(" + row.path.trim() + ")";
  if (row.kind === "choice") return "choice(" + row.values.split(",").map((value) => value.trim()).join(", ") + ")";
  return row.kind;
}

export function formatIoRows(rows: readonly IoRow[]): string {
  return rows.map((row) => row.name.trim() + (row.optional ? "?" : "") + ": " + rowType(row)).join("; ");
}

export function ioRowProblems(rows: readonly IoRow[]): string[] {
  const problems = parseIo(formatIoRows(rows)).errors;
  for (const row of rows) {
    const name = row.name.trim();
    if (name !== "" && !IO_NAME.test(name)) problems.push('"' + name + '" should be PascalCase, like ' + "PlanFile");
  }
  return problems;
}

export function ioFields(rows: readonly IoRow[]): IoField[] {
  return parseIo(formatIoRows(rows)).fields;
}

function readMetadata(doc: Document): YAMLMap | null {
  const metadata = doc.get("metadata", true);
  return isMap(metadata) ? metadata : null;
}

export function parseSkillFile(content: string): SkillFileParse {
  const file = split(content);
  if (typeof file === "string") return { ok: false, error: file };
  const warnings: string[] = [];
  const name = scalarText(file.doc.get("name")) ?? "";
  const description = scalarText(file.doc.get("description")) ?? "";
  const rows: Record<IoKey, IoRow[]> = { inputs: [], outputs: [] };
  const metadata: MetadataEntry[] = [];
  const keptMetadataKeys: string[] = [];
  const map = readMetadata(file.doc);
  if (file.doc.has("metadata") && map === null) warnings.push("metadata is not a key: value map and is kept as it is.");
  for (const pair of map?.items ?? []) {
    const key = isScalar(pair.key) ? scalarText(pair.key.value) : null;
    if (key === null) continue;
    const value = isScalar(pair.value) ? scalarText(pair.value.value) : null;
    if (key === "inputs" || key === "outputs") {
      const parsed = parseIo(value ?? "");
      rows[key] = parsed.fields.map(ioRow);
      if (value === null) warnings.push("metadata." + key + " is not a string; editing its rows replaces it.");
      for (const error of parsed.errors) warnings.push("metadata." + key + ": " + error + "; editing its rows replaces it.");
      continue;
    }
    if (value === null) keptMetadataKeys.push(key);
    else metadata.push({ key, value });
  }
  return {
    ok: true,
    draft: { name, description, inputs: rows.inputs, outputs: rows.outputs, metadata, keptMetadataKeys, body: file.body },
    warnings,
  };
}

function quoted(doc: Document, value: string): Scalar {
  const node = doc.createNode(value) as Scalar;
  node.type = Scalar.QUOTE_DOUBLE;
  return node;
}

function setString(doc: Document, path: readonly string[], value: string) {
  const existing = doc.getIn(path, true);
  if (isScalar(existing)) existing.value = value;
  else doc.setIn(path, quoted(doc, value));
}

function sameRows(a: readonly IoRow[], b: readonly IoRow[]): boolean {
  return formatIoRows(a) === formatIoRows(b);
}

function ensureMetadata(doc: Document): YAMLMap {
  const existing = readMetadata(doc);
  if (existing !== null) return existing;
  const created = new YAMLMap();
  doc.set("metadata", created);
  return created;
}

export function applyDraft(base: string, draft: SkillDraft): string {
  const file = split(base);
  const parsed = parseSkillFile(base);
  if (typeof file === "string" || !parsed.ok) throw new Error(typeof file === "string" ? file : "The skill file cannot be parsed.");
  const before = parsed.draft;
  const doc = file.doc;
  let touched = false;
  if (draft.description !== before.description) {
    setString(doc, ["description"], draft.description);
    touched = true;
  }
  for (const key of IO_KEYS) {
    if (sameRows(draft[key], before[key])) continue;
    touched = true;
    if (draft[key].length === 0) doc.deleteIn(["metadata", key]);
    else {
      ensureMetadata(doc);
      setString(doc, ["metadata", key], formatIoRows(draft[key]));
    }
  }
  const next = new Map(draft.metadata.filter((entry) => entry.key.trim() !== "").map((entry) => [entry.key.trim(), entry.value] as const));
  for (const entry of before.metadata) {
    if (next.has(entry.key)) continue;
    doc.deleteIn(["metadata", entry.key]);
    touched = true;
  }
  for (const [key, value] of next) {
    if (IO_KEYS.some((ioKey) => ioKey === key) || before.keptMetadataKeys.includes(key)) continue;
    if (before.metadata.some((entry) => entry.key === key && entry.value === value)) continue;
    ensureMetadata(doc);
    setString(doc, ["metadata", key], value);
    touched = true;
  }
  const metadata = readMetadata(doc);
  if (metadata !== null && metadata.items.length === 0 && touched) doc.delete("metadata");
  if (!touched) return file.header + draft.body;
  const frontmatter = doc.contents === null || (isMap(doc.contents) && doc.contents.items.length === 0) ? "" : doc.toString(TO_STRING);
  return "---\n" + frontmatter + "---\n" + draft.body;
}

export function isDraftChanged(base: string, draft: SkillDraft): boolean {
  return applyDraft(base, draft) !== base;
}
