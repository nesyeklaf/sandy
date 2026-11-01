import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stageGuard from '../src/extension.ts';

type Handler = (event: { toolName: string; input: unknown }) => { block: true; reason: string } | undefined;
function setup(envExtra: Record<string, string | undefined> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'track-guard-'));
  mkdirSync(path.join(dir, 'threads'));
  const handlers = new Map<string, Handler>();
  const fakePi = { on: (name: string, h: Handler) => handlers.set(name, h) };
  const env = { TRACK_STATE_DIR: dir, SANDY_THREAD_ID: 't1', ...envExtra };
  stageGuard(fakePi as never, { env });
  const call = (toolName: string, input: unknown) => handlers.get('tool_call')!({ toolName, input });
  const file = path.join(dir, 'threads', 't1.json');
  const write = (value: unknown) => { writeFileSync(file + '.tmp', typeof value === 'string' ? value : JSON.stringify(value)); renameSync(file + '.tmp', file); };
  return { call, write, file, dir };
}
const policyFile = (allow: object, over: object = {}) => ({
  version: 1, threadId: 't1', active: true, machine: 'full-control', stage: 'plan', stageTitle: 'Plan', next: ['build'], updatedAt: 1, allow, ...over,
});

test('end to end: no file allows, then a written policy blocks and allows, follows rewrites', () => {
  const { call, write } = setup();
  assert.equal(call('edit', { path: '/repo/a.ts' }), undefined); // no file
  write(policyFile({ edits: false, subagents: [{ agent: 'scout' }] }));
  const blocked = call('edit', { path: '/repo/a.ts' });
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason, /stage "plan"/);
  assert.equal(call('edit', { path: '/tmp/notes.md' }), undefined);
  assert.equal(call('subagent', { agent: 'scout', task: 't' }), undefined);
  assert.equal(call('subagent', { agent: 'worker', task: 't' })?.block, true);
  assert.equal(call('mcp__x__stage_advance', {}), undefined);
  write(policyFile({ edits: false }, { active: false })); // owner paused
  assert.equal(call('edit', { path: '/repo/a.ts' }), undefined);
  write('{broken');
  assert.equal(call('edit', { path: '/repo/a.ts' })?.block, true);
  assert.equal(call('ls', { path: '/' }), undefined);
  write(policyFile({ skills: ['a'] }));
  assert.equal(call('read', { path: '/s/skills/b/SKILL.md' })?.block, true);
});

test('end to end: no SANDY_THREAD_ID is a no-op, unsafe thread ids are ignored', () => {
  const s = setup({ SANDY_THREAD_ID: undefined });
  s.write(policyFile({ edits: false }));
  assert.equal(s.call('edit', { path: '/repo/a.ts' }), undefined);
  const t = setup({ SANDY_THREAD_ID: '../x' });
  assert.equal(t.call('edit', { path: '/repo/a.ts' }), undefined);
});

// ---- Track drivers v2: the agent's lease ticket (sandy/work/track/docs/design-v2.md §8) ------------------------------------

type Entry = { type: string; id: string; customType?: string; data?: unknown; message?: { role: string; usage?: object } };
type ExecCall = { args: string[] };
function leaseSetup(execOptions: { fail?: boolean; hold?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'track-guard-'));
  mkdirSync(path.join(dir, 'threads'));
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const branch: Entry[] = [];
  let n = 0;
  const fakePi = {
    on: (name: string, h: (event: any, ctx: any) => any) => handlers.set(name, h),
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: 'custom', id: 'e' + ++n, customType, data }); },
  };
  const execs: ExecCall[] = [];
  const held: (() => void)[] = [];
  const sandy = async (args: string[]) => {
    execs.push({ args });
    if (execOptions.hold) await new Promise<void>(r => held.push(r));
    if (execOptions.fail) throw new Error('sandy unreachable');
    return '{"kind":"ok"}';
  };
  stageGuard(fakePi as never, { env: { TRACK_STATE_DIR: dir, SANDY_THREAD_ID: 't1' }, sandy, log: () => {} });
  const ctx = { sessionManager: { getBranch: () => branch } };
  const emit = (name: string, event: object) => handlers.get(name)!(event, ctx);
  const call = (toolName: string, input: Record<string, unknown>) => { const result = emit('tool_call', { type: 'tool_call', toolName, input }); return { result, input }; };
  const write = (value: object) => writeFileSync(path.join(dir, 'threads', 't1.json'), JSON.stringify(value));
  const assistant = (input: number, output: number) => branch.push({ type: 'message', id: 'm' + ++n, message: { role: 'assistant', usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output } } });
  const remove = () => rmSync(path.join(dir, 'threads', 't1.json'));
  return { emit, call, write, remove, branch, assistant, execs, held };
}
const agentPolicy = (ticket: string, over: object = {}) => policyFile({}, { running: true, runId: 'r1', rev: 3, ticket, driver: { kind: 'agent' }, ...over });
const result = (toolName: string, text: string, isError = false) => ({ type: 'tool_result', toolName, toolCallId: 'c', input: {}, content: [{ type: 'text', text }], isError });

test('the ticket of a stage_start or stage_advance result is injected into later stage calls, overwriting what the model typed', () => {
  const { emit, call, branch } = leaseSetup();
  assert.deepEqual(call('stage_submit', { outputs: {}, ticket: 'made-up' }).input, { outputs: {} }); // no ticket yet: none is sent
  emit('tool_result', result('stage_start', 'Started.\n\nStage plan\n\n⟦track-ticket⟧ r1.1'));
  assert.deepEqual(call('stage_submit', { outputs: { a: '1' }, ticket: 'made-up' }).input, { outputs: { a: '1' }, ticket: 'r1.1', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 } });
  assert.equal(call('mcp__sandy__stage_propose_force', { to: 'build', reason: 'x' }).input.ticket, 'r1.1');
  emit('tool_result', result('mcp__sandy__stage_advance', 'Refused.\n\n⟦track-ticket⟧ r1.1-not-this', true)); // a failed call names no new lease
  emit('tool_result', result('mcp__sandy__stage_advance', 'Advanced.\n\n⟦track-ticket⟧ r1.2'));
  assert.equal(call('stage_advance', {}).input.ticket, 'r1.2');
  assert.equal(call('stage_status', { ticket: 'x' }).input.ticket, 'x'); // only lease calls are touched
  assert.deepEqual(branch.map(e => e.data), [{ ticket: 'r1.1' }, { ticket: 'r1.2' }]);
});

test('a nested call (codemode) gets the same injection as a top-level one', () => {
  const { emit, write } = leaseSetup();
  write(agentPolicy('r1.4'));
  emit('agent_start', { type: 'agent_start' });
  const input: Record<string, unknown> = { to: 'review' };
  assert.equal(emit('tool_call', { type: 'tool_call', toolName: 'stage_advance', toolCallId: 'cm/1', parentToolCallId: 'cm', input }), undefined);
  assert.equal(input.ticket, 'r1.4');
});

test('a sandy_delegate launch nested in codemode is gated by the same policy', () => {
  const { emit, write } = leaseSetup();
  write(agentPolicy('r1.4', { allow: { subagents: [{ agent: 'scout' }] } }));
  const nested = (agent: string) => emit('tool_call', { type: 'tool_call', toolName: 'sandy_delegate', toolCallId: 'cm/1', parentToolCallId: 'cm', input: { agent, task: 't' } }) as { block?: boolean } | undefined;
  assert.equal(nested('scout'), undefined);
  assert.equal(nested('worker')?.block, true);
});

test('a turn the plugin started for the agent picks the ticket from the policy file, also while the guard is paused, and marks the lease once', () => {
  const { emit, call, write, branch, assistant } = leaseSetup();
  write(agentPolicy('r1.4', { active: false }));
  emit('agent_start', { type: 'agent_start' });
  emit('agent_start', { type: 'agent_start' });
  assistant(10, 5);
  assert.deepEqual(call('stage_submit', { outputs: {} }).input.usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, messages: 1 });
  assert.deepEqual(branch.filter(e => e.customType === 'track-lease').map(e => e.data), [{ ticket: 'r1.4' }]);
});

test('an autopilot lease or a finished track gives the agent no ticket', () => {
  const { emit, call, write } = leaseSetup();
  emit('tool_result', result('stage_start', 'Started.\n\n⟦track-ticket⟧ r1.1'));
  write(agentPolicy('r1.2', { driver: { kind: 'autopilot', name: 'p' } }));
  emit('agent_start', { type: 'agent_start' });
  assert.equal(call('stage_submit', {}).input.ticket, undefined);
  emit('tool_result', result('stage_start', 'Started.\n\n⟦track-ticket⟧ r2.1'));
  write(agentPolicy('', { active: false, running: false }));
  emit('agent_start', { type: 'agent_start' });
  assert.equal(call('stage_advance', {}).input.ticket, undefined);
});

test('a usage the session cannot measure is left out, never sent as zero', () => {
  const { emit, call, branch } = leaseSetup();
  emit('tool_result', result('stage_start', 'Started.\n\n⟦track-ticket⟧ r1.1'));
  branch.push({ type: 'message', id: 'x', message: { role: 'assistant' } });
  assert.deepEqual(call('stage_advance', { usage: { input: 1 } }).input, { ticket: 'r1.1' });
});

test('only the terminal ticket line counts: a ticket line echoed earlier in the result (an output, an input) is ignored', () => {
  const { emit, call } = leaseSetup();
  emit('tool_result', result('stage_start', 'Started.\n\nInputs:\n  - a.x: v\nticket r9.9\n⟦track-ticket⟧ r9.8\nmore\n\n⟦track-ticket⟧ r1.2'));
  assert.equal(call('stage_submit', { outputs: {} }).input.ticket, 'r1.2');
  emit('tool_result', result('stage_advance', 'Gate passed.\n\n  - a.x: ⟦track-ticket⟧ r9.9\nStage b, driven by autopilot x'));
  assert.equal(call('stage_submit', { outputs: {} }).input.ticket, 'r1.2', 'a result without a terminal ticket line keeps the ticket');
});

// ---- the guard meters every lease marker of its session, late and read-only (sandy/work/track/docs/decisions.md D19) -------

const reportUsage = (e: ExecCall) => JSON.parse(e.args[6]!);
const endMarkers = (branch: Entry[]) => branch.filter(e => e.customType === 'track-lease' && (e.data as { ticket: unknown }).ticket === null).length;
const idle = () => new Promise(r => setTimeout(r, 5));

test('agent_end after the lease closed reports the lease usage (including the closing reply) once and appends an end marker', async () => {
  const { emit, write, branch, assistant, execs } = leaseSetup();
  write(agentPolicy('r1.1'));
  emit('agent_start', { type: 'agent_start' });
  assistant(10, 5);
  emit('agent_end', { type: 'agent_end', messages: [] });
  assert.equal(execs.length, 0, 'the lease is still current: nothing is reported');
  assert.equal(endMarkers(branch), 0);
  // stage_advance closed the lease; the agent's closing reply came after the tool result.
  write(agentPolicy('', { running: false }));
  assistant(3, 2);
  emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(execs.length, 1);
  assert.deepEqual(execs[0]!.args.slice(0, 5), ['work', 'track', 'usage', '--ticket', 'r1.1']);
  assert.equal(execs[0]!.args[5], '--usage');
  assert.deepEqual(reportUsage(execs[0]!), { input: 13, output: 7, cacheRead: 0, cacheWrite: 0, total: 20, messages: 2 });
  assert.equal(endMarkers(branch), 1);
  assistant(100, 100);
  emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(execs.length, 1, 'reported once: later work belongs to no lease');
});

test('agent_end reports the old lease when the policy names another ticket or no policy file exists', async () => {
  const other = leaseSetup();
  other.write(agentPolicy('r1.1'));
  other.emit('agent_start', { type: 'agent_start' });
  other.assistant(1, 1);
  other.write(agentPolicy('r1.2', { rev: 10 })); // another size: the guard caches by mtime, size and inode
  other.emit('agent_end', { type: 'agent_end', messages: [] });
  await idle(); // reports go out through a one-at-a-time chain
  assert.equal(other.execs.length, 1);
  assert.equal(other.execs[0]!.args[4], 'r1.1');
  const none = leaseSetup();
  none.write(agentPolicy('r1.1'));
  none.emit('agent_start', { type: 'agent_start' });
  none.assistant(1, 1);
  none.remove();
  none.emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(none.execs.length, 1);
});

test('agent_start after an idle abort reports the old lease before the new turn is captured', async () => {
  const { emit, write, branch, assistant, execs, call } = leaseSetup();
  write(agentPolicy('r1.1'));
  emit('agent_start', { type: 'agent_start' });
  assistant(10, 5);
  // The owner aborted the run while the agent was idle: the next turn starts under another lease.
  write(agentPolicy('r2.1', { runId: 'r2', rev: 10 }));
  emit('agent_start', { type: 'agent_start' });
  await idle();
  assert.equal(execs.length, 1);
  assert.equal(execs[0]!.args[4], 'r1.1');
  assert.deepEqual(reportUsage(execs[0]!), { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, messages: 1 });
  assert.deepEqual(branch.filter(e => e.customType === 'track-lease').map(e => e.data), [{ ticket: 'r1.1' }, { ticket: null }, { ticket: 'r2.1' }], 'the end marker comes before the new lease marker');
  assistant(1, 1);
  assert.equal((call('stage_submit', {}).input.usage as { messages: number }).messages, 1, 'the new lease counts only its own work');
});

test('a newer runner marker does not hide an ended lease: every ended, unreported ticket is reported once and the newer lease stays attributed', async () => {
  const { emit, write, branch, assistant, execs } = leaseSetup();
  const mark = (ticket: string) => branch.push({ type: 'custom', id: 'k' + branch.length, customType: 'track-lease', data: { ticket } });
  const autopilot = (ticket: string, over: object = {}) => agentPolicy(ticket, { driver: { kind: 'autopilot', name: 'p' }, ...over });
  // Autopilot A finished its last step, then closed by a deferred gate; autopilot B claimed and marked before its first turn.
  mark('r1.1');
  assistant(10, 5);
  mark('r1.2');
  assistant(1, 1);
  write(autopilot('r1.2'));
  emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(execs.length, 1);
  assert.equal(execs[0]!.args[4], 'r1.1');
  assert.deepEqual(reportUsage(execs[0]!), { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, messages: 1 });
  assert.equal(endMarkers(branch), 0, 'the newer lease is still current: its attribution is not ended');
  emit('agent_start', { type: 'agent_start' });
  emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(execs.length, 1, 'no duplicate report on the next hook');
  // B's later work still counts for B; when B ends it is reported with all of it, and A is not reported again.
  assistant(2, 2);
  write(autopilot('', { running: false, rev: 10 }));
  emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(execs.length, 2);
  assert.equal(execs[1]!.args[4], 'r1.2');
  assert.deepEqual(reportUsage(execs[1]!), { input: 3, output: 3, cacheRead: 0, cacheWrite: 0, total: 6, messages: 2 });
  assert.equal(endMarkers(branch), 1);
  emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(execs.length, 2, 'both leases are reported once');
});

test('the reported state is read from the session entries: a restarted guard does not report an ended lease again', async () => {
  const first = leaseSetup();
  const mark = (s: ReturnType<typeof leaseSetup>, ticket: string) => s.branch.push({ type: 'custom', id: 'k' + s.branch.length, customType: 'track-lease', data: { ticket } });
  mark(first, 'r1.1');
  first.assistant(10, 5);
  mark(first, 'r1.2');
  first.write(agentPolicy('r1.2', { driver: { kind: 'autopilot', name: 'p' } }));
  first.emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(first.execs.length, 1);
  // Same session entries, a new extension instance (pi restart).
  const restarted = leaseSetup();
  restarted.branch.push(...first.branch);
  restarted.write(agentPolicy('r1.2', { driver: { kind: 'autopilot', name: 'p' } }));
  restarted.emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(restarted.execs.length, 0);
});

test('a long session history: ended leases of older runs are closed without a report, and reports run one at a time', async () => {
  const { emit, write, branch, assistant, execs, held } = leaseSetup({ hold: true });
  const mark = (ticket: string) => branch.push({ type: 'custom', id: 'k' + branch.length, customType: 'track-lease', data: { ticket } });
  for (let i = 1; i <= 20; i++) { mark('old' + i + '.2'); assistant(1, 1); } // markers of earlier runs without end markers
  mark('r1.1'); assistant(10, 5);
  mark('r1.2'); assistant(3, 3);
  mark('r1.3');
  write(agentPolicy('r1.3'));
  emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(execs.length, 1, 'one report in flight at a time');
  assert.equal(execs[0]!.args[4], 'r1.1');
  held.shift()!();
  await idle();
  assert.equal(execs.length, 2);
  assert.equal(execs[1]!.args[4], 'r1.2');
  held.shift()!();
  await idle();
  assert.equal(execs.length, 2, 'tickets of other runs are never sent');
  emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(execs.length, 2, 'the old runs count as handled: no report on the next hook either');
});

test('a lease the session could not measure is not reported; a failing report is swallowed', async () => {
  const unknown = leaseSetup();
  unknown.write(agentPolicy('r1.1'));
  unknown.emit('agent_start', { type: 'agent_start' });
  unknown.branch.push({ type: 'message', id: 'x', message: { role: 'assistant' } });
  unknown.write(agentPolicy('', { running: false }));
  unknown.emit('agent_end', { type: 'agent_end', messages: [] });
  await idle();
  assert.equal(unknown.execs.length, 0);
  const failing = leaseSetup({ fail: true });
  failing.write(agentPolicy('r1.1'));
  failing.emit('agent_start', { type: 'agent_start' });
  failing.assistant(1, 1);
  failing.write(agentPolicy('', { running: false }));
  assert.doesNotThrow(() => failing.emit('agent_end', { type: 'agent_end', messages: [] }));
  await idle();
  assert.equal(failing.execs.length, 1);
});
