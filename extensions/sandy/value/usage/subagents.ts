// What Claude Code's subagents cost. sandy reports only a thread's own usage, so
// a subagent's tokens never reach it; Claude Code writes them to a transcript
// per subagent instead. This reads those transcripts' lines. Pure.

/** One model call a subagent made. */
export interface SubagentCall {
  messageId: string;
  createdAt: number;
  /** Input read fresh, including tokens written to the prompt cache. */
  input: number;
  cacheRead: number;
  output: number;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  uuid?: string;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

/**
 * The model calls in a run of transcript lines. Claude Code writes one line
 * per content block, each carrying its message's usage, so a message appears
 * several times; the last line for a message id wins.
 */
export function subagentCallsOf(text: string): SubagentCall[] {
  const calls = new Map<string, SubagentCall>();
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    const usage = line.message?.usage;
    if (line.type !== "assistant" || usage === undefined) continue;
    const messageId = line.message?.id ?? line.uuid;
    const createdAt = line.timestamp === undefined ? NaN : Date.parse(line.timestamp);
    if (messageId === undefined || Number.isNaN(createdAt)) continue;
    calls.set(messageId, {
      messageId,
      createdAt,
      input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      cacheRead: usage.cache_read_input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
    });
  }
  return [...calls.values()];
}

/** The part of `text` up to its last newline, so a line still being written is read next time. */
export function completeLines(text: string): string {
  const end = text.lastIndexOf("\n");
  return end === -1 ? "" : text.slice(0, end + 1);
}
