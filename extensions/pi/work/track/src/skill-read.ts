import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { renderTrackSkillRead } from '../../../../../packages/skill-dialect/src/index.ts';

const STAGE_START = /(^|__)stage_start$/;

type ReadResult = { toolName: string; input: Record<string, unknown>; isError: boolean };
type ToolLike = { name: string; exposure: string };

export function trackSkillRead(event: ReadResult, cwd: string, tools: () => readonly ToolLike[]): string | undefined {
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
  return renderTrackSkillRead(source);
}
