import { isActiveTerminalSessionStatus } from "@sandy/domain";
import type { TerminalSession } from "@sandy/server-contract";

export function isVisibleTerminalSession(session: TerminalSession): boolean {
  return (
    isActiveTerminalSessionStatus(session.status) ||
    session.status === "disconnected"
  );
}
