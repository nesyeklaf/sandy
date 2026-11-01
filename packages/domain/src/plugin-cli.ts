export const RESERVED_SANDY_CLI_COMMANDS: readonly string[] = [
  "browser",
  "diagnostics",
  "environment",
  "file",
  "guide",
  "help",
  "machine",
  "marketplace",
  "plugin",
  "project",
  "prompt-history",
  "provider",
  "server",
  "settings",
  "skill",
  "status",
  "terminal",
  "theme",
  "thread",
  "voice",
];

export function pluginCliCall(pluginId: string, name: string): string {
  if (RESERVED_SANDY_CLI_COMMANDS.includes(name))
    return `sandy plugin run ${pluginId}`;
  return `sandy ${name}`;
}
