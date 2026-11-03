export const ANSWER_HOLD_MS = 5000;

export type HeldAnswer = { label: string };

type Entry = HeldAnswer & { timer: ReturnType<typeof setTimeout>; send: () => void };

export type AnswerHold = {
  hold(key: string, answer: HeldAnswer, send: () => void): void;
  cancel(key: string): boolean;
  get(key: string): HeldAnswer | null;
  flushAll(): void;
  subscribe(listener: () => void): () => void;
};

export function createAnswerHold(delayMs = ANSWER_HOLD_MS): AnswerHold {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const release = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    emit();
    entry.send();
  };
  return {
    hold(key, answer, send) {
      const previous = entries.get(key);
      if (previous) clearTimeout(previous.timer);
      entries.set(key, { label: answer.label, send, timer: setTimeout(() => release(key), delayMs) });
      emit();
    },
    cancel(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      clearTimeout(entry.timer);
      entries.delete(key);
      emit();
      return true;
    },
    get(key) {
      const entry = entries.get(key);
      return entry ? { label: entry.label } : null;
    },
    flushAll() {
      for (const [key, entry] of [...entries]) {
        clearTimeout(entry.timer);
        release(key);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
