import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

type Dialect = typeof import('../../../../../packages/skill-dialect/src/index.ts');

let dialect: Promise<Dialect | undefined> | undefined;

function loadDialect(): Promise<Dialect | undefined> {
  dialect ??= import('../../../../../packages/skill-dialect/src/index.ts').catch((cause: unknown) => {
    console.error(`pi-work: track skills show in full, the skill dialect did not load (${cause instanceof Error ? cause.message : String(cause)}). Run extensions/scripts/build.sh pi/work.`);
    return undefined;
  });
  return dialect;
}

const STAGE_START = /(^|__)stage_start$/;

type ReadResult = { toolName: string; input: Record<string, unknown>; isError: boolean };
type ToolLike = { name: string; exposure: string };

export async function trackSkillRead(event: ReadResult, cwd: string, tools: () => readonly ToolLike[]): Promise<string | undefined> {
  if (event.isError || event.toolName !== 'read') return undefined;
  const raw = event.input.path;
  if (typeof raw !== 'string' || path.basename(raw) !== 'SKILL.md') return undefined;
  if (!tools().some((t) => STAGE_START.test(t.name) && t.exposure !== 'hidden')) return undefined;
  const file = path.resolve(cwd, raw === '~' || raw.startsWith('~/') ? path.join(homedir(), raw.slice(1)) : raw);
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  return (await loadDialect())?.renderTrackSkillRead(source);
}
