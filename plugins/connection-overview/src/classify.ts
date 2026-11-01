import {
  LOCAL_NETWORKS,
  LOOPBACK,
  TAILNET,
  inAny,
  normalizeIp,
  type Cidr,
} from "./ip.js";
import type { SocketRow } from "./contract.js";

export type Direction = "out" | "in" | "undetermined";
export type ConnectionState =
  | "allowed"
  | "inferred"
  | "yellow"
  | "red"
  | "unverifiable"
  | "undetermined"
  | "third-party";

export interface Resolution {
  name: string;
  ip: string;
  at: number;
}

export interface ClassifyContext {
  allowedHosts: ReadonlySet<string>;
  resolvers: ReadonlySet<string>;
  bindSubnets: readonly Cidr[];
  inferenceProcesses: ReadonlySet<string>;
  thirdPartyProcesses: ReadonlySet<string>;
  resolutionsFor(ip: string): readonly Resolution[];
  now: number;
}

export interface Classification {
  direction: Direction;
  state: ConnectionState;
  reason: string;
}

export const RESOLUTION_MAX_AGE_MS = 5 * 60_000;

const TCP_SYN_RECV = 0x03;

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function directionOf(
  row: Pick<SocketRow, "proto" | "tcpState" | "localListening">,
): Direction {
  if (row.localListening) return "in";
  if (row.proto === "udp") return "out";
  if (row.tcpState === TCP_SYN_RECV) return "undetermined";
  return "out";
}

function isLocal(
  ip: string,
  context: Pick<ClassifyContext, "bindSubnets">,
): boolean {
  return inAny(LOCAL_NETWORKS, ip) || inAny(context.bindSubnets, ip);
}

function classifyIncoming(
  ip: string,
  context: Pick<ClassifyContext, "bindSubnets">,
): Classification {
  const direction = "in";
  if (inAny(LOOPBACK, ip))
    return { direction, state: "unverifiable", reason: "loopback origin" };
  if (inAny(TAILNET, ip))
    return { direction, state: "allowed", reason: "tailnet peer" };
  if (inAny(context.bindSubnets, ip))
    return { direction, state: "allowed", reason: "bind interface peer" };
  return { direction, state: "red", reason: "external peer" };
}

export function classifyRequestPeer(
  peer: { address: string | null },
  context: Pick<ClassifyContext, "bindSubnets">,
): Classification {
  if (peer.address === null)
    return { direction: "in", state: "red", reason: "no socket peer" };
  return classifyIncoming(normalizeIp(peer.address), context);
}

export function classify(
  row: Pick<
    SocketRow,
    "proto" | "tcpState" | "localListening" | "remoteIp" | "remotePort" | "comm"
  >,
  hostname: string | null,
  context: ClassifyContext,
): Classification {
  const direction = directionOf(row);
  const ip = normalizeIp(row.remoteIp);
  if (direction === "in") return classifyIncoming(ip, context);
  if (isLocal(ip, context))
    return { direction, state: "allowed", reason: "local network" };
  if (row.remotePort === 53 && context.resolvers.has(ip))
    return { direction, state: "allowed", reason: "system resolver" };
  if (direction === "undetermined")
    return { direction, state: "undetermined", reason: "direction unknown" };
  const judged = judgeOutgoing(row.comm, ip, hostname, context);
  if (
    (judged.state === "red" || judged.state === "yellow") &&
    context.thirdPartyProcesses.has(row.comm)
  )
    return {
      direction,
      state: "third-party",
      reason: `${row.comm} is not sandy: ${judged.reason}`,
    };
  return { direction, ...judged };
}

function judgeOutgoing(
  comm: string,
  ip: string,
  hostname: string | null,
  context: ClassifyContext,
): Omit<Classification, "direction"> {
  if (hostname !== null) {
    return context.allowedHosts.has(normalizeHost(hostname))
      ? { state: "allowed", reason: "listed host" }
      : { state: "red", reason: "unlisted host" };
  }
  const resolutions = context.resolutionsFor(ip);
  const listed = resolutions.filter((entry) =>
    context.allowedHosts.has(normalizeHost(entry.name)),
  );
  const unlisted = resolutions.filter(
    (entry) => !context.allowedHosts.has(normalizeHost(entry.name)),
  );
  const freshListed = listed.filter(
    (entry) => context.now - entry.at <= RESOLUTION_MAX_AGE_MS,
  );
  if (
    context.inferenceProcesses.has(comm) &&
    freshListed.length > 0 &&
    unlisted.length === 0
  )
    return {
      state: "inferred",
      reason:
        "resolves to " +
        [...new Set(freshListed.map((entry) => entry.name))].join(", "),
    };
  if (listed.length > 0 && (unlisted.length > 0 || freshListed.length === 0))
    return {
      state: "yellow",
      reason:
        unlisted.length > 0
          ? "shared by listed and unlisted names"
          : "stale resolution",
    };
  if (unlisted.length > 0)
    return {
      state: "red",
      reason:
        "resolves to unlisted " +
        [...new Set(unlisted.map((entry) => entry.name))].join(", "),
    };
  if (freshListed.length > 0)
    return {
      state: "red",
      reason: "listed address from a process that is not a provider CLI",
    };
  return { state: "red", reason: "unknown address" };
}
