import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ConfigErrors, type ContextConfig, type ContextConfigInput, parseConfig } from "../core/config.ts";
import { expectedProbe, type ProbeVerdict, validateProbeRecord } from "../core/kept-cap-probe.ts";

/** Where the settings file is looked for when the embedder names none. */
export function defaultConfigFile(): string {
	return join(getAgentDir(), "context.json");
}

/**
 * The config from the settings file, when it exists, and the embedder's overrides, over the defaults. An unreadable
 * or malformed file is an error, not a reason to run on the defaults.
 */
export function loadConfig(
	file: string | false | undefined,
	overrides: ContextConfigInput | undefined,
): ContextConfig | ConfigErrors {
	const path = file === false ? undefined : (file ?? defaultConfigFile());
	if (path === undefined || !existsSync(path)) return parseConfig({}, overrides);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { configErrors: [`${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const result = parseConfig(parsed, overrides);
	if (!("configErrors" in result)) return result;
	return {
		configErrors: result.configErrors.map((error) => (error.startsWith("options.config:") ? error : `${path}: ${error}`)),
	};
}

/** Where the kept-cap probe record is looked for when the embedder names none. */
export function defaultKeptCapProbeFile(): string {
	return join(getAgentDir(), "context-kept-cap-probe.json");
}

/**
 * The verdict of the probe record on disk for this cap, read now, and where it was looked for. With a `model` the
 * record must have been made for it; without one (before the session has a model) it must only name some model.
 */
export function keptCapEvidence(config: ContextConfig, file: string | false | undefined, model?: string): { verdict: ProbeVerdict; where: string } {
	const path = file === false ? undefined : (file ?? defaultKeptCapProbeFile());
	let raw: unknown;
	if (path !== undefined && existsSync(path)) {
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			raw = "unreadable: " + (error instanceof Error ? error.message : String(error));
		}
	}
	return { verdict: validateProbeRecord(raw, expectedProbe(config, model)), where: path === undefined ? "no probe record file is set" : path };
}

/**
 * The reasons the kept-history cap may not be switched on, none when it may: mode "on" needs a probe record that names
 * this cap and the frozen suite and thresholds and whose numbers pass them (see kept-cap-probe.ts). Any other mode
 * needs nothing, and the record is not read. The cap's effect on answers is unproven until a paid probe wrote one.
 * This is the startup check; the model the record covers is checked when a cut would use the cap
 * (see {@link keptCapEvidence}), because the session has no model yet.
 */
export function keptCapGate(config: ContextConfig, file: string | false | undefined): ConfigErrors | undefined {
	if (config.keptCap.mode !== "on") return undefined;
	const { verdict, where } = keptCapEvidence(config, file);
	if (verdict.ok) return undefined;
	return {
		configErrors: [
			`keptCap.mode "on" needs a passing probe record for this cap (${where}): ${verdict.kind}: ${verdict.reason}. Use "shadow" until the probe (backlog #16) has run.`,
		],
	};
}

export function configFailure(errors: ConfigErrors): Error {
	return new Error(`pi-context: invalid configuration\n- ${errors.configErrors.join("\n- ")}`);
}
