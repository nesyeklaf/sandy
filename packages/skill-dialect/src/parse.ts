import Markdoc from "@markdoc/markdoc";
import { readFrontmatter } from "./frontmatter.ts";
import {
  condRefs,
  DIALECT_VERSION,
  DONE_STAGE,
  INPUT_SCOPE,
  parseRef,
  parseType,
  RESERVED_STAGE_IDS,
  type Cond,
  type Derive,
  type ResultField,
  type Segment,
  type ValueType,
} from "./model.ts";
import { describeTemplate, tidy } from "./render.ts";

export type Problem = { file: string; line: number; tag: string; message: string; fix: string };

export type CompiledRule =
  | { type: "outputs" }
  | { type: "user"; prompt?: string }
  | { type: "check"; command: string; label?: string; timeoutSec?: number }
  | { type: "evidence"; name: string; description?: string; ran?: true }
  | { type: "goal"; label?: string; optional?: true };
export type CompiledAllow = {
  skills?: string[];
  edits?: boolean;
  subagents?: { agent?: string; model?: string }[];
  denyTools?: string[];
};
export type CompiledField = { name: string; description?: string; optional?: boolean; type?: string };
export type CompiledEdge = { to: string; when?: string; cond?: Cond; max?: number; exceeded?: "owner"; gate?: CompiledRule[] };
export type CompiledStage = {
  id: string;
  title: string;
  description?: string;
  inputs: string[];
  outputs: CompiledField[];
  allow?: CompiledAllow;
  autopilot?: { name: string; args?: string };
  gate: CompiledRule[];
  next: CompiledEdge[];
  template: Segment[];
  derive?: Derive[];
};
export type CompiledMachine = {
  id: string;
  title: string;
  description?: string;
  start?: string;
  allow?: CompiledAllow;
  inputs?: CompiledField[];
  result?: ResultField[];
  stages: CompiledStage[];
};

type AttrValue = unknown;
type TagNode = {
  kind: "tag";
  name: string;
  attrs: { name: string; value: AttrValue; type: string }[];
  line: number;
  selfClosing: boolean;
  children: Node[];
};
type Node = { kind: "text"; text: string; line: number } | { kind: "var"; path: unknown; line: number } | TagNode;

type MarkdocVariable = { $$mdtype: "Variable"; path: unknown };
type MarkdocFunction = { $$mdtype: "Function"; name: string; parameters: Record<string, unknown> };

type AttrKind = "string" | "bool" | "int" | "cond" | "ref";
type TagSpec = { attrs: Record<string, AttrKind>; required: string[]; form: "self" | "open" | "either" };

const TAGS: Record<string, TagSpec> = {
  input: { attrs: { name: "string", type: "string", description: "string", optional: "bool" }, required: ["name"], form: "self" },
  allow: { attrs: { skills: "string", edits: "bool", subagents: "string", deny: "string" }, required: [], form: "self" },
  result: { attrs: { name: "string", from: "ref" }, required: ["name", "from"], form: "self" },
  stage: {
    attrs: { id: "string", title: "string", skill: "string", autopilot: "string", args: "string", gate: "string", start: "bool" },
    required: ["id"],
    form: "open",
  },
  needs: { attrs: { primary: "string" }, required: ["primary"], form: "self" },
  output: { attrs: { name: "string", type: "string", description: "string", optional: "bool" }, required: ["name"], form: "self" },
  gate: {
    attrs: {
      type: "string",
      prompt: "string",
      command: "string",
      label: "string",
      timeout: "int",
      name: "string",
      description: "string",
      ran: "bool",
      optional: "bool",
    },
    required: ["type"],
    form: "self",
  },
  next: { attrs: { to: "string", label: "string", when: "cond", max: "int", exceeded: "string" }, required: ["to"], form: "either" },
  derive: { attrs: { name: "string", type: "string" }, required: ["name", "type"], form: "open" },
  case: { attrs: { value: "string", when: "cond" }, required: ["value"], form: "self" },
  if: { attrs: { primary: "cond" }, required: ["primary"], form: "open" },
  else: { attrs: {}, required: [], form: "self" },
};

const GATE_ATTRS: Record<string, string[]> = {
  outputs: [],
  user: ["prompt"],
  check: ["command", "label", "timeout"],
  evidence: ["name", "description", "ran"],
  goal: ["label", "optional"],
};

const STAGE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const AUTOPILOT_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const EVIDENCE_NAME = STAGE_ID;
const COND_FNS = ["equals", "present", "any", "all", "not", "and", "or"];

function isVariable(value: unknown): value is MarkdocVariable {
  return typeof value === "object" && value !== null && (value as { $$mdtype?: unknown }).$$mdtype === "Variable";
}

function isFunction(value: unknown): value is MarkdocFunction {
  return typeof value === "object" && value !== null && (value as { $$mdtype?: unknown }).$$mdtype === "Function";
}

function listAttr(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

type Token = {
  type: string;
  start: number;
  end: number;
  content?: string;
  map?: [number, number];
  info?: string;
  meta?: {
    tag?: string;
    attributes?: { type: string; name: string; value: unknown }[] | null;
    variable?: unknown;
    error?: { message: string };
  };
};

type Symbol = { type: ValueType; kind: "output" | "derive" | "input" };

type Piece = { kind: "text"; text: string; start: number } | { kind: "token"; token: Token };

function aloneOnLine(body: string, token: Token): boolean {
  const lineStart = body.lastIndexOf("\n", token.start - 1) + 1;
  const lineEnd = body.indexOf("\n", token.end);
  return body.slice(lineStart, lineEnd < 0 ? body.length : lineEnd).trim() === body.slice(token.start, token.end + 1).trim();
}

function pieces(body: string, firstLine: number): Piece[] {
  const out: Piece[] = [];
  let cursor = 0;
  for (const token of Markdoc.parseTags(body, firstLine) as Token[]) {
    if (token.type === "text") continue;
    let text = body.slice(cursor, token.start);
    if (token.type !== "variable" && aloneOnLine(body, token)) {
      const cut = text.lastIndexOf("\n");
      text = cut < 0 ? "" : text.slice(0, cut);
    }
    if (text !== "") out.push({ kind: "text", text, start: cursor });
    out.push({ kind: "token", token });
    cursor = token.end + 1;
  }
  if (cursor < body.length) out.push({ kind: "text", text: body.slice(cursor), start: cursor });
  return out;
}

class Compiler {
  readonly problems: Problem[] = [];
  private readonly file: string;
  private readonly lineStarts: number[];
  private readonly bodyLine: number;

  constructor(file: string, body: string, bodyLine: number) {
    this.file = file;
    this.bodyLine = bodyLine;
    this.lineStarts = [0];
    for (let i = 0; i < body.length; i++) if (body[i] === "\n") this.lineStarts.push(i + 1);
  }

  problem(line: number, tag: string, message: string, fix: string): void {
    this.problems.push({ file: this.file, line, tag, message, fix });
  }

  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return this.bodyLine + lo + 1;
  }

  tree(list: Piece[]): Node[] {
    const root: Node[] = [];
    const stack: { node: TagNode; into: Node[] }[] = [];
    const target = (): Node[] => (stack.length === 0 ? root : stack[stack.length - 1]!.node.children);
    for (const piece of list) {
      if (piece.kind === "text") {
        const lead = piece.text.length - piece.text.trimStart().length;
        target().push({ kind: "text", text: piece.text, line: this.lineAt(piece.start + Math.min(lead, piece.text.length - 1)) });
        continue;
      }
      const token = piece.token;
      const line = token.map?.[0] ?? this.lineAt(token.start);
      if (token.type === "error") {
        this.problem(line, "syntax", `${token.info ?? "tag"} does not parse: ${token.meta?.error?.message ?? "syntax error"}`, 'write tags as {% name attr="value" /%} with double quotes around text');
        continue;
      }
      if (token.type === "variable") {
        target().push({ kind: "var", path: (token.meta?.variable as MarkdocVariable | undefined)?.path, line });
        continue;
      }
      const name = token.meta?.tag ?? "";
      if (token.type === "tag_close") {
        const top = stack[stack.length - 1];
        if (top === undefined || top.node.name !== name) {
          this.problem(line, name, `{% /${name} %} closes no open {% ${name} %}`, top === undefined ? `remove {% /${name} %}` : `close {% ${top.node.name} %} (line ${top.node.line}) first`);
          continue;
        }
        stack.pop();
        continue;
      }
      const node: TagNode = {
        kind: "tag",
        name,
        attrs: (token.meta?.attributes ?? []).map((a) => ({ name: a.name, value: a.value, type: a.type })),
        line,
        selfClosing: token.type === "tag",
        children: [],
      };
      target().push(node);
      if (token.type === "tag_open") stack.push({ node, into: node.children });
    }
    for (const open of stack) this.problem(open.node.line, open.node.name, `{% ${open.node.name} %} is never closed`, `add {% /${open.node.name} %}`);
    return root;
  }

  attrs(node: TagNode): Record<string, unknown> | undefined {
    const spec = TAGS[node.name];
    if (spec === undefined) {
      this.problem(node.line, node.name, `unknown tag {% ${node.name} %}`, `use one of: ${Object.keys(TAGS).join(", ")}`);
      return undefined;
    }
    if (spec.form === "self" && !node.selfClosing)
      this.problem(node.line, node.name, `{% ${node.name} %} has no body`, `write it self-closing: {% ${node.name} ... /%}`);
    if (spec.form === "open" && node.selfClosing)
      this.problem(node.line, node.name, `{% ${node.name} %} needs a body`, `write {% ${node.name} ... %}...{% /${node.name} %}`);
    const out: Record<string, unknown> = {};
    let ok = true;
    for (const attr of node.attrs) {
      const kind = attr.type === "attribute" ? spec.attrs[attr.name] : undefined;
      if (kind === undefined) {
        const known = Object.keys(spec.attrs).filter((a) => a !== "primary");
        this.problem(
          node.line,
          node.name,
          attr.name === "primary" ? `{% ${node.name} %} takes no positional value` : `unknown attribute ${attr.name} on {% ${node.name} %}`,
          known.length === 0 ? `write {% ${node.name} /%} without attributes` : `use only: ${known.join(", ")}`,
        );
        ok = false;
        continue;
      }
      const value = attr.value;
      const valid =
        kind === "string"
          ? typeof value === "string"
          : kind === "bool"
            ? typeof value === "boolean"
            : kind === "int"
              ? typeof value === "number" && Number.isInteger(value) && value >= 1
              : kind === "cond"
                ? isFunction(value)
                : isVariable(value);
      if (!valid) {
        const expected = {
          string: 'a quoted text: name="value"',
          bool: "true or false without quotes",
          int: "a whole number of at least 1, without quotes",
          cond: 'a condition such as equals($stage.Output, "value")',
          ref: "a reference such as $stage.Output",
        }[kind];
        const label = attr.name === "primary" ? "the value" : attr.name;
        this.problem(node.line, node.name, `${label} on {% ${node.name} %} has the wrong form`, `write ${label} as ${expected}`);
        ok = false;
        continue;
      }
      out[attr.name] = value;
    }
    for (const required of spec.required)
      if (!(required in out) && !node.attrs.some((a) => a.name === required)) {
        this.problem(
          node.line,
          node.name,
          required === "primary" ? `{% ${node.name} %} needs a value` : `{% ${node.name} %} needs ${required}=`,
          required === "primary" ? `write {% ${node.name} ... %} with its value` : `add ${required}="..."`,
        );
        ok = false;
      }
    return ok ? out : undefined;
  }

  ref(path: unknown, line: number, tag: string): string | undefined {
    if (!Array.isArray(path) || path.length !== 2 || !path.every((p) => typeof p === "string")) {
      this.problem(line, tag, "a reference needs exactly two parts: $stage.Output or $input.Name", "write $stage.Output, for example $frame.Musts");
      return undefined;
    }
    const [stage, name] = path as [string, string];
    if (!STAGE_ID.test(stage) || !FIELD_NAME.test(name)) {
      this.problem(line, tag, `$${stage}.${name} is not a valid reference`, "stage ids are lowercase (a-z 0-9 _ -), output names match [A-Za-z][A-Za-z0-9_]*");
      return undefined;
    }
    return `${stage}.${name}`;
  }

  cond(value: unknown, line: number, tag: string): Cond | undefined {
    if (!isFunction(value)) {
      this.problem(line, tag, "a condition must be a function call", 'write equals($stage.Output, "value"), present(...), any(...), all(...), not(...), and(...) or or(...)');
      return undefined;
    }
    if (!COND_FNS.includes(value.name)) {
      this.problem(line, tag, `unknown condition function ${value.name}`, `use one of: ${COND_FNS.join(", ")}`);
      return undefined;
    }
    const keys = Object.keys(value.parameters);
    if (keys.some((k, i) => k !== String(i))) {
      this.problem(line, tag, `${value.name}(...) takes positional arguments only`, `write ${value.name}(a, b) without name=`);
      return undefined;
    }
    const args = keys.map((k) => value.parameters[k]);
    switch (value.name) {
      case "present": {
        if (args.length !== 1 || !isVariable(args[0])) {
          this.problem(line, tag, "present() takes one reference", "write present($stage.Output)");
          return undefined;
        }
        const ref = this.ref(args[0].path, line, tag);
        return ref === undefined ? undefined : { fn: "present", ref };
      }
      case "equals":
      case "any":
      case "all": {
        if (args.length !== 2 || !isVariable(args[0]) || typeof args[1] !== "string") {
          this.problem(line, tag, `${value.name}() takes a reference and a quoted value`, `write ${value.name}($stage.Output, "value")`);
          return undefined;
        }
        const ref = this.ref(args[0].path, line, tag);
        return ref === undefined ? undefined : { fn: value.name, ref, value: args[1] };
      }
      case "not": {
        if (args.length !== 1) {
          this.problem(line, tag, "not() takes one condition", 'write not(equals($stage.Output, "value"))');
          return undefined;
        }
        const arg = this.cond(args[0], line, tag);
        return arg === undefined ? undefined : { fn: "not", arg };
      }
      default: {
        if (args.length < 2) {
          this.problem(line, tag, `${value.name}() takes at least two conditions`, `write ${value.name}(present($a.X), present($b.Y))`);
          return undefined;
        }
        const compiled = args.map((a) => this.cond(a, line, tag));
        if (compiled.some((c) => c === undefined)) return undefined;
        return { fn: value.name as "and" | "or", args: compiled as Cond[] };
      }
    }
  }
}

type PendingCond = { cond: Cond; line: number; tag: string };
type PendingRef = { ref: string; line: number; tag: string; segment?: Extract<Segment, { type: "ref" }> };
type StageDraft = {
  stage: CompiledStage;
  line: number;
  start: boolean;
  conds: PendingCond[];
  refs: PendingRef[];
  edgeLines: number[];
  outputLines: Map<string, number>;
  deriveLines: Map<string, { line: number; cases: number[] }>;
};

function parseAllow(c: Compiler, node: TagNode, attrs: Record<string, unknown>): CompiledAllow {
  const allow: CompiledAllow = {};
  if (typeof attrs.skills === "string") allow.skills = listAttr(attrs.skills);
  if (typeof attrs.edits === "boolean") allow.edits = attrs.edits;
  if (typeof attrs.subagents === "string")
    allow.subagents = listAttr(attrs.subagents).map((item) => {
      const at = item.indexOf("@");
      const agent = at < 0 ? item : item.slice(0, at).trim();
      const model = at < 0 ? "" : item.slice(at + 1).trim();
      if (agent === "" && model === "") c.problem(node.line, "allow", `subagent "${item}" names no agent or model`, 'write subagents="scout, implementer-medium@provider/model"');
      return { ...(agent === "" ? {} : { agent }), ...(model === "" ? {} : { model }) };
    });
  if (typeof attrs.deny === "string") allow.denyTools = listAttr(attrs.deny);
  return allow;
}

function parseRule(c: Compiler, node: TagNode, attrs: Record<string, unknown>): CompiledRule | undefined {
  const type = attrs.type as string;
  const allowed = GATE_ATTRS[type];
  if (allowed === undefined) {
    c.problem(node.line, "gate", `unknown gate type "${type}"`, `use type= one of: ${Object.keys(GATE_ATTRS).join(", ")}`);
    return undefined;
  }
  const extra = Object.keys(attrs).filter((a) => a !== "type" && !allowed.includes(a));
  if (extra.length > 0) {
    c.problem(node.line, "gate", `a ${type} gate takes no ${extra.join(", ")}`, allowed.length === 0 ? `write {% gate type="${type}" /%}` : `use only: ${allowed.join(", ")}`);
    return undefined;
  }
  const str = (key: string): string | undefined => (typeof attrs[key] === "string" ? (attrs[key] as string) : undefined);
  switch (type) {
    case "outputs":
      return { type: "outputs" };
    case "user": {
      const prompt = str("prompt");
      return prompt === undefined ? { type: "user" } : { type: "user", prompt };
    }
    case "check": {
      const command = str("command");
      if (command === undefined || command.trim() === "") {
        c.problem(node.line, "gate", "a check gate needs command=", 'add command="pnpm test"');
        return undefined;
      }
      const timeout = attrs.timeout as number | undefined;
      if (timeout !== undefined && timeout > 1800) c.problem(node.line, "gate", "timeout is above 1800 seconds", "use timeout= of at most 1800");
      const label = str("label");
      return { type: "check", command, ...(label === undefined ? {} : { label }), ...(timeout === undefined ? {} : { timeoutSec: timeout }) };
    }
    case "evidence": {
      const name = str("name");
      if (name === undefined || !EVIDENCE_NAME.test(name)) {
        c.problem(node.line, "gate", "an evidence gate needs a lowercase name=", 'add name="tests" (a-z 0-9 _ -)');
        return undefined;
      }
      if (attrs.ran === false) c.problem(node.line, "gate", "ran=false is the default", "leave ran out or write ran=true");
      const description = str("description");
      return { type: "evidence", name, ...(description === undefined ? {} : { description }), ...(attrs.ran === true ? { ran: true as const } : {}) };
    }
    default: {
      if (attrs.optional === false) c.problem(node.line, "gate", "optional=false is the default", "leave optional out or write optional=true");
      const label = str("label");
      return { type: "goal", ...(label === undefined ? {} : { label }), ...(attrs.optional === true ? { optional: true as const } : {}) };
    }
  }
}

function blankText(node: Node): boolean {
  return node.kind === "text" && node.text.trim() === "";
}

function mergeText(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (segment.type === "text" && last?.type === "text") out[out.length - 1] = { type: "text", text: last.text + segment.text };
    else out.push(segment);
  }
  return out;
}

function compileStage(c: Compiler, node: TagNode, attrs: Record<string, unknown>): StageDraft {
  const id = attrs.id as string;
  if (!STAGE_ID.test(id)) c.problem(node.line, "stage", `stage id "${id}" is not a lowercase id`, "use a-z 0-9 _ - and at most 48 characters, starting with a letter or digit");
  if (RESERVED_STAGE_IDS.includes(id)) c.problem(node.line, "stage", `"${id}" is reserved and cannot be a stage id`, "pick another id");
  const draft: StageDraft = {
    stage: { id, title: typeof attrs.title === "string" && attrs.title.trim() !== "" ? attrs.title : id, inputs: [], outputs: [], gate: [], next: [], template: [] },
    line: node.line,
    start: attrs.start === true,
    conds: [],
    refs: [],
    edgeLines: [],
    outputLines: new Map(),
    deriveLines: new Map(),
  };
  const stage = draft.stage;
  if (attrs.gate !== undefined) {
    if (attrs.gate === "user") stage.gate.push({ type: "user" });
    else c.problem(node.line, "stage", `gate="${String(attrs.gate)}" is not a shorthand`, 'write gate="user", or use {% gate type="..." /%} inside the stage');
  }
  if (typeof attrs.autopilot === "string") {
    if (!AUTOPILOT_NAME.test(attrs.autopilot)) c.problem(node.line, "stage", `autopilot "${attrs.autopilot}" is not a valid name`, "use a-z 0-9 - and at most 48 characters");
    stage.autopilot = { name: attrs.autopilot, ...(typeof attrs.args === "string" ? { args: attrs.args } : {}) };
  } else if (attrs.args !== undefined) c.problem(node.line, "stage", "args= needs autopilot=", 'add autopilot="name" or remove args=');
  const inputs: string[] = [];
  const addInput = (entry: string): void => {
    if (!inputs.includes(entry)) inputs.push(entry);
  };
  const noteRef = (ref: string): void => {
    const parsed = parseRef(ref);
    if (parsed !== undefined && parsed.stage !== id && parsed.stage !== INPUT_SCOPE) addInput(ref);
  };
  const noteCond = (cond: Cond, line: number, tag: string): void => {
    draft.conds.push({ cond, line, tag });
    for (const ref of condRefs(cond)) {
      draft.refs.push({ ref, line, tag });
      noteRef(ref);
    }
  };

  const templateOf = (children: Node[], inIf: boolean): Segment[] => {
    const segments: Segment[] = [];
    for (const child of children) {
      if (child.kind === "text") {
        segments.push({ type: "text", text: child.text });
        continue;
      }
      if (child.kind === "var") {
        const ref = c.ref(child.path, child.line, "variable");
        if (ref === undefined) continue;
        const segment: Extract<Segment, { type: "ref" }> = { type: "ref", ref };
        draft.refs.push({ ref, line: child.line, tag: "variable", segment });
        noteRef(ref);
        segments.push(segment);
        continue;
      }
      if (child.name === "if") {
        const a = c.attrs(child);
        if (a === undefined) continue;
        const cond = c.cond(a.primary, child.line, "if");
        const split = child.children.findIndex((n) => n.kind === "tag" && n.name === "else");
        const elseTags = child.children.filter((n) => n.kind === "tag" && n.name === "else") as TagNode[];
        for (const extra of elseTags.slice(1)) c.problem(extra.line, "else", "an if has at most one else", "remove the second {% else /%}");
        for (const e of elseTags) c.attrs(e);
        const thenNodes = split < 0 ? child.children : child.children.slice(0, split);
        const elseNodes = split < 0 ? [] : child.children.slice(split + 1).filter((n) => !(n.kind === "tag" && n.name === "else"));
        if (cond !== undefined) noteCond(cond, child.line, "if");
        const then = templateOf(thenNodes, true);
        const otherwise = templateOf(elseNodes, true);
        if (cond !== undefined) segments.push({ type: "if", cond, then, else: otherwise });
        continue;
      }
      if (child.name === "else") {
        c.problem(child.line, "else", "{% else /%} outside an if", "put it inside {% if ... %}...{% /if %}");
        continue;
      }
      if (inIf) {
        if (TAGS[child.name] === undefined) c.attrs(child);
        else c.problem(child.line, child.name, `{% ${child.name} %} inside an if`, `an if only changes text: move {% ${child.name} %} out of the if, directly into the stage`);
        continue;
      }
      structural(child);
    }
    return mergeText(segments);
  };

  const structural = (child: TagNode): void => {
    const a = c.attrs(child);
    if (a === undefined) return;
    switch (child.name) {
      case "needs": {
        const entry = (a.primary as string).trim();
        if (entry === "") c.problem(child.line, "needs", "needs is empty", 'write {% needs "frame.Musts" /%} or {% needs "the approved plan" /%}');
        else {
          if (entry.includes(".")) draft.refs.push({ ref: entry, line: child.line, tag: "needs" });
          addInput(entry);
        }
        return;
      }
      case "output": {
        const name = a.name as string;
        if (!FIELD_NAME.test(name)) c.problem(child.line, "output", `output name "${name}" is not valid`, "use [A-Za-z][A-Za-z0-9_]*, at most 48 characters");
        if (draft.outputLines.has(name) || draft.deriveLines.has(name))
          c.problem(child.line, "output", `stage "${id}" names "${name}" twice`, "give each output and derived value its own name");
        draft.outputLines.set(name, child.line);
        const type = typeof a.type === "string" ? a.type.trim() : "text";
        const field: CompiledField = { name };
        if (typeof a.description === "string") field.description = a.description;
        if (a.optional === true) field.optional = true;
        if (type !== "text") field.type = type;
        stage.outputs.push(field);
        return;
      }
      case "gate": {
        const rule = parseRule(c, child, a);
        if (rule !== undefined) stage.gate.push(rule);
        return;
      }
      case "allow": {
        if (stage.allow !== undefined) c.problem(child.line, "allow", `stage "${id}" has two allow tags`, "merge them into one");
        stage.allow = parseAllow(c, child, a);
        return;
      }
      case "next": {
        const edge: CompiledEdge = { to: (a.to as string).trim() };
        if (typeof a.label === "string") edge.when = a.label;
        if (a.when !== undefined) {
          const cond = c.cond(a.when, child.line, "next");
          if (cond !== undefined) {
            edge.cond = cond;
            noteCond(cond, child.line, "next");
          }
        }
        if (typeof a.max === "number") edge.max = a.max;
        if (a.exceeded !== undefined) {
          if (a.exceeded !== "owner") c.problem(child.line, "next", `exceeded="${String(a.exceeded)}" is not supported`, 'write exceeded="owner"');
          else if (edge.max === undefined) c.problem(child.line, "next", "exceeded= needs max=", "add max=2 or remove exceeded=");
          else edge.exceeded = "owner";
        }
        const rules: CompiledRule[] = [];
        for (const inner of child.children) {
          if (blankText(inner)) continue;
          if (inner.kind === "tag" && inner.name === "gate") {
            const ia = c.attrs(inner);
            const rule = ia === undefined ? undefined : parseRule(c, inner, ia);
            if (rule !== undefined) rules.push(rule);
          } else
            c.problem(
              inner.line,
              inner.kind === "tag" ? inner.name : "text",
              "a next body holds only gate tags",
              "move the text or tag out of {% next %}...{% /next %}",
            );
        }
        if (rules.length > 0) edge.gate = rules;
        stage.next.push(edge);
        draft.edgeLines.push(child.line);
        return;
      }
      case "derive": {
        const name = a.name as string;
        if (!FIELD_NAME.test(name)) c.problem(child.line, "derive", `derived name "${name}" is not valid`, "use [A-Za-z][A-Za-z0-9_]*, at most 48 characters");
        if (draft.outputLines.has(name) || draft.deriveLines.has(name))
          c.problem(child.line, "derive", `stage "${id}" names "${name}" twice`, "give each output and derived value its own name");
        const cases: { value: string; when?: Cond }[] = [];
        const caseLines: number[] = [];
        for (const inner of child.children) {
          if (blankText(inner)) continue;
          if (inner.kind !== "tag" || inner.name !== "case") {
            c.problem(inner.line, inner.kind === "tag" ? inner.name : "text", "a derive body holds only case tags", 'write {% case value="..." when=... /%} lines');
            continue;
          }
          const ca = c.attrs(inner);
          if (ca === undefined) continue;
          const entry: { value: string; when?: Cond } = { value: ca.value as string };
          if (ca.when !== undefined) {
            const cond = c.cond(ca.when, inner.line, "case");
            if (cond !== undefined) {
              entry.when = cond;
              noteCond(cond, inner.line, "case");
            }
          }
          cases.push(entry);
          caseLines.push(inner.line);
        }
        draft.deriveLines.set(name, { line: child.line, cases: caseLines });
        stage.derive = [...(stage.derive ?? []), { name, type: (a.type as string).trim(), cases }];
        return;
      }
      case "case":
        c.problem(child.line, "case", "{% case %} outside a derive", "put it inside {% derive ... %}...{% /derive %}");
        return;
      default:
        c.problem(child.line, child.name, `{% ${child.name} %} is not valid inside a stage`, `move it before the first stage`);
    }
  };

  const body = templateOf(node.children, false);
  const skill = typeof attrs.skill === "string" ? attrs.skill.trim() : "";
  stage.template = mergeText(skill === "" ? body : [{ type: "text", text: `Use the skill ${skill}.\n\n` }, ...body]);
  const description = describeTemplate(stage.template);
  if (description !== "") stage.description = description;
  stage.inputs = inputs;
  return draft;
}

function check(c: Compiler, machine: CompiledMachine, drafts: StageDraft[], inputLines: Map<string, number>, results: { line: number; from: string }[]): void {
  const symbols = new Map<string, Symbol>();
  for (const input of machine.inputs ?? []) {
    const parsed = parseType(input.type ?? "text");
    if (!parsed.ok) c.problem(inputLines.get(input.name) ?? 1, "input", parsed.error, "use type=text or a choice(...)");
    else if (parsed.type.kind !== "text" && parsed.type.kind !== "choice")
      c.problem(inputLines.get(input.name) ?? 1, "input", "a run input is text or a choice", "use type=text or a choice(...)");
    else symbols.set(`${INPUT_SCOPE}.${input.name}`, { type: parsed.type, kind: "input" });
  }
  for (const draft of drafts) {
    for (const output of draft.stage.outputs) {
      const parsed = parseType(output.type ?? "text");
      const line = draft.outputLines.get(output.name) ?? draft.line;
      if (!parsed.ok) c.problem(line, "output", parsed.error, "fix type=");
      else symbols.set(`${draft.stage.id}.${output.name}`, { type: parsed.type, kind: "output" });
    }
    for (const derive of draft.stage.derive ?? []) {
      const lines = draft.deriveLines.get(derive.name);
      const line = lines?.line ?? draft.line;
      const parsed = parseType(derive.type);
      if (!parsed.ok || parsed.type.kind !== "choice") {
        c.problem(line, "derive", parsed.ok ? "a derived value is a choice" : parsed.error, 'write type="choice(a, b)"');
        continue;
      }
      symbols.set(`${draft.stage.id}.${derive.name}`, { type: parsed.type, kind: "derive" });
      const options = parsed.type.options;
      if (derive.cases.length === 0) c.problem(line, "derive", `derive ${derive.name} has no case`, 'add {% case value="..." /%} lines, the last one without when=');
      derive.cases.forEach((entry, i) => {
        const caseLine = lines?.cases[i] ?? line;
        if (!options.includes(entry.value)) c.problem(caseLine, "case", `"${entry.value}" is not one of: ${options.join(", ")}`, `use a value of ${derive.type}`);
        const last = i === derive.cases.length - 1;
        if (last && entry.when !== undefined) c.problem(caseLine, "case", `the last case of ${derive.name} has when=`, "end with a fallback case without when=");
        if (!last && entry.when === undefined) c.problem(caseLine, "case", "only the last case may leave out when=", "add when=... or move this case to the end");
      });
    }
  }
  const describeKnown = (stage: string): string => {
    const names = [...symbols.keys()].filter((k) => k.startsWith(`${stage}.`)).map((k) => `$${k}`);
    return names.length === 0 ? "it declares nothing to reference" : `use one of: ${names.join(", ")}`;
  };
  const resolve = (ref: string, line: number, tag: string): Symbol | undefined => {
    const parsed = parseRef(ref);
    if (parsed === undefined) {
      c.problem(line, tag, `"${ref}" is not a stage.Output reference`, "write stage.Output, for example frame.Musts");
      return undefined;
    }
    const symbol = symbols.get(`${parsed.stage}.${parsed.name}`);
    if (symbol !== undefined) return symbol;
    if (parsed.stage === INPUT_SCOPE) c.problem(line, tag, `$input.${parsed.name} is not a run input`, `declare {% input name="${parsed.name}" /%} or ${describeKnown(INPUT_SCOPE)}`);
    else if (!drafts.some((d) => d.stage.id === parsed.stage))
      c.problem(line, tag, `no stage "${parsed.stage}" for $${parsed.stage}.${parsed.name}`, `use one of the stages: ${drafts.map((d) => d.stage.id).join(", ")}`);
    else c.problem(line, tag, `stage "${parsed.stage}" has no output ${parsed.name}`, describeKnown(parsed.stage));
    return undefined;
  };
  for (const output of drafts.flatMap((d) => d.stage.outputs.map((o) => ({ d, o })))) {
    const symbol = symbols.get(`${output.d.stage.id}.${output.o.name}`);
    if (symbol?.type.kind !== "map") continue;
    const line = output.d.outputLines.get(output.o.name) ?? output.d.line;
    const list = resolve(symbol.type.list, line, "output");
    if (list !== undefined && list.type.kind !== "list") c.problem(line, "output", `map key $${symbol.type.list} is not a list output`, "point map(...) at a list(...) output");
  }
  for (const draft of drafts) {
    for (const pending of draft.refs) {
      const symbol = resolve(pending.ref, pending.line, pending.tag);
      if (symbol !== undefined && pending.segment !== undefined && symbol.type.kind === "map") pending.segment.list = symbol.type.list;
    }
    for (const pending of draft.conds) checkCond(c, pending.cond, pending.line, pending.tag, symbols);
    const ids = new Set(drafts.map((d) => d.stage.id));
    const decided = draft.stage.next.some((e) => e.cond !== undefined);
    draft.stage.next.forEach((edge, i) => {
      const line = draft.edgeLines[i] ?? draft.line;
      if (edge.to !== DONE_STAGE && !ids.has(edge.to))
        c.problem(line, "next", `next to="${edge.to}" is not a stage`, `use one of: ${[...ids, DONE_STAGE].join(", ")}`);
      if (edge.max !== undefined && !decided)
        c.problem(line, "next", "max= only counts on a stage the track decides", "add when= conditions to this stage's next tags or remove max=");
      if (decided && edge.cond === undefined && i !== draft.stage.next.length - 1)
        c.problem(line, "next", "a next without when= is the fallback and must come last", "move it after the next tags with when=");
      if (draft.stage.next.findIndex((e) => e.to === edge.to) !== i)
        c.problem(line, "next", `stage "${draft.stage.id}" has two next tags to "${edge.to}"`, "merge them into one; join conditions with or(...)");
    });
  }
  for (const result of results) resolve(result.from, result.line, "result");
}

function checkCond(c: Compiler, cond: Cond, line: number, tag: string, symbols: Map<string, Symbol>): void {
  switch (cond.fn) {
    case "not":
      checkCond(c, cond.arg, line, tag, symbols);
      return;
    case "and":
    case "or":
      for (const arg of cond.args) checkCond(c, arg, line, tag, symbols);
      return;
    case "present":
      return;
    default: {
      const symbol = symbols.get(cond.ref);
      if (symbol === undefined) return;
      const type = symbol.type;
      if (type.kind === "text" || (type.kind === "list" && type.of.kind === "text")) {
        c.problem(line, tag, `${cond.fn}() on $${cond.ref}, which is free text`, `a condition on text may only use present($${cond.ref}); give the output a choice(...) type to branch on it`);
        return;
      }
      if (cond.fn === "equals" && type.kind !== "choice") {
        c.problem(line, tag, `equals() on $${cond.ref}, which holds several values`, `use any($${cond.ref}, "${cond.value}") or all(...)`);
        return;
      }
      if (cond.fn !== "equals" && type.kind === "choice") {
        c.problem(line, tag, `${cond.fn}() on $${cond.ref}, which holds one value`, `use equals($${cond.ref}, "${cond.value}")`);
        return;
      }
      const options = type.kind === "list" ? (type.of.kind === "choice" ? type.of.options : []) : type.options;
      if (!options.includes(cond.value))
        c.problem(line, tag, `"${cond.value}" is never a value of $${cond.ref}`, `use one of: ${options.join(", ")}`);
    }
  }
}

function splitSource(source: string, file: string): { problems: Problem[]; fields: Record<string, string>; metadata: Record<string, string>; body: string; bodyLine: number } {
  const front = readFrontmatter(source);
  if (front === undefined)
    return {
      problems: [{ file, line: 1, tag: "frontmatter", message: "the file has no frontmatter", fix: "start the file with ---, name:, description:, metadata: dialect: \"1\", ---" }],
      fields: {},
      metadata: {},
      body: "",
      bodyLine: 0,
    };
  return { problems: [], fields: front.fields, metadata: front.metadata, body: source.slice(front.bodyStart), bodyLine: front.bodyLine };
}

export function parseSkill(source: string, file: string): { ok: true; machine: CompiledMachine } | { ok: false; problems: Problem[] } {
  const split = splitSource(source, file);
  if (split.problems.length > 0) return { ok: false, problems: split.problems };
  const c = new Compiler(file, split.body, split.bodyLine);
  if (split.metadata.dialect !== DIALECT_VERSION)
    c.problem(1, "frontmatter", `metadata.dialect is "${split.metadata.dialect ?? ""}"`, `set metadata: dialect: "${DIALECT_VERSION}"`);
  const name = split.fields.name ?? "";
  if (!STAGE_ID.test(name)) c.problem(1, "frontmatter", `name "${name}" is not a lowercase id`, "set name: to a-z 0-9 _ -, at most 48 characters");
  const nodes = c.tree(pieces(split.body, split.bodyLine));
  const drafts: StageDraft[] = [];
  const machineInputs: CompiledField[] = [];
  const inputLines = new Map<string, number>();
  const results: { line: number; from: string; name: string }[] = [];
  let machineAllow: CompiledAllow | undefined;
  let preamble = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      if (drafts.length === 0) preamble += node.text;
      else if (node.text.trim() !== "")
        c.problem(node.line, "text", "text after the first stage is outside every stage", "move it into a stage or before the first stage");
      continue;
    }
    if (node.kind === "var") {
      c.problem(node.line, "variable", "a variable outside a stage", "use variables only inside {% stage %}...{% /stage %}");
      continue;
    }
    if (TAGS[node.name] === undefined) {
      c.attrs(node);
      continue;
    }
    if (!["input", "allow", "result", "stage"].includes(node.name)) {
      c.problem(node.line, node.name, `{% ${node.name} %} is only valid inside a stage`, `move it into a {% stage %}`);
      continue;
    }
    const attrs = c.attrs(node);
    if (attrs === undefined) continue;
    if (node.name === "stage") drafts.push(compileStage(c, node, attrs));
    else if (node.name === "input") {
      const inputName = attrs.name as string;
      if (!FIELD_NAME.test(inputName)) c.problem(node.line, "input", `input name "${inputName}" is not valid`, "use [A-Za-z][A-Za-z0-9_]*, at most 48 characters");
      if (inputLines.has(inputName)) c.problem(node.line, "input", `input ${inputName} is declared twice`, "remove one of them");
      inputLines.set(inputName, node.line);
      const field: CompiledField = { name: inputName };
      if (typeof attrs.description === "string") field.description = attrs.description;
      if (attrs.optional === true) field.optional = true;
      const type = typeof attrs.type === "string" ? attrs.type.trim() : "text";
      if (type !== "text") field.type = type;
      machineInputs.push(field);
    } else if (node.name === "allow") {
      if (machineAllow !== undefined) c.problem(node.line, "allow", "two top-level allow tags", "merge them into one");
      machineAllow = parseAllow(c, node, attrs);
    } else {
      const from = (attrs.from as MarkdocVariable).path;
      const ref = c.ref(from, node.line, "result");
      if (ref !== undefined) results.push({ line: node.line, from: ref, name: attrs.name as string });
    }
  }
  if (drafts.length === 0) c.problem(split.bodyLine + 1, "stage", "the skill has no stage", 'add {% stage id="first" %}...{% /stage %}');
  const starts = drafts.filter((d) => d.start);
  for (const extra of starts.slice(1)) c.problem(extra.line, "stage", "two stages have start=true", "keep start=true on one stage");
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (seen.has(draft.stage.id)) c.problem(draft.line, "stage", `stage id "${draft.stage.id}" is used twice`, "give each stage its own id");
    seen.add(draft.stage.id);
  }
  const title = /^#[ \t]+(.+?)[ \t#]*$/m.exec(preamble)?.[1]?.trim();
  const machine: CompiledMachine = { id: name, title: title ?? name, stages: drafts.map((d) => d.stage) };
  if (split.fields.description !== undefined && split.fields.description !== "") machine.description = split.fields.description;
  if (starts[0] !== undefined) machine.start = starts[0].stage.id;
  if (machineAllow !== undefined) machine.allow = machineAllow;
  if (machineInputs.length > 0) machine.inputs = machineInputs;
  if (results.length > 0) machine.result = results.map((r) => ({ name: r.name, from: r.from }));
  check(c, machine, drafts, inputLines, results);
  if (c.problems.length > 0) return { ok: false, problems: [...c.problems].sort((a, b) => a.line - b.line) };
  return { ok: true, machine };
}

export function formatProblem(problem: Problem): string {
  return `${problem.file}:${problem.line} ${problem.tag}: ${problem.message} — ${problem.fix}`;
}

function inputLine(attrs: { name: string; type?: string; description?: string; optional?: boolean }): string {
  const kind = [attrs.type ?? "text", ...(attrs.optional === true ? ["optional"] : [])].join(", ");
  return `- Input ${attrs.name} (${kind})${attrs.description === undefined ? "" : `: ${attrs.description}`}`;
}

export function renderPreamble(source: string): string {
  const split = splitSource(source, "");
  let out = "";
  for (const piece of pieces(split.body, split.bodyLine)) {
    if (piece.kind === "text") {
      out += piece.text;
      continue;
    }
    const token = piece.token;
    if (token.type === "tag_open" && token.meta?.tag === "stage") break;
    if (token.type !== "tag" || token.meta?.tag !== "input") continue;
    const attrs: Record<string, unknown> = {};
    for (const a of token.meta.attributes ?? []) attrs[a.name] = a.value;
    if (typeof attrs.name !== "string") continue;
    out += `\n${inputLine({
      name: attrs.name,
      ...(typeof attrs.type === "string" ? { type: attrs.type } : {}),
      ...(typeof attrs.description === "string" ? { description: attrs.description } : {}),
      ...(attrs.optional === true ? { optional: true } : {}),
    })}`;
  }
  return tidy(out);
}

export function renderTrackSkillRead(source: string): string | undefined {
  const front = readFrontmatter(source);
  if (front === undefined || front.metadata.dialect === undefined) return undefined;
  const name = front.fields.name ?? "";
  const inputs: string[] = [];
  for (const token of Markdoc.parseTags(source.slice(front.bodyStart), front.bodyLine) as Token[]) {
    if (token.type === "tag_open" && token.meta?.tag === "stage") break;
    if (token.type !== "tag" || token.meta?.tag !== "input") continue;
    const nameAttr = (token.meta.attributes ?? []).find((a) => a.name === "name")?.value;
    if (typeof nameAttr === "string") inputs.push(nameAttr);
  }
  const call = `stage_start({skill: ${JSON.stringify(name)}, inputs: {${inputs.map((i) => `${JSON.stringify(i)}: "..."`).join(", ")}}})`;
  return `---\n${front.raw}\n---\n\n${renderPreamble(source)}\n\nThis skill runs as a track: call ${call}; stage_status shows the current stage.\n`;
}
