import { normalizeHost } from "./classify.js";

export const BUILTIN_ALLOWED_HOSTS = [
  "api.anthropic.com",
  "console.anthropic.com",
  "claude.ai",
  "platform.claude.com",
  "statsig.anthropic.com",
  "mcp-proxy.anthropic.com",
  "http-intake.logs.us5.datadoghq.com",
  "api.openai.com",
  "auth.openai.com",
  "chatgpt.com",
  "ab.chatgpt.com",
  "registry.npmjs.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
] as const;

export const PROVIDER_BRIDGE_PROCESS = "sandy-provider-bridge";

const PROVIDER_CLI_PROCESSES = [
  "claude",
  "codex",
  "pi",
  "git",
  "git-remote-http",
  "git-remote-https",
  "gh",
  "ssh",
];

export const INFERENCE_PROCESSES = new Set([
  ...PROVIDER_CLI_PROCESSES,
  PROVIDER_BRIDGE_PROCESS,
]);

export const THIRD_PARTY_PROCESSES = new Set([
  ...PROVIDER_CLI_PROCESSES,
  "opencode",
  "hermes",
  "gemini",
  "chromium",
  "chrome",
  "headless_shell",
]);

export function parseExtraHosts(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map(normalizeHost)
    .filter((host) => host.length > 0);
}

export function validateExtraHosts(value: string): string | null {
  for (const host of parseExtraHosts(value))
    if (
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
        host,
      )
    )
      return `Not an exact host name: ${host}`;
  return null;
}

export function allowedHostSet(extra: string): Set<string> {
  return new Set([...BUILTIN_ALLOWED_HOSTS, ...parseExtraHosts(extra)]);
}

export function parseResolvConf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}
