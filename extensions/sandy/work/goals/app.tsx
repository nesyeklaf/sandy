// Composer banner and a Goals tab for pi-goal-x goals. Data comes from the host that runs pi;
// buttons send pi-goal-x slash commands into the thread.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { definePluginApp, experimental_Icon as Icon, useComposer, useRpc, useSettings } from "@sandy-sdk/plugin-sdk/app";
import type { PluginAppBuilder } from "@sandy-sdk/plugin-sdk/app";
import type { Goal, GoalEvent, SessionActivity, SessionTask, Snapshot, Task, rpcContract } from "./contract.ts";
import { VIEWS, type COMMANDS, type View } from "./views.ts";
import { TONE_TEXT, ago, budget, currentTask, duration, focused, progress, sessionLabel, sessionProgress, sessionTree, statusOf, title, tokens } from "./format.ts";

const POLL_MS = 4000;

const join = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
type Command = (typeof COMMANDS)[number];

function useViews() {
  const { values } = useSettings();
  const on = (view: View) => values?.[view] !== false;
  const limit = (key: string, fallback: number) => (typeof values?.[key] === "number" ? (values[key] as number) : fallback);
  return { on, archivedLimit: limit("archivedLimit", 10), eventLimit: limit("eventLimit", 15) };
}

/** Polls the goal snapshot of a thread; send() runs a goal command and refetches. */
function useGoals(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const { archivedLimit, eventLimit } = useViews();
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const refetch = useCallback(() => {
    if (threadId === null) return;
    rpc.call("snapshot", { threadId, archivedLimit, eventLimit }).then(
      (next) => { setData(next); setError(null); },
      (cause) => setError(message(cause)),
    );
  }, [rpc, threadId, archivedLimit, eventLimit]);
  useEffect(() => {
    setData(null);
    refetch();
    const timer = setInterval(refetch, POLL_MS);
    return () => clearInterval(timer);
  }, [refetch]);
  const send = useCallback(async (command: Command, arg?: string) => {
    if (threadId === null) return;
    setSending(command);
    try {
      await rpc.call("command", { threadId, command, ...(arg ? { arg } : {}) });
      setError(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSending(null);
      setTimeout(refetch, 800);
    }
  }, [rpc, threadId, refetch]);
  return { data, error, send, sending };
}

function threadIdOf(composer: ReturnType<typeof useComposer>): string | null {
  const scope = composer.scope;
  return scope.kind === "thread" || scope.kind === "queued-message" ? scope.threadId : null;
}

/** Clear archives the goal, so it asks first, here in SANDY. The server sends /goal-clear <id> --yes. */
function ClearGoal({ goal, send, sending }: { goal: Goal; send: (c: Command, arg?: string) => void; sending: string | null }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => setAsking(false), [goal.id]);
  if (!asking) {
    return (
      <div>
        <SmallButton label="Clear…" icon="Trash2" tone="danger" disabled={sending !== null} onClick={() => setAsking(true)} title="Archive this goal" />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-destructive/40 p-2 text-xs">
      <span className="grow">Archive this goal? It leaves the open pool for every session.</span>
      <SmallButton label="Archive" icon="Trash2" tone="danger" disabled={sending !== null} onClick={() => { setAsking(false); send("goal-clear", goal.id); }} title={`Send /goal-clear ${goal.id} --yes`} />
      <SmallButton label="Cancel" icon="X" onClick={() => setAsking(false)} />
    </div>
  );
}

function SmallButton(props: { label: string; icon: string; onClick: () => void; disabled?: boolean; title?: string; tone?: "danger" }) {
  return (
    <button
      type="button"
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={join(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-xs hover:bg-accent disabled:opacity-50",
        props.tone === "danger" && "text-destructive",
      )}
    >
      <Icon name={props.icon} className="size-3.5" />
      {props.label}
    </button>
  );
}

function Bar({ value, max, tone = "info" }: { value: number; max: number; tone?: "info" | "warn" | "bad" | "good" }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const color = { info: "bg-primary", warn: "bg-amber-500", bad: "bg-destructive", good: "bg-emerald-500" }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div className={join("h-full rounded-full transition-[width]", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function StatusBadge({ goal }: { goal: Goal }) {
  const s = statusOf(goal);
  return (
    <span className={join("inline-flex shrink-0 items-center gap-1 text-xs font-medium", TONE_TEXT[s.tone])}>
      <Icon name={s.icon} className="size-3.5" />
      {s.label}
    </span>
  );
}

/** Pause while it runs, resume otherwise. */
function PauseResume({ goal, send, sending }: { goal: Goal; send: (c: Command) => void; sending: string | null }) {
  return goal.status === "active"
    ? <SmallButton label="Pause" icon="Pause" disabled={sending !== null} onClick={() => send("goal-pause")} title="Send /goal-pause" />
    : goal.status === "complete" ? null
    : <SmallButton label="Resume" icon="Play" disabled={sending !== null} onClick={() => send("goal-resume")} title="Send /goal-resume" />;
}

function BlockedNote({ goal }: { goal: Goal }) {
  if (!goal.pauseReason && !goal.pauseSuggestedAction) return null;
  return (
    <div className="rounded-md bg-muted/60 px-2 py-1 text-xs">
      {goal.pauseReason && <div><span className="font-medium">Why: </span>{goal.pauseReason}</div>}
      {goal.pauseSuggestedAction && <div className="text-muted-foreground"><span className="font-medium text-foreground">Suggests: </span>{goal.pauseSuggestedAction}</div>}
    </div>
  );
}

function Usage({ goal, showUsage, showBudget }: { goal: Goal; showUsage: boolean; showBudget: boolean }) {
  const b = budget(goal);
  const parts: ReactNode[] = [];
  if (showUsage) parts.push(<span key="u">{duration(goal.activeSeconds)} · {tokens(goal.tokensUsed)} tokens</span>);
  if (showBudget && b) {
    parts.push(
      <span key="b" className={join("inline-flex items-center gap-1.5", b.pct >= 100 ? TONE_TEXT.bad : b.pct >= 80 ? TONE_TEXT.warn : "")}>
        Budget {tokens(b.used)}/{tokens(b.limit)} ({b.pct}%)
        <span className="inline-block w-16"><Bar value={b.used} max={b.limit} tone={b.pct >= 100 ? "bad" : b.pct >= 80 ? "warn" : "info"} /></span>
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{parts}</div>;
}

export function GoalBanner() {
  const composer = useComposer();
  const threadId = threadIdOf(composer);
  const { on } = useViews();
  const { data, send, sending } = useGoals(threadId);
  const [open, setOpen] = useState(false);
  if (!on("showBanner") || threadId === null || data === null) return null;
  const { goal, others } = focused(data);
  // An aborted turn leaves its last tool call open in the session file, so it counts only while the thread runs.
  const activity = on("bannerActivity") && composer.isRunning ? data.sessionActivity : null;
  const toggle = () => setOpen((o) => !o);
  if (goal === null) {
    const tasks = on("bannerSessionTasks") ? data.sessionTasks : [];
    const more = on("bannerMore") && others > 0;
    if (tasks.length === 0 && !more && !activity) return null;
    const s = sessionProgress(tasks);
    const opens = tasks.length > 0;
    const doing = s.current?.status === "in_progress" ? null : activity;
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-1.5 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          {opens ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`Session tasks ${s.done}/${s.total}. ${open ? "Hide" : "Show"} the tasks`}
              title={open ? "Hide the tasks" : "Show the tasks"}
              onClick={toggle}
              className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:bg-muted/50"
            >
              <Icon name="ListChecks" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="w-20 shrink-0"><Bar value={s.done} max={s.total} tone={s.done === s.total ? "good" : "info"} /></span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{s.done}/{s.total}</span>
              {doing && <ActivityText activity={doing} prefix="Now: " />}
              {!doing && s.current && <span className="min-w-0 flex-1 truncate" title={s.current.subject}><span className="text-muted-foreground">{s.current.status === "in_progress" ? "Now: " : "Next: "}</span>{sessionLabel(s.current)}</span>}
              {!doing && !s.current && <span className="flex-1" />}
              <Icon name={open ? "ChevronUp" : "ChevronDown"} className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          ) : (
            <Icon name={activity ? "Activity" : "ListChecks"} className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {!opens && activity && <ActivityText activity={activity} prefix="Now: " />}
          {more && (
            <span className="shrink-0 text-muted-foreground" title="Open goals exist, none is focused in this session. Open the Goals tab to pick one.">
              {tasks.length > 0 ? `+${others} goal${others === 1 ? "" : "s"}` : `${others} open goal${others === 1 ? "" : "s"}, none focused in this session. Open the Goals tab to pick one.`}
            </span>
          )}
        </div>
        {opens && open && <div className="max-h-56 overflow-y-auto border-t pt-1.5"><SessionTaskList tasks={tasks} /></div>}
      </div>
    );
  }
  const p = progress(goal);
  const task = currentTask(goal);
  const stuck = goal.status === "blocked" || goal.status === "paused" || goal.status === "budget_limited";
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="Target" className="size-4 shrink-0 text-muted-foreground" />
        {on("bannerStatus") && <StatusBadge goal={goal} />}
        {on("bannerTitle") && <span className="min-w-0 flex-1 truncate text-sm" title={goal.objective}>{title(goal)}</span>}
        {!on("bannerTitle") && <span className="flex-1" />}
        {on("bannerMore") && others > 0 && <span className="shrink-0 text-xs text-muted-foreground">+{others} goal{others === 1 ? "" : "s"}</span>}
        {on("bannerControls") && <PauseResume goal={goal} send={send} sending={sending} />}
      </div>
      {(on("bannerProgress") && p.total > 0) || (on("bannerCurrentTask") && task) ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Goal tasks ${p.done}/${p.total}. ${open ? "Hide" : "Show"} the tasks`}
          title={open ? "Hide the tasks" : "Show the tasks"}
          onClick={toggle}
          className="flex min-w-0 items-center gap-2 rounded text-left text-xs hover:bg-muted/50"
        >
          {on("bannerProgress") && p.total > 0 && (
            <>
              <span className="w-24 shrink-0"><Bar value={p.done} max={p.total} tone={p.done === p.total ? "good" : "info"} /></span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{p.done}/{p.total}</span>
            </>
          )}
          {on("bannerCurrentTask") && task && (
            <span className="min-w-0 flex-1 truncate" title={task.title}><span className="text-muted-foreground">Now: </span>{task.id} {task.title}</span>
          )}
          <span className="flex-1" />
          <Icon name={open ? "ChevronUp" : "ChevronDown"} className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      ) : null}
      {activity && (
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Icon name="Activity" className="size-3.5 shrink-0 text-muted-foreground" />
          <ActivityText activity={activity} prefix="Doing: " />
        </div>
      )}
      {open && goal.tasks.length > 0 && (
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto border-t pt-1.5">
          {goal.tasks.map((t) => <TaskRow key={t.id} task={t} current={task?.id ?? null} criteria={false} depth={0} />)}
        </ul>
      )}
      <Usage goal={goal} showUsage={on("bannerUsage")} showBudget={on("bannerBudget")} />
      {on("bannerBlocked") && stuck && <BlockedNote goal={goal} />}
    </div>
  );
}

/** The tool call running now, set apart from the plan: muted and italic, because no task says it. */
function ActivityText({ activity, prefix }: { activity: SessionActivity; prefix: string }) {
  return (
    <span className="min-w-0 flex-1 truncate italic text-muted-foreground" title={`${activity.tool}, started ${activity.since}`}>
      {prefix}{activity.label}
    </span>
  );
}

function Section({ title, icon, children, right }: { title: string; icon: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b px-3 py-3 last:border-b-0">
      <header className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon name={icon} className="size-3.5" />
        <span className="flex-1">{title}</span>
        {right}
      </header>
      {children}
    </section>
  );
}

function TaskRow({ task, current, criteria, depth }: { task: Task; current: string | null; criteria: boolean; depth: number }) {
  const icon = task.status === "complete" ? "CircleCheck" : task.status === "skipped" ? "CircleSlash" : task.id === current ? "CircleDot" : "Circle";
  const tone = task.status === "complete" ? TONE_TEXT.good : task.status === "skipped" ? TONE_TEXT.warn : task.id === current ? TONE_TEXT.info : TONE_TEXT.neutral;
  return (
    <li className="flex flex-col gap-0.5" style={{ paddingLeft: depth * 14 }}>
      <div className={join("flex items-start gap-1.5 text-sm", task.id === current && "font-medium")}>
        <Icon name={icon} className={join("mt-0.5 size-3.5 shrink-0", tone)} />
        <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{task.id}</span>
        <span className={join("min-w-0", task.status === "skipped" && "line-through opacity-70")}>{task.title}</span>
      </div>
      {criteria && (task.evidence || task.skipReason || task.verificationContract) && (
        <div className="ml-5 flex flex-col gap-0.5 text-xs text-muted-foreground">
          {task.verificationContract && <div><span className="font-medium text-foreground">Needs: </span>{task.verificationContract}</div>}
          {task.evidence && <div><span className="font-medium text-foreground">Evidence: </span>{task.evidence}</div>}
          {task.skipReason && <div><span className="font-medium text-foreground">Skipped: </span>{task.skipReason}</div>}
        </div>
      )}
      {task.subtasks.length > 0 && (
        <ul className="flex flex-col gap-1">
          {task.subtasks.map((sub) => <TaskRow key={sub.id} task={sub} current={current} criteria={criteria} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}

const SESSION_TASK: Record<SessionTask["status"], { icon: string; tone: keyof typeof TONE_TEXT }> = {
  pending: { icon: "Circle", tone: "neutral" },
  in_progress: { icon: "CircleDot", tone: "info" },
  completed: { icon: "CircleCheck", tone: "good" },
};

/** The session's own task list (pi/work tasks tool): what the agent plans and does without a goal. */
function SessionTasks({ tasks }: { tasks: SessionTask[] }) {
  const s = sessionProgress(tasks);
  return (
    <Section title={`Session tasks ${s.done}/${s.total}`} icon="ListChecks">
      {tasks.length === 0
        ? <p className="text-xs text-muted-foreground">The agent keeps no task list in this session yet.</p>
        : (
          <>
            <Bar value={s.done} max={s.total} tone={s.done === s.total ? "good" : "info"} />
            <SessionTaskList tasks={tasks} />
          </>
        )}
    </Section>
  );
}

/** The session tasks as a tree, subtasks indented under their parent. */
function SessionTaskList({ tasks }: { tasks: SessionTask[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {sessionTree(tasks).map(({ task, depth }) => (
        <li key={task.id} className="flex flex-col gap-0.5" style={{ paddingLeft: depth * 14 }}>
          <div className={join("flex items-start gap-1.5 text-sm", task.status === "in_progress" && "font-medium")}>
            <Icon name={SESSION_TASK[task.status].icon} className={join("mt-0.5 size-3.5 shrink-0", TONE_TEXT[SESSION_TASK[task.status].tone])} />
            <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{task.id}</span>
            <span className={join("min-w-0", task.status === "completed" && "opacity-70")}>{task.subject}</span>
            {task.blockedBy.length > 0 && task.status === "pending" && (
              <span className="shrink-0 text-xs leading-5 text-muted-foreground" title="Waits on these tasks">after {task.blockedBy.map((id) => "#" + id).join(", ")}</span>
            )}
          </div>
          {task.status === "in_progress" && task.activeForm && <div className="ml-5 text-xs text-muted-foreground">{task.activeForm}</div>}
          {task.description && <div className="ml-5 text-xs text-muted-foreground">{task.description}</div>}
        </li>
      ))}
    </ul>
  );
}

const VERDICT: Record<string, { label: string; icon: string; tone: keyof typeof TONE_TEXT }> = {
  approved: { label: "Approved", icon: "ShieldCheck", tone: "good" },
  disapproved: { label: "Disapproved", icon: "ShieldX", tone: "bad" },
  error: { label: "Auditor error", icon: "ShieldAlert", tone: "bad" },
  running: { label: "Audit running", icon: "Loader", tone: "info" },
  skipped: { label: "Audit skipped", icon: "Shield", tone: "neutral" },
};

function Activity({ events, goals }: { events: GoalEvent[]; goals: Goal[] }) {
  if (events.length === 0) return <p className="text-xs text-muted-foreground">No activity in the ledger yet.</p>;
  const names = new Map(goals.map((g) => [g.id, title(g, 40)]));
  return (
    <ol className="flex flex-col gap-1.5">
      {events.map((event, i) => (
        <li key={`${event.at}-${i}`} className="flex gap-2 text-xs">
          <span className="w-16 shrink-0 tabular-nums text-muted-foreground" title={event.at}>{ago(event.at)}</span>
          <span className="min-w-0">
            <span className={TONE_TEXT[event.tone]}>{event.text}</span>
            {event.goalId && goals.length > 1 && <span className="text-muted-foreground"> · {names.get(event.goalId) ?? event.goalId}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ViewSettings({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { on } = useViews();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      {(Object.entries(VIEWS) as [View, string][]).map(([view, label]) => (
        <label key={view} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={on(view)}
            onChange={(e) => rpc.call("setView", { view, on: e.target.checked }).then(() => setError(null), (c) => setError(message(c)))}
          />
          {label}
        </label>
      ))}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">Limits for activity and archive are in the plugin settings. Thread {threadId}.</p>
    </div>
  );
}

export function GoalsTab({ threadId }: { threadId: string }) {
  const { on } = useViews();
  const { data, error, send, sending } = useGoals(threadId);
  const [showSettings, setShowSettings] = useState(false);
  if (data === null) {
    return <div className="p-3 text-sm text-muted-foreground">{error ?? "Loading goals…"}</div>;
  }
  const { goal } = focused(data);
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {error && <div className="border-b px-3 py-2 text-xs text-destructive">{error}</div>}
      {data.error && <div className="border-b px-3 py-2 text-xs text-destructive">{data.error}</div>}
      {goal ? (
        <Section
          title="Focused goal"
          icon="Target"
          right={<button type="button" aria-label="View settings" className="rounded p-0.5 hover:bg-accent" onClick={() => setShowSettings((v) => !v)}><Icon name="Settings" className="size-3.5" /></button>}
        >
          <div className="flex items-center gap-2"><StatusBadge goal={goal} /><span className="font-mono text-xs text-muted-foreground">{goal.id}</span></div>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm">{goal.objective}</p>
          <Usage goal={goal} showUsage showBudget />
          <BlockedNote goal={goal} />
          <div className="flex flex-wrap gap-1.5">
            <PauseResume goal={goal} send={send} sending={sending} />
            <SmallButton label="Status" icon="Info" disabled={sending !== null} onClick={() => send("goal-status")} title="Send /goal-status" />
            <SmallButton label="Unfocus" icon="CircleOff" disabled={sending !== null} onClick={() => send("goal-unfocus")} title="Send /goal-unfocus" />
          </div>
          <ClearGoal goal={goal} send={send} sending={sending} />
        </Section>
      ) : (
        <Section
          title="Goals"
          icon="Target"
          right={<button type="button" aria-label="View settings" className="rounded p-0.5 hover:bg-accent" onClick={() => setShowSettings((v) => !v)}><Icon name="Settings" className="size-3.5" /></button>}
        >
          <p className="text-sm text-muted-foreground">
            {data.goals.length > 0 ? "No goal is focused in this session." : "No open goal. Start one with /goal in the composer."}
          </p>
        </Section>
      )}
      {showSettings && <Section title="Show" icon="Eye"><ViewSettings threadId={threadId} /></Section>}
      {!goal && on("tabSessionTasks") && data.linked && <SessionTasks tasks={data.sessionTasks} />}
      {goal && on("tabTasks") && (
        <Section title={`Tasks ${progress(goal).done}/${progress(goal).total}`} icon="ListChecks">
          {goal.tasks.length === 0
            ? <p className="text-xs text-muted-foreground">No task list yet.</p>
            : (
              <>
                <Bar value={progress(goal).done} max={progress(goal).total} tone={progress(goal).done === progress(goal).total ? "good" : "info"} />
                <ul className="flex flex-col gap-1.5">
                  {goal.tasks.map((t) => <TaskRow key={t.id} task={t} current={currentTask(goal)?.id ?? null} criteria={on("tabCriteria")} depth={0} />)}
                </ul>
              </>
            )}
        </Section>
      )}
      {goal && on("tabCriteria") && (goal.verificationContract || goal.blockCompletion !== null) && (
        <Section title="Completion criteria" icon="ClipboardCheck">
          {goal.verificationContract && <p className="whitespace-pre-wrap text-sm">{goal.verificationContract}</p>}
          {goal.blockCompletion !== null && (
            <p className="text-xs text-muted-foreground">
              {goal.blockCompletion ? "The goal cannot complete while tasks are pending." : "Tasks do not block completion."}
            </p>
          )}
        </Section>
      )}
      {goal && on("tabAudit") && (
        <Section title="Auditor" icon="ShieldCheck">
          {goal.skipAuditor && <p className="text-xs text-muted-foreground">The auditor is off for this goal.</p>}
          {goal.audit ? (
            <>
              <div className={join("flex items-center gap-1.5 text-sm font-medium", TONE_TEXT[VERDICT[goal.audit.verdict].tone])}>
                <Icon name={VERDICT[goal.audit.verdict].icon} className="size-4" />
                {VERDICT[goal.audit.verdict].label}
                <span className="font-normal text-xs text-muted-foreground">{ago(goal.audit.at)}</span>
              </div>
              {goal.audit.report && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Report</summary>
                  <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap">{goal.audit.report}</p>
                </details>
              )}
            </>
          ) : !goal.skipAuditor && <p className="text-xs text-muted-foreground">No audit yet; it runs when the agent asks to complete.</p>}
        </Section>
      )}
      {on("tabActivity") && (
        <Section title="Recent activity" icon="History"><Activity events={data.events} goals={data.goals} /></Section>
      )}
      {on("tabPool") && data.goals.length > (goal ? 1 : 0) && (
        <Section title={`Open goals (${data.goals.length})`} icon="Layers">
          <ul className="flex flex-col gap-2">
            {data.goals.map((g) => {
              const p = progress(g);
              const isFocused = g.id === data.focusedId;
              return (
                <li key={g.id} className={join("flex flex-col gap-1 rounded-md border px-2 py-1.5", isFocused && "border-primary")}>
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusBadge goal={g} />
                    <span className="min-w-0 flex-1 truncate text-sm" title={g.objective}>{title(g)}</span>
                    {!isFocused && <SmallButton label="Focus" icon="Crosshair" disabled={sending !== null} onClick={() => send("goal-focus", g.id)} title={`Send /goal-focus ${g.id}`} />}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {p.total > 0 && <span className="w-16"><Bar value={p.done} max={p.total} /></span>}
                    {p.total > 0 && <span className="tabular-nums">{p.done}/{p.total}</span>}
                    <span>{duration(g.activeSeconds)} · {tokens(g.tokensUsed)} tokens</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {on("tabArchived") && (
        <Section title="Archived" icon="Archive">
          {data.archived.length === 0
            ? <p className="text-xs text-muted-foreground">No archived goals.</p>
            : (
              <ul className="flex flex-col gap-1">
                {data.archived.map((a) => (
                  <li key={a.id} className="flex min-w-0 items-center gap-2 text-xs">
                    <Icon name={a.status === "complete" ? "CircleCheck" : "CircleX"} className={join("size-3.5 shrink-0", a.status === "complete" ? TONE_TEXT.good : TONE_TEXT.neutral)} />
                    <span className="min-w-0 flex-1 truncate" title={a.objective}>{a.objective.split("\n")[0]}</span>
                    <span className="shrink-0 text-muted-foreground">{a.taskCount > 0 ? `${a.tasksDone}/${a.taskCount} · ` : ""}{ago(a.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
        </Section>
      )}
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {data.root ? <span title={data.root}>Goals from {data.root}</span> : "No goal directory yet."}
        {!data.linked && (
          <span> · This thread is not linked to its pi session, so the focused goal is a guess. pi/work links it (scripts/install-pi.sh).</span>
        )}
      </div>
    </div>
  );
}

export const setupGoals = (app: PluginAppBuilder): void => {
};

export default definePluginApp(setupGoals);
