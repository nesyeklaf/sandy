/**
 * The names the context engine writes, all under one prefix. Only current names live here: records written under older
 * names are read by `records.ts`, and nothing writes them any more.
 */
export const KIND_PREFIX = "context.";
/**
 * The notebook, `{ text }`, as its own entry, written by the notebook tool. It does not depend on how the tool was
 * called, so a write from inside another tool (codemode) counts too.
 */
export const NOTEBOOK_KIND = `${KIND_PREFIX}notebook`;
/** The historian's anchored summary, a `SummaryState`. */
export const SUMMARY_KIND = `${KIND_PREFIX}summary`;
/** One record of a historian attempt (`AttemptEntry`): its start before the request goes out, its end after, or an owner's retry. */
export const ATTEMPT_KIND = `${KIND_PREFIX}historian-attempt`;
/** The reminder to update the notebook before a cut. */
export const REMINDER_KIND = `${KIND_PREFIX}notebook-reminder`;
/**
 * The event bus channel on which another extension reports a finished task, for example the ideas advisor. The next
 * cut chance, the next request of a run or the next prompt, then cuts when the context is large enough.
 */
export const CUT_REQUEST_CHANNEL = `${KIND_PREFIX}cut-request`;
/**
 * A cut request from that channel, kept in the log until the next cut chance. The request is read back from the log,
 * not from memory, so it survives a reload or restart of the pi process between the run that reported the task and
 * the next prompt.
 */
export const TASK_DONE_KIND = `${KIND_PREFIX}task-done`;
/**
 * The event bus channel on which the engine publishes its signals after every turn, `ContextSignalsEvent`: the prompt
 * size against the cut thresholds, the tool output of the run, delegations and the after-cut counters. Another
 * extension, for example an advisor that suggests delegating, reads them; the engine acts on none of them.
 */
export const SIGNALS_CHANNEL = `${KIND_PREFIX}signals`;
/** A ping that keeps a waiting session's prompt cache warm. */
export const KEEP_WARM_KIND = `${KIND_PREFIX}keep-warm`;
/**
 * One cache-warming decision of pi (`piAction`, the action it proposed, and `action`, the one this engine returned),
 * stored before any warm request can leave, so the report can tell a warm that was skipped from one that left.
 */
export const WARMING_KIND = `${KIND_PREFIX}warming`;
/**
 * A retrieval call made inside another tool (codemode): a search with the ids it found, a read of an entry or of a
 * file. The transcript holds the top-level calls and only a bounded record of the nested ones, so these entries keep
 * the nested ones through a restart. Ids and paths only, no content.
 */
export const RETRIEVAL_KIND = `${KIND_PREFIX}retrieval`;
/**
 * Ownership of a context edit that replaced a repeated read by a note: where it points, how many tokens it saves, a
 * digest of the replacement. No content. Without it the edit is another writer's and is left alone.
 */
export const DUPLICATE_KIND = `${KIND_PREFIX}duplicate`;
/**
 * What the kept-history cap would remove at a cut (mode "shadow") or removed (mode "on"): ids, paths and counts, no
 * content. The retrieval report counts what the agent asked for afterwards.
 */
export const CAP_SHADOW_KIND = `${KIND_PREFIX}cap-shadow`;
/** The key under a compaction's `details` that marks the cut as this engine's and holds its `CutDetails`. */
export const CUT_DETAILS_KEY = "context";
/** The tag around a cut's text, `<context reason="…">…</context>`. */
export const CUT_TAG_NAME = "context";
