/**
 * One pi process of the claim test: opens a session file with pi's real runtime and the context extension, takes one
 * interactive turn, and reports on stdout what its historian asked. Run with node, which strips the types.
 *
 * Arguments: <session file> <hang|malformed> <clock offset ms> [wait]. `hang`: the historian's call never answers
 * until the process ends. `malformed`: it answers at once with no summary. `wait`: the session file is read at once,
 * but the runtime starts only after a line on stdin, so the process holds a snapshot older than what others append meanwhile.
 */
import { dirname, join } from "node:path";
import type { Summarizer } from "../../src/pi/extension.ts";
import { lifecycleOptions, openRuntime, tempDir } from "./lifecycle.ts";
import { piSdk } from "./pi.ts";

const [sessionFile = "", mode = "malformed", offset = "0", wait] = process.argv.slice(2);
const emit = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify(event) + "\n");

const manager = piSdk.SessionManager.open(sessionFile, dirname(sessionFile));
emit({ event: "open" });
// pi read the file just now; what others append from here on is not in this manager.
if (wait === "wait") await new Promise((resolve) => process.stdin.once("data", resolve));
const dir = tempDir();
let requests = 0;
const notices: string[] = [];
const summarize: Summarizer = (request) => {
	requests++;
	emit({ event: "sent" });
	if (mode === "malformed") return Promise.resolve({ text: "no sections at all" });
	return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
};
const quiet = () => undefined;
const ui = {
	notify: (text: string) => notices.push(text),
	setStatus: quiet,
	setWidget: quiet,
	setFooter: quiet,
	setHeader: quiet,
	setTitle: quiet,
	setWorkingMessage: quiet,
	setEditorText: quiet,
} as never;
const options = lifecycleOptions(join(dir, "ledger.jsonl"), summarize, 100);
const { runtime } = await openRuntime({ dir, manager, trace: [], options: { ...options, now: () => Date.now() + Number(offset) } });
await runtime.session.bindExtensions({ uiContext: ui });
await runtime.session.prompt("go");
for (let i = 0; i < 200; i++) await new Promise((resolve) => setImmediate(resolve));
if (mode === "hang") {
	// Holds the call until the test kills the process.
	setInterval(() => undefined, 1_000);
} else {
	await runtime.dispose();
	emit({ event: "done", requests, paused: notices.some((text) => text.includes("retry-historian")) });
	process.exit(0);
}
