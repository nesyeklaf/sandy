import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandyCli, sandyCommand } from "./sandy-cli.ts";

const dir = mkdtempSync(join(tmpdir(), "sandy-cli-"));

// A fake sandy CLI script: prints `stdout`, then `stderr`, then exits with `code`. Run through sandyCli as SANDY_CLI.
const fakeCli = (name: string, stdout: string, stderr: string, code: number) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exitCode = ${code};\n`);
  chmodSync(path, 0o755);
  return sandyCli({ env: { SANDY_CLI: path } });
};

// Windows, Node 24: the sandy CLI up to 0.48.1 prints a plugin command's complete answer, then its process.exit aborts
// in libuv (exit 0xC0000409, 127 under bash). Seen on seraphim with sandy 0.48.1 for every `sandy work ...` call.
const LIBUV_ABORT = "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76\r\n";

test("sandyCommand: SANDY_CLI picks the binary; on Windows a script runs under node, an .exe or .cmd runs itself", () => {
  assert.deepEqual(sandyCommand({}, "linux", "/node"), { file: "sandy", leadingArgs: [] });
  assert.deepEqual(sandyCommand({ SANDY_CLI: "/opt/sandy" }, "linux", "/node"), { file: "/opt/sandy", leadingArgs: [] });
  assert.deepEqual(sandyCommand({ SANDY_CLI: "C:\\sandy\\dist\\sandy" }, "win32", "C:\\node.exe"), { file: "C:\\node.exe", leadingArgs: ["C:\\sandy\\dist\\sandy"] });
  assert.deepEqual(sandyCommand({ SANDY_CLI: "C:\\sandy\\sandy.EXE" }, "win32", "C:\\node.exe"), { file: "C:\\sandy\\sandy.EXE", leadingArgs: [] });
  assert.deepEqual(sandyCommand({}, "win32", "C:\\node.exe"), { file: "sandy", leadingArgs: [] });
});

test("sandyCli: resolves the stdout of a clean exit", async () => {
  assert.equal(await fakeCli("ok.mjs", "{}\n", "", 0)(["x"]), "{}\n");
});

test("sandyCli: a JSON answer followed by the libuv teardown abort is the answer", async () => {
  const answer = JSON.stringify({ status: "ok", nonce: "n" }) + "\n";
  assert.equal(await fakeCli("abort-json.mjs", answer, LIBUV_ABORT, 127)(["work", "delegate", "policy"]), answer);
});

test("sandyCli: a failure stays a failure: nonzero exit without the abort, or the abort without a JSON answer", async () => {
  await assert.rejects(fakeCli("fail-json.mjs", "{}\n", "refused\n\nusage text\n", 1)(["work", "track", "drive", "claim"]), { message: "sandy work track drive: refused" });
  await assert.rejects(fakeCli("abort-empty.mjs", "", "nonce was already acked\n" + LIBUV_ABORT, 127)(["x"]), /already acked/);
  await assert.rejects(fakeCli("abort-text.mjs", "partial {", LIBUV_ABORT, 127)(["x"]), /UV_HANDLE_CLOSING/);
});

test("sandyCli: an aborted call rejects with the AbortError", async () => {
  const path = join(dir, "slow.mjs");
  writeFileSync(path, "#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n");
  chmodSync(path, 0o755);
  const controller = new AbortController();
  const call = sandyCli({ env: { SANDY_CLI: path } })(["x"], controller.signal);
  controller.abort();
  await assert.rejects(call, { name: "AbortError" });
});
