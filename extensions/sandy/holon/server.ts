import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { holonCli } from "./cli.ts";
import { HolonEngine } from "./engine.ts";
import { HolonError } from "./error.ts";
import { forwardInput, forwardResult } from "./forward.ts";

export const rpcContract = defineRpcContract({
  forward: {
    input: forwardInput,
    output: forwardResult,
  },
});

export const EDITOR_ASSETS = [
  ["elk-worker.min.js", "text/javascript; charset=utf-8"],
  ["routing-worker.js", "text/javascript; charset=utf-8"],
  ["libavoid.wasm", "application/wasm"],
] as const;

function editorAssetDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "vendor", "holon-ui"), join(here, "..", "vendor", "holon-ui")];
  return candidates.find((dir) => EDITOR_ASSETS.every(([file]) => existsSync(join(dir, file)))) ?? null;
}

export default async function plugin(sandy: SandyPluginApi): Promise<void> {
  const engine = new HolonEngine();
  sandy.onDispose(() => engine.close());

  const failure = (cause: unknown) => {
    if (cause instanceof HolonError) return { ok: false as const, error: cause.hint === undefined ? cause.message : `${cause.message}. ${cause.hint}` };
    return { ok: false as const, error: cause instanceof Error ? cause.message : String(cause) };
  };

  async function threadRoot(threadId: string): Promise<string> {
    const thread = await sandy.sdk.threads.get({ threadId, include: "environment" });
    const environment = "environment" in thread ? (thread.environment ?? null) : null;
    if (environment === null || typeof environment.path !== "string") throw new HolonError("the thread has no workspace", "no_workspace");
    const { primaryHostId } = await sandy.sdk.system.config();
    if (environment.hostId !== primaryHostId) {
      throw new HolonError("the thread's workspace is on another machine", "remote_workspace", "The Holons tab edits holons on the disk of the SANDY server only");
    }
    if (!existsSync(environment.path) || !statSync(environment.path).isDirectory()) {
      throw new HolonError(`${environment.path} is not a directory on the disk of the SANDY server`, "no_workspace");
    }
    return environment.path;
  }

  sandy.rpc.register(rpcContract, {
    async forward({ threadId, method, path, query, body }) {
      try {
        const root = await threadRoot(threadId);
        const reply = await engine.request(root, {
          method,
          path,
          ...(query === undefined ? {} : { query }),
          ...(body === undefined ? {} : { body, contentType: "application/json" }),
        });
        return { ok: true as const, status: reply.status, text: reply.text };
      } catch (cause) {
        return failure(cause);
      }
    },
  });

  const vendorDir = editorAssetDir();
  for (const [file, contentType] of EDITOR_ASSETS) {
    sandy.http.route("GET", `/editor/${file}`, () => {
      if (vendorDir === null) return new Response("the holon editor assets are not installed", { status: 404 });
      return new Response(readFileSync(join(vendorDir, file)), { headers: { "Content-Type": contentType, "Cache-Control": "no-cache" } });
    });
  }

  sandy.cli.register(holonCli(engine));
}
