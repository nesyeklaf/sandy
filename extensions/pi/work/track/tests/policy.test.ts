import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, parsePolicy, type Policy } from '../src/policy.ts';

const env = { SANDY_THREAD_STORAGE: '/data/threads/t1', TRACK_STATE_DIR: '/state/gate', HOME: '/home/u' };
const policy = (allow: Policy['allow'], over: Partial<Policy> = {}): Policy => ({
  version: 1, threadId: 't1', active: true, machine: 'm', stage: 'plan', stageTitle: 'Plan', next: ['build'], updatedAt: 1, allow, ...over,
});
const broken = parsePolicy('{not json');
const blocks = (p: Parameters<typeof decide>[0], tool: string, input: unknown) => decide(p, tool, input, env).block === true;

test('no policy, inactive policy: everything allowed', () => {
  assert.equal(blocks(null, 'edit', { path: '/x' }), false);
  assert.equal(blocks(undefined, 'subagent', { agent: 'a' }), false);
  const off = policy({ edits: false, skills: [], subagents: [], denyTools: ['bash'] }, { active: false });
  for (const [t, i] of [['edit', { path: '/x' }], ['bash', { command: 'ls' }], ['subagent', { agent: 'a' }], ['read', { path: '/s/skills/x/SKILL.md' }]] as const) assert.equal(blocks(off, t, i), false, t);
});

test('invalid JSON fails closed for skills, edits, subagents; other tools allowed', () => {
  assert.ok('error' in broken);
  assert.equal(blocks(broken, 'read', { path: '/h/skills/foo/SKILL.md' }), true);
  assert.equal(blocks(broken, 'bash', { command: 'cat ~/skills/foo/SKILL.md' }), true);
  assert.equal(blocks(broken, 'edit', { path: '/repo/a.ts' }), true);
  assert.equal(blocks(broken, 'write', { path: '/repo/a.ts' }), true);
  assert.equal(blocks(broken, 'subagent', { agent: 'worker', task: 't' }), true);
  assert.equal(blocks(broken, 'subagent', { action: 'list' }), false);
  assert.equal(blocks(broken, 'ls', { path: '/' }), false);
  assert.equal(blocks(broken, 'read', { path: '/repo/a.ts' }), false);
  assert.equal(blocks(broken, 'bash', { command: 'ls' }), false);
  assert.equal(blocks(broken, 'edit', { path: '/tmp/a' }), false);
  assert.equal(blocks(broken, 'edit', { path: '/state/gate/threads/t1.json' }), true);
  assert.match((decide(broken, 'edit', { path: '/repo/a.ts' }, env) as { reason: string }).reason, /unreadable/);
});

test('parsePolicy rejects off-contract files, accepts inactive ones', () => {
  assert.ok('error' in parsePolicy('[]'));
  assert.ok('error' in parsePolicy(JSON.stringify({ version: 2, active: true, allow: {} })));
  assert.ok('error' in parsePolicy(JSON.stringify({ version: 1, active: true, allow: { skills: 'x' } })));
  assert.ok('error' in parsePolicy(JSON.stringify({ version: 1, active: true, allow: { subagents: [{ agent: 1 }] } })));
  assert.ok('error' in parsePolicy(JSON.stringify({ version: 1, active: 'yes', allow: {} })));
  assert.equal((parsePolicy(JSON.stringify({ version: 1, active: false })) as Policy).active, false);
});

test('stage tools and sandy track bash are always allowed', () => {
  const p = policy({ edits: false, skills: [], subagents: [], denyTools: ['stage_advance', 'bash', 'mcp__x__stage_advance'] });
  for (const t of ['stage_start', 'stage_status', 'stage_submit', 'stage_advance', 'stage_propose_force', 'mcp__x__stage_advance', 'plugin__stage_status']) assert.equal(blocks(p, t, {}), false, t);
  assert.equal(blocks(p, 'bash', { command: 'sandy track advance build' }), false);
  assert.equal(blocks(p, 'bash', { command: '  sandy track status --json' }), false);
  assert.equal(blocks(p, 'bash', { command: 'sandy track submit "a; b | c"' }), false);
  assert.equal(blocks(p, 'bash', { command: 'sandy tracks' }), true);
  assert.equal(blocks(p, 'bash', { command: 'sandy work track status --json' }), false);
  assert.equal(blocks(p, 'bash', { command: 'sandy work tracks' }), true);
  assert.equal(blocks(p, 'bash', { command: 'sandy work track status; rm -rf x' }), true);
  assert.equal(blocks(p, 'bash', { command: 'ls' }), true);
});

test('stricter: a sandy track command chained with something else is not exempt', () => {
  const p = policy({ denyTools: ['bash'], skills: [] });
  assert.equal(blocks(p, 'bash', { command: 'sandy track status; rm -rf x' }), true);
  assert.equal(blocks(p, 'bash', { command: 'sandy track status && ls' }), true);
  assert.equal(blocks(p, 'bash', { command: 'sandy track status $(ls)' }), true);
  const open = policy({ skills: [] });
  assert.equal(blocks(open, 'bash', { command: 'sandy track status; cat skills/x/SKILL.md' }), true);
});

test('denyTools matches exact names and the suffix after __', () => {
  const p = policy({ denyTools: ['web_search', 'bash'] });
  assert.equal(blocks(p, 'web_search', {}), true);
  assert.equal(blocks(p, 'mcp__exa__web_search', {}), true);
  assert.equal(blocks(p, 'my_web_search', {}), false);
  assert.equal(blocks(p, 'web_search2', {}), false);
  assert.equal(blocks(p, 'bash', { command: 'ls' }), true);
  assert.equal(blocks(p, 'read', { path: '/a' }), false);
  const r = decide(p, 'web_search', {}, env) as { reason: string };
  assert.match(r.reason, /plan/); assert.match(r.reason, /stage_advance/); assert.match(r.reason, /Stages tab/); assert.match(r.reason, /build/);
});

test('skills: read path and bash cat are matched against the list', () => {
  const p = policy({ skills: ['alpha'] });
  assert.equal(blocks(p, 'read', { path: '/home/u/.pi/agent/skills/alpha/SKILL.md' }), false);
  assert.equal(blocks(p, 'read', { path: '/home/u/.pi/agent/skills/beta/SKILL.md' }), true);
  assert.equal(blocks(p, 'mcp__fs__read', { path: '/x/skills/beta/SKILL.md' }), true);
  assert.equal(blocks(p, 'read', { path: '/x/skills/beta/references/doc.md' }), false);
  assert.equal(blocks(p, 'read', { path: '/x/notes/SKILL.md' }), false);
  assert.equal(blocks(p, 'bash', { command: 'cat ~/.pi/agent/skills/alpha/SKILL.md' }), false);
  assert.equal(blocks(p, 'bash', { command: 'cat ~/.pi/agent/skills/beta/SKILL.md' }), true);
  assert.equal(blocks(p, 'bash', { command: 'cat skills/alpha/SKILL.md && head "skills/beta/SKILL.md"' }), true);
  assert.equal(blocks(policy({}), 'read', { path: '/x/skills/beta/SKILL.md' }), false); // absent = any skill
  assert.equal(blocks(policy({ skills: [] }), 'read', { path: '/x/skills/alpha/SKILL.md' }), true);
});

test('edits:false blocks edit/write except $SANDY_THREAD_STORAGE and /tmp', () => {
  const p = policy({ edits: false });
  for (const t of ['edit', 'write', 'mcp__fs__write']) {
    assert.equal(blocks(p, t, { path: '/repo/a.ts' }), true, t);
    assert.equal(blocks(p, t, { path: '/data/threads/t1/notes.md' }), false, t);
    assert.equal(blocks(p, t, { path: '/tmp/x/y.md' }), false, t);
  }
  assert.equal(blocks(p, 'write', { path: '/tmp/../etc/passwd' }), true);
  assert.equal(blocks(p, 'write', { path: '/data/threads/t1/../t2/x' }), true);
  assert.equal(blocks(p, 'write', { path: '/data/threads/t10/x' }), true);
  assert.equal(blocks(p, 'edit', {}), true);
  assert.equal(blocks(p, 'bash', { command: 'echo hi > /repo/a' }), false); // bash is not an edit tool
  assert.equal(blocks(policy({ edits: true }), 'edit', { path: '/repo/a.ts' }), false);
  assert.equal(blocks(policy({}), 'edit', { path: '/repo/a.ts' }), false);
  assert.equal(blocks(policy({ edits: false }), 'write', { path: '/data/x' }, ), true);
});

test('stages.json in a skills dir and the state dir are protected while active, even when edits are allowed', () => {
  const p = policy({ edits: true });
  assert.equal(blocks(p, 'edit', { path: '/home/u/.pi/agent/skills/foo/stages.json' }), true);
  assert.equal(blocks(p, 'write', { path: '/repo/skills/foo/stages.json' }), true);
  assert.equal(blocks(p, 'write', { path: '/repo/foo/stages.json' }), false);
  assert.equal(blocks(p, 'write', { path: '/repo/skills/foo/other.json' }), false);
  assert.equal(blocks(p, 'edit', { path: '/state/gate/threads/t1.json' }), true);
  assert.equal(blocks(p, 'write', { path: '/state/gate/anything' }), true);
  assert.equal(blocks(p, 'write', { path: '/state/gate2/anything' }), false);
  assert.equal(blocks(policy({}), 'edit', { path: '/state/gate/threads/t1.json' }), true);
  // default state dir when the env var is unset
  assert.equal(decide(p, 'edit', { path: '/home/u/.local/state/sandy-track/threads/t1.json' }, { HOME: '/home/u' }).block, true);
  // inactive: no protection
  assert.equal(blocks(policy({}, { active: false }), 'edit', { path: '/state/gate/threads/t1.json' }), false);
});

test('subagent launches are matched against patterns with globs', () => {
  const p = policy({ subagents: [{ agent: 'scout*' }, { agent: 'worker', model: 'anthropic/*' }] });
  assert.equal(blocks(p, 'subagent', { agent: 'scout', task: 't' }), false);
  assert.equal(blocks(p, 'subagent', { agent: 'scout-fast', model: 'x/y' }), false);
  assert.equal(blocks(p, 'subagent', { agent: 'planner' }), true);
  assert.equal(blocks(p, 'subagent', { agent: 'worker', model: 'anthropic/opus' }), false);
  assert.equal(blocks(p, 'subagent', { agent: 'worker', model: 'openai/gpt' }), true);
  assert.equal(blocks(p, 'subagent', { agent: 'worker' }), true); // pattern model set, launch has none
  assert.equal(blocks(p, 'mcp__x__subagent', { agent: 'planner' }), true);
  // tasks[]
  assert.equal(blocks(p, 'subagent', { tasks: [{ agent: 'scout', task: 'a' }, { agent: 'scout2', task: 'b' }] }), false);
  assert.equal(blocks(p, 'subagent', { tasks: [{ agent: 'scout', task: 'a' }, { agent: 'planner', task: 'b' }] }), true);
  // chain[] with nested parallel
  assert.equal(blocks(p, 'subagent', { chain: [{ agent: 'scout' }, { parallel: [{ agent: 'scout', task: 'a' }, { agent: 'worker', model: 'anthropic/x', task: 'b' }] }] }), false);
  assert.equal(blocks(p, 'subagent', { chain: [{ agent: 'scout' }, { parallel: [{ agent: 'scout', task: 'a' }, { agent: 'evil', task: 'b' }] }] }), true);
  assert.equal(blocks(p, 'subagent', { chain: [{ agent: 'planner' }] }), true);
  assert.equal(blocks(p, 'subagent', { chain: [{ tasks: [{ agent: 'evil' }] }] }), true);
  // mixed top-level + tasks
  assert.equal(blocks(p, 'subagent', { agent: 'scout', tasks: [{ agent: 'evil' }] }), true);
  // management calls without agent
  assert.equal(blocks(p, 'subagent', { action: 'list' }), false);
  assert.equal(blocks(p, 'subagent', { action: 'status', id: 'r1' }), false);
  assert.equal(blocks(p, 'subagent', {}), false);
  // absent subagents = any; non-subagent tools unaffected
  assert.equal(blocks(policy({}), 'subagent', { agent: 'anything' }), false);
  assert.equal(blocks(p, 'bash', { command: 'ls' }), false);
});

test('subagents: [] blocks every launch but not management; workflow runs count as launches', () => {
  const p = policy({ subagents: [] });
  assert.equal(blocks(p, 'subagent', { agent: 'scout' }), true);
  assert.equal(blocks(p, 'subagent', { tasks: [{ agent: 'scout' }] }), true);
  assert.equal(blocks(p, 'subagent', { chain: [{ agent: 'scout' }] }), true);
  assert.equal(blocks(p, 'subagent', { action: 'list' }), false);
  assert.equal(blocks(p, 'subagent', { workflow: 'flow.js' }), true);
  assert.equal(blocks(policy({ subagents: [{ agent: '*' }] }), 'subagent', { workflow: 'flow.js' }), true);
  assert.equal(blocks(policy({}), 'subagent', { workflow: 'flow.js' }), false);
});

test('pattern model set and launch without model is blocked; pattern * matches any model', () => {
  assert.equal(blocks(policy({ subagents: [{ model: '*' }] }), 'subagent', { agent: 'a' }), true);
  assert.equal(blocks(policy({ subagents: [{ model: '*' }] }), 'subagent', { agent: 'a', model: 'm' }), false);
  assert.equal(blocks(policy({ subagents: [{ agent: '*' }] }), 'subagent', { agent: 'a' }), false);
  assert.equal(blocks(policy({ subagents: [{}] }), 'subagent', { agent: 'a' }), false);
});

test('sandy_delegate launches are matched like subagent launches (agent + model patterns, aliases)', () => {
  const p = policy({ subagents: [{ agent: 'scout*' }, { agent: 'worker', model: 'anthropic/*' }] });
  assert.equal(blocks(p, 'sandy_delegate', { agent: 'scout', task: 't' }), false);
  assert.equal(blocks(p, 'sandy_delegate', { agent: 'worker', model: 'anthropic/opus', task: 't' }), false);
  assert.equal(blocks(p, 'sandy_delegate', { agent: 'planner', task: 't' }), true);
  assert.equal(blocks(p, 'sandy_delegate', { agent: 'worker', model: 'openai/gpt', task: 't' }), true);
  assert.equal(blocks(p, 'sandy_delegate', { agent: 'worker', task: 't' }), true); // pattern model set, launch has none
  assert.equal(blocks(p, 'mcp__sandy__sandy_delegate', { agent: 'planner', task: 't' }), true);
  assert.equal(blocks(policy({}), 'sandy_delegate', { agent: 'anything', task: 't' }), false); // absent = any
  const reason = decide(p, 'sandy_delegate', { agent: 'planner', task: 't' }, env);
  assert.ok(reason.block && /launching sandy_delegate planner/.test(reason.reason));
  const withModel = decide(p, 'sandy_delegate', { agent: 'worker', model: 'openai/gpt', task: 't' }, env);
  assert.ok(withModel.block && /launching sandy_delegate worker @ openai\/gpt/.test(withModel.reason));
});

test('subagents: [] blocks sandy_delegate and workflow runs; delegate management tools pass', () => {
  const p = policy({ subagents: [] });
  assert.equal(blocks(p, 'sandy_delegate', { agent: 'scout', task: 't' }), true);
  assert.equal(blocks(p, 'sandy_workflow_plus_run', { script: 'x' }), true);
  assert.equal(blocks(p, 'sandy_workflow_run', { scriptPath: 'flow.js' }), true);
  assert.equal(blocks(p, 'mcp__sandy__sandy_workflow_run', { name: 'flow' }), true);
  const any = policy({ subagents: [{ agent: '*' }] });
  assert.equal(blocks(any, 'sandy_workflow_plus_run', { script: 'x' }), true); // unmatched launch '(workflow)'
  assert.equal(blocks(policy({}), 'sandy_workflow_plus_run', { script: 'x' }), false);
  const w = decide(p, 'sandy_workflow_plus_run', { script: 'x' }, env);
  assert.ok(w.block && /launching sandy_workflow_plus_run \(workflow\)/.test(w.reason));
  for (const t of ['sandy_delegate_send', 'sandy_delegate_wait', 'sandy_delegate_status', 'sandy_delegate_stop', 'mcp__sandy__sandy_delegate_status']) {
    assert.equal(blocks(p, t, { id: 'd1', agent: 'scout', message: 'm' }), false, t);
  }
});

test('an unreadable policy blocks sandy_delegate and workflow launches but not management', () => {
  assert.equal(blocks(broken, 'sandy_delegate', { agent: 'worker', task: 't' }), true);
  assert.equal(blocks(broken, 'sandy_workflow_plus_run', { script: 'x' }), true);
  assert.equal(blocks(broken, 'sandy_workflow_run', { name: 'flow' }), true);
  assert.equal(blocks(broken, 'sandy_delegate_status', { id: 'd1' }), false);
  assert.equal(blocks(broken, 'sandy_delegate_stop', { id: 'd1' }), false);
});

test('autopilot_submit is always allowed, even when denyTools names it or the policy is unreadable', () => {
  const p = policy({ edits: false, skills: [], subagents: [], denyTools: ['autopilot_submit', 'bash'] });
  for (const t of ['autopilot_submit', 'mcp__pi__autopilot_submit']) {
    assert.equal(blocks(p, t, { value: 1 }), false, t);
    assert.equal(blocks(broken, t, { value: 1 }), false, t);
  }
});
