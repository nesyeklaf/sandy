// Test DB: the plugin migrations on a better-sqlite3 handle, in memory or on a file (WAL + busy_timeout
// like sandy.database()). Applies the statements in order the way sandy.storage.migrate does, without SANDY.
import Database from "better-sqlite3";
// The whole plugin list: delegate tables added after the merge live at its end (sandy/work/migrations.ts).
import { migrations } from "../../migrations.ts";
import { putAgent, seedBuiltinAgents, type AgentEntry } from "../server/catalog.ts";

// A writer for tests that need one; real implementers come from `sandy work delegate agents import`.
export const TEST_WRITER_AGENT: AgentEntry = {
  name: "implementer-low",
  version: 1,
  description: "Test writer: mechanical, checkable edits.",
  body: [
    "You are `implementer-low`: an implementation subagent.",
    "Execute the brief with narrow, coherent edits in your own worktree and verify them; commit your work on your branch.",
    "If the brief needs a decision it did not make, call `sandy_ask_parent` instead of deciding.",
  ].join("\n"),
  model: "anthropic/claude-haiku-5-5",
  thinking: "high",
  tools: ["bash", "edit", "find", "grep", "ls", "read", "write"],
  role: "writer",
};

export function openDb(file = ":memory:", { migrate = true, busyTimeoutMs = 5000 } = {}): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma("foreign_keys = ON");
  if (migrate) {
    db.transaction(() => {
      for (const statement of migrations) db.exec(statement);
    })();
    seedBuiltinAgents(db);
    putAgent(db, TEST_WRITER_AGENT);
  }
  return db;
}
