export interface UseCase {
  id: string;
  label: string;
  keywords: string[];
}

export const FALLBACK_ID = "other";
export const FALLBACK_LABEL = "Other";

export const DEFAULT_USE_CASES: UseCase[] = [
  { id: "plan", label: "Plan and design", keywords: ["plan", "design", "architect", "spec", "explore", "scheme", "brief", "roadmap"] },
  { id: "build", label: "Build and implement", keywords: ["implement", "build", "send", "prototype", "refactor", "ship"] },
  { id: "debug", label: "Debug and test", keywords: ["debug", "test", "verify", "bug", "fail", "repro"] },
  { id: "review", label: "Review and audit", keywords: ["review", "audit", "check", "lint", "clean"] },
  { id: "write", label: "Write and communicate", keywords: ["write", "doc", "text", "draft", "meeting", "message", "mail"] },
  { id: "learn", label: "Learn and recall", keywords: ["teach", "learn", "vault", "understand", "coach", "note", "recall"] },
  { id: "ui", label: "Design and UI", keywords: ["interface", "visual", "ui", "frontend", "image", "layout", "impeccable"] },
  { id: "sandy", label: "Sandy and plugins", keywords: ["sandy", "plugin", "thread", "cli", "workflow", "automation", "provider", "browser"] },
];

export interface SkillLike {
  name: string;
  description: string | null;
}

const NAME_WEIGHT = 3;

function score(useCase: UseCase, skill: SkillLike): number {
  const name = skill.name.toLowerCase();
  const description = (skill.description ?? "").toLowerCase();
  let total = 0;
  for (const raw of useCase.keywords) {
    const keyword = raw.trim().toLowerCase();
    if (keyword === "") continue;
    if (name.includes(keyword)) total += NAME_WEIGHT;
    if (description.includes(keyword)) total += 1;
  }
  return total;
}

export function classify(skill: SkillLike, useCases: readonly UseCase[]): string {
  let best = FALLBACK_ID;
  let bestScore = 0;
  for (const useCase of useCases) {
    const value = score(useCase, skill);
    if (value > bestScore) {
      best = useCase.id;
      bestScore = value;
    }
  }
  return best;
}

export function resolveUseCase(
  skill: SkillLike,
  useCases: readonly UseCase[],
  assignments: Readonly<Record<string, string>>,
): { useCaseId: string; manual: boolean } {
  const assigned = assignments[skill.name];
  if (assigned !== undefined && (assigned === FALLBACK_ID || useCases.some((u) => u.id === assigned))) {
    return { useCaseId: assigned, manual: true };
  }
  return { useCaseId: classify(skill, useCases), manual: false };
}

export interface SourceLike {
  scope: string;
  provider: string | null;
  filePath: string;
}

export function sourceOf(skill: SourceLike): string {
  if (skill.scope === "sandy-builtin") return "sandy built-in";
  if (skill.scope === "plugin") return skill.provider === null ? "sandy plugins" : skill.provider + " plugins";
  const segments = skill.filePath.split(/[\\/]/u);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? "";
    if (!segment.startsWith(".") || segment === ".sandy-machines" || segment.length < 2) continue;
    if (segment === ".config" && segments[i + 1] !== undefined) return segments[i + 1] ?? "other";
    return segment.slice(1);
  }
  return "other";
}
