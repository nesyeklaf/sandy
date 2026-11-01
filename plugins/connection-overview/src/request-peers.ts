import type { InternalDoNotUsePluginRequestPeers } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import { classifyRequestPeer } from "./classify.js";
import type { Cidr } from "./ip.js";
import { normalizeIp } from "./ip.js";
import type { Observation, Store } from "./store.js";

export const REQUEST_SOURCE_ID = "server-http";

const requestCursorSchema = z.object({
  generation: z.string(),
  after: z.number().int().nonnegative(),
  lastAt: z.number().nullable(),
});
type RequestCursor = z.infer<typeof requestCursorSchema>;

export function createRequestPeerCollector(options: {
  store: Store;
  read: (after: number) => InternalDoNotUsePluginRequestPeers;
  bindSubnets: () => readonly Cidr[];
  serverPid: number;
}) {
  const cursorKey = REQUEST_SOURCE_ID;
  function loadCursor(): RequestCursor | null {
    const parsed = requestCursorSchema.safeParse(
      options.store.loadCursor(cursorKey),
    );
    return parsed.success ? parsed.data : null;
  }

  function pull(): number {
    const saved = loadCursor();
    let snapshot = options.read(saved?.after ?? 0);
    const resumed = saved !== null && saved.generation === snapshot.generation;
    if (saved !== null && !resumed) snapshot = options.read(0);
    const after = resumed ? saved.after : 0;
    const lastAt = resumed ? saved.lastAt : null;
    const first = snapshot.peers[0];
    const lost = first === undefined ? 0 : first.seq - after - 1;
    const bindSubnets = options.bindSubnets();
    const observations: Observation[] = snapshot.peers.map((peer) => {
      const classification = classifyRequestPeer(peer, { bindSubnets });
      return {
        sourceId: REQUEST_SOURCE_ID,
        direction: classification.direction,
        proto: "tcp",
        port: peer.localPort ?? 0,
        hostname: null,
        ip: peer.address === null ? "unknown" : normalizeIp(peer.address),
        state: classification.state,
        reason: classification.reason,
        seenAt: peer.at,
        newSocket: true,
        attribution: {
          pid: options.serverPid,
          startTime: 0,
          comm: peer.websocket ? "websocket" : "http",
        },
      };
    });
    const last = snapshot.peers.at(-1);
    options.store.atomically(() => {
      if (first !== undefined && lost > 0)
        options.store.recordGap(
          REQUEST_SOURCE_ID,
          lastAt ?? first.at,
          first.at,
          lastAt === null
            ? `request ring overwrote ${lost} unread entries before the first read`
            : "request ring overwrote unread entries",
        );
      options.store.record(observations);
      options.store.saveCursor(cursorKey, {
        generation: snapshot.generation,
        after: snapshot.latestSeq,
        lastAt: last?.at ?? lastAt,
      } satisfies RequestCursor);
    });
    return observations.length;
  }

  return { pull };
}
