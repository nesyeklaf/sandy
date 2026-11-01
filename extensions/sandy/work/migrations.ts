// The one migration list of the plugin database. SANDY numbers migrations by their index, so the
// slices below are frozen: a new migration of any part goes at the end of `migrations`, never into
// a part's list (migrations.test.ts pins the slice lengths).
import { migrations as delegateMigrations } from "./delegate/server/migrations.ts";
import { migrations as workflowMigrations } from "./workflows/src/data.ts";

export const DELEGATE_MIGRATION_COUNT = 11;
export const WORKFLOW_MIGRATION_COUNT = 12;

// Migrations sandy/work added after the merge, in order.
// delegation_failure_acks (delegate): the owner acknowledged a failed delegation (the composer banner or the
//   Delegates tab). status and error are the failure it covers: while the row still fails that way, the
//   banner and the composer segment leave it out; any other state deletes the ack, so a new failure shows.
export const workMigrations: string[] = [
  `CREATE TABLE delegation_failure_acks (
     delegation_id TEXT PRIMARY KEY REFERENCES delegations(delegation_id),
     status TEXT NOT NULL,
     error TEXT,
     acked_at INTEGER NOT NULL
   );`,
];

export const migrations: string[] = [...delegateMigrations, ...workflowMigrations, ...workMigrations];
