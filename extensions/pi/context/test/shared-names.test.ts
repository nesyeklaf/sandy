import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import * as kinds from "../src/core/kinds.ts";
import * as keepWarm from "../src/pi/keep-warm.ts";

/*
 * Names other plugins of this repository spell out instead of importing them: the advisor asks for a cut on the
 * context engine's event channel, and SANDY's workflows write the keep-warm signal file the engine reads. A rename on
 * either side would silently cut the link, so the copies are pinned to the one constant here.
 */

const repo = join(import.meta.dirname, "..", "..", "..");
/** The string a file assigns to an exported constant. */
function exported(file: string, name: string): string | undefined {
	const match = new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`).exec(readFileSync(join(repo, file), "utf8"));
	return match?.[1];
}

describe("names shared with other plugins", () => {
	it("the advisor requests a cut on the context engine's channel", () => {
		assert.equal(exported("pi/advisor/src/pi/extension.ts", "CUT_REQUEST_CHANNEL"), kinds.CUT_REQUEST_CHANNEL);
	});

	it("SANDY's workflows write the keep-warm signal file the context engine reads", () => {
		const name = (keepWarm as Record<string, unknown>).KEEP_WARM_FILE;
		assert.equal(name, "pi-keep-warm.json", "the context engine names no keep-warm signal file");
		assert.equal(exported("sandy/work/workflows/src/keep-warm.ts", "KEEP_WARM_FILE"), name);
	});
});
