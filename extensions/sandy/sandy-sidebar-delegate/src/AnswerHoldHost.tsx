import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createAnswerHold, type AnswerHold, type HeldAnswer } from "./answer-hold";

const AnswerHoldContext = createContext<AnswerHold | null>(null);

export function AnswerHoldHost({ children }: { children: ReactNode }) {
  const [hold] = useState(createAnswerHold);
  useEffect(() => () => hold.flushAll(), [hold]);
  return <AnswerHoldContext.Provider value={hold}>{children}</AnswerHoldContext.Provider>;
}

export function useAnswerHold(): AnswerHold {
  const hold = useContext(AnswerHoldContext);
  if (!hold) throw new Error("Answer holds must be inside AnswerHoldHost");
  return hold;
}

export function useHeldAnswer(hold: AnswerHold, key: string | null): HeldAnswer | null {
  const label = useSyncExternalStore(hold.subscribe, () => (key ? (hold.get(key)?.label ?? null) : null));
  return label === null ? null : { label };
}
