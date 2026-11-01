/** Match SANDY's own runtime, never all descendants of a SANDY process. */
export function isSandyInternalListener(processName: string, command = ""): boolean {
  // SANDY host/provider workers can run under node or the desktop executable.
  if (/[/\\]sandy-app[/\\](?:host-daemon|server)[/\\]dist[/\\]/.test(command)) return true;
  if (/[/\\]sandy-(?:provider-bridge|plugin-host)-worker\.mjs(?:\s|$)/.test(command)) return true;

  const sandyName = /^sandy(?: nightly| beta| helper(?: \([^)]+\))?)?$/i.test(processName);
  if (!sandyName) return false;
  if (!command) return true;
  // A SANDY executable running a workspace script is still a user server.
  const executable = command.match(/^.*?[/\\]Contents[/\\]MacOS[/\\]sandy(?: Nightly| Beta)?(?=\s|$)/i)?.[0];
  const args = executable ? command.slice(executable.length).trim() : command.replace(/^\S+\s*/, "").trim();
  return !args || args.startsWith("--type=");
}

export function parseProcessCommands(output: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match) commands.set(Number(match[1]), match[2]);
  }
  return commands;
}
