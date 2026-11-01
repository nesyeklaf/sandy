import { randomUUID } from "node:crypto";
import { defineRpcContract, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import { CHANGED_CHANNEL, MAX_TEXT_LENGTH, truncate } from "./shared";

const EXCERPT_LENGTH = 600;

const roleSchema = z.enum(["user", "assistant"]);

const messageSchema = z
  .object({
    threadId: z.string().min(1).max(200),
    /** The message's `sourceSeqEnd`: unique per thread and stable for its lifetime. */
    seq: z.number().int().nonnegative(),
    /** The timeline row id, used only to mark bookmarked messages in the timeline. */
    rowId: z.string().min(1).max(2_000),
    role: roleSchema,
    text: z.string().max(MAX_TEXT_LENGTH),
  })
  .strict();

const storedBookmarkSchema = messageSchema
  .extend({
    id: z.string().min(1).max(100),
    quote: z.string().min(1).max(MAX_TEXT_LENGTH).nullable(),
    threadTitle: z.string().max(2_000).nullable(),
    projectId: z.string().max(200).nullable(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

const bookmarkSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  seq: z.number().int(),
  role: roleSchema,
  /** The saved selection when there is one, else the message text; cut short. */
  excerpt: z.string(),
  quoted: z.boolean(),
  threadTitle: z.string().nullable(),
  projectId: z.string().nullable(),
  threadDeleted: z.boolean(),
  createdAt: z.number().int(),
});

export type Bookmark = z.infer<typeof bookmarkSchema>;
export type BookmarkMessage = z.infer<typeof messageSchema>;
export type StoredBookmark = z.infer<typeof storedBookmarkSchema>;

export const rpcContract = defineRpcContract({
  list: {
    input: z
      .object({ query: z.string().max(200).optional() })
      .strict()
      .nullable(),
    output: z.object({ bookmarks: z.array(bookmarkSchema) }),
  },
  markers: {
    input: z.null(),
    output: z.object({ rowIds: z.array(z.string()) }),
  },
  toggle: {
    input: messageSchema,
    output: z.object({
      bookmark: bookmarkSchema.nullable(),
      removed: storedBookmarkSchema.nullable(),
    }),
  },
  save: {
    input: messageSchema
      .extend({ quote: z.string().min(1).max(MAX_TEXT_LENGTH) })
      .strict(),
    output: z.object({ bookmark: bookmarkSchema }),
  },
  remove: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ removed: storedBookmarkSchema.nullable() }),
  },
  restore: {
    input: storedBookmarkSchema,
    output: z.object({ bookmark: bookmarkSchema }),
  },
  fullText: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ text: z.string().nullable() }),
  },
});

export interface BookmarkRow {
  id: string;
  thread_id: string;
  seq: number;
  row_id: string;
  role: "user" | "assistant";
  text: string;
  quote: string | null;
  thread_title: string | null;
  project_id: string | null;
  thread_deleted: number;
  created_at: number;
}

// Append-only: the index of a statement is its migration id.
const MIGRATIONS = [
  `CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    row_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    quote TEXT,
    thread_title TEXT,
    project_id TEXT,
    thread_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (thread_id, seq)
  )`,
];

export function toBookmark(row: BookmarkRow): Bookmark {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    role: row.role,
    excerpt: truncate(row.quote ?? row.text, EXCERPT_LENGTH),
    quoted: row.quote !== null,
    threadTitle: row.thread_title,
    projectId: row.project_id,
    threadDeleted: row.thread_deleted === 1,
    createdAt: row.created_at,
  };
}

function toStored(row: BookmarkRow): StoredBookmark {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    rowId: row.row_id,
    role: row.role,
    text: row.text,
    quote: row.quote,
    threadTitle: row.thread_title,
    projectId: row.project_id,
    createdAt: row.created_at,
  };
}

/** Case-insensitive match against the saved text and the thread title. */
export function matchesQuery(row: BookmarkRow, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  return [row.text, row.quote, row.thread_title].some(
    (value) => value !== null && value.toLocaleLowerCase().includes(needle),
  );
}

export default async function plugin(sandy: SandyPluginApi) {
  const db = sandy.storage.database();
  sandy.storage.migrate(db, MIGRATIONS);

  const selectAll = db.prepare<[], BookmarkRow>(
    "SELECT * FROM bookmarks ORDER BY created_at DESC, rowid DESC",
  );
  const selectById = db.prepare<[string], BookmarkRow>(
    "SELECT * FROM bookmarks WHERE id = ?",
  );
  const selectByMessage = db.prepare<[string, number], BookmarkRow>(
    "SELECT * FROM bookmarks WHERE thread_id = ? AND seq = ?",
  );
  const selectRowIds = db.prepare<[], { row_id: string }>(
    "SELECT row_id FROM bookmarks WHERE thread_deleted = 0",
  );
  const insertRow = db.prepare<[Omit<BookmarkRow, "thread_deleted">]>(
    `INSERT OR IGNORE INTO bookmarks
      (id, thread_id, seq, row_id, role, text, quote, thread_title, project_id, created_at)
     VALUES
      (@id, @thread_id, @seq, @row_id, @role, @text, @quote, @thread_title, @project_id, @created_at)`,
  );
  const updateQuote = db.prepare<[string, number, string]>(
    "UPDATE bookmarks SET quote = ?, created_at = ? WHERE id = ?",
  );
  const deleteById = db.prepare<[string]>("DELETE FROM bookmarks WHERE id = ?");
  const markThreadDeleted = db.prepare<[string]>(
    "UPDATE bookmarks SET thread_deleted = 1 WHERE thread_id = ? AND thread_deleted = 0",
  );
  const refreshThread = db.prepare<
    [{ threadId: string; title: string | null; projectId: string }]
  >(
    `UPDATE bookmarks SET thread_title = @title, project_id = @projectId
     WHERE thread_id = @threadId
       AND (thread_title IS NOT @title OR project_id IS NOT @projectId)`,
  );

  const publishChange = () => sandy.realtime.publish(CHANGED_CHANNEL, null);

  async function describeThread(threadId: string) {
    try {
      const thread = await sandy.sdk.threads.get({ threadId });
      return {
        title: thread.title ?? thread.titleFallback ?? null,
        projectId: thread.projectId,
      };
    } catch (error) {
      sandy.log.warn(`Could not read thread ${threadId}: ${String(error)}`);
      return { title: null, projectId: null };
    }
  }

  function messageRow(threadId: string, seq: number): BookmarkRow {
    const row = selectByMessage.get(threadId, seq);
    if (row === undefined) throw new Error("The bookmark could not be saved.");
    return row;
  }

  async function create(
    message: BookmarkMessage,
    quote: string | null,
  ): Promise<BookmarkRow> {
    const thread = await describeThread(message.threadId);
    // A concurrent save of the same message wins; both callers get its row.
    insertRow.run({
      id: randomUUID(),
      thread_id: message.threadId,
      seq: message.seq,
      row_id: message.rowId,
      role: message.role,
      text: message.text,
      quote,
      thread_title: thread.title,
      project_id: thread.projectId,
      created_at: Date.now(),
    });
    return messageRow(message.threadId, message.seq);
  }

  sandy.rpc.register(rpcContract, {
    list(input) {
      const query = input?.query ?? "";
      const bookmarks = selectAll
        .all()
        .filter((row) => matchesQuery(row, query))
        .map(toBookmark);
      return { bookmarks };
    },
    markers() {
      return { rowIds: selectRowIds.all().map((row) => row.row_id) };
    },
    async toggle(message) {
      const existing = selectByMessage.get(message.threadId, message.seq);
      if (existing !== undefined) {
        deleteById.run(existing.id);
        publishChange();
        return { bookmark: null, removed: toStored(existing) };
      }
      const row = await create(message, null);
      publishChange();
      return { bookmark: toBookmark(row), removed: null };
    },
    async save({ quote, ...message }) {
      const existing = selectByMessage.get(message.threadId, message.seq);
      if (existing === undefined) {
        await create(message, quote);
      } else {
        updateQuote.run(quote, Date.now(), existing.id);
      }
      publishChange();
      return { bookmark: toBookmark(messageRow(message.threadId, message.seq)) };
    },
    remove({ id }) {
      const existing = selectById.get(id);
      if (existing === undefined) return { removed: null };
      deleteById.run(id);
      publishChange();
      return { removed: toStored(existing) };
    },
    restore(bookmark) {
      insertRow.run({
        id: bookmark.id,
        thread_id: bookmark.threadId,
        seq: bookmark.seq,
        row_id: bookmark.rowId,
        role: bookmark.role,
        text: bookmark.text,
        quote: bookmark.quote,
        thread_title: bookmark.threadTitle,
        project_id: bookmark.projectId,
        created_at: bookmark.createdAt,
      });
      publishChange();
      return {
        bookmark: toBookmark(messageRow(bookmark.threadId, bookmark.seq)),
      };
    },
    fullText({ id }) {
      const row = selectById.get(id);
      return { text: row === undefined ? null : (row.quote ?? row.text) };
    },
  });

  sandy.events.on("thread.deleted", ({ thread }) => {
    if (markThreadDeleted.run(thread.id).changes > 0) publishChange();
  });

  // Titles are usually generated after the first turn, so refresh the saved
  // title whenever a thread with bookmarks goes idle.
  sandy.events.on("thread.idle", ({ thread }) => {
    const result = refreshThread.run({
      threadId: thread.id,
      title: thread.title ?? thread.titleFallback ?? null,
      projectId: thread.projectId,
    });
    if (result.changes > 0) publishChange();
  });
}
