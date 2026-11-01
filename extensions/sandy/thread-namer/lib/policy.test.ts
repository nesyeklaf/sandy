import { describe, expect, it } from "vitest";
import {
  isNameable,
  shouldAutoRename,
  type NamingRecord,
  type ThreadFacts,
} from "./policy";

const PLUGIN_ID = "thread-namer";

function facts(overrides: Partial<ThreadFacts> = {}): ThreadFacts {
  return {
    title: null,
    visibility: "visible",
    parentThreadId: null,
    archivedAt: null,
    deletedAt: null,
    originPluginId: null,
    ...overrides,
  };
}

const owned = (title: string, maxSeq = 4): NamingRecord => ({
  title,
  at: 0,
  maxSeq,
});

describe("isNameable", () => {
  it("accepts an ordinary top-level thread", () => {
    expect(isNameable(facts(), PLUGIN_ID)).toEqual({ rename: true });
  });

  it("refuses a hidden thread", () => {
    expect(isNameable(facts({ visibility: "hidden" }), PLUGIN_ID)).toMatchObject(
      { rename: false },
    );
  });

  it("refuses this plugin's own naming worker", () => {
    expect(
      isNameable(facts({ originPluginId: PLUGIN_ID }), PLUGIN_ID),
    ).toMatchObject({ rename: false });
  });

  it("names a thread another plugin started", () => {
    expect(
      isNameable(facts({ originPluginId: "github" }), PLUGIN_ID),
    ).toEqual({ rename: true });
  });

  it("refuses a child thread", () => {
    expect(
      isNameable(facts({ parentThreadId: "thr_parent" }), PLUGIN_ID),
    ).toMatchObject({ rename: false });
  });

  it("refuses a deleted thread", () => {
    expect(isNameable(facts({ deletedAt: 1 }), PLUGIN_ID)).toMatchObject({
      rename: false,
    });
  });
});

describe("shouldAutoRename", () => {
  it("names an untitled thread", () => {
    expect(shouldAutoRename(facts(), null, "once", PLUGIN_ID, 4)).toEqual({
      rename: true,
    });
  });

  it("names a thread whose title is blank", () => {
    expect(
      shouldAutoRename(facts({ title: "  " }), null, "once", PLUGIN_ID, 4),
    ).toEqual({ rename: true });
  });

  it("does nothing when automatic naming is off", () => {
    expect(shouldAutoRename(facts(), null, "off", PLUGIN_ID, 4)).toMatchObject({
      rename: false,
    });
  });

  it("never overwrites a title the user typed", () => {
    expect(
      shouldAutoRename(facts({ title: "My own name" }), null, "always", PLUGIN_ID, 9),
    ).toMatchObject({ rename: false, reason: "the name was set by hand" });
  });

  it("treats a renamed thread as hand-named even when it once owned the title", () => {
    expect(
      shouldAutoRename(
        facts({ title: "My own name" }),
        owned("Generated name"),
        "always",
        PLUGIN_ID,
        9,
      ),
    ).toMatchObject({ rename: false });
  });

  it("stops after the first name in once mode", () => {
    expect(
      shouldAutoRename(
        facts({ title: "Generated name" }),
        owned("Generated name"),
        "once",
        PLUGIN_ID,
        9,
      ),
    ).toMatchObject({ rename: false, reason: "already named once" });
  });

  it("refreshes its own name in always mode once the conversation moves on", () => {
    expect(
      shouldAutoRename(
        facts({ title: "Generated name" }),
        owned("Generated name", 4),
        "always",
        PLUGIN_ID,
        9,
      ),
    ).toEqual({ rename: true });
  });

  it("leaves its own name alone when nothing new was said", () => {
    expect(
      shouldAutoRename(
        facts({ title: "Generated name" }),
        owned("Generated name", 9),
        "always",
        PLUGIN_ID,
        9,
      ),
    ).toMatchObject({ rename: false });
  });

  it("skips an archived thread", () => {
    expect(
      shouldAutoRename(facts({ archivedAt: 1 }), null, "always", PLUGIN_ID, 4),
    ).toMatchObject({ rename: false, reason: "archived" });
  });
});
