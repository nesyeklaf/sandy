import type { ThreadEvent } from "@sandy-sdk/plugin-sdk/provider-bridge/testing";

export function threadScope(): ThreadEvent["scope"] {
  return { kind: "thread" };
}

export function turnScope(turnId: string): ThreadEvent["scope"] {
  return { kind: "turn", turnId };
}
