import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import { z } from "zod";
import {
  INFERENCE_PROCESSES,
  THIRD_PARTY_PROCESSES,
  allowedHostSet,
  parseResolvConf,
  validateExtraHosts,
} from "./allowlist.js";
import { normalizeHost } from "./classify.js";
import { createAlerter } from "./alert.js";
import { registerCli } from "./cli.js";
import {
  createCollector,
  PULL_INTERVAL_MS,
  type Cursor,
  type SourceDriver,
} from "./collector.js";
import { OVERVIEW_TAG, hostConnectionsContract } from "./contract.js";
import { subscribeHostnameChannels } from "./diagnostics.js";
import { createHostnameBook } from "./hostnames.js";
import { linuxInterfaces, wireguardSubnets } from "./interfaces.js";
import type { Cidr } from "./ip.js";
import { normalizeIp } from "./ip.js";
import { registerOverviewRpc } from "./overview-rpc.js";
import { nodeProcFs } from "./proc-fs.js";
import { startSamplingLoop } from "./sampling-loop.js";
import { createRequestPeerCollector } from "./request-peers.js";
import { createStore } from "./store.js";

export const EXTRA_ALLOWED_HOSTS = "extraAllowedHosts";
export const SERVER_SOURCE_ID = "server";
const RESOLVE_INTERVAL_MS = 2 * 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const NOTIFICATIONS_PLUGIN_ID = "push-notifications";
const NOTIFICATIONS_SEND_TIMEOUT_MS = 10_000;

const notificationDeliverySchema = z.object({
  ok: z.literal(true),
  channels: z.array(z.enum(["web", "desktop"])),
});

const cursorSchema = z.object({
  generation: z.string().nullable(),
  cursor: z.number().int().nonnegative(),
  gapCursor: z.number().int().nonnegative(),
  lastSampledAt: z.number().nullable(),
});

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export default function connectionOverview(sandy: SandyPluginApi) {
  const settings = sandy.settings.define({
    [EXTRA_ALLOWED_HOSTS]: {
      type: "string",
      label: "Additional allowed hosts",
      description:
        "Exact host names, one per line, that count as allowed besides the model providers and GitHub. Stored in this server's database only.",
      experimental_multiline: true,
      experimental_schema: {
        "~standard": {
          version: 1,
          vendor: "connection-overview",
          validate: (value: unknown) => {
            if (typeof value !== "string")
              return { issues: [{ message: "Expected text" }] };
            const problem = validateExtraHosts(value);
            return problem === null
              ? { value }
              : { issues: [{ message: problem }] };
          },
        },
      },
      default: "",
    },
  });
  const store = createStore(sandy.storage.database(), sandy.storage.migrate);
  const book = createHostnameBook();
  const unsubscribe = subscribeHostnameChannels(book);
  let allowedHosts = allowedHostSet("");
  let resolvers = new Set<string>();
  let bindSubnets: readonly Cidr[] = wireguardSubnets(linuxInterfaces);
  const host = sandy.hosts.experimental_client({
    contract: hostConnectionsContract,
  });
  const activeSources = new Set<string>([SERVER_SOURCE_ID]);
  const daemonRoots = new Map<string, number>();

  async function refreshAllowlist() {
    allowedHosts = allowedHostSet(
      (await settings.get())[EXTRA_ALLOWED_HOSTS] ?? "",
    );
    store.reclassify({
      isAllowed: (hostname) => allowedHosts.has(normalizeHost(hostname)),
      thirdPartyProcesses: THIRD_PARTY_PROCESSES,
    });
    sandy.rpc.experimental_invalidate([OVERVIEW_TAG]);
  }
  settings.onChange(() => void refreshAllowlist());

  const collector = createCollector({
    store,
    book,
    context: () => ({
      allowedHosts,
      resolvers,
      bindSubnets,
      inferenceProcesses: INFERENCE_PROCESSES,
      thirdPartyProcesses: THIRD_PARTY_PROCESSES,
    }),
    loadCursor: (sourceId) => {
      const parsed = cursorSchema.safeParse(store.loadCursor(sourceId));
      return parsed.success ? (parsed.data satisfies Cursor) : null;
    },
    saveCursor: (sourceId, cursor) => store.saveCursor(sourceId, cursor),
  });

  const requestPeers = createRequestPeerCollector({
    store,
    read: (after) => sandy.server.internal_DO_NOT_USE_requestPeers({ after }),
    bindSubnets: () => bindSubnets,
    serverPid: process.pid,
  });

  const alerter = createAlerter({
    store,
    send: async (notification) => {
      await sandy.sdk.plugins.callRpc({
        pluginId: NOTIFICATIONS_PLUGIN_ID,
        method: "notifications.send",
        input: notification,
        outputSchema: notificationDeliverySchema,
        signal: AbortSignal.timeout(NOTIFICATIONS_SEND_TIMEOUT_MS),
      });
    },
    onSendFailed: (error) =>
      sandy.log.warn(`connection overview: alert not sent: ${String(error)}`),
    onSendDeferred: (error) =>
      sandy.log.info(
        `connection overview: alert deferred to the next sweep: ${String(error)}`,
      ),
  });

  async function resolveListedHosts() {
    try {
      resolvers = new Set(
        parseResolvConf(await fs.readFile("/etc/resolv.conf", "utf8")).map(
          normalizeIp,
        ),
      );
    } catch {
      resolvers = new Set();
    }
    await Promise.all(
      [...allowedHosts].map(async (name) => {
        try {
          for (const entry of await dns.lookup(name, { all: true }))
            book.addResolution(name, entry.address);
        } catch {}
      }),
    );
    book.sweep();
  }

  sandy.background.service("collector", {
    async start(signal) {
      await refreshAllowlist();
      const serverDriver: SourceDriver | null =
        process.platform === "linux"
          ? (() => {
              const sampler = startSamplingLoop({
                fs: nodeProcFs,
                rootPid: process.pid,
                generation: randomUUID(),
                signal,
                excludedRoots: () => new Set(daemonRoots.values()),
                onError: (error) =>
                  sandy.log.warn(`connection sampler: ${String(error)}`),
              });
              return {
                sourceId: SERVER_SOURCE_ID,
                label: "server",
                ownPid: process.pid,
                sample: async (input) => ({
                  supported: true as const,
                  ...sampler.read(input),
                }),
              };
            })()
          : null;
      let lastResolve = 0;
      let lastPrune = 0;
      while (!signal.aborted) {
        const started = Date.now();
        if (started - lastResolve >= RESOLVE_INTERVAL_MS) {
          lastResolve = started;
          bindSubnets = wireguardSubnets(linuxInterfaces);
          await resolveListedHosts();
        }
        if (started - lastPrune >= PRUNE_INTERVAL_MS) {
          lastPrune = started;
          store.prune(started);
        }
        const drivers: SourceDriver[] = [];
        if (serverDriver !== null) drivers.push(serverDriver);
        else
          drivers.push({
            sourceId: SERVER_SOURCE_ID,
            label: "server",
            ownPid: null,
            sample: async () => ({
              supported: false as const,
              platform: process.platform,
            }),
          });
        try {
          const hosts = await sandy.sdk.hosts.list();
          activeSources.clear();
          activeSources.add(SERVER_SOURCE_ID);
          for (const hostId of daemonRoots.keys())
            if (
              !hosts.some(
                (entry) => entry.id === hostId && entry.status === "connected",
              )
            )
              daemonRoots.delete(hostId);
          for (const entry of hosts) {
            if (entry.status !== "connected") continue;
            activeSources.add(entry.id);
            drivers.push({
              sourceId: entry.id,
              label: entry.name,
              ownPid: null,
              sample: async (input) => {
                const reply = await host.call("sample", input, {
                  hostId: entry.id,
                  signal,
                  timeoutMs: 8_000,
                });
                if (reply.supported) daemonRoots.set(entry.id, reply.rootPid);
                return reply;
              },
            });
          }
        } catch (error) {
          sandy.log.warn(
            `connection overview: host list failed: ${String(error)}`,
          );
        }
        try {
          requestPeers.pull();
        } catch (error) {
          sandy.log.warn(
            `connection overview: request peers failed: ${String(error)}`,
          );
        }
        await Promise.all(drivers.map((driver) => collector.pull(driver)));
        sandy.rpc.experimental_invalidate([OVERVIEW_TAG]);
        alerter
          .start()
          ?.catch((error: unknown) =>
            sandy.log.warn(
              `connection overview: alert sweep failed: ${String(error)}`,
            ),
          );
        await waitFor(
          Math.max(0, PULL_INTERVAL_MS - (Date.now() - started)),
          signal,
        );
      }
      unsubscribe();
    },
  });

  const health = () => collector.health(activeSources);
  registerCli(sandy, { store, health });
  registerOverviewRpc(sandy, { store, health });
}
