import { readFileSync } from "node:fs";

const bundle = readFileSync("dist/app.js");
console.log(`App bundle: ${bundle.byteLength} bytes.`);
if (bundle.includes("ZodError")) {
  console.error("App bundle failed: dist/app.js contains ZodError.");
  process.exitCode = 1;
} else {
  console.log("App bundle passed: no ZodError.");
}
