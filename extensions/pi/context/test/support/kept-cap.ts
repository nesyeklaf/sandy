import { type ContextConfig, resolveConfig } from "../../src/core/config.ts";
import { expectedProbe, type ProbeExpectation, type ProbeRecord } from "../../src/core/kept-cap-probe.ts";

/** What a probe record must name to gate the cap of `config`. */
export const probeExpectation = (config: ContextConfig = resolveConfig(), model?: string): ProbeExpectation => expectedProbe(config, model);

/** The model the passing probe record covers. */
export const PROBED_MODEL = "probed-provider/probed-model";

/** A complete record for that cap whose numbers pass every frozen threshold. */
export function passingProbe(config: ContextConfig = resolveConfig()): ProbeRecord {
	const expected = expectedProbe(config);
	return {
		version: 1,
		passed: true,
		model: PROBED_MODEL,
		cap: expected.cap,
		suite: expected.suite,
		thresholds: expected.thresholds,
		design: { ...expected.design },
		snapshots: expected.ids.map((id) => ({ id, baseline: { passed: 7, reads: 5 }, capped: { passed: 8, reads: 5 } })),
		savedShare: 0.07,
	};
}
