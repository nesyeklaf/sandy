/**
 * The autopilot's handle on this thread's track (sandy/work/track, Track drivers v2: sandy/work/track/docs/design-v2.md §6, §7). It wraps
 * the driver CLI `sandy work track drive <command> --json` (`SANDY_CLI` overrides the sandy binary). The plugin owns every transition;
 * this client only asks it. Replies are sandy/work/track/run.ts Reply values as JSON.
 *
 * Two handles: TrackClient starts a track from a user-invoked autopilot and opens leases; LeaseTrack is one claimed
 * lease, the stage visit the plugin launched this process for (/autopilot --lease <ticket>). A LeaseTrack never follows
 * the track to another stage: once its lease ends (advanced, forced, switched, released, expired, aborted) every call
 * rejects with LeaseLost, and the plugin launches or tells whoever drives next.
 */
import { randomUUID } from "node:crypto";
import type { Env, StageDriver } from "./policy.ts";
import type { LeaseUsage } from "./usage.ts";
import { sandyCli, workCliArgs, type RunSandy } from "../sandy-cli.ts";

export type { RunSandy };

/** sandy/work/track/run.ts StationView as the CLI returns it (JSON); the client does not re-validate driver semantics. */
export type LeaseStation = {
	runId: string;
	ticket: string;
	track: string;
	stage: string;
	title: string;
	driver: StageDriver;
	cause: string;
	causeText: string;
	inputs: Record<string, string>;
	submissions: { outputs: Record<string, string>; evidence: { kind: string; name: string; [key: string]: unknown }[] };
	missingOutputs: string[];
	next: string[];
	work: { kind: string; id: number; [key: string]: unknown } | null;
	outcome: { kind: string; workId: number; [key: string]: unknown } | null;
	previous: { seq: number; end: LeaseEnd; submissions: LeaseStation["submissions"]; [key: string]: unknown } | null;
};
export type LeaseEnd = { kind: string; [key: string]: unknown };

export type DriveOutcome =
	| { kind: "entered"; station: LeaseStation } // this process is done: the plugin launches or tells the next driver
	| { kind: "finished" }
	| { kind: "refused"; reasons: string[] } // still holding the lease; the autopilot may fix and retry
	| { kind: "lost"; end: LeaseEnd | null }; // the lease ended under us (force, switch, abort, expired)

/**
 * One claimed lease. Every method but advance and release rejects with LeaseLost (and signal aborts) once the plugin
 * answers stale/closed.
 * INVARIANT C1: a LeaseTrack never outlives its lease: no method retargets another ticket.
 * INVARIANT C2: while open, a timer renews the claim every heartbeatMs via status --lease <grant>.
 */
export type LeaseTrack = {
	readonly station: LeaseStation;
	readonly signal: AbortSignal;
	submit(input: { outputs?: Record<string, string>; evidence?: Record<string, string> }): Promise<LeaseStation>;
	/** Host-run command, recorded by the plugin as ran evidence <label>; resolves when done (polls status). */
	run(input: { label: string; command: string; timeoutSec?: number }): Promise<{ exitCode: number; tail: string } | { interrupted: true }>;
	/** Resolves when the gate settles (polls status while pending, including owner approval). */
	advance(input?: { to?: string; note?: string }): Promise<DriveOutcome>;
	/** Asks the owner to force the run to another stage; approved means this lease is gone. */
	proposeForce(input: { to: string; reason: string }): Promise<{ approved: boolean }>;
	/** Hands the stage to the agent. Idempotent: an ended lease (or a stale reply) is { released: false }. */
	release(reason: string): Promise<{ released: boolean }>;
	/** Stops the heartbeat. Called by the runner. */
	close(): void;
};

export class LeaseLost extends Error {
	readonly end: LeaseEnd | null;
	constructor(end: LeaseEnd | null) {
		super(end ? `the lease ended (${end.kind})` : "the lease is not current");
		this.end = end;
		this.name = "LeaseLost";
	}
}

export type TrackClient = {
	/** From a user-invoked autopilot. driveAll sends --autopilot <name>, which sets the plan's track driver. */
	start(
		input: { skill: string } | { machine: unknown },
		options?: { driveAll?: { name: string; args?: string }; note?: string },
	): Promise<{ kind: "started"; ticket: string } | { kind: "proposed" } | { kind: "refused"; reasons: string[] }>;
	/** The current station, or null when the thread has no active track. */
	status(): Promise<LeaseStation | null>;
	/** Claims with a fresh invocation id. Rejects with LeaseLost when stale or claimed by another invocation. usage: this lease's measured usage, sent with submit, advance and release. */
	openLease(ticket: string, options?: { usage?: () => LeaseUsage | null }): Promise<LeaseTrack>;
};

export type TrackClientOptions = {
	sleep?: (ms: number) => Promise<void>;
	/** Poll interval while a run, gate or force proposal is pending, and between publishing retries. */
	pollMs?: number;
	/** Claim renewal interval; the plugin's HEARTBEAT_SEC is 90, renewed at a third of it. */
	heartbeatMs?: number;
	newInvocation?: () => string;
};

/** The largest ad-hoc machine JSON start sends: a plugin CLI call carries at most 64 KiB, the rest is left for the other arguments. */
const MACHINE_LIMIT_BYTES = 60 * 1024;
/** How long a reply may say "publishing" (the guard policy of the last change is not written yet) before giving up. */
const PUBLISH_RETRIES = 30;

type Reply = { kind: string; [key: string]: any };

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const unexpected = (command: string, reply: Reply) => new Error(`sandy work track drive ${command}: unexpected reply ${JSON.stringify(reply).slice(0, 300)}`);
const refused = (command: string, reasons: string[]) => new Error(`sandy work track drive ${command} refused: ${reasons.join("; ")}`);

/** The thread's track client, or null outside a sandy thread (no SANDY_THREAD_ID). */
export function createTrackClient(env: Env = process.env, sandy: RunSandy = sandyCli({ env, timeoutMs: 120_000 }), options: TrackClientOptions = {}): TrackClient | null {
	if (!env.SANDY_THREAD_ID) return null;
	const sleep = options.sleep ?? sleepMs;
	const pollMs = options.pollMs ?? 2_000;
	const heartbeatMs = options.heartbeatMs ?? 30_000;
	const newInvocation = options.newInvocation ?? (() => randomUUID());

	/**
	 * One CLI call; "publishing" is retried, since the plugin refuses lease work until the guard policy is written.
	 * "unpublished" is not: the plugin committed this command but could not write its guard policy, so repeating it
	 * would act twice. It is an error; the plugin retries the write and launches or tells whoever drives next.
	 */
	const drive = async (command: string, args: string[]): Promise<Reply> => {
		for (let attempt = 0; ; attempt++) {
			const stdout = await sandy(workCliArgs("track", "drive", command, ...args, "--json"));
			let reply: Reply;
			try {
				reply = JSON.parse(stdout);
			} catch {
				throw new Error(`sandy work track drive ${command} returned no JSON: ${stdout.slice(0, 200)}`);
			}
			if (reply.kind === "unpublished")
				throw new Error(`sandy work track drive ${command}: committed as rev ${reply.rev}, but the guard policy is not written (${reply.error}); the plugin retries the write`);
			if (reply.kind !== "publishing") return reply;
			if (attempt >= PUBLISH_RETRIES) throw new Error(`sandy work track drive ${command}: the guard policy (rev ${reply.rev}) is still not written`);
			await sleep(pollMs);
		}
	};

	function openTrack(ticket: string, grant: string, first: LeaseStation, usageOf: () => LeaseUsage | null): LeaseTrack {
		const controller = new AbortController();
		let station = first;
		let lostEnd: LeaseEnd | null = null;
		/** The stale or closed reply that ended the lease, whoever read it (a heartbeat or a call); pending calls settle from it. */
		let terminal: Reply | null = null;
		const end = (endOf: LeaseEnd | null, reply: Reply | null = null) => {
			if (controller.signal.aborted) return;
			lostEnd = endOf;
			terminal = reply;
			clearInterval(timer);
			controller.abort(new LeaseLost(endOf));
		};
		const usageArgs = () => {
			const usage = usageOf();
			return usage ? ["--usage", JSON.stringify(usage)] : [];
		};
		/** A lease command; stale or closed ends the lease. */
		const call = async (command: string, args: string[]): Promise<Reply> => {
			if (controller.signal.aborted) throw new LeaseLost(lostEnd);
			const reply = await drive(command, ["--grant", grant, ...args]);
			if (reply.kind === "stale" || reply.kind === "closed") {
				end(reply.kind === "closed" ? reply.end : null, reply);
				throw new LeaseLost(lostEnd);
			}
			return reply;
		};
		/** status --lease: renews the claim and reads the settled outcome. */
		const status = async (): Promise<Reply> => {
			if (controller.signal.aborted) throw new LeaseLost(lostEnd);
			const reply = await drive("status", ["--lease", grant]);
			if (reply.kind === "closed" || reply.kind === "stale") end(reply.kind === "closed" ? reply.end : null, reply);
			else if (reply.kind === "current") station = reply.station;
			return reply;
		};
		/** Polls until the pending job workId settled: its outcome, or the reply that ended the lease. */
		const settle = async (workId: number): Promise<{ outcome: NonNullable<LeaseStation["outcome"]> } | { closed: Reply }> => {
			for (;;) {
				await sleep(pollMs);
				if (terminal !== null) return { closed: terminal };
				const reply = await status();
				if (reply.kind === "closed" || reply.kind === "stale") return { closed: reply };
				if (reply.kind !== "current") throw unexpected("status", reply);
				const now: LeaseStation = reply.station;
				if (now.work?.id !== workId && now.outcome?.workId === workId) return { outcome: now.outcome };
				if (now.work?.id !== workId) throw new Error(`sandy work track drive status: job ${workId} ended without an outcome`);
			}
		};
		const timer = setInterval(() => {
			status().catch(() => {}); // a failed renewal is retried by the next beat; expiry is the plugin's call
		}, heartbeatMs);
		timer.unref?.();

		return {
			get station() {
				return station;
			},
			signal: controller.signal,
			async submit(input) {
				const args = [
					...(input.outputs ? ["--outputs", JSON.stringify(input.outputs)] : []),
					...(input.evidence ? ["--evidence", JSON.stringify(input.evidence)] : []),
					...usageArgs(),
				];
				const reply = await call("submit", args);
				if (reply.kind === "accepted") return (station = reply.station);
				if (reply.kind === "refused") throw refused("submit", reply.reasons);
				if (reply.kind === "busy") throw new Error(`sandy work track drive submit: busy (${reply.work.kind} job running)`);
				throw unexpected("submit", reply);
			},
			async run(input) {
				const args = ["--label", input.label, "--command", input.command, ...(input.timeoutSec ? ["--timeout", String(input.timeoutSec)] : [])];
				const reply = await call("run", args);
				if (reply.kind === "refused") throw refused("run", reply.reasons);
				if (reply.kind === "busy") throw new Error(`sandy work track drive run: busy (${reply.work.kind} job running)`);
				if (reply.kind !== "pending") throw unexpected("run", reply);
				const settled = await settle(reply.workId);
				if ("closed" in settled) throw new LeaseLost(lostEnd);
				if (settled.outcome.kind === "interrupted") return { interrupted: true };
				if (settled.outcome.kind === "unsaved") throw refused("run", [String(settled.outcome.reason)]);
				if (settled.outcome.kind !== "ran") throw unexpected("run", settled.outcome);
				const evidence = station.submissions.evidence.filter((e) => e.kind === "ran" && e.name === input.label).at(-1);
				return { exitCode: settled.outcome.exitCode as number, tail: typeof evidence?.tail === "string" ? evidence.tail : "" };
			},
			async advance(input = {}) {
				if (controller.signal.aborted) return { kind: "lost", end: lostEnd };
				const args = [...(input.to ? ["--to", input.to] : []), ...(input.note ? ["--note", input.note] : []), ...usageArgs()];
				let reply: Reply;
				try {
					reply = await call("advance", args);
				} catch (error) {
					if (error instanceof LeaseLost) return { kind: "lost", end: error.end };
					throw error;
				}
				/** The lease closed: advanced is this advance's success, any other end lost it. */
				const closedOutcome = (closed: Reply): DriveOutcome => {
					const endOf: LeaseEnd | null = closed.kind === "closed" ? closed.end : null;
					if (endOf?.kind !== "advanced") return { kind: "lost", end: endOf };
					return endOf.to === null || !closed.current ? { kind: "finished" } : { kind: "entered", station: closed.current };
				};
				switch (reply.kind) {
					case "entered":
						end({ kind: "advanced", to: reply.station.stage });
						return { kind: "entered", station: reply.station };
					case "finished":
						end({ kind: "advanced", to: null });
						return { kind: "finished" };
					case "refused":
						return { kind: "refused", reasons: reply.reasons };
					case "busy":
						return { kind: "refused", reasons: [`busy: a ${reply.work.kind} job is running`] };
					case "pending": {
						const settled = await settle(reply.workId);
						if ("closed" in settled) return closedOutcome(settled.closed);
						if (settled.outcome.kind === "refused") return { kind: "refused", reasons: settled.outcome.reasons as string[] };
						if (settled.outcome.kind === "interrupted") return { kind: "refused", reasons: [`the gate check was interrupted (${String(settled.outcome.reason ?? "a plugin restart")}); advance again`] };
						if (settled.outcome.kind === "unsaved") return { kind: "refused", reasons: [`the gate result was not kept: ${String(settled.outcome.reason)}`] };
						throw unexpected("advance", settled.outcome);
					}
					default:
						throw unexpected("advance", reply);
				}
			},
			async proposeForce(input) {
				const reply = await call("propose-force", ["--to", input.to, "--reason", input.reason]);
				if (reply.kind === "refused") throw refused("propose-force", reply.reasons);
				if (reply.kind === "busy") throw new Error(`sandy work track drive propose-force: busy (${reply.work.kind} job running)`);
				if (reply.kind !== "pending") throw unexpected("propose-force", reply);
				const settled = await settle(reply.workId);
				if ("closed" in settled) return { approved: settled.closed.kind === "closed" && settled.closed.end?.kind === "forced" };
				if (settled.outcome.kind === "force-rejected") return { approved: false };
				if (settled.outcome.kind === "unsaved") throw refused("propose-force", [String(settled.outcome.reason)]);
				throw unexpected("propose-force", settled.outcome);
			},
			async release(reason) {
				if (controller.signal.aborted) return { released: false };
				let reply: Reply;
				try {
					reply = await call("release", ["--reason", reason, ...usageArgs()]);
				} catch (error) {
					if (error instanceof LeaseLost) return { released: false };
					throw error;
				}
				if (reply.kind !== "released") throw unexpected("release", reply);
				end({ kind: "released", reason });
				return { released: true };
			},
			close() {
				clearInterval(timer);
			},
		};
	}

	return {
		async start(source, startOptions = {}) {
			let sourceArgs: string[];
			if ("skill" in source) sourceArgs = ["--skill", source.skill];
			else {
				// The machine itself, not a path: the plugin's server may run where this host's files are not.
				const machine = JSON.stringify(source.machine);
				const bytes = Buffer.byteLength(machine);
				if (bytes > MACHINE_LIMIT_BYTES)
					throw new Error(
						`ad-hoc track is ${Math.ceil(bytes / 1024)} KiB as JSON; sandy work track drive start takes at most ${MACHINE_LIMIT_BYTES / 1024} KiB ` +
							"(a plugin call carries at most 64 KiB). Shorten its descriptions or prompts.",
					);
				sourceArgs = ["--machine", machine];
			}
			const { driveAll, note } = startOptions;
			const args = [
				...sourceArgs,
				...(note ? ["--note", note] : []),
				...(driveAll ? ["--autopilot", driveAll.name, ...(driveAll.args ? ["--args", driveAll.args] : [])] : []),
			];
			const reply = await drive("start", args);
			if (reply.kind === "started") return { kind: "started", ticket: reply.ticket };
			if (reply.kind === "proposed") return { kind: "proposed" };
			if (reply.kind === "refused") return { kind: "refused", reasons: reply.reasons };
			throw unexpected("start", reply);
		},
		async status() {
			const reply = await drive("status", []);
			if (reply.kind === "current") return reply.station;
			if (reply.kind === "none") return null;
			throw unexpected("status", reply);
		},
		async openLease(ticket, leaseOptions = {}) {
			const reply = await drive("claim", ["--ticket", ticket, "--invocation", newInvocation()]);
			if (reply.kind === "claimed") return openTrack(ticket, reply.grant, reply.station, leaseOptions.usage ?? (() => null));
			if (reply.kind === "closed") throw new LeaseLost(reply.end);
			if (reply.kind === "stale" || reply.kind === "none") throw new LeaseLost(null);
			if (reply.kind === "refused") throw refused("claim", reply.reasons);
			throw unexpected("claim", reply);
		},
	};
}
