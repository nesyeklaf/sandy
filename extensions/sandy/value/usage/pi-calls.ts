// What Pi's own session file says each model call used. sandy reports one usage
// event per turn, and it holds only the turn's last call, so a turn with thirty
// tool calls is counted as one. Pi writes every call, with the cost it
// worked out, to a file on the host it runs on. Pure: text in, calls out.

/** One model call Pi made. */
export interface PiCall {
  /** Unique across files: the provider's response id, else the file and entry id. */
  key: string;
  createdAt: number;
  model: string;
  /** Input read fresh, including tokens written to the prompt cache. */
  input: number;
  cacheRead: number;
  output: number;
  /** Dollars Pi priced the call at; null when it gave none or none above zero. */
  costUsd: number | null;
}

interface SessionLine {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    responseId?: string;
    timestamp?: number;
    usage?: {
      input?: number;
      cacheRead?: number;
      cacheWrite?: number;
      output?: number;
      cost?: { total?: number };
    };
  };
}

/** The file name Pi uses for a provider thread id, which sandy reports as `pi_<uuid>` or `thr_<id>`. */
export function sessionFileName(providerThreadId: string): string | null {
  return /^[A-Za-z0-9_-]+$/.test(providerThreadId) ? `${providerThreadId}.jsonl` : null;
}

/** The assistant calls in a session file's text. Lines that are not complete JSON are skipped. */
export function piCallsOf(text: string, fileKey: string): PiCall[] {
  const calls = new Map<string, PiCall>();
  for (const raw of text.split("\n")) {
    if (!raw.includes('"usage"')) continue;
    let line: SessionLine;
    try {
      line = JSON.parse(raw) as SessionLine;
    } catch {
      continue;
    }
    const message = line.message;
    const usage = message?.usage;
    if (line.type !== "message" || message?.role !== "assistant" || usage === undefined) continue;
    const createdAt = message.timestamp ?? Date.parse(line.timestamp ?? "");
    if (!Number.isFinite(createdAt)) continue;
    const cost = usage.cost?.total;
    const key = message.responseId ?? `${fileKey}:${line.id ?? createdAt}`;
    calls.set(key, {
      key,
      createdAt,
      model: message.model ?? "",
      input: (usage.input ?? 0) + (usage.cacheWrite ?? 0),
      cacheRead: usage.cacheRead ?? 0,
      output: usage.output ?? 0,
      costUsd: typeof cost === "number" && cost > 0 ? cost : null,
    });
  }
  return [...calls.values()];
}
