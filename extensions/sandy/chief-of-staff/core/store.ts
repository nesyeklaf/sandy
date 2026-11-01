// SQLite persistence for items, questions, activity, and small state values.
// Every method is synchronous; the engine owns ordering and side effects.
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import type {
  Activity,
  Item,
  ItemStatus,
  Question,
  QuestionKind,
  QuestionStatus,
} from "../contract";

export type Database = ReturnType<SandyPluginApi["storage"]["database"]>;

export const MIGRATIONS = [
  `CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    thread_id TEXT,
    summary TEXT,
    last_update TEXT,
    nudges INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX items_thread ON items(thread_id)`,
  `CREATE TABLE questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    question TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    why TEXT,
    recommendation TEXT,
    answer TEXT,
    answered_by TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  )`,
  `CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER,
    text TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export const ACTIVE_STATUSES: readonly ItemStatus[] = [
  "starting",
  "running",
  "waiting_chief",
  "waiting_user",
];
export const CLOSED_STATUSES: readonly ItemStatus[] = ["done", "failed", "cancelled"];

interface ItemRow {
  id: number;
  title: string;
  details: string;
  project_id: string;
  status: ItemStatus;
  thread_id: string | null;
  summary: string | null;
  last_update: string | null;
  nudges: number;
  created_at: number;
  updated_at: number;
}

interface QuestionRow {
  id: number;
  item_id: number;
  item_title: string;
  thread_id: string | null;
  kind: QuestionKind;
  question: string;
  context: string;
  options: string;
  status: QuestionStatus;
  why: string | null;
  recommendation: string | null;
  answer: string | null;
  answered_by: "chief" | "user" | null;
  created_at: number;
  resolved_at: number | null;
}

const toItem = (row: ItemRow): Item => ({
  id: row.id,
  title: row.title,
  details: row.details,
  projectId: row.project_id,
  status: row.status,
  threadId: row.thread_id,
  summary: row.summary,
  lastUpdate: row.last_update,
  nudges: row.nudges,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toQuestion = (row: QuestionRow): Question => ({
  id: row.id,
  itemId: row.item_id,
  itemTitle: row.item_title,
  threadId: row.thread_id,
  kind: row.kind,
  question: row.question,
  context: row.context,
  options: JSON.parse(row.options) as string[],
  status: row.status,
  why: row.why,
  recommendation: row.recommendation,
  answer: row.answer,
  answeredBy: row.answered_by,
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
});

const QUESTION_SELECT = `SELECT q.*, i.title AS item_title, i.thread_id AS thread_id
  FROM questions q JOIN items i ON i.id = q.item_id`;

export type ItemPatch = Partial<
  Pick<Item, "status" | "threadId" | "summary" | "lastUpdate" | "nudges">
>;

export interface NewQuestion {
  itemId: number;
  kind: QuestionKind;
  question: string;
  context?: string;
  options?: string[];
  status: "chief" | "user";
  why?: string | null;
}

export class Store {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  // Items

  addItems(entries: { title: string; details: string }[], projectId: string): Item[] {
    const insert = this.db.prepare(
      `INSERT INTO items (title, details, project_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
    );
    const ids = this.db.transaction(() =>
      entries.map((entry) => {
        const at = this.now();
        return Number(insert.run(entry.title, entry.details, projectId, at, at).lastInsertRowid);
      }),
    )();
    return ids.map((id) => this.item(id)!);
  }

  item(id: number): Item | null {
    const row = this.db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
    return row === undefined ? null : toItem(row);
  }

  itemByThread(threadId: string): Item | null {
    const row = this.db
      .prepare(`SELECT * FROM items WHERE thread_id = ?`)
      .get(threadId) as ItemRow | undefined;
    return row === undefined ? null : toItem(row);
  }

  items(): Item[] {
    return (this.db.prepare(`SELECT * FROM items ORDER BY id`).all() as ItemRow[]).map(toItem);
  }

  nextQueued(): Item | null {
    const row = this.db
      .prepare(`SELECT * FROM items WHERE status = 'queued' ORDER BY id LIMIT 1`)
      .get() as ItemRow | undefined;
    return row === undefined ? null : toItem(row);
  }

  activeCount(): number {
    const marks = ACTIVE_STATUSES.map(() => "?").join(",");
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE status IN (${marks})`)
      .get(...ACTIVE_STATUSES) as { n: number };
    return row.n;
  }

  updateItem(id: number, patch: ItemPatch): Item {
    const columns: Record<keyof ItemPatch, string> = {
      status: "status",
      threadId: "thread_id",
      summary: "summary",
      lastUpdate: "last_update",
      nudges: "nudges",
    };
    const keys = Object.keys(patch) as (keyof ItemPatch)[];
    const sets = keys.map((key) => `${columns[key]} = ?`);
    this.db
      .prepare(`UPDATE items SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`)
      .run(...keys.map((key) => patch[key] ?? null), this.now(), id);
    return this.item(id)!;
  }

  removeItem(id: number): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM questions WHERE item_id = ?`).run(id);
      this.db.prepare(`DELETE FROM items WHERE id = ?`).run(id);
    })();
  }

  // Questions

  addQuestion(input: NewQuestion): Question {
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO questions (item_id, kind, question, context, options, status, why, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.itemId,
          input.kind,
          input.question,
          input.context ?? "",
          JSON.stringify(input.options ?? []),
          input.status,
          input.why ?? null,
          this.now(),
        ).lastInsertRowid,
    );
    return this.question(id)!;
  }

  question(id: number): Question | null {
    const row = this.db.prepare(`${QUESTION_SELECT} WHERE q.id = ?`).get(id) as
      | QuestionRow
      | undefined;
    return row === undefined ? null : toQuestion(row);
  }

  questionsWithStatus(status: QuestionStatus): Question[] {
    return (
      this.db.prepare(`${QUESTION_SELECT} WHERE q.status = ? ORDER BY q.id`).all(status) as QuestionRow[]
    ).map(toQuestion);
  }

  openQuestions(itemId: number): Question[] {
    return (
      this.db
        .prepare(`${QUESTION_SELECT} WHERE q.item_id = ? AND q.status IN ('chief','user') ORDER BY q.id`)
        .all(itemId) as QuestionRow[]
    ).map(toQuestion);
  }

  escalate(id: number, why: string, recommendation: string | null, options?: string[]): Question {
    const sets = ["status = 'user'", "why = ?", "recommendation = ?"];
    const values: unknown[] = [why, recommendation];
    if (options !== undefined && options.length > 0) {
      sets.push("options = ?");
      values.push(JSON.stringify(options));
    }
    this.db.prepare(`UPDATE questions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return this.question(id)!;
  }

  answer(id: number, answer: string, by: "chief" | "user"): Question {
    this.db
      .prepare(
        `UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, resolved_at = ? WHERE id = ?`,
      )
      .run(answer, by, this.now(), id);
    return this.question(id)!;
  }

  /** Close open questions of an item, optionally only one kind. */
  dropOpenQuestions(itemId: number, kind?: QuestionKind): number {
    const filter = kind === undefined ? "" : " AND kind = ?";
    const args: unknown[] = [this.now(), itemId];
    if (kind !== undefined) args.push(kind);
    return this.db
      .prepare(
        `UPDATE questions SET status = 'dropped', resolved_at = ?
         WHERE item_id = ? AND status IN ('chief','user')${filter}`,
      )
      .run(...args).changes;
  }

  /** Recent decisions the user made, newest first: precedent for the chief. */
  recentUserDecisions(limit: number): Question[] {
    return (
      this.db
        .prepare(
          `${QUESTION_SELECT} WHERE q.answered_by = 'user' AND q.kind != 'prompt'
           ORDER BY q.resolved_at DESC LIMIT ?`,
        )
        .all(limit) as QuestionRow[]
    ).map(toQuestion);
  }

  countAnsweredBy(by: "chief" | "user"): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE answered_by = ?`).get(by) as {
        n: number;
      }
    ).n;
  }

  // Activity

  log(itemId: number | null, text: string): void {
    this.db
      .prepare(`INSERT INTO activity (item_id, text, at) VALUES (?, ?, ?)`)
      .run(itemId, text, this.now());
  }

  activity(limit: number): Activity[] {
    return (
      this.db
        .prepare(`SELECT id, item_id, text, at FROM activity ORDER BY id DESC LIMIT ?`)
        .all(limit) as { id: number; item_id: number | null; text: string; at: number }[]
    ).map((row) => ({ id: row.id, itemId: row.item_id, text: row.text, at: row.at }));
  }

  // Small state values

  getState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM state WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare(`DELETE FROM state WHERE key = ?`).run(key);
    } else {
      this.db
        .prepare(
          `INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value);
    }
  }
}
