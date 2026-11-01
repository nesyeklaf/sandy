/**
 * Verify autopilot: drives one stage visit that checks a test suite (/autopilot --lease <ticket> verify <command>).
 * The command runs on the host through the plugin (ran evidence "tests" with its exit code), one model step turns the
 * output's tail into the stage's outputs, then the lease submits and advances. A gate check interrupted by a plugin
 * restart (D11) is advanced again, at most twice.
 *
 *   example: sandy/work/track/templates/verify-probe.stages.json
 */
import type { Session } from "../session.ts";
import type { LeaseTrack } from "../track.ts";

const RETRIES = 2;

export default async function verify(args: string, api: { session: Session; lease: LeaseTrack | null }) {
	if (!api.lease) throw new Error("verify drives a stage lease: the track plugin launches it with /autopilot --lease");
	const command = args.trim();
	if (!command) throw new Error("verify needs the test command as its args");
	const station = api.lease.station;
	const ran = await api.lease.run({ label: "tests", command, timeoutSec: 120 });
	if ("interrupted" in ran) return api.lease.release("the test run was interrupted by a plugin restart");
	const outputs = station.missingOutputs;
	const step = await api.session.step({
		say:
			`Stage "${station.title}" of the track "${station.track}". The plugin ran \`${command}\`: exit code ${ran.exitCode}.\n` +
			`Output tail:\n${ran.tail.slice(-2000)}\n\nWrite one sentence for each output: ${outputs.join(", ") || "(none)"}.`,
		tools: [],
		schema: { type: "object", required: outputs, properties: Object.fromEntries(outputs.map((name) => [name, { type: "string" }])) },
	});
	await api.lease.submit({ outputs: step.value as Record<string, string> });
	const attempts = [];
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		const next = await api.lease.advance({ note: `verify: tests exited ${ran.exitCode}` });
		attempts.push(next.kind === "refused" ? { refused: next.reasons } : { kind: next.kind });
		if (next.kind !== "refused" || !next.reasons.some((reason) => reason.includes("interrupted"))) break;
	}
	return { stage: station.stage, exitCode: ran.exitCode, outputs: step.value, attempts };
}
