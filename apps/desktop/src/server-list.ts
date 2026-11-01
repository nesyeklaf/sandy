import { createHash } from "node:crypto";
import type { SandyDesktopServerChoice } from "@sandy/desktop-contract";
import {
  BUILTIN_SERVER_NAME,
  type ServerTargetStore,
} from "./server-target.js";

export function customServerId(url: string): string {
  return `custom:${createHash("sha256").update(url).digest("hex")}`;
}

export function buildDesktopServerChoices(
  store: ServerTargetStore | null,
  builtinServerUrl: string,
): SandyDesktopServerChoice[] {
  const target = store?.getTarget() ?? { kind: "builtin" };
  const customUrls = store?.getCustomServerUrls() ?? [];
  const showBuiltin =
    (store?.getShowBuiltinServer() ?? true) ||
    target.kind === "builtin" ||
    customUrls.length === 0;
  return [
    ...(showBuiltin
      ? [
          {
            id: "builtin",
            name: BUILTIN_SERVER_NAME,
            origin: new URL(builtinServerUrl).origin,
            kind: "local" as const,
            active: target.kind === "builtin",
          },
        ]
      : []),
    ...(store?.getCustomServers() ?? []).map(({ url, name }) => ({
      id: customServerId(url),
      name: name ?? new URL(url).host,
      origin: new URL(url).origin,
      kind: "custom" as const,
      active: target.kind === "custom" && target.url === url,
    })),
  ];
}
