// The one tool_call gate of pi/work. Each part registers its tool_call handler as before; the gate takes those
// handlers over and runs them in a fixed order: the policy guards first (delegate allowlist, track stage,
// autopilot step), the goal last. So a call needs every guard's yes (stage ∩ allowlist ∩ step), and the goal
// counts only calls that actually run as goal work. The first block ends the call; a handler that throws
// blocks it too, so a broken guard never lets a call through.
type Result = { block: true; reason: string } | undefined | void;
export type ToolCallHandler = (event: any, ctx: any) => Result | Promise<Result>;
type Entry = { part: string; rank: number; seq: number; handler: ToolCallHandler };

export class ToolCallGate {
  private entries: Entry[] = [];
  private seq = 0;

  /** pi as the part sees it: on("tool_call") goes to the gate at that rank, everything else to pi. */
  view<T extends object>(pi: T, part: string, rank: number): T {
    const add = (handler: ToolCallHandler) => {
      this.entries.push({ part, rank, seq: this.seq++, handler });
      this.entries.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
    };
    return new Proxy(pi, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "on") return (event: string, handler: any) => (event === "tool_call" ? add(handler) : (value as Function).call(target, event, handler));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** The parts in the order the gate asks them. */
  order(): string[] {
    return this.entries.map((entry) => entry.part);
  }

  readonly handle = async (event: any, ctx: any): Promise<Result> => {
    for (const { part, handler } of this.entries) {
      let result: Result;
      try {
        result = await handler(event, ctx);
      } catch (error) {
        return { block: true, reason: `pi/work ${part}: tool gate failed, call blocked: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (result && result.block) return result;
    }
    return undefined;
  };
}
