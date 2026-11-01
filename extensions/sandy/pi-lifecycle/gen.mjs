import { readFileSync, writeFileSync } from "node:fs";
const source = readFileSync(new URL("./pi-extension.ts", import.meta.url), "utf8");
writeFileSync(new URL("./extension-source.ts", import.meta.url), `// Generated from pi-extension.ts by \`npm run gen\`; check.test.ts fails when it is stale.\nexport default ${JSON.stringify(source)};\n`);
