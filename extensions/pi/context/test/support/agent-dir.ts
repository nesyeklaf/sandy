import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pi and this extension read the agent directory from PI_CODING_AGENT_DIR, default ~/.pi/agent. Every test file
// starts with a fresh one, so no test reads, moves or writes the user's settings, ledger or logins.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "context-agent-dir-"));
