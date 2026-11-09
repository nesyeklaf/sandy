import { writeFileSync } from "node:fs";
import { HolonEngine } from "../engine.ts";

const [bin, root, ready] = process.argv.slice(2);
const engine = new HolonEngine({ bin });
await engine.call(root, { method: "GET", path: "/v0/health" });
writeFileSync(ready, String(process.pid));
setInterval(() => {}, 1000);
