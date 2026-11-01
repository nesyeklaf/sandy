// Loaded by pi's own extension loader (jiti), so imports resolve exactly as in a real pi session.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ContextExtensionOptions, createContextExtension } from "../../src/pi/extension.ts";
import { capturedTools, type ToolDefinition } from "../support/captured.ts";

const options = (globalThis as { __sandyContextTest?: ContextExtensionOptions }).__sandyContextTest ?? {};
const extension = createContextExtension(options);

/** The extension as pi loads it, with its tool definitions captured for nested calls. */
export default function (pi: ExtensionAPI): void {
	const capturing = new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") {
				return (definition: ToolDefinition) => {
					capturedTools().set(definition.name, definition);
					target.registerTool(definition);
				};
			}
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	extension(capturing);
}
