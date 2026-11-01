/**
 * What an autopilot gets from pi: the session it steers turn by turn and the extension API. In pi/work the session is
 * autopilot/session.ts (installSession); here only the types, so the autopilots can be tested with a fake session.
 */
export type Schema = Record<string, unknown>;

export type StepOptions = {
	/** The prompt of this turn. */
	say: string;
	/** The tool names this turn may call; default: the active ones. */
	tools?: string[];
	/** Tool names this turn may not call. */
	deny?: string[];
	/** When set, the turn ends with the model's autopilot_submit call, whose value matches this schema. */
	schema?: Schema;
};
export type StepResult = { text: string; value?: unknown; tools: string[]; model: string; thinking: string };
export type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };

export type Session = {
	/** One model turn in this session. */
	step(options: StepOptions): Promise<StepResult>;
	/** Runs a command in the session's cwd. */
	exec(command: string, args: string[], options?: { timeout?: number }): Promise<ExecResult>;
};

/** A session entry as pi stores it; pi.appendEntry(customType, data) adds {type: "custom", customType, data}. */
export type Entry = { type: string; id?: string; customType?: string; data?: unknown };

export type Ctx = { cwd: string; sessionManager: { getBranch(): Entry[] } };

export type Pi = {
	appendEntry(customType: string, data: unknown): void;
	sendMessage(message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean }): void;
	registerCommand(name: string, options: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }): void;
};

export type Api = { pi: Pi; session: Session };
