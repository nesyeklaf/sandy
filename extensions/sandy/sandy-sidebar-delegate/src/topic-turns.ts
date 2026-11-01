import type { TopicMessage } from "./topics-contract";

/** A user prompt with the agent messages that follow it, up to the next prompt. */
export interface Turn {
  fromSeq: number;
  toSeq: number;
  user: TopicMessage | null;
  agents: TopicMessage[];
}

export function groupTurns(messages: readonly TopicMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    const last = turns[turns.length - 1];
    if (message.role === "user" || !last) {
      turns.push({
        fromSeq: message.seq,
        toSeq: message.seq,
        user: message.role === "user" ? message : null,
        agents: message.role === "user" ? [] : [message],
      });
      continue;
    }
    last.agents.push(message);
    last.toSeq = message.seq;
  }
  return turns;
}

export interface RangeSelection {
  from: number;
  to: number;
  editingId?: string;
  /** The start is set; the next tap sets the end. */
  open?: boolean;
}

/** First tap sets a range and waits for the end; the second tap (or Shift) widens it to include the target. */
export function pickRange(
  current: RangeSelection | null,
  target: { from: number; to: number },
  extend: boolean,
): RangeSelection {
  if (current && (extend || current.open)) {
    return {
      from: Math.min(current.from, target.from),
      to: Math.max(current.to, target.to),
      editingId: current.editingId,
      open: false,
    };
  }
  return { from: target.from, to: target.to, open: true };
}
