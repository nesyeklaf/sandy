import { useSandyNavigate } from "@sandy-sdk/plugin-sdk/app";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { TagEditor } from "./TagEditor";
import { TopicDraftForm } from "./TopicDraftForm";
import { TopicHeader, formatTokens } from "./TopicHeader";
import { TopicMap } from "./TopicMap";
import { TopicTagBar } from "./TopicTagBar";
import { TopicTurnRow } from "./TopicTurnRow";
import { Icon } from "./components/Icon";
import { buildEntries, clipTitle, layoutTurns, mapRuns, turnRange } from "./topic-layout";
import { topicStats } from "./topic-messages";
import { groupTurns, pickRange, type RangeSelection } from "./topic-turns";
import { toast } from "./lib/toast";
import { useTopics } from "./useTopics";
import type { TocTabProps } from "./toc-extension";
import { useTurnDrag } from "./useTurnDrag";
import "./topics.css";

/** The Topics tab: topic ranges of one session, drawn in color, picked by dragging, proposed by the model. */
export function TopicsTab({
  threadId,
  jumpToSeq,
  railSelection,
  clearRailSelection,
}: { threadId: string } & Partial<Pick<TocTabProps, "jumpToSeq" | "railSelection" | "clearRailSelection">>) {
  const topics = useTopics(threadId);
  const [selection, setSelection] = useState<RangeSelection | null>(null);
  const [title, setTitle] = useState("");
  const [highlight, setHighlight] = useState<{ from: number; to: number } | null>(null);
  const [cursor, setCursor] = useState(-1);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const navigate = useSandyNavigate();
  // experimental_messageSeq needs the sandy fork; an older host ignores it and just opens the thread.
  // Inside the rail panel the host scrolls the open chat itself.
  const openInChat = (seq: number) => {
    if (jumpToSeq) jumpToSeq(seq);
    else navigate.toThread(threadId, { experimental_messageSeq: seq } as Parameters<typeof navigate.toThread>[1]);
  };

  const guard = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    }
  };

  const turns = useMemo(() => groupTurns(topics.messages), [topics.messages]);
  // A range dragged along the rail becomes the draft, titled after its first prompt.
  useEffect(() => {
    if (!railSelection) return;
    setSelection({ from: railSelection.fromSeq, to: railSelection.toSeq });
    const first = turns.find((turn) => turn.fromSeq <= railSelection.fromSeq && railSelection.fromSeq <= turn.toSeq);
    setTitle(clipTitle(first?.user?.preview ?? ""));
    clearRailSelection?.();
  }, [railSelection, turns, clearRailSelection]);
  const entries = useMemo(
    () => buildEntries(topics.segments, topics.suggestions),
    [topics.segments, topics.suggestions],
  );
  const slots = useMemo(() => layoutTurns(turns, entries), [turns, entries]);
  const runs = useMemo(() => mapRuns(slots), [slots]);
  const allTags = useMemo(() => [...new Set(entries.flatMap((entry) => entry.tags))].sort(), [entries]);
  const suggested = entries.filter((entry) => entry.suggested);
  const dimmed = (tags: readonly string[] | undefined) => activeTag !== null && !tags?.includes(activeTag);

  const pick = (from: number, to: number, extend: boolean) =>
    setSelection((current) => pickRange(current, { from, to }, extend));
  const { drag, handlers } = useTurnDrag((a, b, extend) => {
    const range = turnRange(turns, a, b);
    if (!range) return;
    setSelection((current) =>
      current && extend
        ? { from: Math.min(current.from, range.from), to: Math.max(current.to, range.to), editingId: current.editingId }
        : { ...range },
    );
    if (!selection?.editingId && title === "") setTitle(clipTitle(turns[a]?.user?.preview ?? ""));
  });

  const jump = (from: number, to: number) => {
    setHighlight({ from, to });
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-from]") ?? []);
    const row = rows.find((el) => Number(el.dataset.from) <= from && from <= Number(el.dataset.to));
    if (row && "scrollIntoView" in row) row.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const step = (delta: number) => {
    const saved = entries.filter((entry) => !entry.suggested);
    if (saved.length === 0) return;
    const next = (((cursor + delta) % saved.length) + saved.length) % saved.length;
    const entry = saved[next];
    setCursor(next);
    if (!entry) return;
    jump(entry.fromSeq, entry.toSeq);
    openInChat(entry.fromSeq);
  };
  const suggest = () =>
    guard(async () => {
      setAiNote(null);
      try {
        const count = await topics.suggest();
        if (count === 0) setAiNote("The AI found no topics.");
      } catch (error) {
        setAiNote(error instanceof Error ? error.message : "The AI could not suggest topics.");
      }
    });
  const acceptAll = () =>
    guard(async () => {
      for (const entry of suggested) await topics.accept(entry);
    });
  const save = () =>
    guard(async () => {
      if (!selection || title.trim() === "") return;
      await topics.save({ id: selection.editingId, fromSeq: selection.from, toSeq: selection.to, title });
      setSelection(null);
      setTitle("");
    });
  const cancel = () => {
    setSelection(null);
    setTitle("");
  };

  const total = topicStats(topics.messages, 0, Number.MAX_SAFE_INTEGER);
  const picked = selection ? topicStats(topics.messages, selection.from, selection.to) : null;
  const dragged = drag ? { from: Math.min(drag.anchor, drag.current), to: Math.max(drag.anchor, drag.current) } : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-xs">
      <section className="flex flex-col gap-1">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Session tags</h3>
        <TagEditor
          tags={topics.threadTags}
          label="Tags for this session"
          onChange={(tags) => void guard(() => topics.setTags("thread", threadId, tags))}
        />
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Topics ({topics.segments.length})
          </h3>
          {entries.some((entry) => !entry.suggested) && topics.segments.length > 1 ? (
            <span className="flex gap-1">
              <button
                type="button"
                aria-label="Previous topic"
                className="flex size-6 items-center justify-center rounded hover:bg-accent"
                onClick={() => step(-1)}
              >
                <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label="Next topic"
                className="flex size-6 items-center justify-center rounded hover:bg-accent"
                onClick={() => step(1)}
              >
                <Icon name="ChevronRight" className="size-3.5" aria-hidden />
              </button>
            </span>
          ) : null}
          <button
            type="button"
            className="sandy-topics-ai ml-auto"
            data-busy={topics.suggesting ? "" : undefined}
            disabled={topics.suggesting || topics.messages.length === 0}
            onClick={() => void suggest()}
          >
            <Icon name={topics.suggesting ? "Loading" : "AiMagic"} className="size-3.5" aria-hidden />
            {topics.suggesting ? "AI is reading the session…" : "Suggest topics"}
          </button>
        </div>
        {aiNote ? <p className="text-muted-foreground">{aiNote}</p> : null}
        <TopicMap
          runs={runs}
          isDimmed={(run) => dimmed(run.owner?.tags) && activeTag !== null}
          onJump={(seq) => jump(seq, seq)}
        />
        <p className="text-2xs text-muted-foreground">
          Total: {total.user} user · {total.assistant} agent · {total.lines} lines · {total.words} words ·{" "}
          {formatTokens(total.tokens)} Tokens
        </p>
        <TopicTagBar
          tags={allTags}
          active={activeTag}
          onToggle={(tag) => setActiveTag((now) => (now === tag ? null : tag))}
        />
        {suggested.length > 0 ? (
          <div className="sandy-topics-banner">
            <span className="min-w-0 flex-1">
              {suggested.length} AI suggestions. Nothing is saved until you accept.
            </span>
            <button
              type="button"
              className="rounded-full bg-foreground px-3 py-1 text-background"
              onClick={() => void acceptAll()}
            >
              Accept all
            </button>
            <button
              type="button"
              className="px-2 text-muted-foreground hover:text-foreground"
              onClick={topics.discardAll}
            >
              Discard
            </button>
          </div>
        ) : null}
        {topics.error ? <p className="text-destructive">{topics.error}</p> : null}
        {topics.loaded && entries.length === 0 ? (
          <p className="text-muted-foreground">
            No topics yet. Let the AI suggest some, or drag over the turns of a topic below.
          </p>
        ) : null}
      </section>

      <section className="flex min-h-0 flex-col gap-1.5">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          History ({turns.length} turns · {topics.messages.length} messages)
        </h3>
        {selection ? null : (
          <p className="text-2xs text-muted-foreground">
            A turn is a prompt with the agent's answer. Drag over the turns of a topic to create it.
          </p>
        )}
        {selection && picked ? (
          <TopicDraftForm
            from={selection.from}
            to={selection.to}
            open={Boolean(selection.open)}
            editing={Boolean(selection.editingId)}
            stats={picked}
            title={title}
            onTitle={setTitle}
            onSave={() => void save()}
            onCancel={cancel}
          />
        ) : null}
        <ul ref={listRef} className="flex flex-col gap-px" aria-label="Messages" {...handlers}>
          {slots.map((slot) => (
            <Fragment key={slot.turn.fromSeq}>
              {slot.starts.map((entry) => (
                <li key={entry.key}>
                  <TopicHeader
                    entry={entry}
                    messages={topics.messages}
                    threadId={threadId}
                    onJump={() => jump(entry.fromSeq, entry.toSeq)}
                    onOpenChat={() => openInChat(entry.fromSeq)}
                    onUseRange={() => {
                      setSelection({ from: entry.fromSeq, to: entry.toSeq, editingId: entry.id ?? undefined });
                      setTitle(entry.title);
                      jump(entry.fromSeq, entry.toSeq);
                    }}
                    onDelete={() => entry.id && void guard(() => topics.remove(entry.id as string))}
                    onTags={(tags) => entry.id && void guard(() => topics.setTags("segment", entry.id as string, tags))}
                    onAccept={() => void guard(() => topics.accept(entry))}
                    onDiscard={() => topics.discard(entry.fromSeq, entry.toSeq)}
                  />
                </li>
              ))}
              <TopicTurnRow
                slot={slot}
                picked={
                  Boolean(selection && selection.from <= slot.turn.toSeq && selection.to >= slot.turn.fromSeq) ||
                  Boolean(dragged && slot.index >= dragged.from && slot.index <= dragged.to)
                }
                highlighted={Boolean(
                  highlight && highlight.from <= slot.turn.toSeq && highlight.to >= slot.turn.fromSeq,
                )}
                dimmed={activeTag !== null && dimmed(slot.owner?.tags)}
                selection={selection}
                onPick={pick}
              />
            </Fragment>
          ))}
        </ul>
      </section>
    </div>
  );
}
