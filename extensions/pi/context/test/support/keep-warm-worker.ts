/**
 * One pi process of the two-process keep-warm test: opens the session file with pi's real runtime and the context
 * extension, and does what the parent tells it over IPC: `prompt` (one turn), `arm` (its clock moves to where the
 * cache is about to expire), `stop`. Its server and signal file are the parent's. Run with node, which strips the types.
 */
import type { FakeAnthropic } from "./anthropic-server.ts";
import { piSdk } from "./pi.ts";
import { START, waitingSession } from "./waiting-session.ts";

const { SERVER = "", SIGNAL = "", SESSION = "" } = process.env;
const server = { baseUrl: SERVER, requests: [], responder: () => [], stop: async () => {} } as unknown as FakeAnthropic;
const manager = piSdk.SessionManager.open(SESSION);
const s = await waitingSession({ shared: { manager, server, signalFile: SIGNAL } });

process.send?.({ ready: true, file: manager.getSessionFile(), pid: process.pid });
process.on("message", async (message) => {
	if (message === "prompt") {
		await s.runtime.session.prompt("Shared process prompt.");
		process.send?.({ prompted: true });
	}
	if (message === "arm") s.clock(START + 250_000);
	if (message === "stop") {
		await s.runtime.dispose();
		process.disconnect();
	}
});
