import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import { VIEWS, hostContract, rpcContract } from "./contract.ts";
import { commandText } from "./views.ts";

interface Target {
  hostId: string;
  path: string;
}

export default async function plugin(sandy: SandyPluginApi) {
  const host = sandy.hosts.experimental_client({ contract: hostContract });
  const views = Object.fromEntries(
    Object.entries(VIEWS).map(([key, label]) => [key, { type: "boolean" as const, label, default: true }]),
  ) as { [K in keyof typeof VIEWS]: { type: "boolean"; label: string; default: true } };
  const settings = sandy.settings.define({
    ...views,
    archivedLimit: { type: "number", label: "Archived goals shown in the tab", experimental_schema: z.number().int().min(0).max(100), default: 10 },
    eventLimit: { type: "number", label: "Activity entries shown in the tab", experimental_schema: z.number().int().min(0).max(200), default: 15 },
  });

  const targets = new Map<string, Target>();
  async function resolveTarget(threadId: string): Promise<Target> {
    const known = targets.get(threadId);
    if (known) return known;
    const thread = await sandy.sdk.threads.get({ threadId });
    const environmentId = (thread as { environmentId: string | null }).environmentId;
    if (!environmentId) throw new Error("this thread has no environment");
    const env = await sandy.sdk.environments.get({ environmentId });
    const target = { hostId: env.hostId, path: env.path ?? "" };
    targets.set(threadId, target);
    return target;
  }

  sandy.rpc.register(rpcContract, {
    snapshot: async ({ threadId, archivedLimit, eventLimit }) => {
      const target = await resolveTarget(threadId);
      return host.call("read", { threadId, cwd: target.path, archivedLimit, eventLimit }, { hostId: target.hostId });
    },
    command: async ({ threadId, command, arg }) => {
      const text = commandText(command, arg);
      // steer-if-active: pi runs extension commands at once, so a pause lands mid-turn instead of after it.
      await sandy.sdk.threads.send({ threadId, mode: "steer-if-active", input: [{ type: "text", text, mentions: [] }] });
      return { sent: text };
    },
    setView: async ({ view, on }) => {
      await settings.experimental_set({ [view]: on } as Parameters<typeof settings.experimental_set>[0]);
      return {};
    },
  });
}
