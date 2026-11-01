#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { maybeReexecViaSandyCli } from "./sandy-cli-reexec.js";
import {
  CORE_COMMAND_GROUPS,
  type CommandGroupDeps,
  pluginProxyCandidate,
  selectCommandGroups,
} from "./command-groups.js";
import { resolveSandyCliVersion } from "./version.js";
import type { CliRuntimeContext } from "./context-env.js";

if (process.env.FORCE_COLOR !== undefined) {
  delete process.env.NO_COLOR;
}

maybeReexecViaSandyCli();

const program = new Command();

program
  .name("sandy")
  .description("SANDY CLI - manage your AI coding agents")
  .enablePositionalOptions()
  .exitOverride()
  .showSuggestionAfterError(false)
  .version(resolveSandyCliVersion());

const KNOWN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  ...CORE_COMMAND_GROUPS.map((group) => group.name),
  "help",
]);

type ContextEnvModule = typeof import("./context-env.js");

function createCommandGroupDeps(
  contextEnv: ContextEnvModule,
): CommandGroupDeps {
  let cliRuntimeContext: CliRuntimeContext | undefined;
  const getCliRuntimeContext = (): CliRuntimeContext =>
    (cliRuntimeContext ??= contextEnv.createCliRuntimeContext());
  return {
    getUrl: () => contextEnv.resolveServerUrl(getCliRuntimeContext()),
    getContext: () => contextEnv.resolveContextSnapshot(getCliRuntimeContext()),
  };
}

// How long a finished plugin command may wait for open handles before it exits anyway.
const PLUGIN_COMMAND_EXIT_FALLBACK_MS = 2_000;

// Ends a plugin command without calling process.exit right away. On Windows, Node 24, process.exit right after the
// undici request of a plugin command aborts in libuv ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
// file src\win\async.c", exit 0xC0000409, nodejs/node#56645) after the answer is printed. The process ends when
// its event loop drains; the unref'd timer fires only if a handle still holds the loop open.
function finishPluginCommand(exitCode: number): true {
  process.exitCode = exitCode;
  setTimeout(
    () => process.exit(exitCode),
    PLUGIN_COMMAND_EXIT_FALLBACK_MS,
  ).unref();
  return true;
}

// Runs `candidate` as a plugin command. Returns true when it handled the invocation (the exit code is set and the
// process must end without running anything else), false when commander should parse it.
async function tryPluginCommandProxy(
  candidate: string,
  getUrl: () => string,
  isSoftAlias: boolean,
): Promise<boolean> {
  const proxy = await import("./plugin-cli-proxy.js");
  const result = await proxy.fetchPluginCliContributions(getUrl());
  if (result.outcome === "unreachable") {
    if (isSoftAlias) return false;
    const message = proxy.describeUnreachableServer(
      getUrl(),
      result.cause,
      result.lastTimeoutMs,
      result.attempts,
    );
    console.error(message);
    const { isJsonInvocation, writeCliErrorEnvelope } =
      await import("./cli-error-output.js");
    writeCliErrorEnvelope(
      { code: "server_unreachable", hint: null, message },
      isJsonInvocation(process.argv),
    );
    return finishPluginCommand(1);
  }
  if (result.outcome === "invalid") return false;
  const match = proxy.findPluginCliCommand(result.contributions, candidate);
  if (match === undefined) {
    const disabledId = await proxy.findDisabledPluginForCommand(
      getUrl(),
      candidate,
    );
    if (disabledId !== null) {
      console.error(
        `sandy ${candidate} is provided by the "${disabledId}" plugin, which is disabled — ` +
          `run \`sandy plugin enable ${disabledId}\` or enable it in Plugins.`,
      );
      return finishPluginCommand(1);
    }
    return false;
  }
  const argv = process.argv.slice(3);
  const command = match.commands.find((entry) => entry.name === argv[0]);
  if (
    command !== undefined &&
    match.rendersHelp !== true &&
    argv.slice(1).some((arg) => arg === "--help" || arg === "-h")
  ) {
    console.log(command.usage);
    return finishPluginCommand(0);
  }
  const exitCode = await proxy.runPluginCliCommand(
    getUrl(),
    match.pluginId,
    argv,
  );
  if (exitCode !== 0) {
    await logCliError({
      code: "plugin_command_failed",
      command: proxy.pluginCommandLabel(match, argv),
      exitCode,
      token: null,
    });
  }
  return finishPluginCommand(exitCode);
}

async function logCliError(args: {
  code: string;
  command: string | null;
  exitCode: number;
  token: string | null;
}): Promise<void> {
  const [{ appendCliErrorLogEntry }, { commandPathLabel }] = await Promise.all([
    import("./cli-error-log.js"),
    import("./commander-errors.js"),
  ]);
  appendCliErrorLogEntry({
    at: new Date().toISOString(),
    cliVersion: resolveSandyCliVersion(),
    code: args.code,
    command: args.command ?? commandPathLabel(program, process.argv),
    exitCode: args.exitCode,
    threadId: process.env.SANDY_THREAD_ID ?? null,
    token: args.token,
  });
}

async function exitForCommanderError(
  error: CommanderError,
  getUrl: (() => string) | null,
): Promise<never> {
  if (error.exitCode === 0) process.exit(0);
  const [errors, hints] = await Promise.all([
    import("./commander-errors.js"),
    import("./context-hints.js"),
  ]);
  const summary = await errors.summarizeCommanderError({
    argv: process.argv,
    error,
    program,
    resolveHostId:
      getUrl === null
        ? async () => null
        : hints.createContextHostIdResolver(getUrl),
  });
  errors.writeCommanderErrorSummary(summary, process.argv);
  await logCliError({
    code: summary.code,
    command: null,
    exitCode: error.exitCode,
    token: summary.logToken,
  });
  process.exit(error.exitCode);
}

async function parseProgram(getUrl: (() => string) | null): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      await exitForCommanderError(error, getUrl);
    }
    throw error;
  }
}

async function rejectHelpForUnknownSubcommand(
  getUrl: () => string,
): Promise<void> {
  const resolution = await import("./command-resolution.js");
  if (!resolution.hasHelpFlag(process.argv)) return;
  const invocation = resolution.resolveInvocation(program, process.argv);
  if (invocation.unknownSubcommand === null) return;
  const message = `error: unknown command '${invocation.unknownSubcommand}'`;
  console.error(message);
  await exitForCommanderError(
    new CommanderError(1, "commander.unknownCommand", message),
    getUrl,
  );
}

async function addJsonShapeHelp(): Promise<void> {
  const [{ JSON_SHAPE_BY_COMMAND_PATH, jsonShapeHelp }, resolution] =
    await Promise.all([
      import("./json-shapes.js"),
      import("./command-resolution.js"),
    ]);
  for (const commandPath of Object.keys(JSON_SHAPE_BY_COMMAND_PATH)) {
    const invocation = resolution.resolveInvocation(program, [
      "node",
      "sandy",
      ...commandPath.split(" "),
    ]);
    const help = jsonShapeHelp(commandPath);
    if (help === null || invocation.path.join(" ") !== commandPath) continue;
    invocation.command.addHelpText("after", help);
  }
}

async function main(): Promise<void> {
  const firstArg = process.argv[2];
  const groups = selectCommandGroups(firstArg);
  if (groups.length === 0) {
    await parseProgram(null);
    return;
  }

  const [contextEnv, ...registrars] = await Promise.all([
    import("./context-env.js"),
    ...groups.map((group) => group.load()),
  ]);
  const deps = createCommandGroupDeps(contextEnv);

  program.addHelpText("after", () => {
    const context = deps.getContext();
    const project = context.projectId ?? "<unset>";
    const thread = context.threadId ?? "<unset>";

    return `

Current context:
  SANDY_PROJECT_ID: ${project}
  SANDY_THREAD_ID: ${thread}
  SANDY_SERVER_URL: ${context.serverUrl}

Quick start:
  sandy status
  sandy project list
  sandy thread show <id>
  sandy thread spawn --project <id> --provider codex --prompt "..."
`;
  });

  for (const register of registrars) {
    register(program, deps);
  }
  await addJsonShapeHelp();

  const candidate = pluginProxyCandidate(firstArg, KNOWN_COMMAND_NAMES);
  if (candidate !== null) {
    const { TOP_LEVEL_SOFT_ALIASES } = await import("./command-resolution.js");
    const aliasTarget = TOP_LEVEL_SOFT_ALIASES[candidate];
    const handled = await tryPluginCommandProxy(
      candidate,
      deps.getUrl,
      aliasTarget !== undefined,
    );
    if (handled) return;
    if (aliasTarget !== undefined) process.argv[2] = aliasTarget;
  }
  await rejectHelpForUnknownSubcommand(deps.getUrl);
  await parseProgram(deps.getUrl);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
