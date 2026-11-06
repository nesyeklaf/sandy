export type IoType =
  | { kind: "text" }
  | { kind: "url" }
  | { kind: "file"; path: string | null }
  | { kind: "choice"; values: string[] }
  | { kind: "raw"; text: string };

export interface IoField {
  name: string;
  optional: boolean;
  type: IoType;
}

export interface IoParseResult {
  fields: IoField[];
  errors: string[];
}

const ENTRY = /^([^:]*?)(\?)?\s*:\s*(.*)$/su;
const CALL = /^(\w+)\s*\((.*)\)$/su;

export function parseIoType(raw: string): IoType | string {
  const text = raw.trim();
  if (text === "text") return { kind: "text" };
  if (text === "url") return { kind: "url" };
  if (text === "file") return { kind: "file", path: null };
  const call = CALL.exec(text);
  if (call === null) return 'unknown type "' + text + '", use text, url, file, file(path) or choice(a, b)';
  const [, kind = "", inner = ""] = call;
  if (kind === "list" || kind === "map") return inner.trim() === "" ? kind + "() needs an item type" : { kind: "raw", text };
  if (kind === "file") {
    const path = inner.trim();
    return path === "" ? "file() needs a path, or write file without parentheses" : { kind: "file", path };
  }
  if (kind === "choice") {
    const values = inner.split(",").map((value) => value.trim());
    if (values.some((value) => value === "")) return "choice(...) has an empty value";
    if (values.length < 2) return "choice(...) needs at least two values";
    if (new Set(values).size !== values.length) return "choice(...) repeats a value";
    return { kind: "choice", values };
  }
  return 'unknown type "' + kind + '(...)", use file(path) or choice(a, b)';
}

export function parseIo(value: string | undefined): IoParseResult {
  const fields: IoField[] = [];
  const errors: string[] = [];
  if (value === undefined || value.trim() === "") return { fields, errors };
  for (const [index, raw] of value.split(";").entries()) {
    const entry = raw.trim();
    const where = "entry " + String(index + 1);
    if (entry === "") {
      errors.push(where + " is empty");
      continue;
    }
    const match = ENTRY.exec(entry);
    if (match === null) {
      errors.push(where + ' "' + entry + '" has no type, write "Name: type"');
      continue;
    }
    const [, rawName = "", mark, rawType = ""] = match;
    const name = rawName.trim();
    if (name === "") {
      errors.push(where + ' "' + entry + '" has no name');
      continue;
    }
    if (fields.some((field) => field.name === name)) {
      errors.push(where + ': "' + name + '" is declared twice');
      continue;
    }
    const type = parseIoType(rawType);
    if (typeof type === "string") {
      errors.push(where + ' "' + name + '": ' + type);
      continue;
    }
    fields.push({ name, optional: mark === "?", type });
  }
  return { fields, errors };
}

export function satisfies(output: IoType, input: IoType): boolean {
  switch (input.kind) {
    case "text":
      return output.kind === "text" || output.kind === "file" || output.kind === "choice" || output.kind === "raw";
    case "url":
      return output.kind === "url";
    case "file":
      return output.kind === "file";
    case "choice":
      return output.kind === "choice" && output.values.every((value) => input.values.includes(value));
    case "raw":
      return output.kind === "raw" && output.text === input.text;
  }
}

export function formatType(type: IoType): string {
  switch (type.kind) {
    case "text":
    case "url":
      return type.kind;
    case "file":
      return type.path === null ? "file" : "file(" + type.path + ")";
    case "choice":
      return "choice(" + type.values.join(", ") + ")";
    case "raw":
      return type.text;
  }
}

export function formatIo(fields: readonly IoField[]): string {
  return fields.map((field) => field.name + (field.optional ? "?" : "") + ": " + formatType(field.type)).join("; ");
}
