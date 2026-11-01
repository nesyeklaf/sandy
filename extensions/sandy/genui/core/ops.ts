// Ops: what agents show around changes to real systems. Approval lists the
// writes a step is about to make (files, deletes, posts to other services,
// temporary files, commands) before the user agrees; Hosts reads a run over
// many hosts grouped by outcome; Runbook is steps the user carries out
// themselves; Job is a long run's status file, read again while it runs.
// Pure readers: the UI (ui/components/ops.tsx) and the markdown fallback
// share them.
import type { Value } from "./types";

type Fields = { readonly [key: string]: Value };

function str(value: Value | undefined): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function fields(value: Value | undefined): Fields | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}

function pick(item: Fields, keys: readonly string[]): string | null {
  for (const key of keys) {
    const found = str(item[key]);
    if (found !== null) return found;
  }
  return null;
}

function strings(value: Value | undefined): string[] {
  if (Array.isArray(value)) return value.map((entry) => str(entry)).filter((entry): entry is string => entry !== null);
  const one = str(value);
  return one === null ? [] : one.split(/\s*,\s*/).filter((entry) => entry !== "");
}

export type OpsRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const MAX_ROWS = 500;

// ---------------------------------------------------------------------------
// Approval

export type ChangeKind = "write" | "delete" | "external" | "temp" | "run";

export const CHANGE_KINDS: readonly ChangeKind[] = ["delete", "external", "write", "run", "temp"];

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  delete: "Deletes",
  external: "Writes outside",
  write: "Writes",
  run: "Runs",
  temp: "Temporary",
};

const KIND_WORDS: Readonly<Record<string, ChangeKind>> = {
  write: "write", writes: "write", edit: "write", create: "write", modify: "write", update: "write", file: "write",
  delete: "delete", deletes: "delete", remove: "delete", rm: "delete", drop: "delete",
  external: "external", post: "external", publish: "external", push: "external", comment: "external", api: "external", remote: "external",
  temp: "temp", temporary: "temp", tmp: "temp", scratch: "temp",
  run: "run", exec: "run", command: "run", shell: "run", restart: "run", deploy: "run",
};

export interface Change {
  readonly kind: ChangeKind;
  readonly target: string;
  readonly detail: string | null;
  readonly command: string | null;
  /** How to undo it; null when not said (shown as "no way back given" for deletes and outside writes). */
  readonly revert: string | null;
}

export interface ApprovalReport {
  readonly changes: readonly Change[];
  /** Deletes and outside writes that name no way back. */
  readonly irreversible: number;
}

const APPROVAL_HINT = "Approval takes a list of changes: [{kind: write|delete|external|temp|run, target, detail?, command?, revert?}]";

export function readApproval(value: Value | undefined): OpsRead<ApprovalReport> {
  if (!Array.isArray(value)) return { ok: false, error: APPROVAL_HINT };
  const changes: Change[] = [];
  for (const entry of value.slice(0, MAX_ROWS)) {
    const item = fields(entry);
    const target = item === null ? str(entry) : pick(item, ["target", "path", "file", "name", "url", "title"]);
    if (target === null) continue;
    const word = item === null ? null : pick(item, ["kind", "type", "action"]);
    const kind = KIND_WORDS[(word ?? "write").toLowerCase().split(/[\s_-]+/)[0] ?? ""] ?? "write";
    changes.push({
      kind,
      target,
      detail: item === null ? null : pick(item, ["detail", "note", "why", "description"]),
      command: item === null ? null : pick(item, ["command", "cmd", "run"]),
      revert: item === null ? null : pick(item, ["revert", "rollback", "undo", "backup"]),
    });
  }
  if (value.length > 0 && changes.length === 0) return { ok: false, error: APPROVAL_HINT };
  changes.sort((a, b) => CHANGE_KINDS.indexOf(a.kind) - CHANGE_KINDS.indexOf(b.kind));
  const irreversible = changes.filter((change) => (change.kind === "delete" || change.kind === "external") && change.revert === null).length;
  return { ok: true, value: { changes, irreversible } };
}

/** The message an approval sends: what was agreed to, so the agent's next turn has it in words. */
export function approvalMessage(report: ApprovalReport, approved: boolean, title: string | null): string {
  const what = title ?? `${report.changes.length} change${report.changes.length === 1 ? "" : "s"}`;
  if (!approved) return `Declined: ${what}. Don't make these changes.`;
  return [`Approved: ${what}.`, ...report.changes.map((change) => `- ${CHANGE_LABEL[change.kind]}: ${change.target}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Hosts

export type HostStatus = "failed" | "unreachable" | "changed" | "ok" | "skipped";

export const HOST_STATUSES: readonly HostStatus[] = ["failed", "unreachable", "changed", "ok", "skipped"];

export const HOST_LABEL: Record<HostStatus, string> = {
  failed: "Failed",
  unreachable: "Unreachable",
  changed: "Changed",
  ok: "OK",
  skipped: "Skipped",
};

const HOST_WORDS: Readonly<Record<string, HostStatus>> = {
  ok: "ok", success: "ok", succeeded: "ok", passed: "ok", done: "ok", good: "ok", unchanged: "ok", green: "ok",
  changed: "changed", updated: "changed", patched: "changed", applied: "changed",
  failed: "failed", failure: "failed", error: "failed", fatal: "failed", bad: "failed", red: "failed",
  unreachable: "unreachable", offline: "unreachable", down: "unreachable", timeout: "unreachable", timedout: "unreachable",
  skipped: "skipped", skip: "skipped", excluded: "skipped", ignored: "skipped", rescued: "skipped",
};

export interface Host {
  readonly host: string;
  readonly status: HostStatus;
  readonly detail: string | null;
  readonly log: string | null;
  /** Where this host was listed (inventories, reports, tickets). */
  readonly sources: readonly string[];
}

export interface SourceCombo {
  readonly sources: readonly string[];
  readonly count: number;
}

export interface HostsReport {
  readonly hosts: readonly Host[];
  readonly counts: Readonly<Record<HostStatus, number>>;
  /** Sets of sources hosts appear in, most hosts first; empty when no host names a source. */
  readonly combos: readonly SourceCombo[];
}

const HOSTS_HINT = "Hosts takes a list: [{host, status: ok|changed|failed|unreachable|skipped, detail?, log?, sources?}]";

export function hostStatus(raw: string | null): HostStatus {
  if (raw === null) return "ok";
  return HOST_WORDS[raw.toLowerCase().replace(/[\s_-]+/g, "")] ?? "failed";
}

export function readHosts(value: Value | undefined): OpsRead<HostsReport> {
  if (!Array.isArray(value)) return { ok: false, error: HOSTS_HINT };
  const hosts: Host[] = [];
  for (const entry of value.slice(0, 5000)) {
    const item = fields(entry);
    const host = item === null ? str(entry) : pick(item, ["host", "name", "hostname", "server", "machine"]);
    if (host === null) continue;
    hosts.push({
      host,
      status: hostStatus(item === null ? null : pick(item, ["status", "state", "result", "outcome"])),
      detail: item === null ? null : pick(item, ["detail", "note", "message", "msg", "error", "reason"]),
      log: item === null ? null : pick(item, ["log", "path", "output"]),
      sources: item === null ? [] : strings(item.sources ?? item.source ?? item.in),
    });
  }
  if (value.length > 0 && hosts.length === 0) return { ok: false, error: HOSTS_HINT };
  const counts = Object.fromEntries(HOST_STATUSES.map((status) => [status, hosts.filter((host) => host.status === status).length])) as Record<HostStatus, number>;
  const combos = new Map<string, SourceCombo>();
  for (const host of hosts) {
    if (host.sources.length === 0) continue;
    const sources = [...new Set(host.sources)].sort();
    const key = sources.join("\u0000");
    combos.set(key, { sources, count: (combos.get(key)?.count ?? 0) + 1 });
  }
  return { ok: true, value: { hosts, counts, combos: [...combos.values()].sort((a, b) => b.count - a.count || b.sources.length - a.sources.length) } };
}

export function hostsSummary(report: HostsReport): string {
  const parts = HOST_STATUSES.filter((status) => report.counts[status] > 0).map((status) => `${report.counts[status]} ${HOST_LABEL[status].toLowerCase()}`);
  return `${report.hosts.length} host${report.hosts.length === 1 ? "" : "s"}${parts.length === 0 ? "" : `: ${parts.join(", ")}`}`;
}

// ---------------------------------------------------------------------------
// Runbook

export interface RunbookStep {
  readonly title: string;
  readonly command: string | null;
  /** What the user should see when it worked. */
  readonly expected: string | null;
  readonly detail: string | null;
}

const RUNBOOK_HINT = "Runbook takes a list of steps: [{title, command?, expected?, detail?}]";

export function readRunbook(value: Value | undefined): OpsRead<readonly RunbookStep[]> {
  if (!Array.isArray(value)) return { ok: false, error: RUNBOOK_HINT };
  const steps: RunbookStep[] = [];
  for (const entry of value.slice(0, 100)) {
    const item = fields(entry);
    const title = item === null ? str(entry) : pick(item, ["title", "name", "step", "do"]);
    if (title === null) continue;
    steps.push({
      title,
      command: item === null ? null : pick(item, ["command", "cmd", "code", "run"]),
      expected: item === null ? null : pick(item, ["expected", "expect", "result", "see"]),
      detail: item === null ? null : pick(item, ["detail", "note", "why"]),
    });
  }
  if (value.length > 0 && steps.length === 0) return { ok: false, error: RUNBOOK_HINT };
  return { ok: true, value: steps };
}

/** What the user reports back after carrying out the steps, one line each that they marked. */
export function runbookMessage(steps: readonly RunbookStep[], marks: Readonly<Record<number, "worked" | "failed">>): string {
  if (steps.every((_, index) => marks[index] === undefined)) return "";
  // Every step is named, so "not done" cannot be mistaken for "not marked yet" by the agent.
  const lines = steps.map((step, index) => `${index + 1}. ${step.title}: ${marks[index] ?? "not marked"}`);
  return ["Runbook:", ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Job

export type JobState = "running" | "done" | "failed" | "unknown";

export interface JobStatus {
  readonly state: JobState;
  readonly phase: string | null;
  readonly message: string | null;
  /** 0..1 when known. */
  readonly progress: number | null;
  readonly done: number | null;
  readonly total: number | null;
  readonly eta: string | null;
  readonly exit: number | null;
  /** The last lines of a plain-text log. */
  readonly tail: readonly string[];
}

const JOB_WORDS: Readonly<Record<string, JobState>> = {
  running: "running", started: "running", pending: "running", queued: "running", inprogress: "running", active: "running",
  done: "done", finished: "done", success: "done", succeeded: "done", complete: "done", completed: "done", ok: "done",
  failed: "failed", error: "failed", failure: "failed", cancelled: "failed", canceled: "failed", aborted: "failed",
};

const TAIL_LINES = 6;

function num(value: Value | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value.replace(/%$/, "")))) return Number(value.replace(/%$/, ""));
  return null;
}

/**
 * A job's status file: JSON ({status, progress, total, phase, message, eta,
 * exit}) or a text log, finished when its last line is `exit 0` / `exit: 1`.
 */
export function readJob(text: string): JobStatus {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const item = fields(JSON.parse(trimmed) as Value);
      if (item !== null) return jobFromFields(item);
    } catch {
      // A JSON file caught mid-write: read it as text this time.
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== "");
  const exitMatch = /^exit(?:\s*code)?[:=\s]\s*(-?\d+)\s*$/i.exec(lines.at(-1)?.trim() ?? "");
  const exit = exitMatch === null ? null : Number(exitMatch[1]);
  const progressMatch = [...lines].reverse().map((line) => /(\d+)\s*\/\s*(\d+)|(\d{1,3}(?:\.\d+)?)\s*%/.exec(line)).find((match) => match !== null) ?? null;
  const done = progressMatch?.[1] === undefined ? null : Number(progressMatch[1]);
  const total = progressMatch?.[2] === undefined ? null : Number(progressMatch[2]);
  const percent = progressMatch?.[3] === undefined ? null : Number(progressMatch[3]) / 100;
  return {
    state: exit === null ? (lines.length === 0 ? "unknown" : "running") : exit === 0 ? "done" : "failed",
    phase: null,
    message: null,
    progress: done !== null && total !== null && total > 0 ? Math.min(1, done / total) : percent,
    done,
    total,
    eta: null,
    exit,
    tail: lines.slice(exit === null ? -TAIL_LINES : -TAIL_LINES - 1, exit === null ? undefined : -1),
  };
}

function jobFromFields(item: Fields): JobStatus {
  const exit = num(item.exit ?? item.exitCode ?? item.code);
  const word = pick(item, ["status", "state"]);
  const stated = word === null ? undefined : JOB_WORDS[word.toLowerCase().replace(/[\s_-]+/g, "")];
  const state: JobState = stated ?? (exit === null ? (word === null ? "running" : "unknown") : exit === 0 ? "done" : "failed");
  const done = num(item.done ?? item.current ?? item.completed ?? item.count);
  const total = num(item.total ?? item.of);
  const given = num(item.progress ?? item.percent);
  const progress = given !== null ? (given > 1 ? given / 100 : given) : done !== null && total !== null && total > 0 ? done / total : null;
  return {
    state,
    phase: pick(item, ["phase", "stage", "step"]),
    message: pick(item, ["message", "msg", "detail", "note", "last"]),
    progress: progress === null ? null : Math.max(0, Math.min(1, progress)),
    done,
    total,
    eta: pick(item, ["eta", "remaining"]),
    exit,
    tail: strings(item.tail ?? item.lines).slice(-TAIL_LINES),
  };
}

/** Whether a job has stopped: it says it finished or failed. */
export function jobFinished(status: JobStatus): boolean {
  return status.state === "done" || status.state === "failed";
}

export function jobLine(status: JobStatus): string {
  const parts = [status.state === "done" ? "Done" : status.state === "failed" ? `Failed${status.exit === null ? "" : ` (exit ${status.exit})`}` : status.state === "running" ? "Running" : "No status yet"];
  if (status.phase !== null) parts.push(status.phase);
  if (status.done !== null && status.total !== null) parts.push(`${status.done} of ${status.total}`);
  else if (status.progress !== null) parts.push(`${Math.round(status.progress * 100)}%`);
  if (status.eta !== null && !jobFinished(status)) parts.push(`about ${status.eta} left`);
  return parts.join(" · ");
}
