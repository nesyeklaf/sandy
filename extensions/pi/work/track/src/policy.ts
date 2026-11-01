import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Contract: sandy/work/track/POLICY.md. */
export type SubagentPattern = { agent?: string; model?: string };
export type Policy = {
  version: 1;
  threadId: string;
  active: boolean;
  machine: string;
  stage: string;
  stageTitle: string;
  next: string[];
  allow: { skills?: string[]; edits?: boolean; subagents?: SubagentPattern[]; denyTools?: string[] };
  // Added within version 1 by Track drivers v2 (absent in older files: read as agent / no ticket).
  running?: boolean;
  rev?: number;
  /** The current lease's ticket; "" without a live run. */
  ticket?: string;
  driver?: { kind: 'agent' } | { kind: 'autopilot'; name: string; args?: string };
};
export type PolicyError = { error: string };
export type Decision = { block: false } | { block: true; reason: string };
export type Env = Record<string, string | undefined>;

const ALLOW: Decision = { block: false };
const STAGE_TOOL = /(^|__)stage_(start|status|submit|advance|propose_force)$/;
/** pi/autopilot's tool that only hands a session.step's value back to the autopilot; never blocked. */
const AUTOPILOT_SUBMIT = /(^|__)autopilot_submit$/;

export function stateDir(env: Env): string {
  return env.TRACK_STATE_DIR || path.join(env.HOME || homedir(), '.local/state/sandy-track');
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses and validates the policy file text. Anything off-contract is an error (the guard then fails closed). */
export function parsePolicy(text: string): Policy | PolicyError {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { error: 'invalid JSON: ' + (e as Error).message }; }
  if (!isObject(raw)) return { error: 'policy is not an object' };
  if (raw.version !== 1) return { error: 'unsupported version ' + String(raw.version) };
  if (typeof raw.active !== 'boolean') return { error: '"active" is not a boolean' };
  if (!raw.active) return { ...raw, active: false, allow: {} } as unknown as Policy; // inactive: nothing else matters
  const allow = raw.allow;
  if (!isObject(allow)) return { error: '"allow" is not an object' };
  if (allow.skills !== undefined && !isStrings(allow.skills)) return { error: 'allow.skills is not a string array' };
  if (allow.denyTools !== undefined && !isStrings(allow.denyTools)) return { error: 'allow.denyTools is not a string array' };
  if (allow.edits !== undefined && typeof allow.edits !== 'boolean') return { error: 'allow.edits is not a boolean' };
  if (allow.subagents !== undefined) {
    const ok = Array.isArray(allow.subagents) && allow.subagents.every(p => isObject(p)
      && (p.agent === undefined || typeof p.agent === 'string') && (p.model === undefined || typeof p.model === 'string'));
    if (!ok) return { error: 'allow.subagents is not an array of {agent?, model?}' };
  }
  return {
    ...raw,
    stage: String(raw.stage ?? '?'),
    stageTitle: String(raw.stageTitle ?? raw.stage ?? '?'),
    next: isStrings(raw.next) ? raw.next : [],
  } as unknown as Policy;
}

const isError = (p: Policy | PolicyError): p is PolicyError => 'error' in p;

function matchesName(toolName: string, base: string): boolean {
  return toolName === base || toolName.endsWith('__' + base);
}

function glob(pattern: string, value: string): boolean {
  const re = pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + re + '$').test(value);
}

// ---- paths ----
function resolvePath(p: string, env: Env): string {
  const home = env.HOME || homedir();
  const expanded = p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
  return path.resolve(expanded);
}
/** Resolves symlinks of the deepest existing ancestor, so a link cannot smuggle a target out of its directory. */
function realPath(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try { return path.join(realpathSync(cur), ...rest.reverse()); } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}
function isUnder(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function targetPath(input: Record<string, unknown>): string | undefined {
  const p = input.path ?? input.file_path;
  return typeof p === 'string' && p ? p : undefined;
}

// ---- bash ----
/** True when the command has an unquoted separator, a command substitution or a heredoc, i.e. may run more than one thing. */
function hasShellControl(cmd: string): boolean {
  let quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") { if (c === "'") quote = ''; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '`' || (c === '$' && cmd[i + 1] === '(') || (c === '<' && cmd[i + 1] === '<')) return true;
    if (quote === '"') { if (c === '"') quote = ''; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '\r') return true;
  }
  return false;
}
function isTrackBash(cmd: string): boolean {
  return /^\s*sandy\s+(work\s+)?track(\s|$)/.test(cmd) && !hasShellControl(cmd);
}

// ---- subagent ----
function collectLaunches(params: Record<string, unknown>): SubagentPattern[] {
  const launches: SubagentPattern[] = [];
  const visit = (node: unknown) => {
    if (!isObject(node)) return;
    if (typeof node.agent === 'string' && node.agent) {
      launches.push({ agent: node.agent, model: typeof node.model === 'string' && node.model ? node.model : undefined });
    }
    for (const key of ['tasks', 'chain', 'parallel', 'steps']) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
    }
  };
  visit(params);
  // A workflow run launches agents named inside the script, which cannot be matched: treat it as an unmatched launch.
  if (launches.length === 0 && params.workflow && !params.action) launches.push({ agent: '(workflow)' });
  return launches;
}
/** sandy_delegate starts one agent run; the workflow runners start agents named inside a script. The other sandy_delegate_* tools only manage runs. */
const DELEGATE_TOOL = 'sandy_delegate';
const WORKFLOW_TOOLS = ['sandy_workflow_plus_run', 'sandy_workflow_run'];
/** The launching tool of this call (base name for the blocked message) and the launches it makes; null when the tool launches nothing. */
function launchesOf(toolName: string, params: Record<string, unknown>): { tool: string; launches: SubagentPattern[] } | null {
  if (matchesName(toolName, 'subagent')) return { tool: 'subagent', launches: collectLaunches(params) };
  if (matchesName(toolName, DELEGATE_TOOL)) {
    const agent = params.agent;
    const model = params.model;
    return { tool: DELEGATE_TOOL, launches: typeof agent === 'string' && agent
      ? [{ agent, model: typeof model === 'string' && model ? model : undefined }] : [] };
  }
  const workflow = WORKFLOW_TOOLS.find(t => matchesName(toolName, t));
  return workflow ? { tool: workflow, launches: [{ agent: '(workflow)' }] } : null;
}
const launchLabel = (l: SubagentPattern) => (l.agent ?? '*') + (l.model ? ' @ ' + l.model : '');
const launchAllowed = (l: SubagentPattern, patterns: SubagentPattern[]) => patterns.some(p =>
  (p.agent === undefined || (l.agent !== undefined && l.agent !== '(workflow)' && glob(p.agent, l.agent)))
  && (p.model === undefined || (l.model !== undefined && glob(p.model, l.model))));

// ---- reasons ----
function describeAllowed(policy: Policy): string {
  const a = policy.allow;
  const parts = [
    a.skills ? 'skills: ' + (a.skills.join(', ') || 'none') : 'skills: any',
    'edits: ' + (a.edits === false ? 'no (only $SANDY_THREAD_STORAGE and /tmp)' : 'yes'),
    a.subagents ? 'subagents: ' + (a.subagents.map(launchLabel).join(', ') || 'none') : 'subagents: any',
  ];
  if (a.denyTools?.length) parts.push('denied tools: ' + a.denyTools.join(', '));
  return parts.join('; ');
}
function blocked(policy: Policy | PolicyError, what: string): Decision {
  if (isError(policy)) {
    return { block: true, reason: 'track guard: ' + what + ' blocked because the stage policy file is unreadable (' + policy.error
      + '). Call stage_status, or ask the owner to fix or pause the guard in the Stages tab.' };
  }
  const next = policy.next.length ? ' Next stages: ' + policy.next.join(', ') + '.' : '';
  return { block: true, reason: 'track guard: ' + what + ' is not allowed in stage "' + policy.stage + '" (' + policy.stageTitle
    + '). Allowed here: ' + describeAllowed(policy) + '.' + next
    + ' Call stage_status to see the stage, stage_advance to move on, or ask the owner to pause the guard in the Stages tab.' };
}

/** Decides one tool call. Unreadable policy ({error}) fails closed for skills, edits and subagent launches. */
export function decide(policy: Policy | PolicyError | null | undefined, toolName: string, input: unknown, env: Env = {}): Decision {
  if (!policy) return ALLOW;
  if (!isError(policy) && !policy.active) return ALLOW;
  const params: Record<string, unknown> = isObject(input) ? input : {};
  const allow = isError(policy) ? undefined : policy.allow;
  const command = typeof params.command === 'string' ? params.command : '';
  const isBash = matchesName(toolName, 'bash');

  if (STAGE_TOOL.test(toolName) || AUTOPILOT_SUBMIT.test(toolName)) return ALLOW;
  if (isBash && isTrackBash(command)) return ALLOW;

  if (allow?.denyTools?.some(t => matchesName(toolName, t))) return blocked(policy, 'tool "' + toolName + '"');

  // skills: undefined allow (error) means no skill is allowed
  const allowedSkills = isError(policy) ? [] : allow?.skills;
  if (allowedSkills) {
    const name = (p: string) => /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i.exec(p.replace(/\\/g, '/'))?.[1];
    if (matchesName(toolName, 'read')) {
      const p = targetPath(params);
      const skill = p && name(p);
      if (skill && !allowedSkills.includes(skill)) return blocked(policy, 'reading skill "' + skill + '"');
    }
    if (isBash) {
      for (const m of command.matchAll(/skills\/([^/\s"'`;&|()<>]+)\/SKILL\.md/gi)) {
        if (!allowedSkills.includes(m[1])) return blocked(policy, 'reading skill "' + m[1] + '"');
      }
    }
  }

  if (matchesName(toolName, 'edit') || matchesName(toolName, 'write')) {
    const p = targetPath(params);
    if (!p) return blocked(policy, 'editing without a target path');
    const resolved = resolvePath(p, env);
    const real = realPath(resolved);
    const state = stateDir(env);
    const stateRoots = [path.resolve(state), realPath(path.resolve(state))];
    const inSkillsDir = [resolved, real].some(x => path.basename(x) === 'stages.json' && path.dirname(x).split(path.sep).includes('skills'));
    if (inSkillsDir || stateRoots.some(r => isUnder(resolved, r) || isUnder(real, r))) {
      return blocked(policy, 'editing "' + p + '" (stage templates and policy files are protected while a run is active)');
    }
    if (isError(policy) || allow?.edits === false) {
      const roots = ['/tmp', ...(env.SANDY_THREAD_STORAGE ? [path.resolve(env.SANDY_THREAD_STORAGE)] : [])].flatMap(r => [r, realPath(r)]);
      // both the lexical and the symlink-resolved target must sit in an allowed root
      const ok = roots.some(r => isUnder(resolved, r)) && roots.some(r => isUnder(real, r));
      if (!ok) return blocked(policy, 'editing "' + p + '"');
    }
  }

  const launching = launchesOf(toolName, params);
  if (launching) {
    const { tool, launches } = launching;
    const patterns = allow?.subagents;
    if (isError(policy) && launches.length) return blocked(policy, 'launching ' + tool + ' ' + launchLabel(launches[0]));
    if (patterns) {
      const bad = launches.find(l => !launchAllowed(l, patterns));
      if (bad) return blocked(policy, 'launching ' + tool + ' ' + launchLabel(bad));
    }
  }
  return ALLOW;
}
