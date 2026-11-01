import { describe, expect, it } from "vitest";
import {
  allowedHostSet,
  parseExtraHosts,
  parseResolvConf,
  validateExtraHosts,
  INFERENCE_PROCESSES,
  THIRD_PARTY_PROCESSES,
} from "./allowlist.js";
import {
  classify,
  RESOLUTION_MAX_AGE_MS,
  type ClassifyContext,
  type Resolution,
} from "./classify.js";
import { parseCidr } from "./ip.js";

const NOW = 1_000_000_000;

function context(
  resolutions: Record<string, Resolution[]> = {},
  extra: Partial<ClassifyContext> = {},
): ClassifyContext {
  return {
    allowedHosts: allowedHostSet("intranet.example.org"),
    resolvers: new Set(["100.100.100.100"]),
    bindSubnets: [],
    inferenceProcesses: INFERENCE_PROCESSES,
    thirdPartyProcesses: THIRD_PARTY_PROCESSES,
    resolutionsFor: (ip) => resolutions[ip] ?? [],
    now: NOW,
    ...extra,
  };
}

function out(remoteIp: string, remotePort = 443, comm = "node") {
  return {
    proto: "tcp" as const,
    tcpState: 1,
    localListening: false,
    remoteIp,
    remotePort,
    comm,
  };
}

describe("classify, first match wins", () => {
  it("allows local networks before any hostname check", () => {
    expect(
      classify(out("192.168.1.20"), "evil.example.com", context()),
    ).toMatchObject({ state: "allowed", reason: "local network" });
    expect(classify(out("100.80.1.2"), null, context())).toMatchObject({
      state: "allowed",
    });
    expect(classify(out("::ffff:10.0.0.5"), null, context())).toMatchObject({
      state: "allowed",
    });
  });

  it("allows extra bind subnets such as a WireGuard network", () => {
    const wg = context({}, { bindSubnets: [parseCidr("198.18.0.0/15")!] });
    expect(classify(out("198.18.4.4"), null, wg)).toMatchObject({
      state: "allowed",
    });
    expect(classify(out("198.18.4.4"), null, context())).toMatchObject({
      state: "red",
    });
  });

  it("allows the system resolver only on port 53", () => {
    const resolver = { ...out("8.8.8.8", 53), proto: "udp" as const };
    expect(
      classify(
        resolver,
        null,
        context({}, { resolvers: new Set(["8.8.8.8"]) }),
      ),
    ).toMatchObject({ state: "allowed", reason: "system resolver" });
    expect(
      classify(
        out("8.8.8.8", 443),
        null,
        context({}, { resolvers: new Set(["8.8.8.8"]) }),
      ),
    ).toMatchObject({ state: "red" });
  });

  it("decides on the socket's hostname when one is bound", () => {
    expect(
      classify(out("160.79.104.10"), "API.Anthropic.com.", context()),
    ).toMatchObject({ state: "allowed", reason: "listed host" });
    expect(
      classify(out("160.79.104.10"), "intranet.example.org", context()),
    ).toMatchObject({ state: "allowed" });
    expect(
      classify(out("104.18.1.1"), "telemetry.get-bb.com", context()),
    ).toMatchObject({ state: "red", reason: "unlisted host" });
  });

  it("infers a provider CLI socket only from fresh, unshared resolutions", () => {
    const fresh = {
      "2607:6bc0::10": [
        { name: "api.anthropic.com", ip: "2607:6bc0::10", at: NOW - 1_000 },
      ],
    };
    expect(
      classify(out("2607:6bc0::10", 443, "claude"), null, context(fresh)),
    ).toMatchObject({
      state: "inferred",
      reason: "resolves to api.anthropic.com",
    });
    expect(
      classify(out("2607:6bc0::10", 443, "node"), null, context(fresh)),
    ).toMatchObject({
      state: "red",
      reason: "listed address from a process that is not a provider CLI",
    });
  });

  it("infers a provider bridge socket like a provider CLI and keeps it sandy's own", () => {
    const fresh = {
      "2a06:98c1:3101::6812:202f": [
        {
          name: "chatgpt.com",
          ip: "2a06:98c1:3101::6812:202f",
          at: NOW - 1_000,
        },
      ],
    };
    expect(
      classify(
        out("2a06:98c1:3101::6812:202f", 443, "sandy-provider-bridge"),
        null,
        context(fresh),
      ),
    ).toMatchObject({ state: "inferred", reason: "resolves to chatgpt.com" });
    expect(
      classify(
        out("2a00:1450:4001:c13::65", 443, "sandy-provider-bridge"),
        null,
        context(),
      ),
    ).toMatchObject({ state: "red", reason: "unknown address" });
  });

  it("names the unlisted host a red address resolves to", () => {
    const seen = {
      "2606:4700:20::681a:384": [
        { name: "example.test", ip: "2606:4700:20::681a:384", at: NOW - 1_000 },
      ],
    };
    expect(
      classify(
        out("2606:4700:20::681a:384", 443, "MainThread"),
        null,
        context(seen),
      ),
    ).toMatchObject({
      state: "red",
      reason: "resolves to unlisted example.test",
    });
  });

  it("turns shared and stale resolutions yellow", () => {
    const shared = {
      "104.18.2.2": [
        { name: "chatgpt.com", ip: "104.18.2.2", at: NOW },
        { name: "tracker.example.net", ip: "104.18.2.2", at: NOW },
      ],
    };
    expect(
      classify(
        out("104.18.2.2", 443, "node-MainThread"),
        null,
        context(shared),
      ),
    ).toMatchObject({
      state: "yellow",
      reason: "shared by listed and unlisted names",
    });
    expect(
      classify(out("104.18.2.2", 443, "codex"), null, context(shared)),
    ).toMatchObject({
      state: "third-party",
      reason: "codex is not sandy: shared by listed and unlisted names",
    });
    const stale = {
      "1.2.3.4": [
        {
          name: "api.openai.com",
          ip: "1.2.3.4",
          at: NOW - RESOLUTION_MAX_AGE_MS - 1,
        },
      ],
    };
    expect(
      classify(out("1.2.3.4", 443, "node-MainThread"), null, context(stale)),
    ).toMatchObject({ state: "yellow", reason: "stale resolution" });
  });

  it("marks everything else red", () => {
    expect(
      classify(out("203.0.113.9", 443, "node-MainThread"), null, context()),
    ).toMatchObject({ state: "red", reason: "unknown address" });
    expect(
      classify(out("203.0.113.9", 443, "curl"), null, context()),
    ).toMatchObject({ state: "red", reason: "unknown address" });
  });

  it("reports half-open server sockets as undetermined, never allowed", () => {
    expect(
      classify({ ...out("203.0.113.9"), tcpState: 3 }, null, context()),
    ).toMatchObject({ direction: "undetermined", state: "undetermined" });
  });

  it("allows incoming peers only from loopback, the tailnet and bind interfaces", () => {
    const incoming = (ip: string) => ({
      ...out(ip, 51000),
      localListening: true,
    });
    expect(classify(incoming("127.0.0.1"), null, context())).toMatchObject({
      direction: "in",
      state: "unverifiable",
    });
    expect(classify(incoming("100.70.1.1"), null, context())).toMatchObject({
      direction: "in",
      state: "allowed",
      reason: "tailnet peer",
    });
    expect(
      classify(incoming("fd7a:115c:a1e0::9"), null, context()),
    ).toMatchObject({ direction: "in", state: "allowed" });
    expect(
      classify(
        incoming("198.18.7.20"),
        null,
        context({}, { bindSubnets: [parseCidr("198.18.7.0/24")!] }),
      ),
    ).toMatchObject({ state: "allowed", reason: "bind interface peer" });
    for (const ip of ["198.51.100.7", "192.168.1.20", "10.0.0.5", "fe80::1"]) {
      expect(classify(incoming(ip), null, context())).toMatchObject({
        direction: "in",
        state: "red",
        reason: "external peer",
      });
    }
  });
});

describe("allowlist settings", () => {
  it("accepts exact host names only", () => {
    expect(parseExtraHosts(" A.example.org\n\nb.example.org, ")).toEqual([
      "a.example.org",
      "b.example.org",
    ]);
    expect(validateExtraHosts("a.example.org\nb.example.org")).toBeNull();
    expect(validateExtraHosts("*.example.org")).toMatch(/exact host/);
    expect(validateExtraHosts("https://example.org")).toMatch(/exact host/);
  });

  it("reads nameservers from resolv.conf", () => {
    expect(
      parseResolvConf(
        "# x\nnameserver 100.100.100.100\nsearch tail.ts.net\nnameserver fd7a::53\n",
      ),
    ).toEqual(["100.100.100.100", "fd7a::53"]);
  });
});

describe("third-party programs sandy launches", () => {
  it("marks a browser or agent CLI socket to an unknown address third-party, not red", () => {
    for (const comm of ["chromium", "opencode", "hermes", "claude"])
      expect(
        classify(out("2a00:1450:4001:c13::65", 443, comm), null, context()),
      ).toMatchObject({
        state: "third-party",
        reason: `${comm} is not sandy: unknown address`,
      });
  });

  it("keeps sandy's own node processes red for the same address", () => {
    expect(
      classify(
        out("2a00:1450:4001:c13::65", 443, "node-MainThread"),
        null,
        context(),
      ),
    ).toMatchObject({ state: "red", reason: "unknown address" });
  });

  it("still shows a provider CLI socket to a listed host as inferred", () => {
    const resolutions = {
      "160.79.104.10": [
        { name: "api.anthropic.com", ip: "160.79.104.10", at: NOW },
      ],
    };
    expect(
      classify(out("160.79.104.10", 443, "claude"), null, context(resolutions)),
    ).toMatchObject({ state: "inferred" });
  });

  it("judges incoming connections to a third-party program like any other", () => {
    expect(
      classify(
        { ...out("203.0.113.9", 51000, "chromium"), localListening: true },
        null,
        context(),
      ),
    ).toMatchObject({ state: "red", reason: "external peer" });
  });
});
