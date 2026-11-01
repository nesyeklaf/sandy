# Slice 7 live evidence: host entry (sandy 0.47.1), 2026-10-27

Setup: `cd sandy/delegate && sandy plugin build . && sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate-s7/sandy/delegate --yes` (source of `delegate@0.1.0` is now this worktree; before: …/plugins-wt/sandy-delegate/sandy/delegate). `sandy plugin list` → `delegate@0.1.0 running`, `service extension-install: running`, `service watchdog: running`. Test threads use project `proj_ceach6fumc` (pi-setup on seraphim), spawned with `env -u SANDY_THREAD_ID sandy thread spawn --provider pi --model anthropic/claude-haiku-5-5 --permission-mode full --visibility visible --prompt-file … --json`. Scripts/prompts: /tmp/sandy-delegate-live/*.txt.

## Install (plugin log, within the first sweep after install)
```
extension on seraphim: installed (C:\Users\eysen\.pi\agent\extensions\sandy-delegate, bundle 9b078a149793)
extension on v2202508294696377407: updated (/home/aemon/.pi/agent/extensions/sandy-delegate, bundle 9b078a149793)
```
- Server: the hand-copied (older) extension was replaced. `diff ~/.pi/agent/extensions/sandy-delegate/index.ts pi-extension.ts` and `diff -r …/shared shared` clean; no `.sandy-delegate-stage-*` left in extensions/; other entries (symlinks, lifecycle/) untouched.
- Seraphim (Windows, fresh): a plain pi thread listed the directory: `index.ts` 9648 bytes, `shared/policy.ts` 4296 bytes (same sizes as on the server), no stage directory.
- `sandy delegate extension` (all hosts, second run):
```
seraphim (host_ydkmdfeew3): unchanged C:\Users\eysen\.pi\agent\extensions\sandy-delegate (bundle 9b078a149793)
v2202508294696377407 (host_qes9vgr78x): unchanged /home/aemon/.pi/agent/extensions/sandy-delegate (bundle 9b078a149793)
NANX0AS60602 (host_v85icuzaha): skipped, host disconnected
```
- Laptop NANX0AS60602 (host_v85icuzaha) was disconnected: not installed, not verified. It gets the extension on its next connect (the sweep installs on any connected host not yet confirmed).

## Windows: how SANDY_CLI runs (recon threads on seraphim, node v24.14.1, pi 1.4.0)
- `SANDY_CLI=C:\Users\eysen\AppData\Local\Programs\sandy\resources\app.asar.unpacked\node_modules\sandy-app\host-daemon\dist\sandy`: an extensionless node script (shebang); sibling `sandy.cmd` is `@echo off` / `node "%~dp0bb" %*`; `sandy` is not on the PATH of a pi thread.
- `execFile(SANDY_CLI)` → ENOENT; `execFile("sandy")` → ENOENT; `execFile("sandy.cmd")` → throws EINVAL (node refuses .cmd without a shell).
- `execFile(process.execPath, [SANDY_CLI, "--version"])` → `0.47.1`; `… delegate list --limit 1` → table. (`.cmd` with `shell: true` also works but prints a DEP0190 warning.)
- So pi-extension.ts `sandyCommand`: on win32 a SANDY_CLI that is not .exe/.com/.cmd/.bat runs as `node <SANDY_CLI> args`; elsewhere `execFile(SANDY_CLI || "sandy")` as before.

## Delegation on seraphim with the host-installed extension
| thread | role |
|---|---|
| thr_zg4vxpm4u3 | parent "[delegate-test] s7 parent seraphim": one sandy_delegate call (scout, async) |
| thr_7bh5zmafug | scout child "[delegate-test] scout s7 seraphim" |
| thr_ruuyufzq49 | plain pi thread (extension loaded, no marker): listed the directory, answered "plain ok" |
- `sandy delegate list`: `dlg_0b0386ad-fb36-4ed2-b27e-f8b8db858444  active  scout  thr_zg4vxpm4u3  thr_7bh5zmafug … ACKED 2026-10-27T15:15:39.019Z  BRIEF delivered  STOP -` (created 15:15:36.174Z: ack 2.8 s after the spawn, then the brief).
- The child returned the repository root listing of its worktree on seraphim and the parent received `@thread:thr_7bh5zmafug completed`. The ack on Windows went through the new node-launched CLI path.
- Normal threads on seraphim were not blocked (the plain thread and the parent, both with the extension loaded, ran normally).

## Recon threads (read-only)
thr_9wn8zfcqck (env/dir), thr_iaqrchix2y (exec probe 1, aborted by my probe's EINVAL), thr_p5qs3bncdy (exec probe 2).

## Red run (staleness test)
`echo "// red run" >> pi-extension.ts; node --test --experimental-strip-types tests/host-bundle.test.ts` → `✖ host-bundle.ts is current: run \`npm run gen\` …  AssertionError: pi-extension.ts changed; run npm run gen` (1 fail). Reverted; `npm run gen` output is what is committed; test green.

## Restore
- Remove the extension on a host: server `rm -r ~/.pi/agent/extensions/sandy-delegate`; seraphim `Remove-Item -Recurse $env:USERPROFILE\.pi\agent\extensions\sandy-delegate`. NOTE: the running plugin reinstalls it within 30 s; disable first: `sandy plugin disable delegate` (or move the dir aside only after that).
- Previous plugin source: `sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate --yes` (that build has no host entry, so nothing reinstalls the extension).
