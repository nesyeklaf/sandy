import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { defineRpcContract, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { holonCli } from "./cli.ts";
import { parseHolon } from "./core/format.ts";
import { gitTopLevel } from "./core/git.ts";
import { modelRootOf } from "./core/scan.ts";
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
      source: z.object({
        kind: z.enum(["workspace", "host", "thread-storage"]),
        threadId: z.string().min(1).nullable(),
        environmentId: z.string().min(1).nullable(),
      }),
      path: z.string().min(1),
      id: z.string().optional(),
    }),
    output: viewResult,
  },
});

type Source = z.infer<typeof rpcContract.view.input>["source"];

async function absoluteFile(sandy: SandyPluginApi, source: Source, path: string): Promise<{ file: string; root: string | null }> {
  if (source.kind === "host" || isAbsolute(path)) return { file: path, root: null };
  if (source.kind === "thread-storage") {
    if (source.threadId === null) throw new HolonInputError("a thread-storage file needs its thread", "no_thread");
    const storage = await sandy.sdk.threads.storageLocation({ threadId: source.threadId });
    return { file: join(storage.storageRootPath, path), root: null };
  }
  let workspace: string | null = null;
  if (source.environmentId !== null) {
    workspace = (await sandy.sdk.environments.get({ environmentId: source.environmentId })).path ?? null;
  } else if (source.threadId !== null) {
    const thread = await sandy.sdk.threads.get({ threadId: source.threadId, include: "environment" });
    const environment = "environment" in thread ? thread.environment : null;
    workspace = typeof environment?.path === "string" ? environment.path : null;
  }
  if (workspace === null) throw new HolonInputError("the file has no workspace path", "no_workspace");
  return { file: join(workspace, path), root: workspace };
}

export default async function plugin(sandy: SandyPluginApi): Promise<void> {
  const db = sandy.storage.database();
  migrateIndex(db, (target, statements) => sandy.storage.migrate(target, statements));
  const service = new HolonService(db);
  sandy.onDispose(() => service.close());

  sandy.rpc.register(rpcContract, {
    async view({ source, path, id }) {
      try {
        const { file, root: workspace } = await absoluteFile(sandy, source, path);
        if (!existsSync(file)) return { ok: false as const, error: `${path} is not on the disk of the SANDY server; holon views need a local workspace` };
        const parsed = parseHolon(readFileSync(file, "utf8"));
        if (!parsed.ok) return { ok: false as const, error: `${path}: ${parsed.error}` };
        const root = modelRootOf(file, workspace ?? gitTopLevel(dirname(file)) ?? dirname(file));
        const { index } = await service.open(root, {});
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
