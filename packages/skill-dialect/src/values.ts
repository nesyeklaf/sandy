import { parseType, type Cond, type Derive, type Scope, type ValueType } from "./model.ts";

export type MapEntry = { position: number; value: string; reason: string };
export type Checked = { ok: true; value: string } | { ok: false; error: string };

const LIST_LINE = /^(\d+)\.\s+(.*)$/;
const MAP_LINE = /^-\s*(\d+)\s*:\s*([^—]*?)\s*(?:—\s*(.*))?$/;

function lines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function parseList(raw: string): { ok: true; items: string[] } | { ok: false; error: string } {
  const items: string[] = [];
  for (const line of lines(raw)) {
    const match = LIST_LINE.exec(line);
    if (match === null) return { ok: false, error: `"${line}" is not a "${items.length + 1}. item" line` };
    if (Number(match[1]) !== items.length + 1)
      return { ok: false, error: `entry "${line}" is numbered ${match[1]}, expected ${items.length + 1}` };
    const item = match[2]!.trim();
    if (item === "") return { ok: false, error: `entry ${items.length + 1} is empty` };
    if (items.includes(item)) return { ok: false, error: `entry "${item}" is listed twice` };
    items.push(item);
  }
  if (items.length === 0) return { ok: false, error: "the list is empty" };
  return { ok: true, items };
}

export function parseMap(raw: string): { ok: true; entries: MapEntry[] } | { ok: false; error: string } {
  const entries: MapEntry[] = [];
  for (const line of lines(raw)) {
    const match = MAP_LINE.exec(line);
    if (match === null) return { ok: false, error: `"${line}" is not a "- n: value — reason" line` };
    entries.push({ position: Number(match[1]), value: match[2]!.trim(), reason: (match[3] ?? "").trim() });
  }
  if (entries.length === 0) return { ok: false, error: "the map is empty" };
  return { ok: true, entries };
}

function formatList(items: string[]): string {
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

function formatMap(entries: MapEntry[]): string {
  return entries.map((e) => `- ${e.position}: ${e.value}${e.reason === "" ? "" : ` — ${e.reason}`}`).join("\n");
}

function checkTyped(type: ValueType, raw: string, scope: Scope): Checked {
  switch (type.kind) {
    case "text":
      return { ok: true, value: raw };
    case "choice": {
      const value = raw.trim();
      return type.options.includes(value)
        ? { ok: true, value }
        : { ok: false, error: `"${value}" is not one of: ${type.options.join(", ")}` };
    }
    case "list": {
      const parsed = parseList(raw);
      if (!parsed.ok) return parsed;
      if (type.of.kind === "choice") {
        const options = type.of.options;
        const wrong = parsed.items.find((item) => !options.includes(item));
        if (wrong !== undefined) return { ok: false, error: `entry "${wrong}" is not one of: ${options.join(", ")}` };
      }
      return { ok: true, value: formatList(parsed.items) };
    }
    case "map": {
      const listRaw = scope[type.list];
      if (listRaw === undefined) return { ok: false, error: `$${type.list} is not produced yet, so its positions are unknown` };
      const list = parseList(listRaw);
      if (!list.ok) return { ok: false, error: `$${type.list} is not a valid list: ${list.error}` };
      const parsed = parseMap(raw);
      if (!parsed.ok) return parsed;
      const count = list.items.length;
      const seen = new Set<number>();
      for (const entry of parsed.entries) {
        if (entry.position < 1 || entry.position > count)
          return { ok: false, error: `position ${entry.position} is not an entry of $${type.list} (1 to ${count})` };
        if (seen.has(entry.position)) return { ok: false, error: `position ${entry.position} is given twice` };
        seen.add(entry.position);
        if (!type.options.includes(entry.value))
          return { ok: false, error: `position ${entry.position}: "${entry.value}" is not one of: ${type.options.join(", ")}` };
        if (entry.reason === "" && entry.value !== type.options[0])
          return { ok: false, error: `position ${entry.position}: a reason is required for ${entry.value}` };
      }
      const missing = list.items.map((_, i) => i + 1).filter((n) => !seen.has(n));
      if (missing.length > 0) return { ok: false, error: `missing positions: ${missing.join(", ")} (one line per entry of $${type.list})` };
      return { ok: true, value: formatMap([...parsed.entries].sort((a, b) => a.position - b.position)) };
    }
  }
}

export function checkValue(type: string, raw: string, scope: Scope): Checked {
  const parsed = parseType(type);
  if (!parsed.ok) return parsed;
  return checkTyped(parsed.type, raw, scope);
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function collectionValues(raw: string): string[] | undefined {
  const map = parseMap(raw);
  if (map.ok) return map.entries.map((e) => e.value);
  const list = parseList(raw);
  return list.ok ? list.items : undefined;
}

export function evaluate(cond: Cond, scope: Scope): boolean {
  switch (cond.fn) {
    case "present":
      return present(scope[cond.ref]);
    case "equals": {
      const value = scope[cond.ref];
      return present(value) && value.trim() === cond.value;
    }
    case "any":
    case "all": {
      const value = scope[cond.ref];
      if (!present(value)) return false;
      const values = collectionValues(value);
      if (values === undefined || values.length === 0) return false;
      return cond.fn === "any" ? values.includes(cond.value) : values.every((v) => v === cond.value);
    }
    case "not":
      return !evaluate(cond.arg, scope);
    case "and":
      return cond.args.every((arg) => evaluate(arg, scope));
    case "or":
      return cond.args.some((arg) => evaluate(arg, scope));
  }
}

export function deriveValues(stage: { id: string; derive?: Derive[] }, scope: Scope): Record<string, string> {
  const derived: Record<string, string> = {};
  let current: Record<string, string> = { ...scope };
  for (const derive of stage.derive ?? []) {
    const hit = derive.cases.find((c) => c.when === undefined || evaluate(c.when, current));
    if (hit === undefined) continue;
    const key = `${stage.id}.${derive.name}`;
    derived[key] = hit.value;
    current = { ...current, [key]: hit.value };
  }
  return derived;
}
