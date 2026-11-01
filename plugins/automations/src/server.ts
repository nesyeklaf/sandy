import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { migrations } from "./data.js";
import { ingestLegacyImport } from "./legacy-import.js";
import { pluginDataDirFromDb } from "./path.js";
import { automationRpcContract, createRpcHandlers } from "./rpc.js";
import {
  closeAutomationRunForSettledThread,
  disableAutomationsForDeletedThreadEvent,
  errorMessage,
  reconcileRunningAutomationRuns,
} from "./run.js";
import { registerAutomationCli } from "./cli.js";
import { createScriptRunScope } from "./script-runner.js";
import { createAutomationService } from "./service.js";
import { sleep, sweepDueAutomations, SWEEP_INTERVAL_MS } from "./sweep.js";

function resolveServerUrl(): string {
  return process.env.SANDY_SERVER_URL?.trim() || "http://127.0.0.1:38886";
}

export default async function plugin(sandy: SandyPluginApi) {
  const db = sandy.storage.database();
  sandy.storage.migrate(db, migrations);
  const pluginDataDir = pluginDataDirFromDb(db);
  await ingestLegacyImport({ sandy, db, pluginDataDir });
  const scriptRuns = createScriptRunScope();
  sandy.onDispose(() => scriptRuns.stop());

  const service = createAutomationService({
    sandy,
    db,
    pluginDataDir,
    serverUrl: resolveServerUrl(),
    scriptRuns,
  });

  sandy.rpc.register(automationRpcContract, createRpcHandlers(service));
  registerAutomationCli({ sandy, service });

  sandy.events.on("thread.idle", ({ thread }) => {
    closeAutomationRunForSettledThread(sandy, db, {
      threadId: thread.id,
      status: "idle",
    });
  });
  sandy.events.on("thread.failed", ({ thread, error }) => {
    closeAutomationRunForSettledThread(sandy, db, {
      threadId: thread.id,
      status: "failed",
      error,
    });
  });

  sandy.events.on("thread.deleted", ({ thread }) => {
    disableAutomationsForDeletedThreadEvent(sandy, db, thread.id);
  });

  sandy.background.service("automation-sweep", {
    async start(signal) {
      try {
        await reconcileRunningAutomationRuns(sandy, db);
      } catch (error) {
        sandy.log.error(
          `Automation startup reconciliation failed: ${errorMessage(error)}`,
        );
      }
      let serverHostId: string | null = null;
      while (!signal.aborted) {
        try {
          serverHostId ??= (await sandy.sdk.system.config()).primaryHostId;
          await sweepDueAutomations(sandy, db, {
            pluginDataDir,
            serverUrl: resolveServerUrl(),
            serverHostId,
            scriptRuns,
          });
        } catch (error) {
          sandy.log.error(`Automation sweep failed: ${errorMessage(error)}`);
        }
        await sleep(SWEEP_INTERVAL_MS, signal);
      }
    },
  });
}
