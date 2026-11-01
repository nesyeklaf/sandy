/**
 * Building the naming prompt and turning an agent's answer into a title.
 *
 * Kept free of the plugin api so both halves can be tested without a sandy
 * server: everything here is a pure function over strings.
 */

/** Instruction sent with the conversation when the setting is left empty. */
export const DEFAULT_INSTRUCTION = [
  "Write a short title for the conversation below, the way a person would name",
  "a tab they want to find again later.",
  "",
  "Rules:",
  "- Name what the conversation is actually about: the task, the bug, the file",
  "  or the feature. Lead with the subject, not with a verb like 'Help with'.",
  "- Use the language the conversation is written in.",
  "- Sentence case. No trailing period, no quotes, no code fences, no emoji.",
  "- Never invent detail that is not in the conversation, and never answer it or",
  "  comment on it.",
  "- Do not read files, run commands or use any tool.",
].join("\n");

/** One conversation turn as the naming prompt sees it. */
export interface OutlineItem {
  role: "user" | "assistant";
  preview: string;
}

/** How many outline items are worth sending; a title comes from the opening. */
const MAX_OUTLINE_ITEMS = 8;

/** Per-item cap, so one long message cannot crowd the rest out. */
const MAX_ITEM_CHARS = 600;

/**
 * The prompt sent to the naming agent: the instruction, the length budget, and
 * the opening of the conversation.
 */
export function buildNamingPrompt(
  instruction: string,
  outline: readonly OutlineItem[],
  maxChars: number,
): string {
  const transcript = outline
    .slice(0, MAX_OUTLINE_ITEMS)
    .map((item) => {
      const preview = collapseWhitespace(item.preview).slice(0, MAX_ITEM_CHARS);
      return `${item.role === "user" ? "User" : "Assistant"}: ${preview}`;
    })
    .filter((line) => line.length > "Assistant: ".length)
    .join("\n\n");

  return [
    instruction,
    "",
    `The title must be at most ${maxChars} characters.`,
    "Reply with the title only: no preamble, no commentary, nothing else.",
    "",
    "--- CONVERSATION ---",
    transcript,
    "--- END OF CONVERSATION ---",
  ].join("\n");
}

/**
 * Agents like to dress an answer up. Strip the wrapping the instruction asks
 * them to leave out, then fit the result to the length budget.
 *
 * Returns an empty string when nothing usable came back, which the caller
 * reports rather than writing onto the thread.
 */
export function cleanTitle(output: string, maxChars: number): string {
  let text = collapseWhitespace(stripFences(output));

  // A chatty agent adds a line of preamble before the title; the title is the
  // last non-empty line in that case, and the only line otherwise.
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  text = lines.at(-1) ?? "";

  text = text
    .replace(/^(?:title|titre)\s*[:\-–]\s*/i, "")
    .replace(/^[-*•]\s+/, "")
    .trim();
  text = stripWrappingQuotes(text);
  text = text.replace(/[.\s]+$/, "").trim();

  return truncateTitle(text, maxChars);
}

/**
 * Cut a title to the budget, on the last word boundary when that still keeps
 * most of the budget, mid-word otherwise (a single long word is better than
 * two characters of it).
 */
export function truncateTitle(title: string, maxChars: number): string {
  if (title.length <= maxChars) return title;
  const cut = title.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const kept = lastSpace >= maxChars * 0.5 ? cut.slice(0, lastSpace) : cut;
  return kept.replace(/[\s,;:–-]+$/, "");
}

function stripFences(output: string): string {
  const text = output.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  return fenced ? fenced[1]!.trim() : text;
}

function stripWrappingQuotes(text: string): string {
  const quoted =
    /^"([\s\S]+)"$/.exec(text) ??
    /^'([\s\S]+)'$/.exec(text) ??
    /^[“„]([\s\S]+)[”“]$/.exec(text) ??
    /^«\s*([\s\S]+?)\s*»$/.exec(text);
  if (quoted === null) return text;
  const inner = quoted[1]!.trim();
  return inner.includes('"') ? text : inner;
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
