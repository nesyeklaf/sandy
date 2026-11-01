/**
 * The /autopilot command: "/autopilot <name> [args]" runs the autopilot <name> in this session and posts its JSON
 * result as a message. An autopilot is an async function (args, api) => result; api.session steers the session turn
 * by turn. sessionFor binds that session to the command's context (pi/work passes autopilot/session.ts).
 * "/autopilot resume" continues the session's newest plan-run that pi stopped in or that ended blocked (plan-run.ts).
 */
import planRun, { latestRun, resumable, resumeRun } from "./plan-run.ts";
import type { Api, Ctx, Pi, Session } from "./session.ts";

export const AUTOPILOTS: Record<string, (args: string, api: Api) => Promise<unknown>> = { "plan-run": planRun };

export default function autopilot(pi: Pi, sessionFor: (ctx: Ctx) => Session) {
	// Per pi process: a reload starts with none, which is exactly when a recorded run may be resumed.
	let running = false;
	const drive = async (start: () => Promise<unknown>) => {
		running = true;
		try {
			return await start();
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		} finally {
			running = false;
		}
	};
	pi.registerCommand("autopilot", {
		description: "Run an autopilot: /autopilot <name> [args]; /autopilot resume continues a plan-run pi stopped in",
		handler: async (input, ctx) => {
			const [name = "", ...rest] = input.trim().split(/\s+/);
			let result: unknown;
			if (name === "resume") {
				const run = latestRun(ctx.sessionManager.getBranch());
				if (running) result = { error: "an autopilot is still running in this pi; resume continues a run after a reload" };
				else if (!resumable(run)) result = { error: run ? "the last plan-run " + run.status + "; nothing to resume" : "no plan-run in this session to resume" };
				else result = await drive(() => resumeRun(run, { pi, session: sessionFor(ctx) }));
			} else {
				const start = AUTOPILOTS[name];
				if (!start) result = { error: "no autopilot " + name + "; known: " + Object.keys(AUTOPILOTS).join(", ") + ", resume" };
				else result = await drive(() => start(rest.join(" "), { pi, session: sessionFor(ctx) }));
			}
			// triggerTurn: false: the result is shown and kept in the context without costing a model call.
			pi.sendMessage({ customType: "autopilot", content: "[autopilot] " + name + " -> " + JSON.stringify(result), display: true }, { triggerTurn: false });
		},
	});
}
