/**
 * The kinds of the entries the context engine writes into a session log, all under one prefix. The engine alone
 * writes under it; a host refuses a client's write of such a kind, and the reader validates every one it finds.
 */
export const KIND_PREFIX = "sandy-context.";
/**
 * The notebook, `{ text }`, as its own entry, written by the notebook tool. It does not depend on how the tool was
 * called, so a write from inside another tool (codemode) counts too.
 */
export const NOTEBOOK_KIND = `${KIND_PREFIX}notebook`;
/** The historian's anchored summary, a `SummaryState`. */
export const SUMMARY_KIND = `${KIND_PREFIX}summary`;
/** The reminder to update the notebook before a cut. */
export const REMINDER_KIND = `${KIND_PREFIX}notebook-reminder`;
/**
 * The event bus channel on which another extension reports a finished task, for example the ideas advisor. The next
 * cut chance, the next request of a run or the next prompt, then cuts when the context is large enough.
 */
export const CUT_REQUEST_CHANNEL = `${KIND_PREFIX}cut-request`;
/**
 * A cut request from that channel, kept in the log until the next cut chance. SANDY starts pi for every message, so a
 * task reported at the end of a run is read back by the process that handles the next prompt.
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
