import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

/**
 * Tool definitions the extension under test registered, so a stand-in for codemode can call them
 * from inside its own call. Kept on globalThis because pi's loader (jiti) and the test
 * runner load this module as separate instances.
 */
export function capturedTools(): Map<string, ToolDefinition> {
	const shared = globalThis as { __sandyContextTools?: Map<string, ToolDefinition> };
	shared.__sandyContextTools ??= new Map();
	return shared.__sandyContextTools;
}
