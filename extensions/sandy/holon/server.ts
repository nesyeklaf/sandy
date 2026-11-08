import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { defineRpcContract, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { holonCli } from "./cli.ts";
import { parseHolon } from "./core/format.ts";
import { gitTopLevel } from "./core/git.ts";
import type { ViewOutput } from "./core/outputs.ts";
import { migrateIndex } from "./index/holon-index.ts";
import { HolonInputError, HolonService } from "./service.ts";

const viewResult = z.union([
  z.object({ ok: z.literal(true), root: z.string(), view: z.custom<ViewOutput>() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const rpcContract = defineRpcContract({
  view: {
    input: z.object({
      threadId: z.string().min(1),
      sourceKind: z.enum(["workspace", "host", "thread-storage"]),
      path: z.string().min(1),
      id: z.string().optional(),
    }),
    output: viewResult,
  },
});

async function absoluteFile(sandy: SandyPluginApi, threadId: string, kind: "workspace" | "host" | "thread-storage", path: string): Promise<{ file: string; root: string | null }> {
  if (kind === "host" || isAbsolute(path)) return { file: path, root: null };
  if (kind === "thread-storage") {
    const storage = await sandy.sdk.threads.storageLocation({ threadId });
    return { file: join(storage.storageRootPath, path), root: null };
  }
  const thread = await sandy.sdk.threads.get({ threadId, include: "environment" });
  const environment = "environment" in thread ? thread.environment : null;
  if (typeof environment?.path !== "string") throw new HolonInputError("the thread has no workspace", "no_workspace");
  return { file: join(environment.path, path), root: environment.path };
}

export default async function plugin(sandy: SandyPluginApi): Promise<void> {
  const db = sandy.storage.database();
  migrateIndex(db, (target, statements) => sandy.storage.migrate(target, statements));
  const service = new HolonService(db);

  sandy.rpc.register(rpcContract, {
    async view({ threadId, sourceKind, path, id }) {
      try {
        const { file, root: workspace } = await absoluteFile(sandy, threadId, sourceKind, path);
        if (!existsSync(file)) return { ok: false as const, error: `${path} is not on the disk of the SANDY server; holon views need a local workspace` };
        const parsed = parseHolon(readFileSync(file, "utf8"));
        if (!parsed.ok) return { ok: false as const, error: `${path}: ${parsed.error}` };
        const root = workspace ?? gitTopLevel(dirname(file)) ?? dirname(file);
        const { index } = service.open(root, {});
        const target = id ?? parsed.value.id;
        const view = index.view(target);
        if (view === null) return { ok: false as const, error: `no holon ${target} under ${root}` };
        return { ok: true as const, root, view };
      } catch (cause) {
        return { ok: false as const, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });

  sandy.cli.register(holonCli(service));
}
