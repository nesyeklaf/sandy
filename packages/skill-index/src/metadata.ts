import matter from "gray-matter";

export interface SkillMetadata {
  name: string | null;
  description: string | null;
  argumentHint: string | null;
  metadata: Record<string, string>;
  error: string | null;
}

function stringEntries(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const entries: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") entries[key] = entry;
  }
  return entries;
}

export function parseSkillMetadata(content: string): SkillMetadata {
  const empty = {
    name: null,
    description: null,
    argumentHint: null,
    metadata: {},
  };
  if (!/^\s*---\r?\n/u.test(content)) {
    return {
      ...empty,
      error: "SKILL.md frontmatter must start with a plain --- delimiter",
    };
  }
  try {
    const data: Record<string, unknown> = matter(content).data;
    const field = (key: string): string | null => {
      const value = data[key];
      return typeof value === "string" && value.trim() ? value.trim() : null;
    };
    return {
      name: field("name"),
      description: field("description"),
      argumentHint: field("argument-hint"),
      metadata: stringEntries(data.metadata),
      error: null,
    };
  } catch (error) {
    return {
      ...empty,
      error:
        error instanceof Error ? error.message : "Invalid SKILL.md frontmatter",
    };
  }
}
