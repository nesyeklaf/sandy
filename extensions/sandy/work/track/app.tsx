// sandy-plugin-track frontend: the Stages tab of a thread, a stage pill in the thread header, and the three
// composer forms the backend opens with sandy.ui.requestInput (gate-approval, track-approval, force-proposal).
// The run is the v2 Run (run.ts): one lease drives the current stage; the owner picks drivers per stage or for the
// whole track, forces a stage, pauses the guard or aborts.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  Markdown,
  useRealtime,
  useRpc,
  type PluginPendingInteractionProps,
} from "@sandy-sdk/plugin-sdk/app";
import type { PluginAppBuilder } from "@sandy-sdk/plugin-sdk/app";
import type { rpcContract } from "./contract";
import type { Machine, Rule, Stage } from "./machine";
import { describeRule, effectiveAllow, ruleKey } from "./machine";
import type { ClosedLease, Driver, Evidence, Lease, LeaseUsage, Run } from "./run";
import { driverFor, driverLabel, endText, previousText } from "./run";
import { useOpenWork } from "../work-tab-link.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";


function useRun(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [run, setRun] = useState<Run | null | undefined>(undefined);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("state", { threadId }).then(
      (result) => {
        setRun((result.run as Run | null) ?? null);
        setPolicyError(result.policyError);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime("run-changed", (payload) => {
    if ((payload as { threadId?: string } | null)?.threadId === threadId) refetch();
  });
  return { rpc, run, policyError, error, setError, refetch };
}

const leaseOf = (run: Run): Lease | null => (run.state.kind === "active" ? run.state.lease : null);

/** The owner is asked something: a gate approval or an agent's force proposal. */
const awaitingOwner = (lease: Lease | null) =>
  lease !== null && lease.work !== null && (lease.work.kind === "force-proposal" || (lease.work.kind === "gate" && lease.work.phase === "asking"));

type StageState = "done" | "current" | "next" | "upcoming" | "skipped";

function stageStates(run: Run): Map<string, StageState> {
  const lease = leaseOf(run);
  const visited = new Set([...Object.keys(run.outputs), ...Object.keys(run.lastVisit), ...run.log.map((l) => l.stage)]);
  const current = lease ? run.machine.stages.find((s) => s.id === lease.stage) : undefined;
  const next = new Set(current?.next.map((e) => e.to) ?? []);
  const states = new Map<string, StageState>();
  for (const stage of run.machine.stages) {
    if (lease && stage.id === lease.stage) states.set(stage.id, "current");
    else if (visited.has(stage.id)) states.set(stage.id, "done");
    else if (next.has(stage.id)) states.set(stage.id, "next");
    else states.set(stage.id, lease ? "upcoming" : "skipped");
  }
  return states;
}

const dot: Record<StageState, string> = {
  done: "bg-emerald-500",
  current: "bg-sky-500 ring-4 ring-sky-500/25",
  next: "bg-transparent border-2 border-sky-500",
  upcoming: "bg-transparent border-2 border-border",
  skipped: "bg-transparent border-2 border-border opacity-50",
};

function Pill({ tone, children }: { tone: "good" | "bad" | "warn" | "info" | "muted"; children: ReactNode }) {
  const tones = {
    good: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    bad: "bg-red-500/15 text-red-600 dark:text-red-400",
    warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    info: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
    muted: "bg-muted text-muted-foreground",
  };
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium", tones[tone])}>{children}</span>;
}

function RuleRow({ rule, result }: { rule: Rule; result: { ok: boolean; detail: string } | undefined }) {
  const icon = result === undefined ? "Circle" : result.ok ? "CircleCheck" : "CircleX";
  const color = result === undefined ? "text-muted-foreground" : result.ok ? "text-emerald-500" : "text-red-500";
  return (
    <li className="flex items-start gap-2">
      <Icon name={icon} className={cn("mt-0.5 size-3.5 shrink-0", color)} />
      <div className="min-w-0">
        <span className="text-muted-foreground">{rule.type}:</span> {describeRule(rule)}
        {result !== undefined && !result.ok ? (
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5 text-[11px]">{result.detail}</pre>
        ) : null}
      </div>
    </li>
  );
}

function allowSummary(machine: Machine, stage: Stage): string[] {
  const allow = effectiveAllow(machine, stage);
  const parts: string[] = [];
  if (allow.skills) parts.push("skills: " + (allow.skills.join(", ") || "none"));
  if (allow.edits === false) parts.push("no edits");
  if (allow.subagents) parts.push("subagents: " + (allow.subagents.map((p) => (p.agent ?? "*") + (p.model ? " @ " + p.model : "")).join(", ") || "none"));
  if (allow.denyTools?.length) parts.push("blocked: " + allow.denyTools.join(", "));
  return parts;
}

/** partial: the last usage report before the lease closed without one; later model work is not counted. */
const tokens = (usage: LeaseUsage | null, partial = false) =>
  usage === null ? "tokens unknown" : partial ? "at least " + usage.total.toLocaleString() + " tokens (partial: closed without a final report)" : usage.total.toLocaleString() + " tokens";
const time = (at: number) => new Date(at).toLocaleTimeString();

function EvidenceRow({ evidence }: { evidence: Evidence }) {
  if (evidence.kind === "text")
    return (
      <li>
        <span className="font-mono">{evidence.name}</span> <Pill tone="warn">self-reported</Pill>: <span className="whitespace-pre-wrap">{evidence.text}</span>
      </li>
    );
  return (
    <li>
      <div className="flex items-center gap-1.5">
        <Icon name={evidence.exitCode === 0 ? "CircleCheck" : "CircleX"} className={cn("size-3.5 shrink-0", evidence.exitCode === 0 ? "text-emerald-500" : "text-red-500")} />
        <span className="font-mono">{evidence.name}</span>
        <Pill tone="good">ran by the plugin</Pill>
      </div>
      <div className="text-muted-foreground">
        <code>{evidence.command}</code> exited {evidence.exitCode} in {evidence.durationMs} ms
      </div>
      {evidence.tail ? <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5 text-[11px]">{evidence.tail}</pre> : null}
    </li>
  );
}

/** Autopilot names the owner can pick: the template's and the ones already chosen. */
function autopilotNames(run: Run): string[] {
  const names = new Set<string>();
  for (const stage of run.machine.stages) if (stage.autopilot) names.add(stage.autopilot.name);
  for (const choice of [run.plan.track, ...Object.values(run.plan.stages)]) if (choice?.kind === "autopilot") names.add(choice.name);
  return [...names].sort();
}

const choiceValue = (choice: Driver | undefined) => (choice === undefined ? "default" : choice.kind === "agent" ? "agent" : "autopilot:" + choice.name);

/**
 * A driver picker: Template default, Agent, a known autopilot, or another autopilot by name.
 * Picking sends setDriver at once; "Other autopilot…" asks for the name first.
 */
function DriverPicker({ label, current, names, fallback, onPick }: { label: string; current: Driver | undefined; names: string[]; fallback: string; onPick: (choice: Driver | "default") => void }) {
  const [other, setOther] = useState<string | null>(null);
  const pick = (value: string) => {
    if (value === "other") return setOther("");
    setOther(null);
    if (value === "default" || value === "agent") return onPick(value === "default" ? "default" : { kind: "agent" });
    onPick({ kind: "autopilot", name: value.slice("autopilot:".length) });
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <select
        aria-label={label}
        className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs"
        value={other === null ? choiceValue(current) : "other"}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="default">Template default ({fallback})</option>
        <option value="agent">Agent</option>
        {names.map((name) => (
          <option key={name} value={"autopilot:" + name}>
            Autopilot {name}
          </option>
        ))}
        <option value="other">Other autopilot…</option>
      </select>
      {other !== null ? (
        <>
          <input
            aria-label="Autopilot name"
            placeholder="autopilot name"
            className="h-7 w-32 rounded-md border border-input bg-transparent px-1.5 text-xs"
            value={other}
            onChange={(e) => setOther(e.target.value.trim())}
          />
          <Button size="sm" variant="outline" disabled={!/^[a-z][a-z0-9-]*$/.test(other)} onClick={() => onPick({ kind: "autopilot", name: other })}>
            Set
          </Button>
        </>
      ) : null}
    </span>
  );
}

function LeaseDetails({ run, lease }: { run: Run; lease: Lease }) {
  const work = lease.work;
  const claimed = lease.claim !== null;
  const wake =
    lease.driver.kind === "agent"
      ? lease.wake.kind === "told" ? "told at " + time(lease.wake.at) : "not told yet"
      : claimed ? "claimed by a launch at " + time(lease.claim!.claimedAt)
      : lease.wake.kind === "launched" ? "launched (attempt " + lease.wake.attempt + "), waiting for its claim"
      : "launch pending";
  return (
    <Section title="This visit">
      <li>
        Driven by <span className="font-medium">{driverLabel(lease.driver)}</span> · {wake}
      </li>
      <li className="text-muted-foreground">
        Why: {lease.causeText} · lease {run.runId}.{lease.seq} · {lease.usage === null ? "tokens unknown" : lease.usage.total.toLocaleString() + " tokens so far"}
      </li>
      {work?.kind === "gate" ? <li>{work.phase === "checking" ? "Checking the gate…" : "Waiting for your approval in the composer."}</li> : null}
      {work?.kind === "run" ? (
        <li>
          Running <code>{work.command}</code> ({work.label})…
        </li>
      ) : null}
      {work?.kind === "force-proposal" ? <li>Force proposal to {work.to} waits for you in the composer: {work.reason}</li> : null}
      {lease.outcome?.kind === "refused" ? <li className="text-red-600 dark:text-red-400">Gate refused: {lease.outcome.reasons.join("; ")}</li> : null}
      {lease.outcome?.kind === "interrupted" ? <li className="text-amber-700 dark:text-amber-400">The {lease.outcome.what} was interrupted ({lease.outcome.reason ?? "a plugin restart"}) and was not run again.</li> : null}
      {lease.outcome?.kind === "unsaved" ? <li className="text-red-600 dark:text-red-400">The {lease.outcome.what === "run" ? "command" : lease.outcome.what} result was not kept: {lease.outcome.reason}</li> : null}
      {lease.outcome?.kind === "force-rejected" ? <li className="text-muted-foreground">You rejected the force proposal to {lease.outcome.to}.</li> : null}
      {lease.previous ? <li className="text-muted-foreground">{previousText(lease.previous)}</li> : null}
    </Section>
  );
}

function StageCard({ run, stage, state, last, picker }: { run: Run; stage: Stage; state: StageState; last: boolean; picker: ReactNode }) {
  const [open, setOpen] = useState(state === "current");
  useEffect(() => setOpen(state === "current"), [state]);
  const lease = state === "current" ? leaseOf(run) : null;
  const outputs = lease ? lease.submissions.outputs : (run.outputs[stage.id] ?? {});
  const evidence = lease ? lease.submissions.evidence : (run.evidence[stage.id] ?? []);
  const results = lease?.work?.kind === "gate" ? lease.work.results : {};
  const allow = allowSummary(run.machine, stage);
  const driver = driverFor(run.machine, run.plan, stage.id);
  return (
    <li className="relative flex gap-3">
      <div className="flex flex-col items-center">
        <span className={cn("mt-1.5 size-3 shrink-0 rounded-full", dot[state])} />
        {last ? null : <span className="mt-1 w-px flex-1 bg-border" />}
      </div>
      <div className={cn("mb-3 min-w-0 flex-1 rounded-lg border bg-card", state === "current" ? "border-sky-500/60" : "border-border")}>
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={cn("min-w-0 flex-1 truncate text-sm font-medium", state === "skipped" && "text-muted-foreground")}>{stage.title}</span>
          <Pill tone="muted">{lease ? driverLabel(lease.driver) : driverLabel(driver)}</Pill>
          {state === "current" ? <Pill tone="info">{awaitingOwner(lease) ? "awaiting owner" : "current"}</Pill> : null}
          {state === "done" ? <Pill tone="good">done</Pill> : null}
          {state === "next" ? <Pill tone="muted">option</Pill> : null}
          <Icon name={open ? "ChevronUp" : "ChevronDown"} className="size-4 text-muted-foreground" />
        </button>
        {open ? (
          <div className="space-y-2.5 border-t border-border px-3 py-2.5 text-xs">
            {stage.description ? <p className="text-muted-foreground">{stage.description}</p> : null}
            {picker ? <div className="flex items-center gap-2">Driver: {picker}</div> : null}
            {lease ? <LeaseDetails run={run} lease={lease} /> : null}
            {stage.inputs.length ? (
              <Section title="Inputs">
                {stage.inputs.map((input) => {
                  const [from, name] = input.split(".");
                  const value = name === undefined ? undefined : run.outputs[from!]?.[name];
                  return (
                    <li key={input}>
                      <span className="font-mono">{input}</span>
                      {value ? <span className="text-muted-foreground"> — {value}</span> : null}
                    </li>
                  );
                })}
              </Section>
            ) : null}
            {stage.outputs.length ? (
              <Section title="Outputs">
                {stage.outputs.map((o) => (
                  <li key={o.name} className="flex items-start gap-2">
                    <Icon
                      name={outputs[o.name]?.trim() ? "CircleCheck" : "Circle"}
                      className={cn("mt-0.5 size-3.5 shrink-0", outputs[o.name]?.trim() ? "text-emerald-500" : "text-muted-foreground")}
                    />
                    <div className="min-w-0">
                      <span className="font-mono">{o.name}</span>
                      {o.optional ? <span className="text-muted-foreground"> (optional)</span> : null}
                      {o.description ? <span className="text-muted-foreground"> — {o.description}</span> : null}
                      {outputs[o.name] ? <div className="mt-0.5 whitespace-pre-wrap break-words">{outputs[o.name]}</div> : null}
                    </div>
                  </li>
                ))}
              </Section>
            ) : null}
            {evidence.length ? (
              <Section title="Evidence">
                {evidence.map((e) => (
                  <EvidenceRow key={e.name + "." + e.seq} evidence={e} />
                ))}
              </Section>
            ) : null}
            {stage.gate.length ? (
              <Section title="Gate">
                {stage.gate.map((rule, i) => (
                  <RuleRow key={i} rule={rule} result={results[ruleKey(rule, i)]} />
                ))}
              </Section>
            ) : null}
            {allow.length ? (
              <Section title="Allowed while here">
                {allow.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </Section>
            ) : null}
            {stage.next.length ? (
              <Section title={stage.next.length > 1 ? "Branches" : "Next"}>
                {stage.next.map((edge) => {
                  const target = run.machine.stages.find((s) => s.id === edge.to);
                  return (
                    <li key={edge.to} className="flex items-start gap-1.5">
                      <Icon name="ArrowRight" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <div>
                        {target?.title ?? edge.to}
                        {edge.when ? <span className="text-muted-foreground"> — when {edge.when}</span> : null}
                        {edge.gate?.length ? (
                          <ul className="mt-1 space-y-1">
                            {edge.gate.map((rule, i) => (
                              <RuleRow key={i} rule={rule} result={results[ruleKey(rule, i, edge.to)]} />
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </Section>
            ) : (
              <p className="text-muted-foreground">Final stage.</p>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function LeaseLog({ run }: { run: Run }) {
  const title = (id: string) => run.machine.stages.find((s) => s.id === id)?.title ?? id;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        Lease log ({run.log.length}
        {run.logDropped ? ", " + run.logDropped + " older dropped" : ""})
      </summary>
      <ol className="mt-1.5 space-y-1.5">
        {run.log.map((entry: ClosedLease) => (
          <li key={entry.seq} className="space-y-0.5">
            <div className="flex gap-2">
              <span className="shrink-0 tabular-nums text-muted-foreground">{time(entry.endedAt)}</span>
              <span>
                <span className="font-medium">{title(entry.stage)}</span> · {driverLabel(entry.driver)} · {entry.cause} → {endText(entry.end)}
              </span>
            </div>
            <div className="pl-16 text-muted-foreground">
              {tokens(entry.usage, entry.usagePartial)}
              {entry.ran.map((r) => (
                <span key={r.name}>
                  {" · ran "}
                  <span className="font-mono">{r.name}</span> exit {r.exitCode}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** The Stage section shows while the thread has a track. */
export function useStagesVisible({ threadId }: { threadId: string }): boolean {
  return useRun(threadId).run != null;
}

export function StagesTab({ threadId }: { threadId: string }) {
  const { rpc, run, policyError, error, setError, refetch } = useRun(threadId);
  const [forceTo, setForceTo] = useState("");
  const [forceNote, setForceNote] = useState("");
  const act = (p: Promise<{ ok: boolean; message?: string }>) =>
    p.then(
      (result) => {
        if (!result.ok) setError(result.message ?? "refused");
        refetch();
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  if (run === undefined) return <Empty>{error ?? "Loading…"}</Empty>;
  if (run === null)
    return (
      <Empty>
        No track in this thread. The agent starts one with <code>stage_start</code> from a skill's <code>stages.json</code>, or proposes an
        ad-hoc track for your approval.
      </Empty>
    );
  const states = stageStates(run);
  const lease = leaseOf(run);
  const live = run.state.kind === "active";
  const names = autopilotNames(run);
  const setDriver = (scope: "track" | "stage", choice: Driver | "default", stage?: string) =>
    act(rpc.call("setDriver", { threadId, scope, choice, ...(stage ? { stage } : {}) }));
  const statusLabel = live ? (run.paused ? "guard paused" : "guarded") : run.state.kind === "proposed" ? "awaiting approval" : run.state.kind;
  const statusTone = live ? (run.paused ? "warn" : "info") : run.state.kind === "done" ? "good" : run.state.kind === "proposed" ? "warn" : "bad";
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="space-y-3 p-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Icon name="Milestone" className="size-4 text-muted-foreground" />
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{run.machine.title}</h2>
            <Pill tone={statusTone}>{statusLabel}</Pill>
          </div>
          <div className="text-xs text-muted-foreground">
            {run.source.kind === "skill" ? "template from skill " + run.source.skill : "ad-hoc track, approved by you"}
            {run.goalId ? " · serves goal " + run.goalId : ""}
          </div>
          {run.machine.description ? <p className="text-xs text-muted-foreground">{run.machine.description}</p> : null}
          {run.state.kind === "aborted" ? <p className="text-xs text-muted-foreground">Aborted: {run.state.reason}</p> : null}
          {lease ? (
            <div className="flex items-center gap-2 text-xs">
              <Icon name={lease.driver.kind === "agent" ? "MessageSquare" : "Bot"} className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                Stage driven by <span className="font-medium">{driverLabel(lease.driver)}</span>
              </span>
            </div>
          ) : null}
          {policyError ? (
            <p role="alert" className="rounded bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">
              Guard policy not written: {policyError}. The stage is not enforced.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {live ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>Whole track:</span>
              <DriverPicker label="Driver of the whole track" current={run.plan.track} names={names} fallback="per stage" onPick={(choice) => setDriver("track", choice)} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => act(rpc.call("setPaused", { threadId, paused: !run.paused }))}>
                <Icon name={run.paused ? "Play" : "Pause"} />
                {run.paused ? "Resume guard" : "Pause guard"}
              </Button>
              {lease?.driver.kind === "autopilot" ? (
                <Button size="sm" variant="outline" onClick={() => setDriver("stage", { kind: "agent" }, lease.stage)}>
                  <Icon name="MessageSquare" />
                  Take over
                </Button>
              ) : null}
              <select
                aria-label="Force stage"
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                value={forceTo}
                onChange={(e) => setForceTo(e.target.value)}
              >
                <option value="">Force to…</option>
                {run.machine.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                    {s.id === lease?.stage ? " (again)" : ""}
                  </option>
                ))}
              </select>
              {forceTo ? (
                <input
                  aria-label="Force note"
                  placeholder="note for the driver (optional)"
                  className="h-8 min-w-40 flex-1 rounded-md border border-input bg-transparent px-2 text-xs"
                  value={forceNote}
                  maxLength={500}
                  onChange={(e) => setForceNote(e.target.value)}
                />
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={forceTo === ""}
                onClick={() =>
                  act(rpc.call("force", { threadId, to: forceTo, ...(forceNote.trim() ? { note: forceNote.trim() } : {}) })).then(() => {
                    setForceTo("");
                    setForceNote("");
                  })
                }
              >
                Force
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => act(rpc.call("abort", { threadId }))}>
                Abort
              </Button>
            </div>
          </div>
        ) : null}
        <ol>
          {run.machine.stages.map((stage, i) => (
            <StageCard
              key={stage.id}
              run={run}
              stage={stage}
              state={states.get(stage.id)!}
              last={i === run.machine.stages.length - 1}
              picker={
                live ? (
                  <DriverPicker
                    label={"Driver of " + stage.title}
                    current={run.plan.stages[stage.id]}
                    names={names}
                    fallback={driverLabel(driverFor(run.machine, { stages: {}, ...(run.plan.track ? { track: run.plan.track } : {}) }, stage.id))}
                    onPick={(choice) => setDriver("stage", choice, stage.id)}
                  />
                ) : null
              }
            />
          ))}
        </ol>
        <LeaseLog run={run} />
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="p-3">
      <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

function HeaderPill({ threadId, isCompactViewport }: { threadId: string; isCompactViewport: boolean }) {
  const { run } = useRun(threadId);
  const openWork = useOpenWork();
  const lease = run ? leaseOf(run) : null;
  if (!run || !lease) return null;
  const stage = run.machine.stages.find((s) => s.id === lease.stage);
  const index = run.machine.stages.findIndex((s) => s.id === lease.stage);
  const label = stage?.title ?? lease.stage;
  return (
    <button
      type="button"
      title={run.machine.title + ": " + label + " · " + driverLabel(lease.driver) + (run.paused ? " (guard paused)" : "")}
      aria-label={"Stage: " + label + ". Open the Stages tab"}
      onClick={() => openWork("stage")}
      className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-md border border-border px-2 text-xs hover:bg-state-hover"
    >
      <span className={cn("size-2 shrink-0 rounded-full", awaitingOwner(lease) ? "bg-amber-500" : run.paused ? "bg-muted-foreground" : "bg-sky-500")} />
      {isCompactViewport ? (
        <span className="tabular-nums">
          {index + 1}/{run.machine.stages.length}
        </span>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </button>
  );
}

// ---- composer forms --------------------------------------------------------------------------------

function Decision({ submit, cancel, approveLabel }: Pick<PluginPendingInteractionProps, "submit" | "cancel"> & { approveLabel: string }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const send = (approved: boolean) => {
    setBusy(true);
    submit({ approved, ...(note.trim() ? { note: note.trim() } : {}) }).finally(() => setBusy(false));
  };
  return (
    <div className="space-y-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note for the agent (optional; required context when you reject)"
        aria-label="Note for the agent"
        rows={2}
        className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => send(true)}>
          <Icon name="Check" />
          {approveLabel}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => send(false)}>
          <Icon name="X" />
          Reject
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
          Later
        </Button>
      </div>
    </div>
  );
}

type GatePayload = {
  machine: string;
  stage: { id: string; title: string };
  to: { id: string; title: string } | null;
  prompts: string[];
  note: string | null;
  outputs: { name: string; value: string | null }[];
  evidence: { name: string; value: string }[];
  results: { ok: boolean; detail: string }[];
  driver: string;
};

function GateApproval({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const p = interaction.payload as unknown as GatePayload;
  return (
    <div className="max-h-[60vh] space-y-2 overflow-y-auto p-3 text-sm">
      <div className="flex items-center gap-2">
        <Icon name="Milestone" className="size-4 text-muted-foreground" />
        <span className="font-medium">{p.stage.title}</span>
        <Icon name="ArrowRight" className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{p.to?.title ?? "finish"}</span>
        <span className="text-xs text-muted-foreground">· {p.machine}</span>
      </div>
      <p className="text-xs text-muted-foreground">Driven by {p.driver}</p>
      {p.prompts.map((prompt) => (
        <p key={prompt}>{prompt}</p>
      ))}
      {p.note ? (
        <div className="rounded bg-muted p-2 text-xs">
          <Markdown content={p.note} />
        </div>
      ) : null}
      {p.outputs.length ? (
        <Section title="Outputs">
          {p.outputs.map((o) => (
            <li key={o.name} className="text-xs">
              <span className="font-mono">{o.name}</span>: <span className="whitespace-pre-wrap">{o.value ?? "—"}</span>
            </li>
          ))}
        </Section>
      ) : null}
      {p.evidence.length ? (
        <Section title="Evidence">
          {p.evidence.map((e) => (
            <li key={e.name} className="text-xs">
              <span className="font-mono">{e.name}</span>: <span className="whitespace-pre-wrap">{e.value}</span>
            </li>
          ))}
        </Section>
      ) : null}
      {p.results.length ? (
        <Section title="Automatic checks">
          {p.results.map((r, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs">
              <Icon name={r.ok ? "CircleCheck" : "CircleX"} className={cn("mt-0.5 size-3.5 shrink-0", r.ok ? "text-emerald-500" : "text-red-500")} />
              <span className="whitespace-pre-wrap">{r.detail.split("\n")[0]}</span>
            </li>
          ))}
        </Section>
      ) : null}
      <Decision submit={submit} cancel={cancel} approveLabel="Approve" />
    </div>
  );
}

function TrackApproval({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const { machine, note } = interaction.payload as unknown as { machine: Machine; note: string | null };
  return (
    <div className="max-h-[60vh] space-y-2 overflow-y-auto p-3 text-sm">
      <div className="flex items-center gap-2">
        <Icon name="Milestone" className="size-4 text-muted-foreground" />
        <span className="font-medium">The agent proposes a track: {machine.title}</span>
      </div>
      {machine.description ? <p className="text-xs text-muted-foreground">{machine.description}</p> : null}
      {note ? (
        <div className="rounded bg-muted p-2 text-xs">
          <Markdown content={note} />
        </div>
      ) : null}
      <ol className="space-y-1.5">
        {machine.stages.map((stage, i) => {
          const allow = allowSummary(machine, stage);
          return (
            <li key={stage.id} className="rounded-md border border-border p-2 text-xs">
              <div className="font-medium">
                {i + 1}. {stage.title} <span className="font-mono text-muted-foreground">({stage.id})</span>
              </div>
              {stage.outputs.length ? <div>outputs: {stage.outputs.map((o) => o.name).join(", ")}</div> : null}
              {stage.gate.length ? <div>gate: {stage.gate.map(describeRule).join("; ")}</div> : <div className="text-amber-600">no gate</div>}
              {allow.length ? <div>allowed: {allow.join("; ")}</div> : <div className="text-muted-foreground">no tool limits</div>}
              <div className="text-muted-foreground">
                next: {stage.next.length ? stage.next.map((e) => `${e.to}${e.when ? ` (${e.when})` : ""}`).join(", ") : "end"}
              </div>
            </li>
          );
        })}
      </ol>
      <Decision submit={submit} cancel={cancel} approveLabel="Approve track" />
    </div>
  );
}

type ForceProposalPayload = {
  machine: string;
  from: { id: string; title: string };
  to: { id: string; title: string };
  reason: string;
  driver: string;
};

function ForceProposal({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const p = interaction.payload as unknown as ForceProposalPayload;
  return (
    <div className="max-h-[60vh] space-y-2 overflow-y-auto p-3 text-sm">
      <div className="flex items-center gap-2">
        <Icon name="Milestone" className="size-4 text-muted-foreground" />
        <span className="font-medium">Force proposal: {p.from.title}</span>
        <Icon name="ArrowRight" className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{p.to.title}</span>
        <span className="text-xs text-muted-foreground">· {p.machine}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {p.driver} asks to jump to this stage without its gate. Approving starts a new visit of {p.to.title}.
      </p>
      <div className="rounded bg-muted p-2 text-xs">
        <Markdown content={p.reason} />
      </div>
      <Decision submit={submit} cancel={cancel} approveLabel="Approve force" />
    </div>
  );
}

export const setupTrack = (app: PluginAppBuilder): void => {
  app.slots.experimental_threadHeaderAction({ id: "stage", title: "Stage", component: HeaderPill });
  app.slots.pendingInteraction({ id: "gate-approval", component: GateApproval });
  app.slots.pendingInteraction({ id: "track-approval", component: TrackApproval });
  app.slots.pendingInteraction({ id: "force-proposal", component: ForceProposal });
};

export default definePluginApp(setupTrack);
