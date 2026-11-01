import type { TopicMessage } from "./topics-contract";

interface EventRow {
  seq: number;
  type: string;
  data: unknown;
}

const PREVIEW_LENGTH = 300;

export function measureText(text: string): Pick<TopicMessage, "lines" | "words" | "tokens"> {
  const trimmed = text.trim();
  return {
    lines: trimmed === "" ? 0 : trimmed.split("\n").length,
    words: trimmed === "" ? 0 : trimmed.split(/\s+/).length,
    // A rough estimate: about four characters per token.
    tokens: Math.ceil(trimmed.length / 4),
  };
}

function message(seq: number, role: TopicMessage["role"], text: string): TopicMessage | null {
  if (text.trim() === "") return null;
  return { seq, role, preview: text.trim().replace(/\s+/g, " ").slice(0, PREVIEW_LENGTH), ...measureText(text) };
}

/** User prompts and finished agent messages, the same seqs a `#msg=` link uses. */
export function messageFromEvent(event: EventRow): TopicMessage | null {
  const data = event.data as {
    initiator?: string;
    input?: Array<{ type?: string; text?: string }>;
    item?: { type?: string; text?: string };
  };
  if (event.type === "client/turn/requested" && data.initiator === "user") {
    const text = (data.input ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
    return message(event.seq, "user", text);
  }
  if (event.type === "item/completed" && data.item?.type === "agentMessage") {
    return message(event.seq, "assistant", data.item.text ?? "");
  }
  return null;
}

interface TopicStats {
  user: number;
  assistant: number;
  lines: number;
  words: number;
  tokens: number;
}

export function topicStats(messages: readonly TopicMessage[], fromSeq: number, toSeq: number): TopicStats {
  const stats: TopicStats = { user: 0, assistant: 0, lines: 0, words: 0, tokens: 0 };
  for (const m of messages) {
    if (m.seq < fromSeq || m.seq > toSeq) continue;
    if (m.role === "user") stats.user += 1;
    else stats.assistant += 1;
    stats.lines += m.lines;
    stats.words += m.words;
    stats.tokens += m.tokens;
  }
  return stats;
}
