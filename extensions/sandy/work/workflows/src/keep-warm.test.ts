import { describe, expect, it } from "vitest";
import { createKeepWarm, KEEP_WARM_FILE } from "./keep-warm.js";

describe("keep-warm signal", () => {
  it("writes the wait into the worker's thread storage on the worker's host and removes it when the wait ends", async () => {
    const files = new Map<string, string>();
    const warnings: string[] = [];
    const keepWarm = createKeepWarm(
      {
        threads: {
          storageLocation: async ({ threadId }: { threadId: string }) => ({
            hostId: "host-b",
            storageRootPath: `/storage/${threadId}/`,
          }),
        },
        files: {
          write: async ({ hostId, path, content }: { hostId?: string; path: string; content: string }) => {
            files.set(`${hostId}:${path}`, content);
            return {} as never;
          },
          remove: async ({ hostId, path }: { hostId?: string; path: string }) => {
            if (!files.delete(`${hostId}:${path}`)) throw new Error("ENOENT");
            return {} as never;
          },
        },
      } as never,
      (message) => warnings.push(message),
    );
    await keepWarm.announceWait("thr_a", 1234);
    expect(Object.fromEntries(files)).toEqual({
      [`host-b:/storage/thr_a/${KEEP_WARM_FILE}`]: JSON.stringify({ until: 1234 }),
    });
    await keepWarm.endWait("thr_a");
    expect(files.size).toBe(0);
    await keepWarm.endWait("thr_a");
    expect(warnings).toEqual([]);
  });

  it("does not fail the call when the worker's storage cannot be written", async () => {
    const warnings: string[] = [];
    const keepWarm = createKeepWarm(
      { threads: { storageLocation: async () => Promise.reject(new Error("offline")) } } as never,
      (message) => warnings.push(message),
    );
    await keepWarm.announceWait("thr_a", 1);
    expect(warnings).toHaveLength(1);
  });
});
