import { useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";
import type { TurnSlot } from "./topic-layout";
import type { TopicMessage } from "./topics-contract";
import "./topics.css";

interface TurnRowProps {
  slot: TurnSlot;
  /** In the range being picked, by drag or by tap. */
  picked: boolean;
  highlighted: boolean;
  dimmed: boolean;
  /** Inside the open range, exact messages count; elsewhere the whole turn. */
  selection: { from: number; to: number } | null;
  /** Keyboard and tap: first press sets a start, the second the end. */
  onPick: (from: number, to: number, extend: boolean) => void;
}

function Line({ message, className }: { message: TopicMessage; className?: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className={cn("min-w-0 flex-1", className)}>{message.preview}</span>
      <span className="shrink-0 text-2xs text-muted-foreground">{message.lines} Z.</span>
    </span>
  );
}

/** One turn: the prompt and the final answer in full width; the steps in between fold away. */
export function TopicTurnRow({ slot, picked, highlighted, dimmed, selection, onPick }: TurnRowProps) {
  const { turn, owner } = slot;
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const answer = turn.agents[turn.agents.length - 1] ?? null;
  const steps = turn.agents.slice(0, -1);
  return (
    <li
      data-turn={slot.index}
      data-from={turn.fromSeq}
      data-to={turn.toSeq}
      data-owner={owner ? "topic" : "none"}
      data-suggested={owner?.suggested ? "" : undefined}
      data-picked={picked ? "" : undefined}
      data-highlight={highlighted ? "" : undefined}
      data-dim={dimmed ? "" : undefined}
      data-full={expanded ? "" : undefined}
      className="sandy-topics-turn"
      style={{ "--h": owner?.hue } as CSSProperties}
    >
      <span data-grip className="sandy-topics-grip" aria-hidden>
        <Icon name="DragHandle" className="size-3.5" aria-hidden />
      </span>
      <button
        type="button"
        data-pick
        aria-pressed={picked}
        className="sandy-topics-pick text-xs"
        onClick={(event) => {
          // A mouse press is handled by the drag; a keyboard press has no detail.
          if (event.detail === 0) onPick(turn.fromSeq, turn.toSeq, event.shiftKey);
        }}
      >
        {turn.user ? <Line message={turn.user} className="sandy-topics-clamp-3 font-semibold" /> : null}
        {answer ? <Line message={answer} className="sandy-topics-clamp-2 mt-0.5 text-muted-foreground" /> : null}
      </button>
      <div className="flex items-center gap-1 pb-1 pl-5 text-2xs text-muted-foreground">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Shorten text" : "Show full text"}
          className="rounded px-1 hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-3" aria-hidden />
        </button>
        {steps.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            className="flex items-center gap-1 rounded px-1 hover:text-foreground"
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3" aria-hidden />
            {steps.length} steps
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className="ml-5 flex flex-col pb-1" aria-label="Intermediate steps">
          {steps.map((step) => {
            const inRange = selection !== null && step.seq >= selection.from && step.seq <= selection.to;
            return (
              <li key={step.seq}>
                <button
                  type="button"
                  aria-pressed={inRange}
                  className={cn(
                    "w-full rounded px-1.5 py-0.5 text-left text-2xs text-muted-foreground hover:bg-accent",
                    inRange && "bg-primary/15",
                  )}
                  onClick={(event) => onPick(step.seq, step.seq, event.shiftKey)}
                >
                  <Line message={step} className="sandy-topics-clamp-2" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
