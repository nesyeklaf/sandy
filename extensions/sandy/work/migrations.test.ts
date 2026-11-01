import assert from "node:assert/strict";
import { test } from "node:test";
import { migrations as delegateMigrations } from "./delegate/server/migrations.ts";
import { DELEGATE_MIGRATION_COUNT, migrations, WORKFLOW_MIGRATION_COUNT } from "./migrations.ts";
import { migrations as workflowMigrations } from "./workflows/src/data.ts";

test("the parts' migration slices stay frozen; new migrations go at the end of the plugin list", () => {
  assert.equal(delegateMigrations.length, DELEGATE_MIGRATION_COUNT, "a delegate migration was added to its own list: move it to the end of sandy/work/migrations.ts");
  assert.equal(workflowMigrations.length, WORKFLOW_MIGRATION_COUNT, "a workflow migration was added to its own list: move it to the end of sandy/work/migrations.ts");
  assert.deepEqual(migrations.slice(0, DELEGATE_MIGRATION_COUNT), delegateMigrations);
  assert.deepEqual(migrations.slice(DELEGATE_MIGRATION_COUNT, DELEGATE_MIGRATION_COUNT + WORKFLOW_MIGRATION_COUNT), workflowMigrations);
});
