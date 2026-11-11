import { assert } from "./assert";
import type { CoordinationMode } from "./space-coordination-contract";
import type { ServerContext } from "./server-context";

type Database = ServerContext["db"];

export function createSpaceRolesStore(db: Database) {
  const selectOrchestrator = db.prepare("SELECT space_id FROM space_orchestrators WHERE thread_id = ?");
  const selectOrchestratorsOfSpace = db.prepare(
    "SELECT thread_id FROM space_orchestrators WHERE space_id = ? ORDER BY assigned_at, thread_id",
  );
  const selectAllOrchestrators = db.prepare(
    "SELECT thread_id FROM space_orchestrators ORDER BY assigned_at, thread_id",
  );
  const selectManagedSpace = db.prepare("SELECT space_id FROM space_managed_members WHERE thread_id = ?");
  const selectWake = db.prepare("SELECT wake_enabled FROM space_settings WHERE space_id = ?");

  return {
    orchestratorSpaceOf(threadId: string): string | null {
      assert(threadId.length > 0, "threadId must not be empty");
      const row = selectOrchestrator.get(threadId) as { space_id: string } | undefined;
      return row === undefined ? null : row.space_id;
    },

    orchestratorsOf(spaceId: string): string[] {
      assert(spaceId.length > 0, "spaceId must not be empty");
      return (selectOrchestratorsOfSpace.all(spaceId) as Array<{ thread_id: string }>).map((row) => row.thread_id);
    },

    allOrchestrators(): string[] {
      return (selectAllOrchestrators.all() as Array<{ thread_id: string }>).map((row) => row.thread_id);
    },

    assignOrchestrator(threadId: string, spaceId: string, nowMs: number): boolean {
      assert(threadId.length > 0 && spaceId.length > 0, "thread and Space ids must not be empty");
      const existing = this.orchestratorSpaceOf(threadId);
      if (existing === spaceId) return false;
      db.prepare("INSERT OR REPLACE INTO space_orchestrators (thread_id, space_id, assigned_at) VALUES (?, ?, ?)").run(
        threadId,
        spaceId,
        nowMs,
      );
      assert(this.orchestratorSpaceOf(threadId) === spaceId, "orchestrator row must exist after assignment");
      return true;
    },

    clearOrchestrator(threadId: string): string | null {
      const existing = this.orchestratorSpaceOf(threadId);
      if (existing === null) return null;
      db.prepare("DELETE FROM space_orchestrators WHERE thread_id = ?").run(threadId);
      assert(this.orchestratorSpaceOf(threadId) === null, "orchestrator row must be gone after clearing");
      return existing;
    },

    managedSpaceOf(threadId: string): string | null {
      const row = selectManagedSpace.get(threadId) as { space_id: string } | undefined;
      return row === undefined ? null : row.space_id;
    },

    modeIn(threadId: string, spaceId: string | null): CoordinationMode {
      return spaceId !== null && this.managedSpaceOf(threadId) === spaceId ? "managed" : "independent";
    },

    setMode(threadId: string, spaceId: string, mode: CoordinationMode, nowMs: number): boolean {
      assert(threadId.length > 0 && spaceId.length > 0, "thread and Space ids must not be empty");
      const before = this.modeIn(threadId, spaceId);
      if (mode === "managed") {
        if (before === "managed") return false;
        db.prepare("INSERT OR REPLACE INTO space_managed_members (thread_id, space_id, set_at) VALUES (?, ?, ?)").run(
          threadId,
          spaceId,
          nowMs,
        );
      } else if (this.managedSpaceOf(threadId) === null) {
        return false;
      } else {
        db.prepare("DELETE FROM space_managed_members WHERE thread_id = ?").run(threadId);
      }
      assert(this.modeIn(threadId, spaceId) === mode, "mode must match after write");
      return true;
    },

    revokeManaged(threadId: string): boolean {
      const hadRow = this.managedSpaceOf(threadId) !== null;
      if (hadRow) db.prepare("DELETE FROM space_managed_members WHERE thread_id = ?").run(threadId);
      return hadRow;
    },

    wakeEnabled(spaceId: string): boolean {
      const row = selectWake.get(spaceId) as { wake_enabled: number } | undefined;
      return row === undefined ? true : row.wake_enabled === 1;
    },

    setWake(spaceId: string, enabled: boolean): void {
      assert(spaceId.length > 0, "spaceId must not be empty");
      db.prepare("INSERT OR REPLACE INTO space_settings (space_id, wake_enabled) VALUES (?, ?)").run(
        spaceId,
        enabled ? 1 : 0,
      );
      assert(this.wakeEnabled(spaceId) === enabled, "wake switch must match after write");
    },

    forgetThread(threadId: string): { orchestratorSpaceId: string | null } {
      const orchestratorSpaceId = this.clearOrchestrator(threadId);
      db.prepare("DELETE FROM space_managed_members WHERE thread_id = ?").run(threadId);
      db.prepare("DELETE FROM space_idea_links WHERE thread_id = ?").run(threadId);
      return { orchestratorSpaceId };
    },
  };
}

export type SpaceRolesStore = ReturnType<typeof createSpaceRolesStore>;
