import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@sandy-sdk/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "./server.js";

describe("workflows CLI argument validation", () => {
  let harness: ReturnType<typeof createFakePluginHost>["harness"];

  beforeEach(async () => {
    const host = createFakePluginHost({
      pluginId: "workflows",
      agentSkillIds: ["workflows-plus"],
    });
    harness = host.harness;
    await plugin(host.sandy);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it.each([
    {
      argv: ["run", "--script", "source", "extra"],
      error: "unexpected argument 'extra'",
    },
    {
      argv: ["validate"],
      error: "missing required options: one of --script, --file, --name",
    },
    {
      argv: ["validate", "--script", "one", "--file", "two"],
      error: "--script and --file cannot be combined",
    },
    {
      argv: ["status", "run-1", "run-2"],
      error: "unexpected argument 'run-2'",
    },
    {
      argv: ["status", "run-1", "--limit", "2"],
      error: "unknown option '--limit'",
    },
    {
      argv: ["history", "run-1", "--cursor", "-1"],
      error:
        "invalid value '-1' for --cursor. Expected an integer between 0 and 9007199254740991",
    },
    {
      argv: ["history", "run-1", "--limit", "101"],
      error:
        "invalid value '101' for --limit. Expected an integer between 1 and 100",
    },
    {
      argv: ["history", "run-1", "--limit", "1e2"],
      error:
        "invalid value '1e2' for --limit. Expected an integer between 1 and 100",
    },
    {
      argv: ["list", "--limit", "51"],
      error:
        "invalid value '51' for --limit. Expected an integer between 1 and 50",
    },
    {
      argv: ["list", "extra"],
      error: "unexpected argument 'extra'",
    },
    {
      argv: ["stop"],
      error: "missing required arguments: <run-id>",
    },
  ])("rejects malformed invocation $argv", async ({ argv, error }) => {
    const result = await harness.runCli(argv);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.split("\n")[0]).toContain(error);
    expect(result.stdout).toBe("");
  });

  it("reports a failure as a JSON envelope when the invocation carries --json", async () => {
    const result = await harness.runCli(["status", "run-1", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        code: "command_failed",
        message: "This command must run inside a SANDY project thread",
      },
    });
    expect(result.stderr).toBe(
      "This command must run inside a SANDY project thread\n",
    );
  });

  it.each([["--help"], ["help"], ["history", "--help"]])(
    "documents %s without running a command",
    async (...argv) => {
      const result = await harness.runCli(argv);

      expect(result.exitCode).toBe(0);
      // The part alone renders its own name; sandy/work's dispatch adds "work" (server.test.ts).
      expect(result.stdout).toContain("sandy workflows-plus history");
      expect(result.stderr).toBe("");
    },
  );

  it("keeps one author tool and the shared Claude workflow language", async () => {
    expect(harness.registrations.agentTools.map((tool) => tool.name)).toEqual([
      "sandy_workflow_plus_run",
      "sandy_workflow_plus_result",
    ]);
    expect(
      harness.registrations.cli?.commands.map((command) => command.name),
    ).toEqual(["run", "validate", "status", "history", "list", "result", "stop"]);
    const run = harness.registrations.agentTools.find(
      (tool) => tool.name === "sandy_workflow_plus_run",
    );
    expect(run?.description).toBe(
      "Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a run ID and a `previewDirective`. After a successful call, emit that directive exactly once on its own line (not in a code fence) so SANDY renders live progress in chat. A completion notification is sent to the origin thread. Use `sandy work workflows-plus status <run-id>` for a compact summary. For detailed history, redirect a bounded JSONL page from `sandy work workflows-plus history <run-id> --cursor <call-index> --limit <1-100>` into `$SANDY_THREAD_STORAGE`, then inspect the file with normal filesystem tools.",
    );
    expect(run?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        script: {
          description:
            "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
        },
        args: {
          description:
            "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
        },
      },
    });

    const result = harness.registrations.agentTools.find(
      (tool) => tool.name === "sandy_workflow_plus_result",
    );
    expect(result?.description).toBe(
      'Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response with {"value": ...} to provide the structured output.',
    );

    const author = await harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );
    expect(author.tools.map((tool) => tool.name)).toEqual(["sandy_workflow_plus_run"]);
    expect(author.skills).toEqual(["workflows-plus"]);
  });
});

describe("workflows agent-tool boundary schemas", () => {
  it.each([
    ["sandy_workflow_plus_run", { script: "return null", extra: true }],
    ["sandy_workflow_plus_result", { value: null, extra: true }],
  ])("rejects extra fields for %s", async (tool, input) => {
    const { sandy, harness } = createFakePluginHost({
      pluginId: "workflows",
      agentSkillIds: ["workflows-plus"],
    });
    await plugin(sandy);
    await expect(harness.callAgentTool(tool, input)).rejects.toThrow(
      `tool "${tool}" arguments are invalid`,
    );
    await harness.dispose();
  });
});
