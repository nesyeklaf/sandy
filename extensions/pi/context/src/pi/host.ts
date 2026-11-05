/**
 * What the extension needs from the pi it runs in. The host is judged by capabilities it shows, not by a version
 * string, so a pi that offers them works whatever it is called. Everything listed exists in pi 1.3.0, the oldest
 * pi this extension supports.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REQUIRED_CAPABILITIES = {
	hooks: "event hooks (pi.on)",
	tools: "tool registration (pi.registerTool)",
	commands: "slash commands (pi.registerCommand)",
	sessionEntries: "custom session entries (pi.appendEntry)",
	messages: "custom messages (pi.sendMessage)",
	eventBus: "the extension event bus (pi.events)",
	agentDir: "the agent directory (getAgentDir)",
	sessionProjection: "the session projection (buildSessionProjection)",
} as const;

export type CapabilityName = keyof typeof REQUIRED_CAPABILITIES;

/** For each required capability, whether this host has it. */
export type HostCapabilities = Readonly<Record<CapabilityName, boolean>>;

export interface SupportedHost {
	readonly supported: true;
}

export interface UnsupportedHost {
	readonly supported: false;
	readonly missing: readonly CapabilityName[];
	readonly message: string;
}

/** The parts of pi's package the check reads; the module namespace of @earendil-works/pi-coding-agent fits. */
export interface HostModule {
	readonly getAgentDir?: unknown;
	readonly buildSessionProjection?: unknown;
}

/** Look at the pi object an extension is given and at pi's package, and record what they offer. */
export function detectCapabilities(pi: ExtensionAPI, host: HostModule): HostCapabilities {
	const api = pi as unknown as Record<string, unknown>;
	const events = api.events as { on?: unknown; emit?: unknown } | undefined;
	return {
		hooks: typeof api.on === "function",
		tools: typeof api.registerTool === "function",
		commands: typeof api.registerCommand === "function",
		sessionEntries: typeof api.appendEntry === "function",
		messages: typeof api.sendMessage === "function",
		eventBus: typeof events?.on === "function" && typeof events.emit === "function",
		agentDir: typeof host.getAgentDir === "function",
		sessionProjection: typeof host.buildSessionProjection === "function",
	};
}

export function checkHost(capabilities: HostCapabilities): SupportedHost | UnsupportedHost {
	const missing = (Object.keys(REQUIRED_CAPABILITIES) as CapabilityName[]).filter((name) => !capabilities[name]);
	if (missing.length === 0) return { supported: true };
	const names = missing.map((name) => REQUIRED_CAPABILITIES[name]).join(", ");
	return {
		supported: false,
		missing,
		message: `pi-context needs pi 1.3.0 or newer; this pi lacks: ${names}. Update pi, or remove this extension.`,
	};
}

/**
 * A view of pi whose hooks, tools and commands do nothing until ready() says so. The extension registers everything
 * at load, in the order pi's other extensions see, but must not act before its startup checks passed.
 */
export function gatedApi(pi: ExtensionAPI, ready: () => boolean, inactive: () => string): ExtensionAPI {
	return new Proxy(pi, {
		get(target, key) {
			if (key === "on") {
				return (event: string, handler: (...args: unknown[]) => unknown) =>
					(target.on as (event: string, handler: unknown) => unknown)(event, (...args: unknown[]) =>
						ready() ? handler(...args) : undefined,
					);
			}
			if (key === "registerTool") {
				return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) =>
					target.registerTool({
						...definition,
						execute: (...args: Parameters<typeof definition.execute>) => {
							if (!ready()) throw new Error(inactive());
							return definition.execute(...args);
						},
					});
			}
			if (key === "registerCommand") {
				return (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
					target.registerCommand(name, {
						...command,
						handler: async (...args: Parameters<typeof command.handler>) => {
							if (!ready()) throw new Error(inactive());
							return command.handler(...args);
						},
					});
			}
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
