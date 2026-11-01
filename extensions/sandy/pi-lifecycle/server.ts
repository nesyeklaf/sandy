// sandy-plugin-pi-lifecycle: shows which SANDY sessions have a loaded pi, when it last restarted or
// reloaded, what it costs, and restarts or reloads it per session or per host.
// Restart = release the loaded runtime (sandy thread stop); the next message starts a fresh pi.
// Reload = ask the pi-side extension to run ctx.reload() once pi is idle.
import { PluginCliError, cliCommand, defineCli, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { hostContract, rpcContract, type HostScan, type HostView, type Proc, type SessionView } from "./contract.ts";

export { rpcContract };

type ThreadInfo = { title: string | null; status: string | null };

export default async function plugin(sandy: SandyPluginApi) {
  const host = sandy.hosts.experimental_client({ contract: hostContract });

  async function connectedHosts() {
    return (await sandy.sdk.hosts.list()).filter((item) => item.status === "connected");
  }

  async function threadInfo(threadId: string): Promise<ThreadInfo> {
    try {
      const result = (await sandy.sdk.threads.get({ threadId })) as { thread?: Record<string, unknown> } & Record<string, unknown>;
      const thread = (result.thread ?? result) as { title?: string | null; titleFallback?: string | null; status?: string };
      return { title: thread.title ?? thread.titleFallback ?? null, status: thread.status ?? null };
    } catch {
      return { title: null, status: null };
    }
  }

  const sessionOf = async (proc: Proc): Promise<SessionView> => ({ ...proc, ...(await threadInfo(proc.threadId)) });

  async function scan(hostId: string): Promise<HostScan> {
    return host.call("scan", {}, { hostId });
  }

  async function hostView(item: { id: string; name: string }): Promise<HostView> {
    try {
      const result = await scan(item.id);
      return {
        hostId: item.id,
        name: item.name,
        error: null,
        extensionInstalled: result.extensionInstalled,
        sessions: await Promise.all(result.processes.map(sessionOf)),
      };
    } catch (error) {
      return { hostId: item.id, name: item.name, error: String(error), extensionInstalled: false, sessions: [] };
    }
  }

  /** The host whose pi process serves this thread, if any is loaded. */
  async function locate(threadId: string) {
    for (const item of await connectedHosts()) {
      try {
        const result = await scan(item.id);
        const proc = result.processes.find((candidate) => candidate.threadId === threadId);
        if (proc) return { hostId: item.id, proc, extensionInstalled: result.extensionInstalled };
      } catch {
        // an unreachable host cannot be the one serving the thread
      }
    }
    return null;
  }

  const isIdle = (status: string | null) => status === null || status === "idle";

  async function restart(threadId: string, force: boolean) {
    const { status } = await threadInfo(threadId);
    if (!force && !isIdle(status)) throw new Error(`thread is ${status}; restarting now would interrupt it`);
    await sandy.sdk.threads.stop({ threadId });
  }

  async function reload(threadId: string) {
    const found = await locate(threadId);
    if (!found) throw new Error("pi is not loaded in this session; the next message starts it fresh");
    if (!found.proc.hook) throw new Error("the lifecycle extension is not loaded in this pi; restart the session once after installing it");
    await host.call("requestReload", { targets: [{ pid: found.proc.pid, startedAt: found.proc.hook.startedAt }] }, { hostId: found.hostId });
    sandy.realtime.publish("changed", {});
  }

  sandy.rpc.register(rpcContract, {
    hosts: async () => ({ hosts: await Promise.all((await connectedHosts()).map(hostView)) }),
    session: async ({ threadId }) => {
      const found = await locate(threadId);
      return found
        ? { hostId: found.hostId, session: await sessionOf(found.proc), extensionInstalled: found.extensionInstalled }
        : { hostId: null, session: null, extensionInstalled: false };
    },
    restart: async ({ threadId, force }) => {
      await restart(threadId, force === true);
      sandy.realtime.publish("changed", {});
      return {};
    },
    reload: async ({ threadId }) => {
      await reload(threadId);
      return {};
    },
    restartHost: async ({ hostId, includeRunning }) => {
      const sessions = (await scan(hostId)).processes;
      let count = 0;
      for (const proc of sessions) {
        const { status } = await threadInfo(proc.threadId);
        if (!includeRunning && !isIdle(status)) continue;
        await sandy.sdk.threads.stop({ threadId: proc.threadId });
        count += 1;
      }
      sandy.realtime.publish("changed", {});
      return { count };
    },
    reloadHost: async ({ hostId }) => {
      const { processes } = await scan(hostId);
      const targets = processes.flatMap((proc) => (proc.hook ? [{ pid: proc.pid, startedAt: proc.hook.startedAt }] : []));
      const { requested } = await host.call("requestReload", { targets }, { hostId });
      sandy.realtime.publish("changed", {});
      return { count: requested };
    },
    install: async ({ hostId }) => host.call("install", {}, { hostId }),
  });

  const fail = (error: unknown) => new PluginCliError(String(error), { code: "pi_lifecycle_error" });
  const age = (at: number | null) => (at === null ? "-" : `${Math.max(0, Math.round((Date.now() - at) / 60000))}m ago`);

  sandy.cli.register(
    defineCli({
      name: "pi-lifecycle",
      summary: "pi processes per SANDY session: status, restart, reload",
      commands: {
        status: cliCommand({
          summary: "List loaded pi processes on every connected host",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input) {
            const hosts = await Promise.all((await connectedHosts()).map(hostView));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(hosts, null, 2) };
            const lines = hosts.flatMap((item) => [
              `${item.name}${item.error ? ` (${item.error})` : ""}${item.extensionInstalled ? "" : " [extension not installed]"}`,
              ...item.sessions.map((s) => `  ${s.threadId} ${s.title ?? ""} | start ${age(s.startedAt)} | reload ${age(s.hook?.lastReloadAt ?? null)} | ${Math.round(s.rssBytes / 1048576)} MB | ${s.cpuPercent}% cpu`),
            ]);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        restart: cliCommand({
          summary: "Restart pi in one session (releases the loaded runtime)",
          positionals: [{ name: "thread", description: "Thread id", required: true }],
          options: { force: { type: "boolean", description: "Also when the thread is running" } },
          async run(input) {
            await restart(input.positionals.thread ?? "", input.options.force === true).catch((error) => { throw fail(error); });
            return { exitCode: 0, stdout: "restarted" };
          },
        }),
        reload: cliCommand({
          summary: "Reload pi in one session once it is idle",
          positionals: [{ name: "thread", description: "Thread id", required: true }],
          async run(input) {
            await reload(input.positionals.thread ?? "").catch((error) => { throw fail(error); });
            return { exitCode: 0, stdout: "reload requested" };
          },
        }),
      },
    }),
  );
}
