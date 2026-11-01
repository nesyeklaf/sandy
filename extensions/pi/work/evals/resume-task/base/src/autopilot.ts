/**
 * The /autopilot command: "/autopilot <name> [args]" runs the autopilot <name> in this session and posts its JSON
 * result as a message. An autopilot is an async function (args, api) => result; api.session steers the session turn
 * by turn. sessionFor binds that session to the command's context (pi/work passes autopilot/session.ts).
 */
import planRun from "./plan-run.ts";
import type { Api, Ctx, Pi, Session } from "./session.ts";

export const AUTOPILOTS: Record<string, (args: string, api: Api) => Promise<unknown>> = { "plan-run": planRun };

export default function autopilot(pi: Pi, sessionFor: (ctx: Ctx) => Session) {
	pi.registerCommand("autopilot", {
		description: "Run an autopilot: /autopilot <name> [args]",
		handler: async (input, ctx) => {
			const [name = "", ...rest] = input.trim().split(/\s+/);
			const run = AUTOPILOTS[name];
			let result: unknown;
			if (!run) result = { error: `no autopilot ${name}; known: ${Object.keys(AUTOPILOTS).join(", ")}` };
			else {
				try {
					result = await run(rest.join(" "), { pi, session: sessionFor(ctx) });
				} catch (error) {
					result = { error: error instanceof Error ? error.message : String(error) };
				}
			}
			// triggerTurn: false: the result is shown and kept in the context without costing a model call.
			pi.sendMessage({ customType: "autopilot", content: `[autopilot] ${name} -> ${JSON.stringify(result)}`, display: true }, { triggerTurn: false });
		},
	});
}
