import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stageGuard from '../src/extension.ts';

type Result = Promise<{ content: { type: string; text: string }[] } | undefined>;

function setup(tools: { name: string; exposure: string }[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'track-skill-read-'));
  mkdirSync(path.join(dir, 'threads'));
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Result>();
  const fakePi = { on: (name: string, h: (event: unknown, ctx: unknown) => Result) => handlers.set(name, h), getAllTools: () => tools, appendEntry: () => {} };
  stageGuard(fakePi as never, { env: { TRACK_STATE_DIR: dir, SANDY_THREAD_ID: 't1' } });
  const read = (file: string, toolName = 'read') =>
    handlers.get('tool_result')!({ type: 'tool_result', toolName, toolCallId: 'c', input: { path: file }, content: [{ type: 'text', text: 'raw' }], isError: false }, { cwd: dir, sessionManager: { getBranch: () => [] } });
  return { dir, read };
}

const dialectSkill = `---
name: probe
description: A probe.
metadata:
  dialect: "1"
---
# Probe

Prose for a reader.

{% input name="Task" description="what to probe" /%}

{% stage id="a" title="A" %}
Secret stage body.
{% next to="done" label="answered" /%}
{% /stage %}
`;

test('reading a dialect SKILL.md while stage_start is available shows frontmatter, prose, inputs and the stage_start call, never the stages', async () => {
  const { dir, read } = setup([{ name: 'mcp__sandy__stage_start', exposure: 'codemode' }]);
  mkdirSync(path.join(dir, 'probe'));
  writeFileSync(path.join(dir, 'probe', 'SKILL.md'), dialectSkill);
  const text = (await read('probe/SKILL.md'))!.content[0]!.text;
  assert.match(text, /^---\nname: probe\n/);
  assert.match(text, /Prose for a reader\./);
  assert.match(text, /- Input Task \(text\): what to probe/);
  assert.match(text, /This skill runs as a track: call stage_start\(\{skill: "probe", inputs: \{"Task": "\.\.\."\}\}\); stage_status shows the current stage\./);
  assert.doesNotMatch(text, /Secret stage body|\{%/);
  assert.equal((await read(path.join(dir, 'probe', 'SKILL.md')))!.content[0]!.text, text);
});

test('outside Sandy, for a SKILL.md without dialect, another tool or another file the read result stays raw', async () => {
  const outside = setup([{ name: 'read', exposure: 'direct' }]);
  writeFileSync(path.join(outside.dir, 'SKILL.md'), dialectSkill);
  assert.equal(await outside.read('SKILL.md'), undefined);
  const hidden = setup([{ name: 'stage_start', exposure: 'hidden' }]);
  writeFileSync(path.join(hidden.dir, 'SKILL.md'), dialectSkill);
  assert.equal(await hidden.read('SKILL.md'), undefined);
  const inside = setup([{ name: 'stage_start', exposure: 'direct' }]);
  writeFileSync(path.join(inside.dir, 'SKILL.md'), '---\nname: plain\ndescription: x\n---\n# Plain\n{% stage id="a" %}x{% /stage %}\n');
  writeFileSync(path.join(inside.dir, 'NOTES.md'), dialectSkill);
  assert.equal(await inside.read('SKILL.md'), undefined);
  assert.equal(await inside.read('NOTES.md'), undefined);
  assert.equal(await inside.read('missing/SKILL.md'), undefined);
  assert.equal(await inside.read('SKILL.md', 'bash'), undefined);
});
