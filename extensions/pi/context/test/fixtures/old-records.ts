/**
 * Records as sessions written before the rename to `context` hold them, frozen from real session logs (texts
 * shortened). Users resume such sessions, so every one of them must keep decoding. Never update these to new names.
 */
export const OLD_NOTEBOOK = {
	type: "custom",
	customType: "sandy-context.notebook",
	data: { text: "GOAL: ship slice 2" },
	id: "a1b2c3d4",
	parentId: "a1b2c3d3",
	timestamp: "2026-10-31T05:30:00.000Z",
} as const;

export const OLD_SUMMARY = {
	type: "custom",
	customType: "sandy-context.summary",
	data: {
		version: 1,
		coveredThroughId: "6189b0f7",
		sections: { goal: ["Read-only research as bb-delegate child (#e368969f)"], state: ["Done: loaded batch_2.md"] },
	},
	id: "b1b2c3d4",
	parentId: "b1b2c3d3",
	timestamp: "2026-10-31T05:31:00.000Z",
} as const;

export const OLD_REMINDER = {
	type: "custom_message",
	customType: "sandy-context.notebook-reminder",
	content: "[sandy-context] A context cut is coming in about 19k tokens. Your notebook is empty.",
	display: false,
	id: "ea34c891",
	parentId: "d55db7e3",
	timestamp: "2026-10-31T05:32:31.813Z",
} as const;

export const OLD_TASK_DONE = {
	type: "custom",
	customType: "sandy-context.task-done",
	data: { task: "IDEA-1" },
	id: "c1b2c3d4",
	parentId: "c1b2c3d3",
	timestamp: "2026-10-31T05:33:00.000Z",
} as const;

export const OLD_KEEP_WARM = {
	type: "custom_message",
	customType: "sandy-context.keep-warm",
	content: "keep-warm ping",
	display: false,
	id: "d1b2c3d4",
	parentId: "d1b2c3d3",
	timestamp: "2026-10-31T05:33:30.000Z",
} as const;

export const OLD_CUT = {
	type: "compaction",
	id: "5d62246b",
	parentId: "4100bb5f",
	timestamp: "2026-10-31T05:34:30.129Z",
	summary: '<sandy-context reason="watermark">\nThis session keeps going indefinitely.\n</sandy-context>\nThe conversation continues verbatim from here.',
	firstKeptEntryId: "4c67c1ef",
	tokensBefore: 145402,
	details: {
		sandyContext: {
			version: 1,
			reason: "watermark",
			keptFromId: "4c67c1ef",
			maskedFromId: "5430b480",
			summaryThroughId: "d6c61abd",
			archivedEntries: 24,
			blockTokens: 1945,
		},
	},
	fromHook: true,
} as const;

/** A cut from before the historian summarized: no summaryThroughId, an unsummarized gap instead. */
export const OLD_CUT_UNSUMMARIZED = {
	type: "compaction",
	id: "6d62246b",
	parentId: "5100bb5f",
	timestamp: "2026-10-30T05:34:30.129Z",
	summary: '<sandy-context reason="task">\nThis session keeps going indefinitely.\n</sandy-context>',
	firstKeptEntryId: "5c67c1ef",
	tokensBefore: 90000,
	details: {
		sandyContext: {
			version: 1,
			reason: "task",
			keptFromId: "5c67c1ef",
			maskedFromId: "6430b480",
			unsummarized: { fromId: "0001", toId: "0042", entries: 42 },
			archivedEntries: 42,
			blockTokens: 1200,
		},
	},
	fromHook: true,
} as const;

/** Sessions written before the notebook had its own entry kept it in the notebook tool's result. */
export const OLD_NOTEBOOK_TOOL_RESULT = {
	type: "message",
	id: "e1b2c3d4",
	parentId: "e1b2c3d3",
	timestamp: "2026-10-20T05:00:00.000Z",
	message: {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "notebook",
		isError: false,
		content: [{ type: "text", text: "Notebook saved." }],
		details: { text: "GOAL: the old notebook" },
		timestamp: 1_760_936_400_000,
	},
} as const;
