import { cliCommand, defineCli, type SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { mcpAccessProblem } from "./access.js";
import { createCliRunner } from "./cli-runner.js";
import { createCommandIndexLoader } from "./command-index.js";
import { createSandyMcpHttpHandler } from "./mcp-handler.js";

const MCP_SERVER_VERSION = "0.1.0";
const MCP_ROUTE_PATH = "/mcp";

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

function localMcpUrl(sandy: SandyPluginApi): string {
  return `${sandy.server.loopbackBaseUrl}/api/v1/plugins/${sandy.pluginId}/http${MCP_ROUTE_PATH}`;
}

export default async function mcpPlugin(sandy: SandyPluginApi): Promise<void> {
  const runCli = createCliRunner({
    env: process.env,
    serverUrl: () => sandy.server.loopbackBaseUrl,
  });
  const handler = createSandyMcpHttpHandler(
    { runCli, loadCommandIndex: createCommandIndexLoader(runCli) },
    MCP_SERVER_VERSION,
    (error) => sandy.log.warn(`MCP request failed: ${error.message}`),
  );
  sandy.onDispose(() => handler.close());

  for (const method of ["POST", "GET", "DELETE"]) {
    sandy.http.route(
      method,
      MCP_ROUTE_PATH,
      async (context) => {
        const problem = mcpAccessProblem(context.req.raw.headers);
        if (problem !== null) {
          return Response.json(
            { error: "forbidden", message: problem.message },
            { status: problem.status },
          );
        }
        return handler.fetch(context.req.raw);
      },
      { auth: "none" },
    );
  }

  sandy.cli.register(
    defineCli({
      name: "mcp",
      summary:
        "Let MCP clients on this machine or your tailnet control this sandy",
      description:
        "While this plugin is enabled, sandy serves a Model Context Protocol endpoint next to its API. Apps on this machine use the loopback address; devices on your tailnet or WireGuard network reach the same path on an address listed in SANDY_SERVER_BIND_HOST.",
      commands: {
        status: cliCommand({
          summary: "Show the MCP address for this sandy",
          options: { json: JSON_OPTION },
          async run(input) {
            const localUrl = localMcpUrl(sandy);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ localUrl })
                : `Local: ${localUrl}`,
            };
          },
        }),
      },
    }),
  );
}
