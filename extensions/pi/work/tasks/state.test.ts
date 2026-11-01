import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, ENTRY, latest, type Task } from "./state.ts";

test("create numbers tasks, nests subtasks and starts them pending; update moves one task", () => {
  let tasks = apply([], { action: "create", tasks: [{ subject: "read code" }, { subject: "write test", subtasks: [{ subject: "edge case" }] }] });
  assert.deepEqual(tasks.map((t) => [t.id, t.subject, t.status, t.parent]), [["1", "read code", "pending", undefined], ["2", "write test", "pending", undefined], ["3", "edge case", "pending", "2"]]);
  tasks = apply(tasks, { action: "create", subject: "docs", parent: "#1", blockedBy: [2] });
  assert.deepEqual(tasks[3], { id: "4", subject: "docs", status: "pending", parent: "1", blockedBy: ["2"] });
  tasks = apply(tasks, { action: "update", id: 2, status: "in_progress", activeForm: "writing the test" });
  tasks = apply(tasks, { action: "update", id: "2", status: "completed", description: "npm test 12/12" });
  assert.deepEqual(tasks[1], { id: "2", subject: "write test", status: "completed", activeForm: "writing the test", description: "npm test 12/12" });
  tasks = apply(tasks, { action: "update", id: "2", description: "" });
  assert.equal(tasks[1].description, undefined);
});

test("statuses move as in rpiv-todo: completed only to deleted, deleted is final", () => {
  let tasks = apply([], { action: "create", subject: "a" });
  tasks = apply(tasks, { action: "update", id: "1", status: "completed" });
  assert.throws(() => apply(tasks, { action: "update", id: "1", status: "in_progress" }), /#1 is completed; it cannot go to in_progress \(create a new task/);
  tasks = apply(tasks, { action: "update", id: "1", status: "deleted" });
  assert.throws(() => apply(tasks, { action: "update", id: "1", status: "pending" }), /cannot go to pending/);
  assert.throws(() => apply(tasks, { action: "update", id: "1", status: "finished" }), /status must be one of pending, in_progress, completed, deleted/);
});

test("delete tombstones a task with its subtasks; clear empties; new ids never reuse old ones", () => {
  let tasks = apply([], { action: "create", tasks: [{ subject: "a", subtasks: [{ subject: "a1", subtasks: [{ subject: "a2" }] }] }, { subject: "b" }] });
  tasks = apply(tasks, { action: "delete", id: "1" });
  assert.deepEqual(tasks.map((t) => t.status), ["deleted", "deleted", "deleted", "pending"]);
  assert.equal(apply(tasks, { action: "create", subject: "c" }).at(-1)!.id, "5");
  assert.deepEqual(apply(tasks, { action: "clear" }), []);
});

test("blockedBy is checked: unknown, deleted, self and cycles are rejected", () => {
  let tasks = apply([], { action: "create", tasks: [{ subject: "a" }, { subject: "b" }, { subject: "c" }] });
  tasks = apply(tasks, { action: "update", id: "2", addBlockedBy: ["1"] });
  assert.throws(() => apply(tasks, { action: "update", id: "1", addBlockedBy: ["2"] }), /cycle/);
  assert.throws(() => apply(tasks, { action: "update", id: "1", addBlockedBy: ["1"] }), /itself/);
  assert.throws(() => apply(tasks, { action: "update", id: "1", addBlockedBy: ["9"] }), /no task #9/);
  const gone = apply(tasks, { action: "delete", id: "3" });
  assert.throws(() => apply(gone, { action: "update", id: "1", addBlockedBy: ["3"] }), /#3 is deleted/);
  assert.equal(apply(tasks, { action: "update", id: "2", removeBlockedBy: ["1"] })[1].blockedBy, undefined);
});

test("bad input throws a message the model can act on", () => {
  assert.throws(() => apply([], { action: "create", subject: " " }), /subject/);
  assert.throws(() => apply([], { action: "create", subject: "a", tasks: [{ subject: "b" }] }), /either subject or tasks/);
  assert.throws(() => apply([], { action: "create", subject: "a", parent: "zz" }), /no task #zz/);
  assert.throws(() => apply([], { action: "update", id: "9", status: "completed" }), /no task #9/);
});

test("latest takes the last tasks entry of the branch, and reads version 1 lists in the new words", () => {
  const snap = (tasks: unknown[], version = 2) => ({ type: "custom", customType: ENTRY, data: { version, tasks, updatedAt: 1 } });
  const entries = [snap([{ id: "1", subject: "old", status: "pending" }]), { type: "message" }, snap([{ id: "1", subject: "new", status: "in_progress" }]), { type: "custom", customType: "other", data: {} }];
  assert.equal(latest(entries)?.tasks[0].subject, "new");
  assert.equal(latest([{ type: "message" }]), null);
  assert.equal(latest([{ type: "custom", customType: ENTRY, data: { tasks: [{ id: 1 }] } }]), null);
  const v1 = latest([snap([{ id: "t1", title: "a", status: "done", note: "ok" }, { id: "t2", title: "b", status: "blocked", note: "no access", parent: "t1" }, { id: "t3", title: "c", status: "doing" }, { id: "t4", title: "d", status: "todo" }], 1)]);
  assert.deepEqual(v1?.tasks, [
    { id: "t1", subject: "a", status: "completed", description: "ok" },
    { id: "t2", subject: "b", status: "pending", description: "blocked: no access", parent: "t1" },
    { id: "t3", subject: "c", status: "in_progress" },
    { id: "t4", subject: "d", status: "pending" },
  ]);
});

