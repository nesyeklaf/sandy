// Chief of staff panel: decisions that need you first, then the backlog,
// your standing guidance, and recent activity.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useSandyNavigate, useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import { toast } from "sonner";
import type { Item, ItemAction, Overview, Question, rpcContract } from "./contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const CHANGED_CHANNEL = "cos-changed";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("overview").then(
      (next) => {
        setOverview(next);
        setError(null);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED_CHANNEL, refetch);
  return { rpc, overview, error, refetch };
}

/** Run an RPC call, toast failures, refetch on success. */
function useAction(refetch: () => void) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (call: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        await call();
        refetch();
        return true;
      } catch (cause) {
        toast.error(errorText(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refetch],
  );
  return { busy, run };
}

const STATUS: Record<Item["status"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "text-muted-foreground border-border" },
  starting: { label: "Starting", tone: "text-muted-foreground border-border" },
  running: { label: "Working", tone: "text-primary border-primary/40" },
  waiting_chief: { label: "With chief", tone: "text-primary border-primary/40" },
  waiting_user: { label: "Needs you", tone: "text-amber-600 dark:text-amber-400 border-amber-500/50" },
  done: { label: "Done", tone: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40" },
  failed: { label: "Failed", tone: "text-destructive border-destructive/40" },
  cancelled: { label: "Cancelled", tone: "text-muted-foreground border-border" },
};

const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs " +
  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring/40 disabled:opacity-50";

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

// Header

function Summary({ overview, rpc, run, busy }: { overview: Overview; rpc: Rpc; run: ReturnType<typeof useAction>["run"]; busy: boolean }) {
  const { items } = overview;
  const count = (...statuses: Item["status"][]) => items.filter((i) => statuses.includes(i.status)).length;
  const navigate = useSandyNavigate();
  const copyBrief = async () => {
    try {
      const { markdown } = await rpc.call("brief");
      await navigator.clipboard.writeText(markdown);
      toast.success("Briefing copied");
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };
  const stats: [string, number][] = [
    ["done", count("done")],
    ["working", count("starting", "running", "waiting_chief")],
    ["queued", count("queued")],
    ["need you", overview.decisions.length],
    ["answered by chief", overview.answeredByChief],
  ];
  return (
    <header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {items.length === 0
            ? "Paste your backlog below. Each item gets its own agent thread."
            : `${count("done")} of ${items.length} items done.`}
          {overview.paused ? " Dispatch is paused." : ""}
        </p>
        <div className="flex items-center gap-1.5">
          {overview.chiefThreadId === null ? null : (
            <Button variant="ghost" size="sm" onClick={() => navigate.toThread(overview.chiefThreadId!, { split: true })}>
              <Icon name="MessageSquare" className="size-4" />
              Chief thread
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={copyBrief}>
            <Icon name="ClipboardCopy" className="size-4" />
            Copy briefing
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => run(() => rpc.call("set_paused", { paused: !overview.paused }))}
          >
            <Icon name={overview.paused ? "Play" : "Pause"} className="size-4" />
            {overview.paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>
      {items.length === 0 ? null : (
        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
          {stats.map(([label, value]) => (
            <div key={label} className={cn("bg-card px-3 py-2.5", label === "need you" && value > 0 && "bg-amber-500/10")}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </header>
  );
}

// Decisions

function DecisionCard({ question, rpc, run, busy }: { question: Question; rpc: Rpc; run: ReturnType<typeof useAction>["run"]; busy: boolean }) {
  const navigate = useSandyNavigate();
  const [answer, setAnswer] = useState("");
  const decide = async (text: string) => {
    if (text.trim() === "") return;
    if (await run(() => rpc.call("decide", { questionId: question.id, answer: text.trim() }))) setAnswer("");
  };
  const isPrompt = question.kind === "prompt";
  return (
    <li className="rounded-lg border border-amber-500/40 bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Q{question.id} · #{question.itemId} {question.itemTitle}
        </p>
        {question.threadId === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 -mt-1.5 h-7"
            onClick={() => navigate.toThread(question.threadId!, { split: true })}
          >
            Open thread
            <Icon name="ArrowUpRight" className="size-3.5" />
          </Button>
        )}
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm font-medium text-foreground">{question.question}</p>
      {question.why ? <p className="mt-2 text-sm text-muted-foreground">{question.why}</p> : null}
      {question.recommendation ? (
        <p className="mt-2 text-sm">
          <span className="font-medium">Chief recommends: </span>
          {question.recommendation}
        </p>
      ) : null}
      {isPrompt ? (
        <div className="mt-3">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("Handled in the thread")}>
            Mark handled
          </Button>
        </div>
      ) : (
        <>
          {question.options.length === 0 ? null : (
            <div className="mt-3 flex flex-wrap gap-2">
              {question.options.map((option) => (
                <Button key={option} size="sm" variant="outline" disabled={busy} onClick={() => decide(option)}>
                  {option}
                </Button>
              ))}
            </div>
          )}
          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void decide(answer);
            }}
          >
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void decide(answer);
              }}
              rows={1}
              placeholder={question.options.length > 0 ? "Or write your own answer…" : "Your answer…"}
              aria-label={`Answer to Q${question.id}`}
              className={cn(fieldClass, "min-h-9 resize-y")}
            />
            <Button type="submit" size="sm" disabled={busy || answer.trim() === ""}>
              Send
            </Button>
          </form>
        </>
      )}
    </li>
  );
}

// Backlog

function Intake({ overview, rpc, run, busy }: { overview: Overview; rpc: Rpc; run: ReturnType<typeof useAction>["run"]; busy: boolean }) {
  const [text, setText] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  useEffect(() => {
    rpc.call("projects").then(
      (list) => {
        setProjects(list);
        setProjectId((current) => current || overview.lastProjectId || list[0]?.id || "");
      },
      (cause) => toast.error(errorText(cause)),
    );
    // Projects load once per mount; lastProjectId only seeds the choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() === "" || projectId === "") return;
    if (await run(() => rpc.call("add_backlog", { text, projectId }))) setText("");
  };
  return (
    <form onSubmit={submit} className="rounded-lg border border-border bg-card p-3">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={4}
        placeholder={"One item per line. Indent lines under an item to add details.\n- Fix the flaky checkout test\n- Draft the Q3 roadmap doc\n    focus on infra cost"}
        aria-label="Backlog items"
        className={cn(fieldClass, "resize-y font-mono text-[13px]")}
      />
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Project
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            disabled={projects === null}
            className={cn(fieldClass, "h-8 w-auto py-0")}
          >
            {(projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" disabled={busy || text.trim() === "" || projectId === ""}>
          <Icon name="Plus" className="size-4" />
          Add to backlog
        </Button>
      </div>
    </form>
  );
}

function ItemRow({ item, act, busy }: { item: Item; act: (action: ItemAction) => void; busy: boolean }) {
  const navigate = useSandyNavigate();
  const status = STATUS[item.status];
  const note = item.summary ?? item.lastUpdate;
  const open = item.status === "queued" || item.status === "starting" || item.status === "running" || item.status === "waiting_chief" || item.status === "waiting_user";
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className={cn("mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", status.tone)}>
        {status.label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground" title={item.title}>
          <span className="text-muted-foreground tabular-nums">#{item.id}</span> {item.title}
        </p>
        {note ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{note}</p> : null}
      </div>
      <div className="flex shrink-0 items-center">
        {item.threadId === null ? null : (
          <IconButton label="Open thread" icon="ArrowUpRight" onClick={() => navigate.toThread(item.threadId!, { split: true })} />
        )}
        {item.status === "failed" || item.status === "cancelled" ? (
          <IconButton label="Retry" icon="RotateCcw" disabled={busy} onClick={() => act("retry")} />
        ) : null}
        {open ? (
          <IconButton label="Cancel" icon="CircleSlash" disabled={busy} onClick={() => act("cancel")} />
        ) : (
          <IconButton label="Remove" icon="Trash2" disabled={busy} onClick={() => act("remove")} />
        )}
      </div>
    </li>
  );
}

function IconButton({ label, icon, onClick, disabled }: { label: string; icon: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground" aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} className="size-4" />
    </Button>
  );
}

function Guidance({ overview, rpc, run, busy }: { overview: Overview; rpc: Rpc; run: ReturnType<typeof useAction>["run"]; busy: boolean }) {
  const [text, setText] = useState(overview.guidance);
  useEffect(() => setText(overview.guidance), [overview.guidance]);
  const dirty = text !== overview.guidance;
  return (
    <div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        placeholder="How the chief of staff should decide for you, e.g. prefer small PRs; never merge to main; ask me about anything that costs money."
        aria-label="Standing guidance"
        className={cn(fieldClass, "resize-y")}
      />
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => run(() => rpc.call("set_guidance", { text }))}>
          Save guidance
        </Button>
      </div>
    </div>
  );
}

const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function ChiefOfStaffPage() {
  const { rpc, overview, error, refetch } = useOverview();
  const { busy, run } = useAction(refetch);
  if (overview === null) {
    return (
      <Frame>
        {error === null ? <Empty>Loading…</Empty> : <p role="alert" className="text-sm text-destructive">{error}</p>}
      </Frame>
    );
  }
  const shared = { overview, rpc, run, busy };
  const order: Item["status"][] = ["waiting_user", "waiting_chief", "running", "starting", "queued", "failed", "done", "cancelled"];
  const items = [...overview.items].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.id - b.id);
  return (
    <Frame>
      <Summary {...shared} />
      {error === null ? null : <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <Section title={`Decisions for you (${overview.decisions.length})`}>
        {overview.decisions.length === 0 ? (
          <Empty>Nothing needs you. The chief of staff handles routine questions.</Empty>
        ) : (
          <ul className="space-y-3">
            {overview.decisions.map((question) => (
              <DecisionCard key={question.id} question={question} rpc={rpc} run={run} busy={busy} />
            ))}
          </ul>
        )}
      </Section>
      <Section title="Backlog" aside={<span className="text-xs text-muted-foreground">Up to {overview.maxConcurrent} at a time</span>}>
        <Intake {...shared} />
        {items.length === 0 ? null : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {items.map((item) => (
              <ItemRow key={item.id} item={item} busy={busy} act={(action) => void run(() => rpc.call("item_action", { itemId: item.id, action }))} />
            ))}
          </ul>
        )}
      </Section>
      <Section title="Standing guidance">
        <Guidance {...shared} />
      </Section>
      {overview.activity.length === 0 ? null : (
        <Section title="Activity">
          <ol className="space-y-1 text-xs text-muted-foreground">
            {overview.activity.map((entry) => (
              <li key={entry.id} className="flex gap-3">
                <span className="w-12 shrink-0 tabular-nums">{timeOf(entry.at)}</span>
                <span className="min-w-0">{entry.text}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-8 pt-3 md:px-5 md:pt-4">{children}</div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "chief-of-staff",
    title: "Chief of staff",
    icon: "Briefcase",
    path: "chief-of-staff",
    component: ChiefOfStaffPage,
  });
});
