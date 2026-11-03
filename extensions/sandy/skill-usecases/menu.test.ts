import { test } from "node:test";
import assert from "node:assert/strict";
import { flowMenuItems } from "./flow-menu.ts";
import { migrateLinear } from "./graph.ts";

const source = {
  useCases: [
    { id: "build", label: "Build", keywords: [] },
    { id: "plan", label: "Plan", keywords: [] },
  ],
  fallbackId: "other",
  fallbackLabel: "Other",
  flows: [
    migrateLinear({ id: "f1", useCaseId: "build", name: "Quick feature", description: "", steps: [{ skill: "quick-plan", note: "" }] }),
    migrateLinear({ id: "f2", useCaseId: "gone", name: "Orphan", description: "", steps: [] }),
  ],
};

test("without a query the menu shows only areas that hold flows, orphans under the fallback", () => {
  const rows = flowMenuItems(source, "");
  assert.deepEqual(rows.map((row) => [row.id, row.items?.map((item) => item.id)]), [["build", ["f1"]], ["other", ["f2"]]]);
});

test("a query searches flows flat across areas and no data yields no rows", () => {
  assert.deepEqual(flowMenuItems(source, "quick").map((row) => row.id), ["f1"]);
  assert.deepEqual(flowMenuItems(null, ""), []);
});
