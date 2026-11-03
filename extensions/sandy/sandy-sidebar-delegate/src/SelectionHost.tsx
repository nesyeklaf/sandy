import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface Selection {
  active: boolean;
  selectedIds: ReadonlySet<string>;
  enter: () => void;
  exit: () => void;
  toggle: (threadId: string) => void;
  clear: () => void;
}

const EMPTY: ReadonlySet<string> = new Set();

const INACTIVE: Selection = {
  active: false,
  selectedIds: EMPTY,
  enter: () => undefined,
  exit: () => undefined,
  toggle: () => undefined,
  clear: () => undefined,
};

const SelectionContext = createContext<Selection>(INACTIVE);

export function SelectionHost({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(EMPTY);
  const enter = useCallback(() => setActive(true), []);
  const exit = useCallback(() => {
    setActive(false);
    setSelectedIds(EMPTY);
  }, []);
  const clear = useCallback(() => setSelectedIds(EMPTY), []);
  const toggle = useCallback((threadId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(threadId)) next.add(threadId);
      return next;
    });
  }, []);
  const value = useMemo(
    () => ({ active, selectedIds, enter, exit, toggle, clear }),
    [active, selectedIds, enter, exit, toggle, clear],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): Selection {
  return useContext(SelectionContext);
}
