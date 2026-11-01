/**
 * Best-effort evidence that another extension also compacts the session. pi lists no hooks, so there are two signs:
 * a command of a known competitor, visible at startup, and a compaction another writer committed where this
 * extension had proposed its own, visible after that competitor won. A competitor with only a hook is therefore named
 * after its first win, not at startup; one that loads before us and loses stays unseen. Nothing here orders handlers
 * or reads private runner state.
 */

/** The name a command is registered under; pi appends `:<n>` to a command whose name another extension took. */
export interface CommandInfo {
	readonly name: string;
}

/** Extensions known to replace the session's compaction, by the command they register. */
const KNOWN_COMPETITORS: readonly { readonly competitor: string; readonly command: string }[] = [
	{ competitor: "pi-cached-compaction", command: "cached-compaction" },
];

export type WarningEvidence =
	| { readonly reason: "known-command"; readonly competitor: string; readonly command: string }
	| { readonly reason: "foreign-cut-won"; readonly proposed: string };

/** What the compaction pi just committed was written by. */
export interface CommittedCut {
	readonly ours: boolean;
}

/**
 * The evidence in what the host shows: its commands (at startup, or any time), the reason of the cut this extension
 * proposed (undefined when it proposed none), and the cut pi committed (undefined when none was observed; a
 * compaction already in a resumed log is not an observation).
 */
export function observeOwners(
	commands: readonly CommandInfo[],
	proposedCut: string | undefined,
	committedCut: CommittedCut | undefined,
): WarningEvidence[] {
	const evidence: WarningEvidence[] = [];
	for (const { competitor, command } of KNOWN_COMPETITORS) {
		if (commands.some(({ name }) => name === command || name.startsWith(`${command}:`))) {
			evidence.push({ reason: "known-command", competitor, command });
		}
	}
	if (proposedCut !== undefined && committedCut !== undefined && !committedCut.ours) {
		evidence.push({ reason: "foreign-cut-won", proposed: proposedCut });
	}
	return evidence;
}

function warningText(evidence: WarningEvidence): string {
	return evidence.reason === "known-command"
		? `context: ${evidence.competitor} (/${evidence.command}) is installed and also compacts the session. Whichever loads last wins each compaction; remove one of them for predictable cuts.`
		: `context: another extension committed the ${evidence.proposed} compaction in place of ours. Whichever loads last wins each compaction; remove one of the two for predictable cuts.`;
}

/** Wording for evidence not shown yet in this session: each reason (and known competitor) is worded once. */
export class CompetitorWarnings {
	private readonly shown = new Set<string>();

	/** Evidence of another compacting extension was seen: our summary must not stand in for its checkpoint. */
	get active(): boolean {
		return this.shown.size > 0;
	}

	fresh(evidence: readonly WarningEvidence[]): string[] {
		return evidence.flatMap((item) => {
			const key = item.reason === "known-command" ? `${item.reason}:${item.competitor}` : item.reason;
			if (this.shown.has(key)) return [];
			this.shown.add(key);
			return [warningText(item)];
		});
	}
}
