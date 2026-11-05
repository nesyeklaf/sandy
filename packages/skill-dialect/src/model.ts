export const DIALECT_VERSION = "1";
export const DONE_STAGE = "done";
export const INPUT_SCOPE = "input";
export const RESERVED_STAGE_IDS: readonly string[] = [DONE_STAGE, INPUT_SCOPE];

export type Cond =
  | { fn: "equals"; ref: string; value: string }
  | { fn: "present"; ref: string }
  | { fn: "any"; ref: string; value: string }
  | { fn: "all"; ref: string; value: string }
  | { fn: "not"; arg: Cond }
  | { fn: "and"; args: Cond[] }
  | { fn: "or"; args: Cond[] };

export type Segment =
  | { type: "text"; text: string }
  | { type: "ref"; ref: string; list?: string }
  | { type: "if"; cond: Cond; then: Segment[]; else: Segment[] };

export type DeriveCase = { value: string; when?: Cond };
export type Derive = { name: string; type: string; cases: DeriveCase[] };
export type ResultField = { name: string; from: string };

export type Scope = Readonly<Record<string, string>>;

export type ValueType =
  | { kind: "text" }
  | { kind: "url" }
  | { kind: "file"; path?: string }
  | { kind: "choice"; options: string[] }
  | {
      kind: "list";
      of: { kind: "text" } | { kind: "choice"; options: string[] };
    }
  | { kind: "map"; list: string; options: string[] };

const CHOICE_OPTION = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;
const REF = /^\$?([a-z0-9][a-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_]*)$/;

export function parseRef(
  text: string,
): { stage: string; name: string } | undefined {
  const match = REF.exec(text.trim());
  return match === null ? undefined : { stage: match[1]!, name: match[2]! };
}

function parseChoice(
  inner: string,
): { ok: true; options: string[] } | { ok: false; error: string } {
  const options = inner.split(",").map((option) => option.trim());
  if (options.length < 2)
    return { ok: false, error: "a choice needs at least two values" };
  for (const option of options)
    if (!CHOICE_OPTION.test(option))
      return {
        ok: false,
        error: `choice value "${option}" may use letters, digits, space, _ . - only`,
      };
  if (new Set(options).size !== options.length)
    return { ok: false, error: "a choice lists a value twice" };
  return { ok: true, options };
}

export function parseType(
  source: string,
): { ok: true; type: ValueType } | { ok: false; error: string } {
  const text = source.trim();
  if (text === "text") return { ok: true, type: { kind: "text" } };
  if (text === "url") return { ok: true, type: { kind: "url" } };
  if (text === "file") return { ok: true, type: { kind: "file" } };
  const file = /^file\((.*)\)$/.exec(text);
  if (file !== null) {
    const path = file[1]!.trim();
    if (path === "")
      return { ok: false, error: "file() needs a path, or write file without parentheses" };
    if (/[()"\n]/.test(path))
      return { ok: false, error: `file path "${path}" may not hold ( ) or quotes` };
    return { ok: true, type: { kind: "file", path } };
  }
  const choice = /^choice\((.*)\)$/.exec(text);
  if (choice !== null) {
    const parsed = parseChoice(choice[1]!);
    return parsed.ok
      ? { ok: true, type: { kind: "choice", options: parsed.options } }
      : parsed;
  }
  const list = /^list\((.*)\)$/.exec(text);
  if (list !== null) {
    const inner = parseType(list[1]!);
    if (!inner.ok) return inner;
    if (inner.type.kind !== "text" && inner.type.kind !== "choice")
      return { ok: false, error: "a list holds text or a choice" };
    return { ok: true, type: { kind: "list", of: inner.type } };
  }
  const map = /^map\(\s*(\$[^,\s]+)\s*,\s*choice\((.*)\)\s*\)$/.exec(text);
  if (map !== null) {
    const ref = parseRef(map[1]!);
    if (ref === undefined)
      return {
        ok: false,
        error: `map key "${map[1]}" is not a $stage.Output reference`,
      };
    const parsed = parseChoice(map[2]!);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      type: {
        kind: "map",
        list: `${ref.stage}.${ref.name}`,
        options: parsed.options,
      },
    };
  }
  return {
    ok: false,
    error: `unknown type "${text}": use text, url, file, file(path), choice(a, b), list(text), list(choice(a, b)) or map($stage.List, choice(a, b))`,
  };
}

export function formatType(type: ValueType): string {
  switch (type.kind) {
    case "text":
      return "text";
    case "url":
      return "url";
    case "file":
      return type.path === undefined ? "file" : `file(${type.path})`;
    case "choice":
      return `choice(${type.options.join(", ")})`;
    case "list":
      return `list(${formatType(type.of)})`;
    case "map":
      return `map($${type.list}, choice(${type.options.join(", ")}))`;
  }
}

export function lineFormat(type: ValueType): string | undefined {
  switch (type.kind) {
    case "text":
      return undefined;
    case "url":
      return "a URL";
    case "file":
      return type.path === undefined ? "a file path" : `a file path (default ${type.path})`;
    case "choice":
      return `exactly one of: ${type.options.join(", ")}`;
    case "list":
      return `one "1. item" line per entry, numbered from 1${type.of.kind === "choice" ? `, each item one of: ${type.of.options.join(", ")}` : ""}`;
    case "map":
      return `one "- n: value — reason" line per entry n of $${type.list}, value one of: ${type.options.join(", ")}; the reason may be left out only for ${type.options[0]}`;
  }
}

export function describeCond(cond: Cond): string {
  switch (cond.fn) {
    case "present":
      return `present($${cond.ref})`;
    case "equals":
    case "any":
    case "all":
      return `${cond.fn}($${cond.ref}, ${JSON.stringify(cond.value)})`;
    case "not":
      return `not(${describeCond(cond.arg)})`;
    case "and":
    case "or":
      return `${cond.fn}(${cond.args.map(describeCond).join(", ")})`;
  }
}

export function condRefs(cond: Cond): string[] {
  switch (cond.fn) {
    case "present":
    case "equals":
    case "any":
    case "all":
      return [cond.ref];
    case "not":
      return condRefs(cond.arg);
    case "and":
    case "or":
      return cond.args.flatMap(condRefs);
  }
}
