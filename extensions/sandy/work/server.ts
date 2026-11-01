// sandy/work: delegate, track, workflows and goals as one plugin. Each part keeps its own register
// function and registers through combine()'s view; the plugin database holds one migration list.
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { combine } from "./combine.ts";
import registerDelegate from "./delegate/server/index.ts";
import registerGoals from "./goals/server.ts";
import { migrations } from "./migrations.ts";
import { migrations as delegateMigrations } from "./delegate/server/migrations.ts";
import registerTrack from "./track/server.ts";
import { migrations as workflowMigrations } from "./workflows/src/data.ts";
import registerWorkflows from "./workflows/src/server.ts";
import { createWorkersLink } from "./workers-link.ts";
import { importLegacy } from "./legacy-import.ts";

export default async function plugin(sandy: SandyPluginApi) {
  const work = combine(sandy, {
    cli: { name: "work", summary: "Delegates, tracks and workflows of this SANDY" },
    migrations,
    partMigrations: [delegateMigrations, workflowMigrations],
  });
  // Worker slots: workflows asks the delegate ledger in process (workers-link.ts).
  const workers = createWorkersLink();
  await registerDelegate(work.view, workers);
  await registerWorkflows(work.view, workers);
  await registerTrack(work.view);
  await registerGoals(work.view);
  work.finish();
  // Agent catalog and changed settings of the replaced plugins, once; not awaited so a settings call
  // to the server never holds up this plugin's load.
  void importLegacy(sandy, sandy.storage.database()).catch((error: unknown) => sandy.log.warn(`legacy import failed, retried at the next load: ${String(error)}`));
}
