import { assert } from "./assert";
import {
  CHECK_IN_MINUTES_DEFAULT,
  CHECK_IN_MINUTES_MAX,
  type CoordinationMode,
  type CoordinationSettings,
} from "./space-coordination-contract";
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
  const selectStarted = db.prepare("SELECT space_id, descendant FROM space_started_sessions WHERE thread_id = ?");
  const selectSettings = db.prepare(
    "SELECT self_reports, check_in_minutes, failure_fallback FROM space_settings WHERE space_id = ?",
  );
  const upsertSettings = db.prepare(
    "INSERT INTO space_settings (space_id, self_reports, check_in_minutes, failure_fallback) VALUES (?, ?, ?, ?) ON CONFLICT (space_id) DO UPDATE SET self_reports = excluded.self_reports, check_in_minutes = excluded.check_in_minutes, failure_fallback = excluded.failure_fallback",
  );

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

    startedOf(threadId: string): { spaceId: string; descendant: boolean } | null {
      const row = selectStarted.get(threadId) as { space_id: string; descendant: number } | undefined;
      return row === undefined ? null : { spaceId: row.space_id, descendant: row.descendant === 1 };
    },

    recordStarted(
      threadId: string,
      spaceId: string,
      starterThreadId: string,
      nowMs: number,
      descendant: boolean = false,
    ): void {
      assert(
        threadId.length > 0 && spaceId.length > 0 && starterThreadId.length > 0,
        "started session ids must not be empty",
      );
      db.prepare(
        "INSERT OR REPLACE INTO space_started_sessions (thread_id, space_id, starter_thread_id, started_at, descendant) VALUES (?, ?, ?, ?, ?)",
      ).run(threadId, spaceId, starterThreadId, nowMs, descendant ? 1 : 0);
      assert(this.startedOf(threadId)?.spaceId === spaceId, "started row must exist after recording");
    },

    clearStarted(threadId: string): void {
      db.prepare("DELETE FROM space_started_sessions WHERE thread_id = ?").run(threadId);
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

    settingsOf(spaceId: string): CoordinationSettings {
      assert(spaceId.length > 0, "spaceId must not be empty");
      const row = selectSettings.get(spaceId) as
        | { self_reports: number; check_in_minutes: number; failure_fallback: number }
        | undefined;
      if (row === undefined) {
        return { selfReports: true, checkInMinutes: CHECK_IN_MINUTES_DEFAULT, failureFallback: true };
      }
      assert(
        row.check_in_minutes >= 0 && row.check_in_minutes <= CHECK_IN_MINUTES_MAX,
        "stored check-in interval is within range",
      );
      return {
        selfReports: row.self_reports === 1,
        checkInMinutes: row.check_in_minutes,
        failureFallback: row.failure_fallback === 1,
      };
    },

    setSettings(spaceId: string, settings: CoordinationSettings): void {
      assert(spaceId.length > 0, "spaceId must not be empty");
      assert(
        Number.isInteger(settings.checkInMinutes) &&
          settings.checkInMinutes >= 0 &&
          settings.checkInMinutes <= CHECK_IN_MINUTES_MAX,
        "check-in interval must be within range before writing",
      );
      upsertSettings.run(
        spaceId,
        settings.selfReports ? 1 : 0,
        settings.checkInMinutes,
        settings.failureFallback ? 1 : 0,
      );
      const stored = this.settingsOf(spaceId);
      assert(
        stored.selfReports === settings.selfReports &&
          stored.checkInMinutes === settings.checkInMinutes &&
          stored.failureFallback === settings.failureFallback,
        "settings must match after write",
      );
    },

    forgetThread(threadId: string): { orchestratorSpaceId: string | null } {
      const orchestratorSpaceId = this.clearOrchestrator(threadId);
      db.prepare("DELETE FROM space_managed_members WHERE thread_id = ?").run(threadId);
      this.clearStarted(threadId);
      db.prepare("DELETE FROM space_idea_links WHERE thread_id = ?").run(threadId);
      db.prepare("DELETE FROM space_member_reports WHERE thread_id = ?").run(threadId);
      return { orchestratorSpaceId };
    },
  };
}

export type SpaceRolesStore = ReturnType<typeof createSpaceRolesStore>;
