import { createStorage } from "./storage.js";
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { storageRpc } from "./contract.js";
import { createService } from "./service.js";
import { registerCli } from "./cli.js";

export default function plugin(sandy: SandyPluginApi) {
  const service = createService(sandy);
  const devCleanupEnabled = async () =>
    (await service.state()).policy.deleteDevDataOnCheckoutRemoval;
  const storage = createStorage(sandy, devCleanupEnabled);
  sandy.events.on("experimental_environment.removed", ({ removal }) =>
    removal.hostId === null
      ? undefined
      : storage.cleanDevelopmentStorage(removal.hostId),
  );
  sandy.background.schedule(
    "development-storage-cleanup",
    "0 * * * *",
    storage.reconcileDevelopmentStorage,
  );
  sandy.background.service("development-storage-recovery", {
    async start(signal) {
      if (signal.aborted) return;
      const unsubscribe = sandy.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.changes.includes("host-connected"))
            void storage.reconcileDevelopmentStorage();
          if (
            event.changes.includes("host-connected") ||
            event.changes.includes("host-disconnected")
          )
            sandy.realtime.publish("changed", null);
        },
      });
      const unsubscribeConnection = sandy.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected" && event.reconnected)
            void storage.reconcileDevelopmentStorage();
        },
      });
      try {
        await storage.reconcileDevelopmentStorage();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        unsubscribe();
        unsubscribeConnection();
      }
    },
  });
  const cleanupEnabled = async () =>
    (await service.state()).policy.deleteStorageOnArchive;
  sandy.events.on("thread.archived", async ({ thread }) => {
    if (
      thread.archivedAt === null ||
      thread.pinnedAt !== null ||
      !(await cleanupEnabled())
    )
      return;
    storage.queueArchivedStorage(thread.id, thread.archivedAt);
    await storage.clearPendingArchives(cleanupEnabled);
  });
  for (const event of ["thread.idle", "thread.failed"] as const)
    sandy.events.on(event, () => storage.clearPendingArchives(cleanupEnabled));
  for (const event of ["thread.unarchived", "thread.deleted"] as const)
    sandy.events.on(event, ({ thread }) =>
      storage.cancelArchivedStorage(thread.id),
    );
  sandy.background.schedule("archive-storage-cleanup", "* * * * *", () =>
    storage.clearPendingArchives(cleanupEnabled),
  );
  sandy.rpc.register(storageRpc, {
    startEntryCleanup: storage.startEntryCleanup,
    entryCleanup: storage.entryCleanup,
    startCleanup: storage.startCleanup,
    hosts: () => storage.hosts(),
    host: storage.host,
    scanHost: storage.scanHost,
    scanAll: () => storage.scanAll(),
    removeOrphans: (input) => storage.removeOrphans(input),
    clearLargeFiles: storage.clearLargeFiles,
    startClearLargeFiles: storage.startClearLargeFiles,
    retryWorktreeCleanup: (input) => storage.retryWorktreeCleanup(input),
    clearThread: storage.clearThread,
    clearArchivedFiles: storage.clearArchivedFiles,
    startClearArchivedFiles: storage.startClearArchivedFiles,
    removeDevInstances: (input) => storage.removeDevInstances(input),
    removeExternalWorktrees: (input) => storage.removeExternalWorktrees(input),
    startRemoveExternalWorktree: storage.startRemoveExternalWorktree,
    state: () => service.state(),
    preview: (policy) => service.preview(policy),
    configure: (policy) => service.configure(policy),
  });
  registerCli(sandy, service, storage);
  sandy.background.schedule("retention", "0 * * * *", () => service.sweep());
}
