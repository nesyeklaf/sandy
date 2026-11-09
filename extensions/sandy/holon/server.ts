import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { defineRpcContract, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { holonCli } from "./cli.ts";
import type { MapOutput, ViewOutput } from "./core/outputs.ts";
import { HolonEngine } from "./engine.ts";
import { HolonError } from "./error.ts";
import { gitTopLevel, modelRootOf } from "./root.ts";

const viewResult = z.union([
  z.object({ ok: z.literal(true), root: z.string(), view: z.custom<ViewOutput>() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const mapResult = z.union([
  z.object({ ok: z.literal(true), root: z.string(), map: z.custom<MapOutput>() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const fileInput = z.object({
  source: z.object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().min(1).nullable(),
    environmentId: z.string().min(1).nullable(),
  }),
  path: z.string().min(1),
});

export const rpcContract = defineRpcContract({
  view: {
    input: fileInput.extend({ id: z.string().optional() }),
    output: viewResult,
  },
  map: {
    input: fileInput,
    output: mapResult,
  },
});

type Source = z.infer<typeof fileInput>["source"];

const holonFile = z.object({ id: z.string().min(1) });

function holonIdOf(file: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new HolonError("not valid holon JSON", "invalid_holon_file");
  }
  const holon = holonFile.safeParse(parsed);
  if (!holon.success) throw new HolonError("no holon id", "invalid_holon_file");
  return holon.data.id;
}

async function absoluteFile(sandy: SandyPluginApi, source: Source, path: string): Promise<{ file: string; root: string | null }> {
  if (source.kind === "host" || isAbsolute(path)) return { file: path, root: null };
  if (source.kind === "thread-storage") {
    if (source.threadId === null) throw new HolonError("a thread-storage file needs its thread", "no_thread");
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
  if (workspace === null) throw new HolonError("the file has no workspace path", "no_workspace");
  return { file: join(workspace, path), root: workspace };
}

export default async function plugin(sandy: SandyPluginApi): Promise<void> {
  const engine = new HolonEngine();
  sandy.onDispose(() => engine.close());

  const failure = (cause: unknown) => {
    if (cause instanceof HolonError) return { ok: false as const, error: cause.hint === undefined ? cause.message : `${cause.message}. ${cause.hint}` };
    return { ok: false as const, error: cause instanceof Error ? cause.message : String(cause) };
  };

  async function modelOf(source: Source, path: string): Promise<{ file: string; root: string } | { error: string }> {
    const { file, root: workspace } = await absoluteFile(sandy, source, path);
    if (!existsSync(file)) return { error: `${path} is not on the disk of the SANDY server; holon views need a local workspace` };
    return { file, root: modelRootOf(file, workspace ?? gitTopLevel(dirname(file)) ?? dirname(file)) };
  }

  sandy.rpc.register(rpcContract, {
    async view({ source, path, id }) {
      try {
        const model = await modelOf(source, path);
        if ("error" in model) return { ok: false as const, error: model.error };
        const target = id ?? holonIdOf(model.file);
        const reply = await engine.call(model.root, { method: "GET", path: `/v0/holons/${encodeURIComponent(target)}` });
        return { ok: true as const, root: model.root, view: JSON.parse(reply.text) as ViewOutput };
      } catch (cause) {
        return failure(cause);
      }
    },
    async map({ source, path }) {
      try {
        const model = await modelOf(source, path);
        if ("error" in model) return { ok: false as const, error: model.error };
        const reply = await engine.call(model.root, { method: "GET", path: "/v0/map" });
        return { ok: true as const, root: model.root, map: JSON.parse(reply.text) as MapOutput };
      } catch (cause) {
        return failure(cause);
      }
    },
  });

  sandy.cli.register(holonCli(engine));
}
