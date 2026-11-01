import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { blockedCommandReason, DEFAULT_BLOCKED_COMMANDS } from '../src/blocklist.ts';
import { createConfigStore } from '../src/config.ts';
import { createPermissionController } from '../src/controller.ts';

const rules = DEFAULT_BLOCKED_COMMANDS;
const blocked = (command: string) => blockedCommandReason(command, rules) !== undefined;

test('ssh AI is allowed, every other ssh is blocked', () => {
  for (const ok of ['ssh AI', 'ssh AI uptime', 'ssh AI "ls -la /tmp"', 'ls | ssh AI cat', 'echo ssh host', 'git commit -m "ssh host"', 'grep ssh ~/.ssh/config']) assert.equal(blocked(ok), false, ok);
  for (const bad of ['ssh host', 'ssh -p 22 AI', 'ssh AI -o ProxyCommand=x', 'ssh AIX', 'ssh ai', '/usr/bin/ssh host', 'FOO=1 ssh host', 'scp a b:c', 'rsync a b:c', 'sftp host']) assert.equal(blocked(bad), true, bad);
});
test('separators, subshells, substitutions, wrappers and quoting do not hide a program', () => {
  for (const bad of [
    'ssh AI; ssh host', 'true && ssh host', 'false || ssh host', 'ssh host &', '(ssh host)', '{ ssh host; }', 'if true; then ssh host; fi',
    'echo $(ssh host)', 'echo "$(ssh host)"', 'echo `ssh host`', 'ssh AI $(ssh host)', 'cat <(ssh host)',
    'bash -c "ssh host"', "sh -lc 'ssh host'", 'bash -c "bash -c \'ssh host\'"', 'eval "ssh host"',
    'sudo -u x ssh host', 'env FOO=1 ssh host', 'env -S "ssh host"', 'nohup ssh host', 'timeout 5 ssh host', 'xargs -I{} ssh {}', 'find . -exec scp a b \\;',
    '"ssh" host', 's"s"h host', "'ssh' host", '\\ssh host',
  ]) assert.equal(blocked(bad), true, bad);
});
test('empty programs list disables the blocklist; custom rules work', () => {
  assert.equal(blockedCommandReason('ssh host', { programs: [], allow: [] }), undefined);
  const custom = { programs: ['kubectl'], allow: ['kubectl get'] };
  assert.equal(blockedCommandReason('kubectl get pods', custom), undefined);
  assert.ok(blockedCommandReason('kubectl delete pod x', custom));
});

function fixture(raw?: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-permissions-block-')); const cwd = path.join(dir, 'ws'); mkdirSync(cwd);
  const store = createConfigStore(path.join(dir, 'agent'));
  const write = (value: unknown) => { mkdirSync(path.dirname(store.path), { recursive: true }); writeFileSync(store.path, typeof value === 'string' ? value : JSON.stringify(value)); };
  if (raw) write(raw);
  const ctx = { cwd, signal: undefined, hasUI: false, ui: {} } as any;
  const controller = createPermissionController(store); controller.start(ctx);
  return { ctx, controller, write };
}
const bash = (cmd: string) => ({ toolName: 'bash', input: { cmd } });

test('the blocklist holds in yolo and read-only, and for powershell/command inputs', async () => {
  const f = fixture();
  f.controller.setMode('yolo');
  assert.equal((await f.controller.enforce(bash('ssh host'), f.ctx))?.block, true);
  assert.equal(await f.controller.enforce(bash('ssh AI uptime'), f.ctx), undefined);
  assert.equal((await f.controller.enforce({ toolName: 'powershell', input: { command: 'ssh host' } }, f.ctx))?.block, true);
  f.controller.setReadOnly(true);
  assert.equal((await f.controller.enforce(bash('ssh host'), f.ctx))?.block, true);
});
test('allow list from the config file is used; invalid blockedCommands fail closed outside yolo', async () => {
  const f = fixture({ blockedCommands: { programs: ['ssh'], allow: ['ssh AI', 'ssh build'] } });
  assert.equal(await f.controller.enforce(bash('ssh build make'), f.ctx), undefined);
  assert.equal((await f.controller.enforce(bash('ssh other'), f.ctx))?.block, true);
  f.write({ blockedCommands: { programs: 'ssh' } });
  assert.match(String((await f.controller.enforce(bash('ls'), f.ctx))?.reason), /blockedCommands/);
  f.controller.setMode('yolo');
  assert.equal((await f.controller.enforce(bash('ssh other'), f.ctx))?.block, true, 'last good list stays active');
});
test('a changed mode/readOnly in the file is adopted, an unchanged one keeps the runtime value', async () => {
  const f = fixture({ mode: 'auto' });
  f.controller.setMode('yolo');
  await f.controller.enforce(bash('ls'), f.ctx);
  assert.equal(f.controller.getConfig().mode, 'yolo', 'unchanged file keeps runtime mode');
  f.write({ mode: 'ask', readOnly: true });
  await f.controller.enforce(bash('ls'), f.ctx);
  assert.equal(f.controller.getConfig().mode, 'ask');
  assert.equal(f.controller.getConfig().readOnly, true);
  f.write({ mode: 'yolo', readOnly: true });
  assert.equal(await f.controller.enforce(bash('touch x'), f.ctx), undefined, 'file switched to yolo before the check');
});
