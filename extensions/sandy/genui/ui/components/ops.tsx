// Ops components: Approval (the writes a step will make, before the user
// agrees), Hosts (a run over many hosts by outcome), Runbook (steps the user
// carries out, reported back) and Job (a long run's status file, read again
// while it runs). Readers live in core/ops.ts.
import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  approvalMessage,
  CHANGE_KINDS,
  CHANGE_LABEL,
  HOST_LABEL,
  HOST_STATUSES,
  hostsSummary,
  jobFinished,
  jobLine,
  readApproval,
  readHosts,
  readJob,
  readRunbook,
  runbookMessage,
  type ChangeKind,
  type HostStatus,
  type JobStatus,
} from "../../core/ops";
import type { Value } from "../../core/types";
import { NodeKeyContext, useUiRuntime } from "../runtime";
import { optionalText, type Props } from "../values";
import { ErrorLine } from "./display";
import { Button, ButtonGroup, FOCUS_RING } from "./inputs";
import { Frame, Heading, Quiet, TEXT_BUTTON } from "./perfKit";
import { ICON_BUTTON } from "./projectKit";

const MONO = "font-mono text-[11.5px] leading-5 [overflow-wrap:anywhere]";

function CopyButton({ text, label }: { text: string; label: string }) {
  const { run } = useUiRuntime();
  return (
    <button type="button" aria-label={label} title={label} onClick={() => void run([{ kind: "action", type: "copy", text }])} className={ICON_BUTTON}>
      <Icon name="Copy" aria-hidden className="size-3.5" />
    </button>
  );
}

function CodeLine({ code, label }: { code: string; label: string }) {
  return (
    <div className="flex min-w-0 items-start gap-1 rounded-md bg-surface-recessed py-0.5 pl-2 pr-0.5">
      <code className={cn("min-w-0 flex-1 py-0.5 text-foreground", MONO)}>{code}</code>
      <CopyButton text={code} label={label} />
    </div>
  );
}

function sendAction(text: string): Value[] {
  return [{ kind: "action", type: "send", text }];
}

// ---------------------------------------------------------------------------
// Approval

const KIND_ICON: Record<ChangeKind, string> = { delete: "Trash2", external: "Globe", write: "FilePen", run: "Terminal", temp: "Clock" };
const KIND_TONE: Record<ChangeKind, string> = {
  delete: "text-destructive",
  external: "text-warning-text",
  write: "text-foreground",
  run: "text-foreground",
  temp: "text-muted-foreground",
};

export function Approval({ props }: { props: Props }) {
  const read = useMemo(() => readApproval(props.changes), [props.changes]);
  const question = useContext(NodeKeyContext);
  const title = optionalText(props.title);
  if (!read.ok) return <ErrorLine message={read.error} />;
  const report = read.value;
  const kinds = CHANGE_KINDS.filter((kind) => report.changes.some((change) => change.kind === kind));
  const approve: Props = { label: "Approve", variant: "primary", action: sendAction(approvalMessage(report, true, title)) };
  const decline: Props = { label: "Decline", variant: "secondary", action: sendAction(approvalMessage(report, false, title)) };
  return (
    <Frame label="Approval">
      <Heading
        title={title ?? "Before I go ahead"}
        meta={`${report.changes.length} change${report.changes.length === 1 ? "" : "s"}: ${kinds.map((kind) => `${report.changes.filter((change) => change.kind === kind).length} ${CHANGE_LABEL[kind].toLowerCase()}`).join(", ")}`}
      />
      {report.irreversible > 0 ? (
        <p className="m-0 flex items-start gap-2 text-xs leading-5 text-warning-text">
          <Icon name="AlertTriangle" aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {report.irreversible === 1 ? "One change names no way back." : `${report.irreversible} changes name no way back.`}
        </p>
      ) : null}
      {report.changes.length === 0 ? <Quiet>No changes.</Quiet> : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {report.changes.map((change, index) => (
          <li key={index} className="flex min-w-0 items-start gap-2 border-t border-border/60 py-1.5 first:border-t-0">
            <Icon name={KIND_ICON[change.kind]} aria-label={CHANGE_LABEL[change.kind]} className={cn("mt-[3px] size-3.5 shrink-0", KIND_TONE[change.kind])} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className={cn("text-[13px] leading-5", MONO, KIND_TONE[change.kind])}>{change.target}</span>
                <span className="text-[11px] leading-4 text-muted-foreground">{CHANGE_LABEL[change.kind]}</span>
              </div>
              {change.detail === null ? null : <span className="text-xs leading-5 text-muted-foreground">{change.detail}</span>}
              {change.command === null ? null : <CodeLine code={change.command} label="Copy command" />}
              {change.revert !== null ? (
                <span className="text-xs leading-5 text-muted-foreground">
                  Undo: <span className={MONO}>{change.revert}</span>
                </span>
              ) : change.kind === "delete" || change.kind === "external" ? (
                <span className="text-xs leading-5 text-warning-text">No way back given</span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <ButtonGroup
        question={question}
        buttons={[
          { key: "approve", props: approve, element: <Button props={approve} /> },
          { key: "decline", props: decline, element: <Button props={decline} /> },
        ]}
      />
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Hosts

const HOST_TONE: Record<HostStatus, string> = {
  failed: "text-destructive",
  unreachable: "text-destructive",
  changed: "text-warning-text",
  ok: "text-success",
  skipped: "text-muted-foreground",
};
const HOST_ICON: Record<HostStatus, string> = { failed: "X", unreachable: "WifiOff", changed: "RefreshCw", ok: "Check", skipped: "Minus" };
const HOSTS_SHOWN = 12;

export function Hosts({ props }: { props: Props }) {
  const read = useMemo(() => readHosts(props.items), [props.items]);
  const [open, setOpen] = useState<ReadonlySet<HostStatus>>(new Set());
  if (!read.ok) return <ErrorLine message={read.error} />;
  const report = read.value;
  const toggle = (status: HostStatus) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  return (
    <Frame label="Hosts">
      <Heading title={optionalText(props.title) ?? "Hosts"} meta={hostsSummary(report)} />
      {report.hosts.length === 0 ? <Quiet>No hosts.</Quiet> : null}
      {HOST_STATUSES.filter((status) => report.counts[status] > 0).map((status) => {
        const hosts = report.hosts.filter((host) => host.status === status);
        const all = open.has(status);
        const shown = all ? hosts : hosts.slice(0, HOSTS_SHOWN);
        return (
          <section key={status} aria-label={HOST_LABEL[status]} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <Icon name={HOST_ICON[status]} aria-hidden className={cn("size-3.5 shrink-0", HOST_TONE[status])} />
              <span className={cn("text-xs font-medium leading-5", HOST_TONE[status])}>
                {HOST_LABEL[status]} · {hosts.length}
              </span>
              <CopyButton text={hosts.map((host) => host.host).join("\n")} label={`Copy the ${HOST_LABEL[status].toLowerCase()} hosts`} />
            </div>
            <ul className="m-0 flex list-none flex-col p-0 pl-5">
              {shown.map((host, index) => (
                <li key={`${host.host}:${index}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs leading-5">
                  <span className={cn(MONO, "text-foreground")}>{host.host}</span>
                  {host.detail === null ? null : <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{host.detail}</span>}
                  {host.log === null ? null : <span className={cn(MONO, "text-muted-foreground")}>{host.log}</span>}
                </li>
              ))}
            </ul>
            {hosts.length > HOSTS_SHOWN ? (
              <button type="button" onClick={() => toggle(status)} className={cn(TEXT_BUTTON, "ml-5")}>
                {all ? "Show fewer" : `Show all ${hosts.length}`}
              </button>
            ) : null}
          </section>
        );
      })}
      {report.combos.length > 1 ? (
        <section aria-label="Where the hosts are listed" className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium leading-5 text-muted-foreground">Listed in</span>
          {report.combos.slice(0, 8).map((combo) => (
            <div key={combo.sources.join("+")} className="flex min-w-0 items-baseline justify-between gap-3 text-xs leading-5">
              <span className="min-w-0 [overflow-wrap:anywhere]">{combo.sources.join(" + ")}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{combo.count}</span>
            </div>
          ))}
        </section>
      ) : null}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Runbook

type Mark = "worked" | "failed";

export function Runbook({ props }: { props: Props }) {
  const read = useMemo(() => readRunbook(props.steps), [props.steps]);
  const [marks, setMarks] = useState<Readonly<Record<number, Mark>>>({});
  if (!read.ok) return <ErrorLine message={read.error} />;
  const steps = read.value;
  const message = runbookMessage(steps, marks);
  const report: Props = { label: "Report back", variant: "primary", action: sendAction(message) };
  const mark = (index: number, value: Mark) =>
    setMarks((previous) => {
      const next = { ...previous };
      if (next[index] === value) delete next[index];
      else next[index] = value;
      return next;
    });
  return (
    <Frame label="Runbook">
      <Heading title={optionalText(props.title) ?? "Your steps"} meta={`${steps.length} step${steps.length === 1 ? "" : "s"} for you to carry out; mark each and report back`} />
      <ol className="m-0 flex list-none flex-col p-0">
        {steps.map((step, index) => (
          <li key={index} className="flex min-w-0 items-start gap-2.5 border-t border-border/60 py-2 first:border-t-0">
            <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-recessed text-[11px] tabular-nums text-muted-foreground">{index + 1}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[13px] leading-5 text-foreground">{step.title}</span>
              {step.detail === null ? null : <span className="text-xs leading-5 text-muted-foreground">{step.detail}</span>}
              {step.command === null ? null : <CodeLine code={step.command} label={`Copy the command of step ${index + 1}`} />}
              {step.expected === null ? null : <span className="text-xs leading-5 text-muted-foreground">You should see: {step.expected}</span>}
              <div className="flex gap-1.5" role="group" aria-label={`Step ${index + 1} result`}>
                {(["worked", "failed"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={marks[index] === value}
                    onClick={() => mark(index, value)}
                    className={cn(
                      "cursor-pointer rounded-md border px-2 text-xs leading-5 transition-colors",
                      marks[index] === value
                        ? value === "worked"
                          ? "border-success/40 bg-success/12 text-success"
                          : "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
                      FOCUS_RING,
                    )}
                  >
                    {value === "worked" ? "Worked" : "Failed"}
                  </button>
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {message === "" ? <Quiet>Mark a step to report back.</Quiet> : <Button props={report} />}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Job

const POLL_MS = 3000;
const QUIET_MS = 10 * 60_000;
const MAX_MS = 2 * 60 * 60_000;

type JobView = { readonly status: JobStatus | null; readonly error: string | null; readonly stopped: "finished" | "quiet" | "limit" | null };

export function Job({ props }: { props: Props }) {
  const path = optionalText(props.path);
  const { readText } = useUiRuntime();
  const [view, setView] = useState<JobView>({ status: null, error: null, stopped: null });
  useEffect(() => {
    if (path === null || readText === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    let last = "";
    let changedAt = started;
    const tick = async () => {
      const file = await readText(path, { fresh: true });
      if (!live) return;
      if (!file.ok) {
        // An unreadable file ends at the limit too: a spinner or a "waiting" line must not outlive the polling.
        const limit = Date.now() - started > MAX_MS;
        setView((previous) => ({ ...previous, error: file.error, stopped: limit ? "limit" : previous.stopped }));
        if (limit) return;
      } else {
        if (file.text !== last) {
          last = file.text;
          changedAt = Date.now();
        }
        const status = readJob(file.text);
        const now = Date.now();
        const stopped = jobFinished(status) ? "finished" : now - changedAt > QUIET_MS ? "quiet" : now - started > MAX_MS ? "limit" : null;
        setView({ status, error: null, stopped });
        if (stopped !== null) return;
      }
      if (Date.now() - started > MAX_MS) return;
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path, readText]);
  if (path === null) return <ErrorLine message="Job takes the path of a status file: Job(path, title?)" />;
  if (readText === null) return <Quiet>A live job ({path}) is followed when this reply is open in SANDY.</Quiet>;
  const status = view.status;
  const tone = status === null ? "text-muted-foreground" : status.state === "failed" ? "text-destructive" : status.state === "done" ? "text-success" : "text-foreground";
  const meta: ReactNode = (
    <>
      <span className={MONO}>{path}</span>
      {view.stopped === "quiet" ? " · no change for 10 minutes, stopped following" : view.stopped === "limit" ? " · stopped following after 2 hours" : null}
    </>
  );
  return (
    <Frame label="Job">
      <Heading title={optionalText(props.title) ?? "Job"} meta={meta} />
      {view.error !== null && status === null ? (
        <Quiet>{view.stopped === "limit" ? `No status file (${view.error}).` : `Waiting for the status file (${view.error}).`}</Quiet>
      ) : null}
      {view.error !== null && status !== null ? <Quiet>The status file can no longer be read ({view.error}); the line above is the last state seen.</Quiet> : null}
      {status === null ? null : (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={cn("flex items-center gap-1.5 text-[13px] font-medium leading-5", tone)} aria-live="polite">
            {status.state === "running" && view.stopped === null ? <Icon name="Loader" aria-hidden className="size-3.5 animate-spin" /> : null}
            {jobLine(status)}
          </span>
          {status.progress === null ? null : (
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(status.progress * 100)} className="h-1.5 w-full overflow-hidden rounded-full bg-surface-recessed">
              <div className={cn("h-full rounded-full transition-[width] duration-500", status.state === "failed" ? "bg-destructive" : status.state === "done" ? "bg-success" : "bg-primary")} style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
          )}
          {status.message === null ? null : <span className="text-xs leading-5 text-muted-foreground">{status.message}</span>}
          {status.tail.length === 0 ? null : <pre className={cn("m-0 max-h-40 overflow-auto rounded-md bg-surface-recessed px-2 py-1 text-muted-foreground", MONO)}>{status.tail.join("\n")}</pre>}
        </div>
      )}
    </Frame>
  );
}
