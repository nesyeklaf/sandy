export const ANSWER_HOLD_MS = 5000;

export type HeldAnswer = { label: string; sending: boolean };

type Entry =
  | { view: HeldAnswer; sending: false; timer: ReturnType<typeof setTimeout>; discard: () => void }
  | { view: HeldAnswer; sending: true };

export type AnswerHold = {
  hold(key: string, answer: { label: string }, send: () => Promise<void>, discard?: () => void): void;
  cancel(key: string): boolean;
  get(key: string): HeldAnswer | null;
  discardAll(): void;
  subscribe(listener: () => void): () => void;
};

export function createAnswerHold(delayMs = ANSWER_HOLD_MS): AnswerHold {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const release = (key: string, label: string, send: () => Promise<void>) => {
    entries.set(key, { view: { label, sending: true }, sending: true });
    emit();
    send().catch(() => {
      entries.delete(key);
      emit();
    });
  };
  const drop = (key: string): boolean => {
    const entry = entries.get(key);
    if (!entry || entry.sending) return false;
    clearTimeout(entry.timer);
    entries.delete(key);
    entry.discard();
    return true;
  };
  return {
    hold(key, answer, send, discard = () => {}) {
      if (entries.get(key)?.sending) return;
      drop(key);
      const timer = setTimeout(() => release(key, answer.label, send), delayMs);
      entries.set(key, { view: { label: answer.label, sending: false }, sending: false, timer, discard });
      emit();
    },
    cancel(key) {
      const dropped = drop(key);
      if (dropped) emit();
      return dropped;
    },
    get(key) {
      return entries.get(key)?.view ?? null;
    },
    discardAll() {
      let dropped = false;
      for (const key of [...entries.keys()]) dropped = drop(key) || dropped;
      if (dropped) emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
