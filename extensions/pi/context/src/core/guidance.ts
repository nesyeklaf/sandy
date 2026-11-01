/**
 * What the agent is told about context management. The guidance is constant, so it joins the
 * cached system prompt once; the reminder is appended at most once per cut.
 */
import { TOOLS } from "./tools.ts";

/** Name of the system prompt section; pi wraps it in a tag of the same name. */
export const GUIDANCE_SECTION = "sandy-context";

export const CONTEXT_GUIDANCE = [
	"This session can run indefinitely. At planned points older history is cut out of your context; nothing is deleted, and the complete log stays searchable.",
	`- ${TOOLS.notebook.name}: your working state across cuts, carried verbatim into your context after each one. Keep in it what you must not lose: the goal, constraints and preferences the user stated, decisions and why, the plan and where you are in it. Update it when one of these changes, not only when reminded. A write replaces the whole notebook, so write the complete current state, and keep it short.`,
	`- ${TOOLS.historySearch.name} and ${TOOLS.historyRead.name}: after a cut, search the log before you guess or ask the user again. Exact identifiers, paths and error text find the most.`,
].join("\n");

/**
 * Append a section to a prompt that another extension forced as opaque text, rendered the
 * way pi renders named sections. Idempotent, so a repeated run keeps the prefix stable.
 */
export function withSection(prompt: string, name: string, text: string): string {
	const section = `<${name}>\n${text}\n</${name}>`;
	return prompt.includes(section) ? prompt : `${prompt}\n\n${section}`;
}

/**
 * The guidance for the system prompt, or undefined when the notebook tool is not selected.
 * Codemode's `only` mode can hide tool declarations and their prompt snippets, so the
 * guidance then says how to reach the tools.
 */
export function guidanceFor(selectedTools: readonly string[], hiddenTools: readonly string[]): string | undefined {
	if (!selectedTools.includes(TOOLS.notebook.name)) return undefined;
	if (!hiddenTools.includes(TOOLS.notebook.name)) return CONTEXT_GUIDANCE;
	const access = selectedTools.includes("codemode")
		? `Call them inside a codemode script as \`tools.${TOOLS.notebook.name}({ text })\`, \`tools.${TOOLS.historySearch.name}({ query })\` and \`tools.${TOOLS.historyRead.name}({ id })\`.`
		: "Call them through the tool that runs other tools.";
	return `${CONTEXT_GUIDANCE}\nThese tools are not declared to you directly. ${access}`;
}

/**
 * Appended near the watermark when the notebook was not written since the last cut.
 * `tokensLeft` is the distance to the next planned cut.
 */
export function notebookReminder(tokensLeft: number, empty: boolean): string {
	const left = Math.max(0, Math.round(tokensLeft / 1_000));
	const state = empty ? "Your notebook is empty." : "You have not updated your notebook since the last cut.";
	return `[sandy-context] A context cut is coming in about ${left}k tokens. ${state} Update it now with the complete current state (goal, user constraints, decisions, plan and where you are), then continue with your task. Do not mention this reminder to the user.`;
}
