import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Icon } from "./components/Icon";
import { toast } from "./lib/toast";
import { formatTokens } from "./TopicHeader";
import { buildEntries, type TopicEntry } from "./topic-layout";
import { entryAt, stepEntry } from "./topic-rail";
import { topicStats } from "./topic-messages";
import type { TocTabProps } from "./toc-extension";
import { useTopics } from "./useTopics";
import "./topics.css";

type Props = Pick<TocTabProps, "threadId" | "jumpToSeq" | "activeSeq" | "hoveredBand" | "setHoveredRange" | "openTab">;

/** The hover view of the thread rail: topics of the session as a short list; a click jumps there. */
export function TopicsPopover({
  threadId,
  jumpToSeq,
  activeSeq = null,
  hoveredBand = null,
  setHoveredRange,
  openTab,
}: Props) {
  const topics = useTopics(threadId);
  const [note, setNote] = useState<string | null>(null);
  const entries = useMemo(
    () => buildEntries(topics.segments, topics.suggestions),
    [topics.segments, topics.suggestions],
  );
  const here = entryAt(entries, activeSeq);
  const saved = entries.filter((entry) => !entry.suggested);

  useEffect(() => () => setHoveredRange?.(null), [setHoveredRange]);

  const guard = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    }
  };
  const suggest = () =>
    guard(async () => {
      setNote(null);
      try {
        if ((await topics.suggest()) === 0) setNote("The AI found no topics.");
      } catch (error) {
        setNote(error instanceof Error ? error.message : "The AI could not suggest topics.");
      }
    });
  const go = (delta: -1 | 1) => {
    const next = stepEntry(saved, activeSeq, delta);
    if (next) jumpToSeq(next.fromSeq);
  };
  const suggested = entries.filter((entry) => entry.suggested);

  return (
    <div className="sandy-topics-pop flex flex-col gap-1.5 p-2 text-xs">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="sandy-topics-ai"
          data-busy={topics.suggesting ? "" : undefined}
          disabled={topics.suggesting || topics.messages.length === 0}
          onClick={() => void suggest()}
        >
          <Icon name={topics.suggesting ? "Loading" : "AiMagic"} className="size-3.5" aria-hidden />
          {topics.suggesting ? "Reading…" : "Suggest topics"}
        </button>
        <span className="ml-auto flex gap-0.5">
          <button
            type="button"
            aria-label="Previous topic"
            disabled={saved.length === 0}
            className="flex size-6 items-center justify-center rounded hover:bg-accent disabled:opacity-40"
            onClick={() => go(-1)}
          >
            <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next topic"
            disabled={saved.length === 0}
            className="flex size-6 items-center justify-center rounded hover:bg-accent disabled:opacity-40"
            onClick={() => go(1)}
          >
            <Icon name="ChevronRight" className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>
      {note ? <p className="text-muted-foreground">{note}</p> : null}
      {suggested.length > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed px-2 py-1 text-2xs">
          <span className="min-w-0 flex-1">{suggested.length} AI suggestions</span>
          <button
            type="button"
            className="rounded-full bg-foreground px-2 py-0.5 text-background"
            onClick={() =>
              void guard(async () => {
                for (const entry of suggested) await topics.accept(entry);
              })
            }
          >
            Accept all
          </button>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={topics.discardAll}>
            Discard
          </button>
        </div>
      ) : null}
      {topics.loaded && entries.length === 0 ? (
        <p className="text-muted-foreground">
          No topics yet. Let the AI suggest some, or drag along the rail to mark a range.
        </p>
      ) : null}
      <ul className="flex flex-col gap-px" aria-label="Topics">
        {entries.map((entry) => (
          <TopicRow
            key={entry.key}
            entry={entry}
            stats={topicStats(topics.messages, entry.fromSeq, entry.toSeq)}
            here={here === entry}
            lit={hoveredBand !== null && hoveredBand.fromSeq === entry.fromSeq && hoveredBand.toSeq === entry.toSeq}
            onJump={() => jumpToSeq(entry.fromSeq)}
            onHover={(on) => setHoveredRange?.(on ? { fromSeq: entry.fromSeq, toSeq: entry.toSeq } : null)}
            onAccept={() => void guard(() => topics.accept(entry))}
            onDiscard={() => topics.discard(entry.fromSeq, entry.toSeq)}
          />
        ))}
      </ul>
      {openTab ? (
        <button
          type="button"
          className="self-end rounded px-1 text-2xs text-muted-foreground hover:text-foreground"
          onClick={() => openTab("topics-manage")}
        >
          Manage ›
        </button>
      ) : null}
    </div>
  );
}

function TopicRow({
  entry,
  stats,
  here,
  lit,
  onJump,
  onHover,
  onAccept,
  onDiscard,
}: {
  entry: TopicEntry;
  stats: ReturnType<typeof topicStats>;
  here: boolean;
  lit: boolean;
  onJump: () => void;
  onHover: (on: boolean) => void;
  onAccept: () => void;
  onDiscard: () => void;
}) {
  return (
    <li
      className="sandy-topics-poprow flex items-center gap-1.5 rounded-md px-1.5 py-1"
      style={{ "--h": entry.hue } as CSSProperties}
      data-suggested={entry.suggested ? "" : undefined}
      data-here={here ? "" : undefined}
      data-lit={lit ? "" : undefined}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <span className="sandy-topics-popdot" aria-hidden />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onJump}>
        <span className="block truncate font-medium">{entry.title}</span>
        <span className="block text-2xs text-muted-foreground">
          {stats.user + stats.assistant} msgs · {formatTokens(stats.tokens)} tokens
        </span>
      </button>
      {here ? <span className="rounded-full bg-accent px-1.5 text-2xs">here</span> : null}
      {entry.suggested ? (
        <span className="flex gap-1">
          <button type="button" aria-label="Accept topic" className="rounded px-1 hover:bg-accent" onClick={onAccept}>
            <Icon name="Check" className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Discard suggestion"
            className="rounded px-1 hover:bg-accent"
            onClick={onDiscard}
          >
            <Icon name="CircleX" className="size-3.5" aria-hidden />
          </button>
        </span>
      ) : null}
    </li>
  );
}
