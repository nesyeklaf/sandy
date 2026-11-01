import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Headless mode (fork addition). Some hosts report `ctx.hasUI` but cannot
 * answer dialogs raised by slash commands: SANDY's pi bridge forwards
 * confirm/select/input requests that never reach the user, so the command
 * waits until the turn stalls. PI_GOAL_HEADLESS=1 makes pi-goal-x take the
 * same paths it takes without a UI. Status lines and widgets still render.
 *
 * Read at call time, so a host extension can set the variable after load.
 */
export function isHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_GOAL_HEADLESS === "1";
}

/** True when dialogs (confirm, select, input, custom) can reach the user. */
export function interactive(ctx: Pick<ExtensionContext, "hasUI">, env: NodeJS.ProcessEnv = process.env): boolean {
	return ctx.hasUI && !isHeadless(env);
}

/** Arguments of /goal-clear and /goal-focus: an optional goal id and --yes. */
export function parseGoalTargetArgs(raw: string | undefined): { id?: string; yes: boolean } {
	const parts = (raw ?? "").trim().split(/\s+/).filter(Boolean);
	const yes = parts.some((part) => part === "--yes" || part === "-y");
	const id = parts.find((part) => !part.startsWith("-"));
	return id ? { id, yes } : { yes };
}
