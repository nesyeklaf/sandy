import { promptEntries } from "./historian.ts";
/** The faux model's side of the pi scenario: probe output and the historian's and condenser's answers. */

export function probeText(label: string): string {
	const filler = Array.from({ length: 90 }, (_, i) => `line ${i} of probe output with ordinary words`).join("\n");
	return `FACT fact-${label} = value-${label}\n${filler}`;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("\n");
}

export function historianAnswer(prompt: string): string {
	const facts = promptEntries(prompt).flatMap((one) =>
		[...one.text.matchAll(/FACT (fact-[\w-]+) = (value-[\w-]+)/g)].map(([, fact, value]) => "- " + fact + " is " + value + " (#" + one.id + ")"),
	);
	const last = promptEntries(prompt).at(-1)?.id ?? "none";
	return [
		"## Topic",
		"- Probing modules one by one",
		"## Current state",
		"- Done: probed up to (#" + last + "). Next: probe the next module (#" + last + ")",
		"## Facts and findings",
		...facts,
	].join("\n");
}

/** Condense mechanically: one bullet per section that keeps the range of entry ids. */
export function condenserAnswer(prompt: string): string {
	return prompt
		.split(/\n(?=## )/)
		.flatMap((block) => {
			const heading = /^(?:<records>\n)?(## .+)/.exec(block)?.[1];
			const ids = [...block.matchAll(/#(\w+)\)/g)].map((match) => match[1]);
			return heading && ids.length > 0 ? [heading, `- ${ids.length} records (#${ids[0]} … #${ids.at(-1)})`] : [];
		})
		.join("\n");
}
