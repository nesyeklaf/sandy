import type { useRpc } from "@sandy-sdk/plugin-sdk/app";
import type { sandySidebarRpcContract } from "./contract";

export type SidebarRpc = ReturnType<typeof useRpc<typeof sandySidebarRpcContract>>;

export class RemoteStore<State> {
  private state: State;
  private rpc: SidebarRpc | null = null;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private inFlight = false;
  private pending = false;
  private scheduled = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly initial: State,
    private readonly load: (rpc: SidebarRpc) => Promise<State>,
    private readonly pollMs: number | null = null,
  ) {
    this.state = initial;
  }

  readonly bind = (rpc: SidebarRpc): void => {
    this.rpc = rpc;
  };

  readonly getState = (): State => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.invalidate();
      if (this.pollMs !== null) this.timer = setInterval(this.invalidate, this.pollMs);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      this.generation += 1;
      this.pending = false;
      this.state = this.initial;
    };
  };

  readonly invalidate = (): void => {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.refresh();
    });
  };

  readonly set = (next: State): void => {
    this.generation += 1;
    this.publish(next);
  };

  private publish(next: State): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    if (this.rpc === null || this.listeners.size === 0) return;
    this.inFlight = true;
    const generation = this.generation;
    const outcome = await this.load(this.rpc).then(
      (value) => ({ value }),
      () => null,
    );
    this.inFlight = false;
    if (outcome !== null && generation === this.generation) this.publish(outcome.value);
    if (this.pending) {
      this.pending = false;
      void this.refresh();
    }
  }
}
