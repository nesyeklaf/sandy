import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
// Relative import across packages (docs/decisions.md): track-guard and pi/autopilot are installed from one checkout.
import { LEASE_MARKER, LEASE_METERED, latestMarker, unreportedTickets, usageForTicket, type SessionEntryLike } from '../../autopilot/usage.ts';
import { decide, parsePolicy, stateDir, type Env, type Policy, type PolicyError } from './policy.ts';
import { sandyCli, workCliArgs, type RunSandy } from '../../sandy-cli.ts';

type Cached = { key: string; policy: Policy | PolicyError };

/** Lease calls: the guard writes the agent's ticket into them (sandy/work/track/docs/design-v2.md §8). */
const LEASE_TOOL = /(^|__)stage_(submit|advance|propose_force)$/;
/** Calls whose usage is reported: the lease's measured tokens travel with its submissions and its advance. */
const USAGE_TOOL = /(^|__)stage_(submit|advance)$/;
/** Results that can hand the agent a new lease; such a result's text ends with the line "⟦track-ticket⟧ <ticket>". */
const TICKET_RESULT = /(^|__)stage_(start|advance)$/;
/**
 * The terminal line only: the plugin removes the marker from the rest of every result (sandy/work/track/POLICY.md), so a
 * ticket line inside echoed outputs or inputs is never read. Same marker as TICKET_MARKER in sandy/work/track/server.ts.
 */
const TICKET_LINE = /\n⟦track-ticket⟧ (\S+)$/;

/**
 * Hard-gates tool calls by the stage policy file of the current SANDY thread (see sandy/work/track/POLICY.md). No-op outside stage runs.
 * It also carries the agent's lease ticket: captured from what the plugin told the agent (a stage_start/stage_advance
 * result, or the policy file when a turn starts), and written into every stage_submit/advance/propose_force call, top
 * level or nested, overwriting whatever the model typed. A model therefore can only act for the lease it was told about.
 *
 * It is also the usage meter of every lease marker in its session (agent or autopilot runner alike), late and read-only:
 * when a turn ends or starts and the newest marker is no longer the policy file's current ticket, the lease is over, so
 * the guard reports what the session measured for it (`sandy work track usage`) and appends an end marker. The report completes
 * a closed lease's usage (the closing reply after stage_advance, an owner abort); it never moves the track.
 */
export default function stageGuardExtension(
  pi: ExtensionAPI,
  options: {
    env?: Env;
    /** Runs the sandy CLI for the late report; the shared runner (SANDY_CLI or `sandy`) by default. */
    sandy?: RunSandy;
    /** Where a failed report is noted; stderr by default. */
    log?: (message: string) => void;
  } = {},
): void {
  const cache = new Map<string, Cached>();
  /** The agent's lease ticket; null while the agent drives nothing. */
  let ticket: string | null = null;

  function load(file: string): Policy | PolicyError | null {
    let key: string;
    try {
      const st = statSync(file);
      key = [st.mtimeMs, st.size, st.ino].join(':');
    } catch (e) {
      cache.delete(file);
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
      return { error: 'cannot stat policy file: ' + (e as Error).message };
    }
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.policy;
    let policy: Policy | PolicyError;
    try { policy = parsePolicy(readFileSync(file, 'utf8')); } catch (e) { return { error: 'cannot read policy file: ' + (e as Error).message }; }
    cache.set(file, { key, policy });
    return policy;
  }

  function policyFile(): Policy | PolicyError | null {
    const env = options.env ?? process.env;
    const threadId = env.SANDY_THREAD_ID;
    if (!threadId || threadId !== path.basename(threadId) || threadId === '..') return null;
    return load(path.join(stateDir(env), 'threads', threadId + '.json'));
  }

  const branchOf = (ctx: { sessionManager?: { getBranch(): unknown[] } }): SessionEntryLike[] => (ctx.sessionManager?.getBranch() ?? []) as SessionEntryLike[];

  /** Takes a new ticket; the session's later model work counts for its lease from the marker on. */
  function capture(next: string | null, ctx: { sessionManager?: { getBranch(): unknown[] } }): void {
    ticket = next;
    if (next !== null && latestMarker(branchOf(ctx)) !== next) pi.appendEntry(LEASE_MARKER, { ticket: next });
  }

  /**
   * Reports the usage of every marked lease that is no longer the current one and was not reported yet (state read from
   * the session entries). Recording that a lease was reported never touches the attribution of a newer lease: the end
   * marker is appended only when the newest marker itself is the ended lease. Only leases of the policy's current run or the
   * newest marker's run are sent (the plugin keeps no other run, it would refuse them as stale); older runs' leases in a
   * long session history are recorded as handled without a CLI call. Reports go out one at a time.
   */
  function meterEndedLease(ctx: { sessionManager?: { getBranch(): unknown[] } }): void {
    const branch = branchOf(ctx);
    const pending = unreportedTickets(branch);
    if (pending.length === 0) return;
    const policy = policyFile();
    if (policy && 'error' in policy) return; // cannot tell which lease is current: report later
    const newest = latestMarker(branch);
    const ended = pending.filter((marked) => !(policy && policy.running !== false && policy.ticket === marked));
    const runs = new Set([policy?.ticket ? runOf(policy.ticket) : '', newest === null ? '' : runOf(newest)].filter(r => r !== ''));
    for (const marked of ended) {
      if (marked !== newest) pi.appendEntry(LEASE_METERED, { ticket: marked });
      if (runs.has(runOf(marked))) report(marked, usageForTicket(branch, marked));
    }
    if (newest !== null && ended.includes(newest)) pi.appendEntry(LEASE_MARKER, { ticket: null });
  }

  function report(marked: string, usage: ReturnType<typeof usageForTicket>): void {
    if (usage === null) return;
    const env = options.env ?? process.env;
    const sandy = options.sandy ?? sandyCli({ env });
    const log = options.log ?? ((message: string) => console.error(message));
    const args = workCliArgs('track', 'usage', '--ticket', marked, '--usage', JSON.stringify(usage));
    const threadId = env.SANDY_THREAD_ID;
    if (threadId) args.push('--thread', threadId);
    reports = reports.then(() => sandy(args)).then(
      () => {},
      (e: unknown) => log(`track-guard: usage report for ${marked} failed: ${(e as Error).message}`),
    );
  }
  /** The chain of late usage reports: one CLI call at a time. */
  let reports: Promise<void> = Promise.resolve();
  /** A ticket's run id: tickets are "<runId>.<seq>". */
  const runOf = (ticket: string) => ticket.slice(0, Math.max(0, ticket.lastIndexOf('.')));

  pi.on('agent_end', (_event, ctx) => { meterEndedLease(ctx); });

  // A turn starts: the plugin told the agent about its lease (or the user typed). The policy file names the current
  // lease, also while the owner paused the guard; an autopilot's lease or no run leaves the agent without a ticket.
  pi.on('agent_start', (_event, ctx) => {
    meterEndedLease(ctx);
    const policy = policyFile();
    if (!policy || 'error' in policy) return;
    const agentDrives = policy.running !== false && (policy.driver?.kind ?? 'agent') === 'agent' && typeof policy.ticket === 'string' && policy.ticket !== '';
    capture(agentDrives ? policy.ticket! : null, ctx);
  });

  pi.on('tool_result', (event, ctx) => {
    if (event.isError || !TICKET_RESULT.test(event.toolName)) return undefined;
    const text = event.content.map(c => (c.type === 'text' ? c.text : '')).join('\n');
    const found = TICKET_LINE.exec('\n' + text)?.[1];
    if (found) capture(found, ctx);
    return undefined;
  });

  pi.on('tool_call', (event, ctx) => {
    if (LEASE_TOOL.test(event.toolName)) {
      const input = event.input as Record<string, unknown>;
      delete input.ticket;
      delete input.usage;
      if (ticket !== null) {
        input.ticket = ticket;
        const usage = USAGE_TOOL.test(event.toolName) ? usageForTicket(branchOf(ctx), ticket) : null;
        if (usage) input.usage = usage;
      }
    }
    const decision = decide(policyFile(), event.toolName, event.input, options.env ?? process.env);
    return decision.block ? { block: true, reason: decision.reason } : undefined;
  });
}
