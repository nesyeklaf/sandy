// Preset library: personas (tone) and skills (pointer + environment facts),
// read from plain Markdown files with a tiny frontmatter. Pure except for file
// reads; no SANDY imports, so it is testable with node --test.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SEED_FILES } from "./seed.ts";

/** SANDY truncates a plugin's instruction contribution at this length. */
export const BLOCK_LIMIT = 4096;

export interface Preset {
  id: string;
  name: string;
  icon: string;
  /** Skill name the agent must load; only on skill presets. */
  skill: string | null;
  body: string;
  file: string;
}

export interface Library {
  personas: Preset[];
  skills: Preset[];
  /** Files that could not be used, with the reason. Never silent. */
  problems: string[];
}

export interface Selection {
  persona: string | null;
  skills: string[];
}

export interface Assembled {
  block: string | null;
  length: number;
  warnings: string[];
}

export const EMPTY_SELECTION: Selection = { persona: null, skills: [] };

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Parses `---\nkey: value\n---\nbody`. Returns an error string on bad input. */
export function parsePreset(file: string, text: string): Preset | string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (match === null) return `${file}: Frontmatter fehlt (--- ... ---)`;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (pair !== null) fields.set(pair[1]!, pair[2]!.trim().replace(/^["']|["']$/g, ""));
  }
  const id = fields.get("id") ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return `${file}: id fehlt oder ist ungültig (a-z, 0-9, -)`;
  const body = match[2]!.trim();
  if (body === "" && !fields.has("skill")) return `${file}: Body ist leer`;
  return {
    id,
    name: fields.get("name") || id,
    icon: fields.get("icon") || "MessageCircle",
    skill: fields.get("skill") || null,
    body,
    file,
  };
}

function loadKind(dir: string, kind: "personas" | "skills", problems: string[]): Preset[] {
  const folder = join(dir, kind);
  if (!existsSync(folder)) return [];
  const presets: Preset[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(folder).filter((n) => n.endsWith(".md")).sort()) {
    const parsed = parsePreset(`${kind}/${name}`, readFileSync(join(folder, name), "utf8"));
    if (typeof parsed === "string") problems.push(parsed);
    else if (seen.has(parsed.id)) problems.push(`${kind}/${name}: doppelte id ${parsed.id}`);
    else {
      seen.add(parsed.id);
      presets.push(parsed);
    }
  }
  return presets;
}

export function loadLibrary(dir: string): Library {
  const problems: string[] = [];
  return { personas: loadKind(dir, "personas", problems), skills: loadKind(dir, "skills", problems), problems };
}

/** Writes the bundled examples when the folder does not exist yet. */
export function seedIfMissing(dir: string): boolean {
  if (existsSync(dir)) return false;
  for (const [relative, text] of Object.entries(SEED_FILES)) {
    const target = join(dir, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
  }
  return true;
}

/** Re-reads the folder only when a file name, size or mtime changed. */
export function cachedLibrary(dir: string): () => Library {
  let signature = "";
  let library: Library = { personas: [], skills: [], problems: [] };
  return () => {
    const parts: string[] = [];
    for (const kind of ["personas", "skills"]) {
      const folder = join(dir, kind);
      if (!existsSync(folder)) continue;
      for (const name of readdirSync(folder).sort()) {
        const stat = statSync(join(folder, name));
        parts.push(`${kind}/${name}:${stat.size}:${stat.mtimeMs}`);
      }
    }
    const next = parts.join("|");
    if (next !== signature) {
      signature = next;
      library = loadLibrary(dir);
    }
    return library;
  };
}

/** Finds the SKILL.md of an installed skill, or null. */
export function findSkillFile(name: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const candidate = join(root, name, "SKILL.md");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export const DEFAULT_SKILL_ROOTS = [join(homedir(), ".agents", "skills"), join(homedir(), ".pi", "agent", "skills")];

/**
 * Builds the instruction block: persona body, one sentence that makes the agent
 * load every selected skill, a precedence line, then the skill bodies.
 */
export function assemble(
  library: Library,
  selection: Selection,
  skillFile: (name: string) => string | null,
): Assembled {
  const warnings: string[] = [];
  const parts: string[] = [];
  const persona =
    selection.persona === null ? null : (library.personas.find((p) => p.id === selection.persona) ?? null);
  if (selection.persona !== null && persona === null) warnings.push(`Persona ${selection.persona} nicht gefunden`);
  if (persona !== null) parts.push(persona.body);

  const skills: Preset[] = [];
  for (const id of selection.skills) {
    const skill = library.skills.find((s) => s.id === id);
    if (skill === undefined) warnings.push(`Skill-Preset ${id} nicht gefunden`);
    else skills.push(skill);
  }

  const loadable = skills.filter((s) => s.skill !== null);
  if (loadable.length > 0) {
    const lines = loadable.map((s) => {
      const file = skillFile(s.skill!);
      // The server may run on another machine than the agent, so a missing
      // file is not an error: the agent finds the skill by name in its catalog.
      return file === null ? `- ${s.skill} (aus deinem Skill-Katalog)` : `- ${s.skill}: ${file}`;
    });
    parts.push(
      [
        "Lies diese Skills vollständig (SKILL.md und alles, was sie zu lesen vorschreiben), bevor du antwortest, und folge ihren Regeln:",
        ...lines,
      ].join("\n"),
    );
  }
  if (persona !== null && skills.length > 0) {
    parts.push("Bei Widerspruch gilt zuerst der Ton oben, dann die Skills in der genannten Reihenfolge.");
  } else if (skills.length > 1) {
    parts.push("Bei Widerspruch zwischen Skills gilt die genannte Reihenfolge.");
  }
  for (const skill of skills) {
    if (skill.body !== "") parts.push(`[${skill.skill ?? skill.id}] ${skill.body}`);
  }

  if (parts.length === 0) return { block: null, length: 0, warnings };
  const block = parts.join("\n\n");
  if (block.length > BLOCK_LIMIT) {
    warnings.push(`Block hat ${block.length} Zeichen, SANDY kürzt bei ${BLOCK_LIMIT}`);
  }
  return { block, length: block.length, warnings };
}
