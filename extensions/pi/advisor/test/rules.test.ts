import { describe, expect, it } from "vitest";
import { buildLedger } from "../src/core/ledger.ts";
import { runRules } from "../src/core/rules.ts";
import type { Msg } from "../src/core/types.ts";

const call = (id: string, name: string, args: Record<string, unknown>): Msg => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const res = (id: string, name: string, text: string, isError = false): Msg => ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] });
const user: Msg = { role: "user", content: "mach" };

describe("rules", () => {
	it("flags a passing-test claim with no test command", () => {
		const s = runRules("Alle Tests sind grün und der Build ist sauber.", buildLedger([user]));
		expect(s[0]?.rule).toBe("tests_pass");
		expect(s[0]?.kind).toBe("unbelegt");
	});
	it("accepts the claim when a matching command succeeded, even hidden in a wrapper tool", () => {
		const l = buildLedger([user, call("1", "fabric_exec", { code: "await pi.bash({cmd:'npx vitest run'})" }), res("1", "fabric_exec", "36 passed")]);
		expect(runRules("Alle Tests sind grün.", l)).toEqual([]);
	});
	it("calls the claim refuted when the last matching command failed", () => {
		const l = buildLedger([user, call("1", "bash", { cmd: "npm test" }), res("1", "bash", "1 failed", true)]);
		const s = runRules("Die Tests sind erfolgreich durchgelaufen.", l);
		expect(s[0]?.kind).toBe("widerlegt");
	});
	it("flags a file-change claim without an edit", () => {
		const s = runRules("Ich habe die Datei config.ts angepasst und erweitert.", buildLedger([user, call("1", "read", { path: "a" }), res("1", "read", "x")]));
		expect(s[0]?.rule).toBe("file_changed");
	});
	it("flags 'gepusht' without git push, accepts it with one", () => {
		expect(runRules("Der Branch ist gepusht.", buildLedger([user]))[0]?.rule).toBe("shipped");
		const l = buildLedger([user, call("1", "bash", { cmd: "git push origin x" }), res("1", "bash", "ok")]);
		expect(runRules("Der Branch ist gepusht.", l)).toEqual([]);
	});
	it("ignores negated and quoted claims", () => {
		const l = buildLedger([user]);
		expect(runRules("Die Tests habe ich nicht gelaufen, sie sind noch nicht grün.", l)).toEqual([]);
		expect(runRules("Beispiel:\n```\nTests sind grün\n```", l)).toEqual([]);
	});
	it("only looks at the current turn", () => {
		const l = buildLedger([call("1", "bash", { cmd: "npm test" }), res("1", "bash", "ok"), user]);
		expect(runRules("Alle Tests sind grün.", l)[0]?.rule).toBe("tests_pass");
	});
	it("can switch a rule off", () => {
		expect(runRules("Alle Tests sind grün.", [], { tests_pass: false })).toEqual([]);
	});
});
