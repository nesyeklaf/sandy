import type { AuditExtras } from "../ui/core-tool-render.js";
import type { FabricLegacyRenderAudit, FabricPersistedExecutionDetailsV1 } from "./details.js";

/**
 * Session entry (`pi.appendEntry`) that carries a bounded, privacy-projected copy of one
 * fabric_exec render for hosts that cannot render pi's tool-result details (SANDY's
 * `fabric-render` plugin reads it from the thread log and joins it by `toolCallId`).
 */
export const FABRIC_RENDER_ENTRY_TYPE = "fabric-render";
export const FABRIC_RENDER_SCHEMA_VERSION = 1;
export const FABRIC_RENDER_ENTRY_MAX_BYTES = 64 * 1024;

const ARG_STRING_MAX = 200;
const RESULT_STRING_MAX = 600;
const DIFF_MAX = 8000;
const COMMAND_MAX = 2000;
const OUTPUT_MAX = 3000;
const MAX_AUDITS_FLOOR = 8;

export interface FabricRenderEntryAudit {
  ref: string;
  tool?: string;
  provider?: string;
  success?: boolean;
  error?: string;
  /** String leaves shortened; nested values flattened to a short JSON text. */
  args?: Record<string, string>;
  /** Short text of the result; never the full value. */
  result?: string;
  resultTruncated?: boolean;
  /** Edit/write diff in pi's line format (`@@ n @@`, ` N text`, `-N text`, `+N text`), bounded. */
  diff?: string;
  /** Content of a file that `write` created, bounded. */
  content?: string;
  /** Line count of the content before it was shortened (read). */
  lines?: number;
  /** Full bash command, bounded. */
  command?: string;
  /** Last lines of the bash output, bounded. */
  output?: string;
  exitCode?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface FabricRenderEntryV1 {
  schemaVersion: typeof FABRIC_RENDER_SCHEMA_VERSION;
  toolCallId: string;
  display?: { name?: string; description?: string };
  success: boolean;
  error?: string;
  phases: string[];
  auditCount: number;
  audits: FabricRenderEntryAudit[];
  /** True when audits were dropped, shortened or cut to fit the size limit. */
  truncated: boolean;
}

const shorten = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const asText = (value: unknown, max: number): string => {
  if (typeof value === "string") return shorten(value, max);
  try {
    return shorten(JSON.stringify(value) ?? String(value), max);
  } catch {
    return "[unserializable]";
  }
};

const projectAudit = (
  audit: FabricLegacyRenderAudit,
  extrasFor?: (audit: FabricLegacyRenderAudit) => AuditExtras,
): FabricRenderEntryAudit => {
  const extras = extrasFor?.(audit) ?? {};
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(audit.args ?? {})) args[key] = asText(value, ARG_STRING_MAX);
  return {
    ref: audit.ref,
    ...(audit.tool !== undefined ? { tool: audit.tool } : {}),
    ...(audit.provider !== undefined ? { provider: audit.provider } : {}),
    ...(audit.success !== undefined ? { success: audit.success } : {}),
    ...(audit.error !== undefined ? { error: shorten(audit.error, ARG_STRING_MAX) } : {}),
    ...(Object.keys(args).length > 0 ? { args } : {}),
    ...(audit.result !== undefined ? { result: asText(audit.result, RESULT_STRING_MAX) } : {}),
    ...(audit.resultTruncated === true ? { resultTruncated: true } : {}),
    ...(extras.diff ? { diff: shorten(extras.diff, DIFF_MAX) } : {}),
    ...(extras.content ? { content: shorten(extras.content, DIFF_MAX) } : {}),
    ...(extras.lines !== undefined ? { lines: extras.lines } : {}),
    ...(extras.command ? { command: shorten(extras.command, COMMAND_MAX) } : {}),
    ...(extras.output ? { output: extras.output.length <= OUTPUT_MAX ? extras.output : `…${extras.output.slice(-(OUTPUT_MAX - 1))}` } : {}),
    ...(extras.exitCode !== undefined ? { exitCode: extras.exitCode } : {}),
    ...(audit.startedAt !== undefined ? { startedAt: audit.startedAt } : {}),
    ...(audit.endedAt !== undefined ? { endedAt: audit.endedAt } : {}),
  };
};

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Builds the entry data, or undefined when nothing can be rendered. The entry is bounded:
 * past the size limit results and args go first, then the oldest audits.
 */
export const createFabricRenderEntry = (input: {
  toolCallId: string;
  display?: { name?: string; description?: string };
  details: Pick<FabricPersistedExecutionDetailsV1, "success" | "audits" | "phases" | "error">;
  maxBytes?: number;
  /** Supplies diff, content, command and output of an audit; the entry module stays free of UI code. */
  extrasFor?: (audit: FabricLegacyRenderAudit) => AuditExtras;
}): FabricRenderEntryV1 => {
  const max = input.maxBytes ?? FABRIC_RENDER_ENTRY_MAX_BYTES;
  const display = {
    ...(input.display?.name ? { name: shorten(input.display.name, ARG_STRING_MAX) } : {}),
    ...(input.display?.description ? { description: shorten(input.display.description, ARG_STRING_MAX * 2) } : {}),
  };
  let audits = input.details.audits.map((audit) => projectAudit(audit, input.extrasFor));
  const entry = (): FabricRenderEntryV1 => ({
    schemaVersion: FABRIC_RENDER_SCHEMA_VERSION,
    toolCallId: input.toolCallId,
    ...(Object.keys(display).length > 0 ? { display } : {}),
    success: input.details.success,
    ...(input.details.error ? { error: shorten(input.details.error, 500) } : {}),
    phases: input.details.phases.slice(0, 20).map((phase) => shorten(phase, ARG_STRING_MAX)),
    auditCount: input.details.audits.length,
    audits,
    truncated,
  });
  let truncated = false;
  if (bytes(entry()) > max) {
    truncated = true;
    audits = audits.map(({ diff: _d, content: _c, output: _o, ...rest }) => rest);
  }
  if (bytes(entry()) > max) {
    audits = audits.map(({ result: _result, args: _args, ...rest }) => rest);
  }
  while (bytes(entry()) > max && audits.length > MAX_AUDITS_FLOOR) {
    truncated = true;
    audits = audits.slice(Math.ceil(audits.length / 2));
  }
  return entry();
};
