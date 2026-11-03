import assert from "node:assert/strict";
import test from "node:test";
import type { SkillFile } from "./contract.ts";
import {
  canSave,
  editedDraft,
  isDirty,
  readDone,
  readFailed,
  readStarted,
  saveDone,
  saveStarted,
  startEditor,
  type EditorState,
} from "./skill-editor-state.ts";

const ORIGINAL = "---\nname: x\ndescription: original\n---\nbody\n";

function file(filePath: string, content = ORIGINAL): SkillFile {
  return { content, revision: "a".repeat(64), filePath, writable: true };
}

function description(state: EditorState): string | null {
  return state.loaded !== null && "draft" in state.loaded ? state.loaded.draft.description : null;
}

function opened(projectId: string): EditorState {
  const read = readStarted(startEditor(), { projectId, skillId: "same-id" });
  return readDone(read.state, read.ticket, file("/" + projectId + "/.sandy/skills/x/SKILL.md"));
}

test("an edit typed while a save is pending survives the acknowledgement and stays dirty", () => {
  const typed = editedDraft(opened("p"), { description: "version submitted" });
  const save = saveStarted(typed, "a".repeat(64));
  assert.ok(save.ticket);
  assert.equal(save.send?.content, "---\nname: x\ndescription: version submitted\n---\nbody\n");
  assert.equal(canSave(save.state), false);
  const later = editedDraft(save.state, { description: "typing after save" });
  const acked = saveDone(later, save.ticket, { outcome: "written", revision: "b".repeat(64), filePath: "/p/.sandy/skills/x/SKILL.md" });
  assert.equal(description(acked), "typing after save");
  assert.equal(acked.saving, false);
  assert.equal(acked.loaded?.file.revision, "b".repeat(64));
  assert.equal(acked.loaded?.file.content, save.send?.content);
  assert.equal(isDirty(acked), true);
  assert.equal(canSave(acked), true);
});

test("an acknowledged save without later edits leaves a clean draft at the new revision", () => {
  const save = saveStarted(editedDraft(opened("p"), { description: "saved" }), "a".repeat(64));
  assert.ok(save.ticket);
  const acked = saveDone(save.state, save.ticket, { outcome: "written", revision: "b".repeat(64), filePath: "/p/x/SKILL.md" });
  assert.equal(description(acked), "saved");
  assert.equal(isDirty(acked), false);
  assert.equal(acked.notice, "Saved to /p/x/SKILL.md");
});

test("switching projects drops the old draft, ignores stale reads and saves nothing until the new read lands", () => {
  const edited = editedDraft(opened("old"), { description: "old project unsaved edit" });
  const pendingSave = saveStarted(edited, "a".repeat(64));
  const staleRead = readStarted(startEditor(), { projectId: "old", skillId: "same-id" }).ticket;
  const switched = readStarted(pendingSave.state, { projectId: "new", skillId: "same-id" });
  assert.equal(switched.state.loaded, null);
  assert.equal(switched.state.saving, false);
  assert.equal(canSave(switched.state), false);
  assert.deepEqual(saveStarted(switched.state, "a".repeat(64)).send, null);
  assert.ok(pendingSave.ticket);
  const lateAck = saveDone(switched.state, pendingSave.ticket, { outcome: "written", revision: "c".repeat(64), filePath: "/old/x/SKILL.md" });
  assert.equal(lateAck, switched.state);
  assert.equal(readDone(switched.state, staleRead, file("/old/.sandy/skills/x/SKILL.md")), switched.state);
  assert.equal(readFailed(switched.state, staleRead, "gone"), switched.state);
  const fresh = readDone(switched.state, switched.ticket, file("/new/.sandy/skills/x/SKILL.md"));
  assert.equal(description(fresh), "original");
  assert.equal(isDirty(fresh), false);
  const save = saveStarted(editedDraft(fresh, { description: "new project edit" }), "a".repeat(64));
  assert.deepEqual(save.send, { projectId: "new", skillId: "same-id", revision: "a".repeat(64), content: "---\nname: x\ndescription: new project edit\n---\nbody\n" });
});

test("a newer read of the same skill wins over an older one that resolves later", () => {
  const first = readStarted(startEditor(), { projectId: "p", skillId: "s" });
  const second = readStarted(first.state, { projectId: "p", skillId: "s" });
  const newer = readDone(second.state, second.ticket, file("/p/x/SKILL.md", "---\nname: x\ndescription: newer\n---\n"));
  assert.equal(readDone(newer, first.ticket, file("/p/x/SKILL.md")), newer);
  assert.equal(description(newer), "newer");
});
