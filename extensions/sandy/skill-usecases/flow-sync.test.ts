import assert from "node:assert/strict";
import test from "node:test";
import { record, startHistory, undo } from "./canvas-model.ts";
import { acked, edited, fetched, fetchStarted, reconcileEditor, startSync, type FlowSync } from "./flow-sync.ts";
import type { Flow } from "./graph.ts";
import { uxFlow } from "./ux-flow.fixture.ts";

const named = (name: string, description = ""): Flow => ({ ...uxFlow(), name, description });

function fakeServer() {
  let stored: Flow[] = [named("First")];
  let sync: FlowSync = startSync();
  const sent: Flow[][] = [];
  const editLocally = (flows: Flow[]) => {
    const step = edited(sync, flows);
    sync = step.sync;
    if (step.send !== null) sent.push(step.send);
  };
  const ackOldest = () => {
    const saved = sent.shift();
    assert.ok(saved, "no save in flight");
    stored = saved;
    const step = acked(sync);
    sync = step.sync;
    if (step.send !== null) sent.push(step.send);
  };
  return {
    editLocally,
    ackOldest,
    inFlight: () => sent.length,
    stored: () => stored,
    get sync() {
      return sync;
    },
    set sync(next: FlowSync) {
      sync = next;
    },
  };
}

test("overlapping edits are sent one at a time and coalesce to the latest local state", () => {
  const server = fakeServer();
  server.editLocally([named("Local rename")]);
  server.editLocally([named("Local rename", "Middle description")]);
  server.editLocally([named("Local rename", "Latest description")]);
  assert.equal(server.inFlight(), 1, "a second save must wait for the first acknowledgement");
  server.ackOldest();
  assert.equal(server.inFlight(), 1, "the queued edits go out as one save");
  server.ackOldest();
  assert.equal(server.inFlight(), 0);
  assert.deepEqual(server.stored().map((flow) => [flow.name, flow.description]), [["Local rename", "Latest description"]]);
  assert.equal(server.sync.inFlight, false);
});

test("a refetch that answers while saves are pending keeps the newer local flows", () => {
  const server = fakeServer();
  const early = fetchStarted(server.sync);
  const earlier = fetchStarted(early.sync);
  server.sync = earlier.sync;
  server.editLocally([named("Local rename", "Latest description")]);
  const during = fetched(server.sync, early.ticket, [named("First")]);
  server.sync = during.sync;
  assert.deepEqual(during.flows?.map((flow) => flow.description), ["Latest description"]);
  server.ackOldest();
  const stale = fetched(server.sync, earlier.ticket, [named("First")]);
  assert.deepEqual(stale.flows?.map((flow) => flow.description), ["Latest description"], "a fetch started before the save must not restore the old server state");
  const late = fetchStarted(server.sync);
  const fresh = fetched(late.sync, late.ticket, server.stored());
  assert.deepEqual(fresh.flows, server.stored());
});

test("an older fetch answering after a newer one is ignored", () => {
  const first = fetchStarted(startSync());
  const second = fetchStarted(first.sync);
  const newer = fetched(second.sync, second.ticket, [named("Remote edit")]);
  assert.deepEqual(newer.flows?.map((flow) => flow.name), ["Remote edit"]);
  const older = fetched(newer.sync, first.ticket, [named("First")]);
  assert.equal(older.flows, null);
});

test("a remote edit of the open flow reaches the editor and stays undoable", () => {
  const history = record(startHistory(named("Start")), named("First"));
  const next = reconcileEditor(history, named("Remote edit"), false);
  assert.equal(next.present.name, "Remote edit");
  assert.equal(undo(next).present.name, "First");
  assert.equal(undo(undo(next)).present.name, "Start");
});

test("with unsaved local edits the editor keeps its own state", () => {
  const history = startHistory(named("Local rename"));
  assert.equal(reconcileEditor(history, named("Remote edit"), true), history);
});

test("the server echo of the editor's own state leaves history untouched", () => {
  const local = named("First", "Same");
  const history = startHistory(local);
  const echo: Flow = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(local).reverse())));
  assert.equal(reconcileEditor(history, echo, false), history);
});

test("another flow replaces the editor history", () => {
  const history = record(startHistory(named("Start")), named("First"));
  const other = { ...named("Other"), id: "other" };
  const next = reconcileEditor(history, other, false);
  assert.deepEqual([next.present.id, next.past.length], ["other", 0]);
});
