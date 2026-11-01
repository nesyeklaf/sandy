export interface McpAccessProblem {
  status: 403;
  message: string;
}

export function mcpAccessProblem(headers: Headers): McpAccessProblem | null {
  return headers.get("origin") === null
    ? null
    : {
        status: 403,
        message: "The sandy MCP endpoint does not accept requests from web pages.",
      };
}
