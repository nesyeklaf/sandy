/**
 * When a thread may be renamed. Pure so the rules can be read — and tested —
 * without a sandy server.
 */

/** What the plugin remembers about a name it wrote itself. */
export interface NamingRecord {
  /** The exact title written, so a later manual rename is recognisable. */
  title: string;
  at: number;
  /** The outline length the title was written from. */
  maxSeq: number;
}

/** The thread facts the rules look at. */
export interface ThreadFacts {
  title: string | null;
  visibility: "visible" | "hidden";
  parentThreadId: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  originPluginId: string | null;
}

/** How eagerly threads are named automatically. */
export type NamingMode = "off" | "once" | "always";

export type NamingDecision =
  | { rename: true }
  | { rename: false; reason: string };

/**
 * Whether a thread can be named at all — the questions a forced rename asks
 * too, since none of them is about eagerness.
 */
export function isNameable(
  facts: ThreadFacts,
  pluginId: string,
): NamingDecision {
  if (facts.deletedAt !== null) return { rename: false, reason: "deleted" };
  if (facts.visibility === "hidden") {
    return { rename: false, reason: "a hidden thread" };
  }
  // The naming worker is itself a thread; naming it would name our own work.
  if (facts.originPluginId === pluginId) {
    return { rename: false, reason: "this plugin's own worker" };
  }
  if (facts.parentThreadId !== null) {
    return { rename: false, reason: "a child thread named by its parent" };
  }
  return { rename: true };
}

/**
 * Whether an idle thread should be named now.
 *
 * A title the user typed is never overwritten: only an empty title, or one
 * this plugin wrote itself, is fair game.
 */
export function shouldAutoRename(
  facts: ThreadFacts,
  record: NamingRecord | null,
  mode: NamingMode,
  pluginId: string,
  outlineMaxSeq: number,
): NamingDecision {
  if (mode === "off") return { rename: false, reason: "automatic naming is off" };

  const nameable = isNameable(facts, pluginId);
  if (!nameable.rename) return nameable;
  if (facts.archivedAt !== null) {
    return { rename: false, reason: "archived" };
  }

  if (facts.title === null || facts.title.trim() === "") return { rename: true };

  if (record === null || record.title !== facts.title) {
    return { rename: false, reason: "the name was set by hand" };
  }
  if (mode === "once") {
    return { rename: false, reason: "already named once" };
  }
  if (outlineMaxSeq <= record.maxSeq) {
    return { rename: false, reason: "the conversation has not moved on" };
  }
  return { rename: true };
}
