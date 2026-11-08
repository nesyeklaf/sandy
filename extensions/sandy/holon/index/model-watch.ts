import { watch, type FSWatcher } from "node:fs";

const IGNORED = new Set(["node_modules", ".git"]);
const MAX_PENDING = 10_000;

export interface Changes {
  full: boolean;
  paths: string[];
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class ModelWatch {
  readonly root: string;
  private readonly pending = new Set<string>();
  private full = false;
  private watcher: FSWatcher | null = null;

  constructor(root: string) {
    this.root = root;
    try {
      this.watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => this.note(name));
      this.watcher.on("error", () => this.close());
    } catch {
      this.watcher = null;
    }
  }

  get live(): boolean {
    return this.watcher !== null;
  }

  private note(name: string | Buffer | null): void {
    if (name === null) {
      this.full = true;
      return;
    }
    const path = name.toString().replaceAll("\\", "/");
    if (path === "" || path.split("/").some((segment) => IGNORED.has(segment))) return;
    if (this.pending.size >= MAX_PENDING) {
      this.full = true;
      this.pending.clear();
      return;
    }
    if (!this.full) this.pending.add(path);
  }

  async drain(): Promise<void> {
    await nextTurn();
    await nextTurn();
  }

  take(): Changes {
    const changes = { full: this.full || !this.live, paths: [...this.pending] };
    this.full = false;
    this.pending.clear();
    return changes;
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
