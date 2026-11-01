/**
 * Probe for a track station: drives the one stage visit it is launched for (/autopilot --lease <ticket> track-probe).
 * One step with a schema produces the stage's outputs, the lease submits them and advances; the plugin then hands the
 * next stage to its driver.
 *
 *   stages.json: { "id": "build", ..., "outputs": [{ "name": "result" }], "autopilot": { "name": "track-probe", "args": "<task>" } }
 *   example: sandy/work/track/templates/mixed-probe.stages.json
 *
 * Every output the stage still misses is asked for in one step; args is the task the step works on.
 */
import type { Session } from "../session.ts";
import type { LeaseTrack } from "../track.ts";

export default async function trackProbe(args: string, api: { session: Session; lease: LeaseTrack | null }) {
	if (!api.lease) throw new Error("track-probe drives a stage lease: the track plugin launches it with /autopilot --lease");
	const station = api.lease.station;
	const outputs = station.missingOutputs;
	const step = await api.session.step({
		say:
			`You are working on stage "${station.title}" of the track "${station.track}".${args ? ` Task: ${args}.` : ""}\n` +
			`Produce a short value (one or two sentences) for each output: ${outputs.join(", ") || "(none)"}.`,
		tools: [],
		schema: { type: "object", required: outputs, properties: Object.fromEntries(outputs.map((name) => [name, { type: "string" }])) },
	});
	await api.lease.submit({ outputs: step.value as Record<string, string> });
	const next = await api.lease.advance({ note: "track-probe submitted the stage's outputs" });
	return { stage: station.stage, outputs: step.value, advance: next.kind === "entered" ? { entered: next.station.stage } : next };
}
