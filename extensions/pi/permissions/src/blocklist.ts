import path from 'node:path';

/**
 * Hard command blocklist. Unlike rules and heuristics it applies in every mode
 * (including yolo and read-only) and never asks: a blocked program only runs
 * when an explicit allow entry matches.
 *
 * Best-effort lexical analysis of shell text, not an OS sandbox. It resolves
 * quoting, separators, subshells, command substitution, common wrappers
 * (env, sudo, xargs, nohup, ...), `sh -c`/eval strings and `find -exec`. It
 * cannot see through variables (`$cmd host`), aliases or scripts on disk.
 */
export type BlockedCommands = {
  /** Program basenames that are blocked, e.g. "ssh". */
  programs: string[];
  /**
   * Exceptions as word prefixes, e.g. "ssh AI": the program and the following
   * words must match exactly, and the next word (the remote command) must not
   * be an option, because `ssh AI -o ProxyCommand=...` would run locally.
   */
  allow: string[];
};

export const DEFAULT_BLOCKED_COMMANDS: BlockedCommands = {
  programs: ['ssh', 'scp', 'sftp', 'rsync', 'sshfs', 'ssh-copy-id', 'mosh', 'autossh'],
  allow: ['ssh AI'],
};

const MAX_DEPTH = 8;
const SUBST = '\u0001';
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'coproc', 'function']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
/** Wrapper -> options that consume the next word. Wrappers run the first non-option word. */
const WRAPPERS: Record<string, string[]> = {
  command: [], builtin: [], exec: ['-a'], nohup: [], setsid: [], time: ['-f', '-o'], nice: ['-n'],
  ionice: ['-c', '-n', '-p'], stdbuf: [], unbuffer: [], caffeinate: [], chronic: [],
  env: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-r', '-t'], doas: ['-u', '-C'],
  timeout: ['-s', '-k', '--signal', '--kill-after'], xargs: ['-I', '-n', '-P', '-d', '-E', '-L', '-s', '-a', '-l', '-i'],
  watch: ['-n', '--interval'], flock: ['-w', '-E'],
};
const NEEDS_POSITIONAL = new Set(['timeout', 'flock']);

type Segments = string[][];

function matchingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') i++;
    else if (ch === "'") { const j = src.indexOf("'", i + 1); i = j === -1 ? src.length : j; }
    else if (ch === '"') { for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++; }
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return src.length;
}

function closingBacktick(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '`') return i;
  }
  return src.length;
}

/** Split shell text into simple commands (lists of unquoted words), recursing into substitutions. */
export function parseSegments(src: string, out: Segments = [], depth = 0): Segments {
  if (depth > MAX_DEPTH) return out;
  let words: string[] = [];
  let cur = '';
  let started = false;
  const flush = () => { if (started) words.push(cur); cur = ''; started = false; };
  const endSegment = () => { flush(); if (words.length) out.push(words); words = []; };
  const nested = (inner: string) => { parseSegments(inner, out, depth + 1); cur += SUBST; started = true; };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '\\') {
      if (next === '\n') { i++; continue; }
      if (next !== undefined) { cur += next; started = true; i++; }
    } else if (ch === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j === -1 ? src.length : j;
      cur += src.slice(i + 1, end); started = true; i = end;
    } else if (ch === '"') {
      started = true;
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\') { if (src[j + 1] !== undefined) cur += src[++j]; }
        else if (src[j] === '$' && src[j + 1] === '(') {
          const close = matchingParen(src, j + 1);
          nested(src.slice(j + 2, close)); j = close;
        } else if (src[j] === '`') {
          const close = closingBacktick(src, j);
          nested(src.slice(j + 1, close)); j = close;
        } else cur += src[j];
      }
      i = j;
    } else if ((ch === '$' || ch === '<' || ch === '>') && next === '(') {
      const close = matchingParen(src, i + 1);
      nested(src.slice(i + 2, close)); i = close;
    } else if (ch === '`') {
      const close = closingBacktick(src, i);
      nested(src.slice(i + 1, close)); i = close;
    } else if (ch === ' ' || ch === '\t') flush();
    else if (ch === '#' && !started) { while (i < src.length && src[i] !== '\n') i++; i--; }
    else if (ch === '\n' || ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') endSegment();
    else { cur += ch; started = true; }
  }
  endSegment();
  return out;
}

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word);
const isRedirect = (word: string) => /^\d*(>>?|<|<<<?|>&|<&|&>>?)/.test(word);
const redirectTakesNext = (word: string) => /^\d*(>>?|<|<<<?|>&|<&|&>>?)$/.test(word);
const baseName = (word: string) => path.basename(word);

/** Resolve one simple command to the commands it actually runs (wrappers unwrapped). */
function effectiveCommands(words: string[], out: Segments, depth: number): void {
  if (depth > MAX_DEPTH) return;
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (isAssignment(word) || RESERVED.has(word)) i++;
    else if (isRedirect(word)) i += redirectTakesNext(word) ? 2 : 1;
    else break;
  }
  const command = words.slice(i);
  if (!command.length) return;
  out.push(command);
  const program = baseName(command[0]);
  const args = command.slice(1);

  if (SHELLS.has(program)) {
    const flag = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    if (flag !== -1 && args[flag + 1] !== undefined) scriptCommands(args[flag + 1], out, depth + 1);
    return;
  }
  if (program === 'eval') { scriptCommands(args.join(' '), out, depth + 1); return; }
  if (program === 'find') {
    for (let k = 0; k < args.length; k++) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[k])) continue;
      const end = args.findIndex((arg, at) => at > k && (arg === ';' || arg === '+'));
      effectiveCommands(args.slice(k + 1, end === -1 ? undefined : end), out, depth + 1);
    }
    return;
  }
  const withValue = WRAPPERS[program];
  if (!withValue) return;
  let k = 0;
  let skippedPositional = !NEEDS_POSITIONAL.has(program);
  while (k < args.length) {
    const arg = args[k];
    if (program === 'env' && isAssignment(arg)) k++;
    else if ((program === 'env' && (arg === '-S' || arg === '--split-string')) && args[k + 1] !== undefined) {
      scriptCommands(args[k + 1], out, depth + 1); return;
    } else if (withValue.includes(arg)) k += 2;
    else if (arg === '--') { k++; break; }
    else if (arg.startsWith('-')) k++;
    else if (!skippedPositional) { skippedPositional = true; k++; }
    else break;
  }
  effectiveCommands(args.slice(k), out, depth + 1);
}

function scriptCommands(script: string, out: Segments, depth: number): void {
  for (const segment of parseSegments(script, [], depth)) effectiveCommands(segment, out, depth);
}

/** Every command the shell text would run, in no particular order. */
export function commandsIn(command: string): Segments {
  const out: Segments = [];
  for (const segment of parseSegments(command)) effectiveCommands(segment, out, 0);
  return out;
}

function allowedBy(rule: string, command: string[]): boolean {
  const prefix = rule.trim().split(/\s+/).filter(Boolean);
  if (!prefix.length || command.length < prefix.length) return false;
  if (!prefix.every((word, at) => (at === 0 ? baseName(command[0]) : command[at]) === word)) return false;
  const remote = command[prefix.length];
  return remote === undefined || !remote.startsWith('-');
}

/** The reason a command is blocked, or undefined when every command it runs is permitted. */
export function blockedCommandReason(command: string, rules: BlockedCommands): string | undefined {
  if (!rules.programs.length) return undefined;
  for (const words of commandsIn(command)) {
    const program = baseName(words[0]);
    if (!rules.programs.includes(program)) continue;
    if (rules.allow.some(rule => allowedBy(rule, words))) continue;
    const shown = words.map(word => word.replaceAll(SUBST, '$(...)')).join(' ').slice(0, 120);
    const allowed = rules.allow.filter(rule => rule.trim().split(/\s+/)[0] === program);
    return `Blocked by permissions policy: ${program} is not allowed (\`${shown}\`).${allowed.length ? ` Allowed: ${allowed.join(', ')}.` : ''}`;
  }
  return undefined;
}
