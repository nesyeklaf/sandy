import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { piSdk } from "./support/pi.ts";

describe("pi's config directory in tests", () => {
	it("is a throwaway directory, never the user's ~/.pi/agent", () => {
		const dir = piSdk.getAgentDir();
		assert.notEqual(dir, join(homedir(), ".pi", "agent"));
		assert.ok(dir.startsWith(tmpdir()), dir);
	});
});
