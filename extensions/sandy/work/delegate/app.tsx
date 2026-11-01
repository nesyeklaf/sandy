// The "question" form of sandy_ask_parent (server/ask.ts): shown in the delegated child's composer, it submits
// { answer } or dismisses the question. The "Delegates" thread tab (DelegatesTab below, server/panel.ts):
// the viewed thread's delegations, or a delegate child's own row, with transcript, steer, answer, stop,
// reveal, prompt audit and, for writers, branch changes and Merge.
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  definePluginApp, experimental_useRpcQuery, ThreadChat, ThreadTitle, useSandyNavigate, useComposer, useRpc,
  type ExperimentalThreadContextSegmentProps, type PluginPendingInteractionProps,
} from "@sandy-sdk/plugin-sdk/app";
import type { PluginAppBuilder } from "@sandy-sdk/plugin-sdk/app";
import { rpcContract } from "./contract.ts";
import { useOpenWork } from "../work-tab-link.ts";
import type { PanelRow } from "./panel-types.ts";
import {
  bannerRows, canStopAll, needsAck, childSegmentText, fleetCounts, fleetSegmentText, openRows, formatFleetCounts, formatReasoning, formatRuntime, formatTokens,
  isEnded, mergeMessage, moveSelection, panelLayout, stateLabel, statusTone, type StatusTone,
} from "./panel-view.ts";

type QuestionFormPayload = { questionId?: string; question?: string; options?: string[] };

function QuestionForm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = (interaction.payload ?? {}) as QuestionFormPayload;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = (answer: string) => {
    if (answer.trim() === "" || busy) return;
    setBusy(true);
    void submit({ answer }).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-2 p-2 text-sm">
      <div className="text-xs text-muted-foreground">Question from the delegated agent{payload.questionId ? ` (${payload.questionId})` : ""}</div>
      <div className="whitespace-pre-wrap">{payload.question ?? interaction.title}</div>
      {payload.options && payload.options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {payload.options.map((option) => (
            <button key={option} type="button" disabled={busy} className="rounded border px-2 py-1 text-xs hover:bg-muted" onClick={() => send(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        className="min-h-16 rounded border bg-transparent px-2 py-1"
        placeholder="Answer"
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send(text);
        }}
      />
      <div className="flex gap-2">
        <button type="button" disabled={busy || text.trim() === ""} className="rounded border px-2 py-1 text-xs" onClick={() => send(text)}>
          Answer
        </button>
        <button type="button" disabled={busy} className="rounded px-2 py-1 text-xs text-muted-foreground" onClick={() => void cancel()}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

const POLL_MS = 3000;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const TONE_CLASS: Record<StatusTone, string> = {
  running: "text-blue-600 dark:text-blue-400",
  waiting: "text-amber-600 dark:text-amber-400",
  done: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  ended: "text-muted-foreground",
};

// Narrow panels (panelLayout) get touch-sized buttons, at least 36px tall.
const NarrowContext = createContext(false);
const BUTTON = "rounded border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50";
const useButtonClass = (): string => (useContext(NarrowContext) ? `${BUTTON} min-h-9 px-3` : BUTTON);


// A delegation the composer banner asked the Delegates tab to open; the tab consumes it when it has the row.
let requestedDelegation: string | null = null;
const requestListeners = new Set<() => void>();
function requestDelegation(delegationId: string | null) {
  requestedDelegation = delegationId;
  for (const listener of requestListeners) listener();
}
const useRequestedDelegation = (): string | null =>
  useSyncExternalStore(
    (listener) => {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    () => requestedDelegation,
  );

function useDelegates(threadId: string, enabled = true) {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "listDelegates", input: { threadId }, enabled });
  const { refetch } = query;
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [refetch, enabled]);
  return query;
}

// Runs one panel action at a time and keeps its last message (or error) for the row.
function useAction(after: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = (action: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    action()
      .then((text) => setMessage(text))
      .catch((error: unknown) => setMessage(`error: ${errorText(error)}`))
      .finally(() => {
        setBusy(false);
        after();
      });
  };
  return { busy, message, run };
}

function AsksYouBadge() {
  return <span className="shrink-0 rounded-full bg-amber-100 px-1.5 font-medium text-amber-800 dark:bg-amber-900/60 dark:text-amber-200">asks you</span>;
}

function RowSummary({ row, selected, open, onOpen }: { row: PanelRow; selected: boolean; open: boolean; onOpen(): void }) {
  const narrow = useContext(NarrowContext);
  const tone = statusTone(row);
  const asks = row.question?.state === "open";
  return (
    <button
      type="button"
      data-delegation={row.delegationId}
      className={`flex w-full flex-col gap-0.5 border-b px-2 ${narrow ? "py-2.5" : "py-1.5"} text-left text-xs ${selected ? "bg-muted" : "hover:bg-muted/50"}`}
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-center gap-2">
        {asks ? <AsksYouBadge /> : <span className={`shrink-0 font-medium ${TONE_CLASS[tone]}`}>{row.status}</span>}
        <span className="shrink-0 font-medium">{row.agent}</span>
        <span className="min-w-0 truncate text-muted-foreground">{row.title ?? row.delegationId}</span>
        {row.hidden === false ? <span className="shrink-0 text-muted-foreground">visible</span> : null}
        {row.stale ? <span className="shrink-0 text-amber-600 dark:text-amber-400">stale</span> : null}
        {row.acknowledged ? <span className="shrink-0 text-muted-foreground">acknowledged</span> : null}
        <span className="ml-auto shrink-0 text-muted-foreground">{narrow ? "›" : open ? "▾" : "▸"}</span>
      </div>
      <div className={`flex min-w-0 gap-x-3 tabular-nums text-muted-foreground ${narrow ? "flex-wrap" : "items-baseline"}`}>
        <span className={narrow ? "" : "min-w-0 flex-1 truncate"} title="model">{row.model ?? "model —"}</span>
        <span className={narrow ? "" : "w-28 shrink-0"}>{formatReasoning(row.reasoningLevel)}</span>
        <span className={narrow ? "" : "w-44 shrink-0 text-right"} title="Σ tokens / context in use">{formatTokens(row.tokens)}</span>
        <span className={narrow ? "ml-auto" : "w-16 shrink-0 text-right"} title="runtime">{formatRuntime(row.runtime)}</span>
      </div>
      {row.error !== null ? <div className="truncate text-red-600 dark:text-red-400">{row.error}</div> : null}
      {row.sandyError !== undefined ? <div className="truncate text-red-600 dark:text-red-400">SANDY: {row.sandyError}</div> : null}
      {row.question !== null ? <div className="truncate text-amber-700 dark:text-amber-300">? {row.question.question}</div> : null}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function SendBox({ row, threadId, after }: { row: PanelRow; threadId: string; after(): void }) {
  const button = useButtonClass();
  const rpc = useRpc<typeof rpcContract>();
  const action = useAction(after);
  const [text, setText] = useState("");
  const question = row.question?.state === "open" ? row.question : null;
  const send = (mode: "steer" | "queue") =>
    action.run(async () => {
      const sent = await rpc.call("sendToDelegate", { threadId, delegationId: row.delegationId, message: text, mode });
      setText("");
      return `${sent.status}: ${sent.detail}`;
    });
  const answer = (value: string) =>
    action.run(async () => {
      const answered = await rpc.call("answerQuestion", { delegationId: row.delegationId, questionId: question!.questionId, answer: value });
      setText("");
      return `answered ${answered.questionId} (${answered.delivery})`;
    });
  return (
    <Section title={question !== null ? "Answer the question" : "Steer"}>
      {question !== null ? (
        <>
          <div className="whitespace-pre-wrap text-xs">{question.question}</div>
          {question.options.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {question.options.map((option) => (
                <button key={option} type="button" className={button} disabled={action.busy} onClick={() => answer(option)}>
                  {option}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      <textarea
        className="min-h-14 rounded border bg-transparent px-2 py-1 text-xs"
        placeholder={question !== null ? "Answer" : "Message to the child (Ctrl+Enter steers)"}
        value={text}
        disabled={action.busy || isEnded(row)}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text.trim() !== "") (question !== null ? answer(text) : send("steer"));
        }}
      />
      <div className="flex flex-wrap items-center gap-1">
        {question !== null ? (
          <button type="button" className={button} disabled={action.busy || text.trim() === ""} onClick={() => answer(text)}>Answer</button>
        ) : (
          <>
            <button type="button" className={button} disabled={action.busy || text.trim() === "" || isEnded(row)} onClick={() => send("steer")}>Steer</button>
            <button type="button" className={button} disabled={action.busy || text.trim() === "" || isEnded(row)} onClick={() => send("queue")}>Queue</button>
          </>
        )}
        {action.message !== null ? <span className="text-xs text-muted-foreground">{action.message}</span> : null}
      </div>
    </Section>
  );
}

function WriterSection({ row, threadId, after }: { row: PanelRow; threadId: string; after(): void }) {
  const button = useButtonClass();
  const rpc = useRpc<typeof rpcContract>();
  const details = experimental_useRpcQuery({ contract: rpcContract, method: "writerDetails", input: { threadId, delegationId: row.delegationId } });
  const action = useAction(() => {
    void details.refetch();
    after();
  });
  const running = statusTone(row) === "running";
  return (
    <Section title="Branch">
      {details.error !== null ? <div className="text-xs text-muted-foreground">{details.error.message}</div> : null}
      {details.data !== undefined ? (
        <>
          <div className="text-xs">
            <span className="font-mono">{details.data.branch}</span> → <span className="font-mono">{details.data.base}</span>
            <span className="text-muted-foreground"> ({details.data.commits.length} commit{details.data.commits.length === 1 ? "" : "s"} to merge)</span>
          </div>
          {details.data.files.length > 0 ? (
            <ul className="max-h-32 overflow-auto font-mono text-[11px]">
              {details.data.files.map((file) => (
                <li key={file.path}>
                  <span className="inline-block w-5 text-muted-foreground">{file.status}</span>
                  {file.path}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={button}
          disabled={action.busy || running || details.data === undefined || details.data.merged}
          title={running ? "wait until the child is done" : undefined}
          onClick={() => action.run(async () => mergeMessage(await rpc.call("mergeDelegate", { threadId, delegationId: row.delegationId })))}
        >
          Merge
        </button>
        {action.message !== null ? <span className="text-xs">{action.message}</span> : null}
      </div>
    </Section>
  );
}

function PromptAuditSection({ row, threadId }: { row: PanelRow; threadId: string }) {
  const [open, setOpen] = useState(false);
  const audit = experimental_useRpcQuery({ contract: rpcContract, method: "promptAudit", input: { threadId, delegationId: row.delegationId }, enabled: open });
  const data = audit.data;
  return (
    <details className="text-xs" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Prompt audit</summary>
      {audit.error !== null ? <div className="text-red-600">{audit.error.message}</div> : null}
      {data !== undefined ? (
        <div className="mt-1 flex flex-col gap-1">
          <div>
            {data.agent} v{data.agentVersion ?? "—"} ({data.role ?? "—"}) · {data.model ?? "—"} · thinking {data.thinking ?? "—"}
          </div>
          <div className="text-muted-foreground">snapshot <span className="font-mono">{data.snapshotHash?.slice(0, 12) ?? "—"}</span> · policy <span className="font-mono">{data.policyHash?.slice(0, 12) ?? "—"}</span></div>
          <div>requested tools: <span className="font-mono">{data.requestedTools.join(", ") || "—"}</span></div>
          <div>active tools: <span className="font-mono">{data.activeTools.join(", ") || "—"}</span> + transport <span className="font-mono">{data.transportTools.join(", ")}</span></div>
          <div className="text-muted-foreground">bootstrap prompt</div>
          <pre className="whitespace-pre-wrap rounded border p-1 font-mono text-[11px]">{data.bootstrapPrompt}</pre>
          {data.brief !== null ? (
            <>
              <div className="text-muted-foreground">brief{data.brief.title ? ` "${data.brief.title}"` : ""} · {data.brief.deliveredAt === null ? "not delivered" : `delivered ${new Date(data.brief.deliveredAt).toLocaleTimeString()}`}</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border p-1 font-mono text-[11px]">{data.brief.task}</pre>
              {data.brief.body !== null ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border p-1 font-mono text-[11px]">{data.brief.body}</pre> : null}
            </>
          ) : (
            <div className="text-muted-foreground">no brief stored</div>
          )}
          <div className="text-muted-foreground">acks by pi session</div>
          {data.sessions.length === 0 ? <div>none</div> : null}
          {data.sessions.map((session) => (
            <div key={session.piSessionId ?? "unacked"} className="font-mono text-[11px]">
              {session.piSessionId ?? "(issued, not acked)"}: {session.acks.map((ack) => (ack.ackedAt === null ? "issued" : `turn ${ack.turn}${ack.turnSeq !== null ? `@${ack.turnSeq}` : ""}${ack.briefDeliveredAt !== null ? " +brief" : ""}`)).join(", ")}
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
}

// The transcript starts at the latest message: ThreadChat's timeline opens at its top, so the scrollable
// element inside is moved to its end while the transcript first loads.
function Transcript({ threadId }: { threadId: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const toEnd = () => {
      for (const element of box.current?.querySelectorAll<HTMLElement>("*") ?? []) {
        if (element.scrollHeight > element.clientHeight + 1 && getComputedStyle(element).overflowY !== "visible") element.scrollTop = element.scrollHeight;
      }
    };
    const timers = [100, 400, 1000, 2000].map((ms) => setTimeout(toEnd, ms));
    return () => timers.forEach(clearTimeout);
  }, [threadId]);
  return (
    <div ref={box} className="h-96 overflow-hidden rounded border">
      <ThreadChat threadId={threadId} variant="timeline" layout="contained" />
    </div>
  );
}

function RowDetail({ row, threadId, after }: { row: PanelRow; threadId: string; after(): void }) {
  const button = useButtonClass();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useSandyNavigate();
  const action = useAction(after);
  const ended = isEnded(row);
  const asks = row.question?.state === "open";
  const failed = statusTone(row) === "failed";
  return (
    <div className="flex flex-col gap-2 border-b bg-muted/20 px-2 py-2">
      {asks ? <SendBox row={row} threadId={threadId} after={after} /> : null}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={button}
          disabled={action.busy || ended}
          onClick={() =>
            action.run(async () => {
              const stopped = await rpc.call("stopDelegates", { threadId, delegationId: row.delegationId });
              const entry = stopped.stopped[0];
              return entry === undefined ? "nothing to stop" : `${entry.state}${entry.stopConfirmed ? "" : " (stop not confirmed yet)"}${entry.error ? `: ${entry.error}` : ""}`;
            })
          }
        >
          Stop
        </button>
        {failed ? (
          <button
            type="button"
            className={button}
            disabled={action.busy || row.acknowledged}
            title="Keeps the failure here, removes it from the banner above the composer"
            onClick={() =>
              action.run(async () => {
                const result = await rpc.call("ackFailures", { threadId, delegationId: row.delegationId });
                return result.acknowledged.length > 0 ? "acknowledged" : "no failure to acknowledge";
              })
            }
          >
            {row.acknowledged ? "Acknowledged" : "Acknowledge"}
          </button>
        ) : null}
        {row.threadId !== null && row.hidden !== null ? (
          <button
            type="button"
            className={button}
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                const result = await rpc.call("setDelegateHidden", { threadId, delegationId: row.delegationId, hidden: !row.hidden });
                return result.hidden ? "hidden from the sidebar" : "revealed in the sidebar";
              })
            }
          >
            {row.hidden ? "Reveal" : "Hide"}
          </button>
        ) : null}
        {row.threadId !== null ? (
          <button type="button" className={button} onClick={() => navigate.toThread(row.threadId!, { split: true })}>Open thread</button>
        ) : null}
        <span className="font-mono text-[11px] text-muted-foreground">{row.delegationId}</span>
        {action.message !== null ? <span className="text-xs">{action.message}</span> : null}
      </div>
      {!asks ? <SendBox row={row} threadId={threadId} after={after} /> : null}
      {row.role === "writer" ? <WriterSection row={row} threadId={threadId} after={after} /> : null}
      <PromptAuditSection row={row} threadId={threadId} />
      {row.threadId !== null ? (
        <Section title="Transcript">
          <Transcript threadId={row.threadId} />
        </Section>
      ) : null}
    </div>
  );
}

function useElementWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function DelegatesTab({ threadId }: { threadId: string }) {
  const list = useDelegates(threadId);
  const rpc = useRpc<typeof rpcContract>();
  const [selected, setSelected] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const narrow = panelLayout(useElementWidth(container)) === "narrow";
  const button = narrow ? `${BUTTON} min-h-9 px-3` : BUTTON;
  const requested = useRequestedDelegation();
  const refresh = () => void list.refetch();
  const stopAll = useAction(refresh);
  const rows = list.data?.rows ?? [];
  useEffect(() => {
    if (list.data?.viewedIsChild && rows.length === 1 && openId === null) setOpenId(rows[0].delegationId);
  }, [list.data?.viewedIsChild, rows.length]);
  useEffect(() => {
    if (requested === null) return;
    const index = rows.findIndex((row) => row.delegationId === requested);
    if (index === -1) return;
    setSelected(index);
    setOpenId(requested);
    requestDelegation(null);
  }, [requested, rows.length]);
  useEffect(() => {
    container.current?.querySelector(`[data-delegation="${rows[selected]?.delegationId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected, openId]);
  if (list.data === undefined) {
    return <div ref={container} className="p-3 text-xs text-muted-foreground">{list.error !== null ? list.error.message : "Loading delegates…"}</div>;
  }
  const openRow = rows.find((row) => row.delegationId === openId);
  // Narrow: the open row's detail replaces the list; Back returns to it.
  const detailOnly = narrow && openRow !== undefined;
  return (
    <NarrowContext.Provider value={narrow}>
      <div
        ref={container}
        tabIndex={0}
        className="flex h-full flex-col overflow-auto text-sm outline-none"
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget && (event.target as HTMLElement).tagName !== "BUTTON") return;
          if (event.key === "Enter") {
            const row = rows[selected];
            if (row !== undefined) setOpenId(openId === row.delegationId ? null : row.delegationId);
            event.preventDefault();
            return;
          }
          if (event.key === "Escape" && openId !== null) {
            setOpenId(null);
            event.preventDefault();
            return;
          }
          const next = moveSelection(event.key, selected, rows.length);
          if (next !== selected) {
            setSelected(next);
            event.preventDefault();
          }
        }}
      >
        <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5 text-xs">
          {detailOnly ? (
            <button type="button" className={button} onClick={() => setOpenId(null)}>‹ Back</button>
          ) : null}
          <span className="font-medium">{list.data.viewedIsChild ? "This delegate" : `Delegates (${rows.length}${list.data.truncated ? "+" : ""})`}</span>
          <span className="text-muted-foreground">{formatFleetCounts(fleetCounts(rows))}</span>
          {list.error !== null ? <span className="text-red-600">{list.error.message}</span> : null}
          <span className="ml-auto" />
          {stopAll.message !== null ? <span className="text-muted-foreground">{stopAll.message}</span> : null}
          {!list.data.viewedIsChild ? (
            <button
              type="button"
              className={button}
              disabled={stopAll.busy || !canStopAll(rows)}
              title={canStopAll(rows) ? undefined : "nothing is running or waiting to start"}
              onClick={() =>
                stopAll.run(async () => {
                  const stopped = await rpc.call("stopDelegates", { threadId });
                  return `stopped ${stopped.stopped.length}${stopped.skipped.length > 0 ? `, skipped ${stopped.skipped.length}` : ""}`;
                })
              }
            >
              Stop all
            </button>
          ) : null}
        </div>
        {rows.length === 0 ? <div className="p-3 text-xs text-muted-foreground">No delegations from this thread.</div> : null}
        {detailOnly ? (
          <>
            <RowSummary row={openRow} selected open onOpen={() => setOpenId(null)} />
            <RowDetail row={openRow} threadId={threadId} after={refresh} />
          </>
        ) : (
          rows.map((row, index) => (
            <div key={row.delegationId}>
              <RowSummary
                row={row}
                selected={index === selected}
                open={openId === row.delegationId}
                onOpen={() => {
                  setSelected(index);
                  setOpenId(openId === row.delegationId ? null : row.delegationId);
                }}
              />
              {openId === row.delegationId && !narrow ? <RowDetail row={row} threadId={threadId} after={refresh} /> : null}
            </div>
          ))
        )}
      </div>
    </NarrowContext.Provider>
  );
}

// The tab, the composer segment and the banner show on a thread that launched delegations or is a delegate child.
export function useDelegatesTabVisible({ threadId }: { threadId: string }): boolean {
  const list = experimental_useRpcQuery({ contract: rpcContract, method: "listDelegates", input: { threadId } });
  return (list.data?.rows.length ?? 0) > 0;
}

// The composer segment shows on a delegate child, and on a parent only while one of its children is open
// (running, asks the parent, failed). It polls, so it appears again when a new child starts.
function useDelegatesSegmentVisible({ threadId }: { threadId: string }): boolean {
  const list = useDelegates(threadId);
  if (list.data === undefined) return false;
  return list.data.viewedIsChild ? list.data.rows.length > 0 : openRows(list.data.rows).length > 0;
}

// Opens the Delegates tab of the current thread view, with that delegation selected when given.
function useOpenDelegates(): (delegationId?: string) => void {
  const openWork = useOpenWork();
  return (delegationId) => {
    if (delegationId !== undefined) requestDelegation(delegationId);
    openWork("delegates");
  };
}

// Composer context segment: on a parent the fleet ("3 delegates · 1 asks you · Σ 74k"), on a delegate child
// its own agent, role and state.
function DelegatesSegmentSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const list = useDelegates(threadId);
  const rows = list.data?.rows ?? [];
  if (rows.length === 0) return null;
  const child = list.data?.viewedIsChild ? rows[0] : undefined;
  const asks = rows.some((row) => row.question?.state === "open");
  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      className={`inline-flex min-h-7 max-w-full items-center gap-1 truncate rounded px-1 text-xs hover:bg-muted ${asks ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
      onClick={onToggle}
    >
      <span className="truncate">{child !== undefined ? childSegmentText(child) : fleetSegmentText(rows)}</span>
      <span className="shrink-0">{isExpanded ? "▾" : "▸"}</span>
    </button>
  );
}

function DelegatesSegmentAction() {
  const open = useOpenDelegates();
  return (
    <button type="button" className="min-h-7 rounded px-1.5 text-xs underline-offset-2 hover:underline" onClick={() => open()}>
      Delegates
    </button>
  );
}

function DelegatesSegmentDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const list = useDelegates(threadId, isExpanded);
  const open = useOpenDelegates();
  if (!isExpanded || list.data === undefined) return null;
  const rows = list.data.rows;
  if (list.data.viewedIsChild && rows[0] !== undefined) {
    const row = rows[0];
    return (
      <div className="flex flex-col gap-0.5 px-2 py-1 text-xs">
        <div>agent <span className="font-medium">{row.agent}{row.agentVersion !== null ? ` v${row.agentVersion}` : ""}</span> · role {row.role ?? "—"} · {stateLabel(row)}</div>
        <div className="flex min-w-0 items-center gap-1 text-muted-foreground">
          delegated by <span className="min-w-0 truncate text-foreground"><ThreadTitle threadId={row.parentThreadId} /></span>
        </div>
        {row.question?.state === "open" ? <div className="truncate text-amber-700 dark:text-amber-300">? {row.question.question}</div> : null}
      </div>
    );
  }
  const openList = openRows(rows);
  const done = rows.length - openList.length;
  return (
    <ul className="flex max-h-56 flex-col overflow-auto px-1 py-1 text-xs">
      {openList.map((row) => (
        <li key={row.delegationId}>
          <button
            type="button"
            className="flex min-h-8 w-full min-w-0 flex-wrap items-center gap-x-2 rounded px-1 text-left tabular-nums hover:bg-muted"
            onClick={() => open(row.delegationId)}
          >
            {row.question?.state === "open" ? <AsksYouBadge /> : <span className={`font-medium ${TONE_CLASS[statusTone(row)]}`}>{row.status}</span>}
            <span className="font-medium">{row.agent}</span>
            <span className="text-muted-foreground">{row.model ?? "—"}</span>
            <span className="text-muted-foreground">{row.tokens.total === null ? "—" : formatTokens(row.tokens)}</span>
            <span className="ml-auto text-muted-foreground">{formatRuntime(row.runtime)}</span>
          </button>
        </li>
      ))}
      {done > 0 ? (
        <li>
          <button type="button" className="min-h-8 w-full rounded px-1 text-left text-muted-foreground hover:bg-muted hover:underline" onClick={() => open()}>
            +{done} done → Delegates
          </button>
        </li>
      ) : null}
    </ul>
  );
}

const BANNER_ROWS = 4;

// Fleet banner above a parent's composer, only while a child asks the parent or failed; a row opens that
// child in the Delegates tab. The collapsed composer shows one row.
export function FleetBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : "";
  const list = useDelegates(threadId || "none", threadId !== "");
  const open = useOpenDelegates();
  const rpc = useRpc<typeof rpcContract>();
  const refresh = () => void list.refetch();
  const ack = useAction(refresh);
  if (threadId === "" || list.data === undefined || list.data.viewedIsChild) return null;
  const needing = bannerRows(list.data.rows);
  if (needing.length === 0) return null;
  const limit = composer.layout === "compact" ? 1 : BANNER_ROWS;
  const failures = needing.filter(needsAck).length;
  const acknowledge = (delegationId?: string) =>
    ack.run(async () => {
      const result = await rpc.call("ackFailures", delegationId === undefined ? { threadId } : { threadId, delegationId });
      return `${result.acknowledged.length} acknowledged`;
    });
  return (
    <div className="flex flex-col rounded-md border border-amber-300 bg-amber-50/60 text-xs dark:border-amber-700 dark:bg-amber-950/30">
      {needing.slice(0, limit).map((row) => (
        <div key={row.delegationId} className="flex min-h-9 min-w-0 items-center hover:bg-amber-100/70 dark:hover:bg-amber-900/40">
          <button type="button" className="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-2 text-left" onClick={() => open(row.delegationId)}>
            {row.question?.state === "open" ? <AsksYouBadge /> : <span className="shrink-0 font-medium text-red-600 dark:text-red-400">{row.status}</span>}
            <span className="shrink-0 font-medium">{row.agent}</span>
            <span className="min-w-0 truncate text-muted-foreground">
              {row.question?.state === "open" ? row.question.question : (row.error ?? row.sandyError ?? row.title ?? "")}
            </span>
            <span className="ml-auto shrink-0 text-muted-foreground">Open ›</span>
          </button>
          {needsAck(row) ? (
            <button
              type="button"
              aria-label={`Acknowledge the failure of ${row.agent}`}
              title="Acknowledge: removes it from this banner, it stays in Delegates"
              disabled={ack.busy}
              className="min-h-9 shrink-0 px-2 text-muted-foreground hover:text-foreground disabled:opacity-50"
              onClick={() => acknowledge(row.delegationId)}
            >
              ✕
            </button>
          ) : null}
        </div>
      ))}
      {needing.length > limit || failures > 1 ? (
        <div className="flex min-h-8 items-center gap-3 px-2">
          {needing.length > limit ? (
            <button type="button" className="text-left text-muted-foreground hover:underline" onClick={() => open()}>
              +{needing.length - limit} more in Delegates
            </button>
          ) : null}
          {failures > 1 ? (
            <button type="button" disabled={ack.busy} className="ml-auto text-muted-foreground hover:underline disabled:opacity-50" onClick={() => acknowledge()}>
              Acknowledge {failures} failures
            </button>
          ) : null}
        </div>
      ) : null}
      {ack.message?.startsWith("error") ? <div className="px-2 pb-1 text-red-600 dark:text-red-400">{ack.message}</div> : null}
    </div>
  );
}

export const setupDelegate = (app: PluginAppBuilder): void => {
  app.slots.pendingInteraction({ id: "question", component: QuestionForm });
  app.slots.experimental_threadContextSegment({
    id: "delegates",
    title: "Delegates",
    group: "delegates",
    summary: DelegatesSegmentSummary,
    action: DelegatesSegmentAction,
    details: DelegatesSegmentDetails,
    useVisible: useDelegatesSegmentVisible,
  });
};

export default definePluginApp(setupDelegate);
