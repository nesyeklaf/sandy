import type { ElkNode } from "elkjs/lib/elk-api";
import ELK from "elkjs/lib/elk-api.js";
import { Worker as InlineWorker } from "elkjs/lib/elk-worker.min.js";

const elk = new ELK({ workerFactory: (url?: string) => new InlineWorker(url) });

export function layoutGraph(root: ElkNode): Promise<ElkNode> {
  return elk.layout(root);
}
