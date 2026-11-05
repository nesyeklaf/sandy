import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A pi object that records everything an extension registers on it, in order. */
export interface FakePi {
	readonly api: ExtensionAPI;
	/** One entry per registration: `on:<event>`, `tool:<name>`, `command:<name>`, `events.on:<channel>`. */
	readonly registered: string[];
	readonly handlers: { readonly event: string; readonly handler: Handler }[];
	readonly tools: Map<string, { execute: (...args: unknown[]) => unknown }>;
}

/** The full API surface the extension needs, minus the members named in `without`. */
export function fakePi(without: readonly string[] = []): FakePi {
	const registered: string[] = [];
	const handlers: FakePi["handlers"] = [];
	const tools: FakePi["tools"] = new Map();
	const surface: Record<string, unknown> = {
		on: (event: string, handler: Handler) => {
			registered.push(`on:${event}`);
			handlers.push({ event, handler });
		},
		registerTool: (definition: { name: string; execute: (...args: unknown[]) => unknown }) => {
			registered.push(`tool:${definition.name}`);
			tools.set(definition.name, definition);
		},
		registerCommand: (name: string) => {
			registered.push(`command:${name}`);
		},
		appendEntry: () => {},
		sendMessage: () => {},
		events: {
			on: (channel: string) => {
				registered.push(`events.on:${channel}`);
			},
			emit: () => {},
		},
	};
	for (const name of without) delete surface[name];
	return { api: surface as unknown as ExtensionAPI, registered, handlers, tools };
}
