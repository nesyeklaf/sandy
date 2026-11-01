import { Type } from "typebox";
import { READ_AROUND_MAX, READ_CHARS, TOOLS } from "../core/tools.ts";

/**
 * The parameter schemas of the context tools, in TypeBox as pi and Pi Durable declare tools. The
 * texts and bounds come from the core, which owns them; only the shape is written here.
 */
export const historySearchParameters = Type.Object({
	query: Type.String({ description: TOOLS.historySearch.parameters.query }),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: TOOLS.historySearch.parameters.limit })),
	includeVisible: Type.Optional(Type.Boolean({ description: TOOLS.historySearch.parameters.includeVisible })),
	cursor: Type.Optional(Type.String({ description: TOOLS.historySearch.parameters.cursor })),
});

export const historyReadParameters = Type.Object({
	id: Type.String({ description: TOOLS.historyRead.parameters.id }),
	around: Type.Optional(
		Type.Integer({ minimum: 0, maximum: READ_AROUND_MAX, description: TOOLS.historyRead.parameters.around }),
	),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: TOOLS.historyRead.parameters.offset })),
	maxChars: Type.Optional(
		Type.Integer({
			minimum: READ_CHARS.min,
			maximum: READ_CHARS.max,
			description: TOOLS.historyRead.parameters.maxChars,
		}),
	),
});

export const notebookParameters = Type.Object({
	text: Type.Optional(Type.String({ description: TOOLS.notebook.parameters.text })),
});
