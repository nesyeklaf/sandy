import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

/**
 * How long a kept worker is expected to wait for its next call, such as a reviewer's verdict. Sandy context pings the
 * worker until then when keeping its prompt cache warm is cheaper than letting it go cold; a continuation or the end of
 * the run ends the wait early. Whether a provider's cache expires at all is Sandy context's knowledge, not this
 * plugin's: a Codex worker, whose cache never expires, gets the signal too and is simply never pinged.
 */
export const KEEP_WARM_WAIT_MS = 30 * 60_000;

/** The keep-warm signal Sandy context reads, in the worker thread's storage on the machine that runs the worker. */
export const KEEP_WARM_FILE = "pi-keep-warm.json";

type Sdk = Pick<SandyPluginApi["sdk"], "threads" | "files">;

/**
 * Tells a kept worker's Sandy context how long the worker waits, through the host-routed file API, because the
 * worker may run on another machine than this server. Best effort: a worker without Sandy context ignores the file,
 * and a failed write must not fail the call.
 */
export function createKeepWarm(sdk: Sdk, warn: (message: string) => void) {
  async function signal(threadId: string) {
    const { hostId, storageRootPath } = await sdk.threads.storageLocation({ threadId });
    return { hostId, path: `${storageRootPath.replace(/\/$/, "")}/${KEEP_WARM_FILE}` };
  }
  return {
    async announceWait(threadId: string, until: number): Promise<void> {
      try {
        const { hostId, path } = await signal(threadId);
        await sdk.files.write({ hostId, path, content: JSON.stringify({ until }), createParents: true });
      } catch (error) {
        warn(`Could not announce the keep-warm wait of ${threadId}: ${String(error)}`);
      }
    },
    async endWait(threadId: string): Promise<void> {
      try {
        const { hostId, path } = await signal(threadId);
        await sdk.files.remove({ hostId, path });
      } catch {
        // Nothing to remove, or the thread is gone with its storage.
      }
    },
  };
}
