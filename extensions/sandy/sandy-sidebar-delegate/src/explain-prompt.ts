const MAX_QUOTE = 2000;

/** The prompt that asks a model to explain one selected passage of a session. */
export function buildExplainPrompt(quote: string, sessionTitle: string): string {
  const passage = quote.length > MAX_QUOTE ? quote.slice(0, MAX_QUOTE) + "…" : quote;
  return [
    "A developer is reading an AI coding agent's reply and does not understand a passage.",
    "Explain it in plain words: what it means, why it matters, and any term they may not know.",
    "Answer in the language of the passage, in at most 120 words, as short paragraphs or a few bullets.",
    "Do not use tools, do not read files, and do not repeat the passage.",
    "",
    "Session: " + sessionTitle,
    "Passage:",
    passage,
  ].join("\n");
}

/** Keeps the answer a reasonable length for a card. */
export function cleanExplanation(output: string): string {
  const text = output.trim();
  if (text === "") throw new Error("The model returned no explanation");
  return text.length > 2000 ? text.slice(0, 2000) + "…" : text;
}
