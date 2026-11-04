import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { CleanSettledDialog } from "./CleanSettledDialog";

type OpenCleanSettled = (threadIds: readonly string[]) => void;

const CleanSettledContext = createContext<OpenCleanSettled | null>(null);

export function CleanSettledHost({ onNavigate, children }: { onNavigate: () => void; children: ReactNode }) {
  const [threadIds, setThreadIds] = useState<string[] | null>(null);
  const open = useMemo<OpenCleanSettled>(() => (ids) => setThreadIds([...ids]), []);
  return (
    <CleanSettledContext.Provider value={open}>
      {children}
      {threadIds ? (
        <CleanSettledDialog
          threadIds={threadIds}
          open
          onOpenChange={(next) => {
            if (!next) setThreadIds(null);
          }}
          onNavigate={onNavigate}
        />
      ) : null}
    </CleanSettledContext.Provider>
  );
}

export function useOpenCleanSettled(): OpenCleanSettled | null {
  return useContext(CleanSettledContext);
}
