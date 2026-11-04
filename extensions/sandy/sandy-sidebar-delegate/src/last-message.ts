export const LAST_MESSAGE_MAX_LENGTH = 300;

export function lastMessageLine(assistantText: string | null): string | null {
  const text = assistantText?.replace(/\s+/g, " ").trim() ?? "";
  if (text === "") return null;
  return text.length > LAST_MESSAGE_MAX_LENGTH ? `${text.slice(0, LAST_MESSAGE_MAX_LENGTH - 1)}…` : text;
}
