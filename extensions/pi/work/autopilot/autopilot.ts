/**
 * Autopilot: /autopilot [--report] <name> [args] and a `autopilot` tool. An autopilot is a TypeScript module whose default export is
 * `async (args, api) => result`, looked up in <cwd>/.pi/autopilots/<name>.ts first, then in the global templates
 * ~/.pi/agent/autopilots/<name>.ts. It is imported at call time, so an autopilot the orchestrator just wrote runs without
 * restarting Pi. With --report the command hands the JSON result to the SANDY workflow call running in this thread
 * (`sandy work workflows-plus result`), so a workflow can start an autopilot with a raw prompt and get its value back.
 * `api.session` (session.ts) lets a /autopilot command steer its own session turn by turn. `api.track` (track.ts) is this
 * thread's sandy work track client, or null outside sandy; an autopilot may start a track with it.
 * Track stations (Track drivers v2, sandy/work/track/docs/design-v2.md §7): the track plugin launches a stage's autopilot with
 * "/autopilot --lease <ticket> <name> [args]". The autopilot then gets `api.lease`, the claimed lease of that one stage
 * visit; when it returns or throws still holding the lease, the stage is released to the agent (the plugin tells it).
 * /autopilot resume (autopilots/resume.ts) continues the newest unfinished plan-run of this session after pi reloaded or
 * restarted in the middle of it; the run's state lives in session entries, not in the autopilot module (docs/resume.md).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installSession, type Session, type SessionBinding } from "./session.ts";
import { createTrackClient, LeaseLost, type LeaseTrack, type TrackClient } from "./track.ts";
import { LEASE_MARKER, usageForTicket, type SessionEntryLike } from "./usage.ts";
import { sandyCli, workCliArgs } from "../sandy-cli.ts";

function locate(cwd: string, name: string): string {
	if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`bad autopilot name ${name}`);
	const candidates = [join(cwd, ".pi", "autopilots", `${name}.ts`), join(homedir(), ".pi", "agent", "autopilots", `${name}.ts`)];
	const file = candidates.find((path) => existsSync(path));
	if (!file) throw new Error(`no autopilot ${name} in ${candidates.join(" or ")}`);
	return file;
}

async function runAutopilot(cwd: string, name: string, args: unknown, api: unknown): Promise<unknown> {
	const mod = await import(`${pathToFileURL(locate(cwd, name)).href}?t=${Date.now()}`);
	return await mod.default(args, api);
}

async function report(value: unknown): Promise<void> {
	await sandyCli({ timeoutMs: 60_000 })(workCliArgs("workflows-plus", "result", "--value", JSON.stringify(value)));
}

const RETRY_DELAYS_MS = [2_000, 10_000];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A report: true call ends only on a reported value, so a lost report would leave it waiting until the run times out.
 * The value is retried; if it never lands (SANDY busy, value rejected), a short error value is reported instead.
 * Throws only when even that fails.
 */
export async function deliver(
	send: (value: unknown) => Promise<void>,
	value: unknown,
	wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
	let failure: unknown;
	for (const delay of [0, ...RETRY_DELAYS_MS]) {
		if (delay) await wait(delay);
		try {
			return await send(value);
		} catch (error) {
			failure = error;
		}
	}
	const reason = failure instanceof Error ? failure.message : String(failure);
	await send({ error: `could not report the autopilot result: ${reason}` });
}

/**
 * The api an autopilot gets. With a lease, api.session is bound to lease.signal (it stops when the lease ends) and waits
 * for a settled session before every step (a fallback opening turn may be running).
 */
export function autopilotApi(
	deps: { pi: unknown; sessionFor: (ctx: any, binding?: SessionBinding) => Session; track: TrackClient | null; turnRequested?: () => void },
	ctx: any,
	lease: LeaseTrack | null,
) {
	const binding = lease ? { signal: lease.signal, settled: () => settledSession(ctx), turnRequested: deps.turnRequested } : undefined;
	return { ctx, pi: deps.pi, session: deps.sessionFor(ctx, binding), track: deps.track, lease };
}

export default function (pi: any) {
	const sessionFor = installSession(pi);
	const turnWaiters = new Set<() => void>();
	/** A turn counts as started once a lease's step asks for it: pi starts the run only after its preparation
	 * (compaction, before_agent_start), and a fallback opening sent meanwhile would be steered into that step. */
	const turnRequested = () => {
		for (const started of turnWaiters) started();
		turnWaiters.clear();
	};
	pi.on("agent_start", turnRequested);
	/** Resolves true when the next agent run starts, false when none started within ms. */
	const turnStarted = (ms: number) =>
		new Promise<boolean>((resolve) => {
			const started = () => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				turnWaiters.delete(started);
				resolve(false);
			}, ms);
			turnWaiters.add(started);
		});
	const apiFor = (ctx: any, lease: LeaseTrack | null = null) => autopilotApi({ pi, sessionFor, track: createTrackClient(), turnRequested }, ctx, lease);
	const runCalled = (ctx: any, name: string, args: unknown) => runAutopilot(ctx.cwd, name, args, apiFor(ctx));

	pi.registerCommand("autopilot", {
		description: "Run an autopilot from .pi/autopilots or ~/.pi/agent/autopilots; --report hands the result to the SANDY workflow",
		handler: async (input: string, ctx: any) => {
			const words = input.trim().split(/\s+/);
			if (words[0] === "--lease") {
				const [, ticket, name, ...rest] = words;
				const args = rest.join(" ");
				if (!ticket || !name) {
					pi.sendMessage({ customType: "autopilot", content: "Usage: /autopilot --lease <ticket> <name> [args]\nReply only with: ok", display: true }, { triggerTurn: true });
					return;
				}
				const client = createTrackClient();
				// Detached like --report: the bridge waits for the command inside its turn/start request.
				setTimeout(() => {
					void handleLeaseCommand(
						{ ticket, name, args },
						{ pi, client, branch: () => ctx.sessionManager.getBranch(), turnStarted, run: (lease) => runAutopilot(ctx.cwd, name, args, apiFor(ctx, lease)) },
					).catch((error) => console.error(`[autopilot] ${name} --lease ${ticket}: ${message(error)}`));
				}, 0);
				return;
			}
			const reporting = words[0] === "--report";
			const [name, ...rest] = reporting ? words.slice(1) : words;
			const drive = async () => {
				try {
					return await runCalled(ctx, name, rest.join(" "));
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			};
			if (reporting) {
				// SANDY's bridge waits for the command inside its turn/start request, which times out after about 30 seconds.
				// A reporting autopilot runs detached so turn/start returns; the call waits for the reported value instead.
				setTimeout(() => void finish(name, true, drive()), 0);
				return;
			}
			await finish(name, false, drive());
		},
	});

	async function finish(name: string, reporting: boolean, pending: Promise<unknown>) {
		const result = await pending;
		const text = `[autopilot] ${name} -> ${JSON.stringify(result)}`;
		console.log(text);
		if (!reporting) {
			// triggerTurn: false keeps it out of a running turn: pi steers a message without it into that turn, which costs a
			// whole extra model call over the full context.
			pi.sendMessage({ customType: "autopilot", content: text, display: true }, { triggerTurn: false });
			return;
		}
		try {
			await deliver(report, result);
		} catch (error) {
			console.error(`[autopilot] ${name}: could not report: ${error instanceof Error ? error.message : String(error)}`);
		}
		// A command alone never ends a turn in SANDY's Pi bridge, so the worker would stay busy. One short turn ends it
		// and leaves the autopilot result in the session context for a later continuation.
		pi.sendMessage(
			{ customType: "autopilot", content: `${text}\nThe autopilot result is recorded. Reply only with: ok`, display: true },
			{ triggerTurn: true },
		);
	}

	pi.registerTool({
		name: "autopilot",
		label: "Autopilot",
		description:
			"Run the autopilot <name> (.pi/autopilots or ~/.pi/agent/autopilots) with args and return its JSON result. The test autopilots take args as the string '<repo> <test file>'.",
		parameters: {
			type: "object",
			properties: { name: { type: "string" }, args: { type: ["object", "string"] } },
			required: ["name"],
		},
		async execute(_id: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
			const result = await runCalled(ctx, params.name, params.args ?? {});
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type LeaseCommandDeps = {
	pi: { appendEntry(customType: string, data: unknown): void; sendMessage(message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean }): void };
	/** null outside a sandy thread. */
	client: TrackClient | null;
	/** The session's active branch (ctx.sessionManager.getBranch()), for the lease's measured usage. */
	branch: () => readonly SessionEntryLike[];
	/** Resolves true when the next agent run starts, false when none started within ms. */
	turnStarted: (ms: number) => Promise<boolean>;
	/** Runs the autopilot with api.lease. */
	run: (lease: LeaseTrack) => Promise<unknown>;
};

/**
 * Waits until the session is idle with nothing queued and stays so for one poll. sendMessage with triggerTurn may start
 * its turn after a tick, so one waitForIdle alone can resolve before a fallback opening turn even began.
 */
export async function settledSession(ctx: { waitForIdle(): Promise<void>; isIdle(): boolean; hasPendingMessages(): boolean }, pollMs = 100, limit = 3000): Promise<void> {
	for (let i = 0; i < limit; i++) {
		await ctx.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		if (ctx.isIdle() && !ctx.hasPendingMessages()) return;
	}
	throw new Error("the session never became idle");
}

/**
 * How long a launched autopilot may go without starting an agent turn before it gets a fallback opening turn. That turn
 * costs a whole model call over the full context, and autopilots that run a command first (verify) often need more than
 * 20 s; sandy fails an unstarted turn only after 120 s (provider_turn_start_timeout), so 90 s leaves margin.
 */
const OPENING_FALLBACK_MS = 90_000;

/**
 * "/autopilot --lease <ticket> <name> [args]", sent by the track plugin's launch effect (sandy/work/track/docs/design-v2.md §7).
 * Claims the lease with a fresh invocation id, marks the session so its model work counts for this lease (usage.ts),
 * runs the autopilot right away, and finally releases the lease if the autopilot still holds it and closes it.
 * sandy's bridge needs the command to start an agent turn (probes-v2 (a)); the autopilot's first step is that turn, with
 * no extra turn that would cost a full uncached request. Only an autopilot that starts no turn within
 * OPENING_FALLBACK_MS gets one short opening message with triggerTurn; one that returns before any turn started ends
 * the sandy turn with its result message. A stale ticket or a failed claim gets the opening message at once.
 */
export async function handleLeaseCommand(input: { ticket: string; name: string; args: string }, deps: LeaseCommandDeps): Promise<void> {
	const { pi, client } = deps;
	const { ticket, name } = input;
	const open = (text: string) => pi.sendMessage({ customType: "autopilot", content: `${text}\nReply only with: ok`, display: true }, { triggerTurn: true });
	if (!client) return open(`[autopilot] ${name}: no sandy thread, lease ${ticket} not taken.`);
	let lease: LeaseTrack;
	try {
		lease = await client.openLease(ticket, { usage: () => usageForTicket(deps.branch(), ticket) });
	} catch (error) {
		const why = error instanceof LeaseLost ? `stale launch, the lease ${error.end ? `ended (${error.end.kind})` : "is not current"}` : `could not claim: ${message(error)}`;
		return open(`[autopilot] ${name}: ${why} (lease ${ticket}).`);
	}
	pi.appendEntry(LEASE_MARKER, { ticket });
	// A sandy turn is running once the autopilot started one or the fallback opened one.
	let turnOpened = false;
	let finished = false;
	void deps.turnStarted(OPENING_FALLBACK_MS).then((started) => {
		if (finished) return;
		turnOpened = true;
		if (!started) open(`[autopilot] ${name} drives stage "${lease.station.title}" (lease ${ticket}). Do not act on this stage meanwhile.`);
	});
	let text: string;
	let releaseReason = `autopilot ${name} returned without advancing`;
	try {
		text = `[autopilot] ${name} -> ${JSON.stringify(await deps.run(lease))}`;
	} catch (error) {
		releaseReason = `autopilot ${name} failed: ${message(error)}`;
		text = `[autopilot] ${name} failed: ${message(error)}`;
	} finally {
		try {
			if (!lease.signal.aborted) await lease.release(releaseReason);
		} catch (error) {
			console.error(`[autopilot] ${name}: release failed: ${message(error)}`);
		}
		lease.close();
	}
	console.log(text);
	finished = true;
	// triggerTurn: false: a step of the next lease may already be running; pi would steer the result into it as one more
	// model call over the full context. Without a running turn it is only appended.
	if (turnOpened) pi.sendMessage({ customType: "autopilot", content: text, display: true }, { triggerTurn: false });
	else open(text);
}
