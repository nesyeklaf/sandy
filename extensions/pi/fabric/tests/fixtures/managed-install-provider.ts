import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

// Deterministic offline model: one fabric_exec that writes and reads a file
// through nested Pi tools, then a final text. Pi's normal dispatch runs the tool.
export default function (pi: ExtensionAPI) {
  let calls = 0;
  pi.registerProvider("managed-install", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "offline-probe",
    api: "managed-install-api",
    models: [{
      id: "probe", name: "Probe", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model) {
      const file = JSON.stringify(process.env.FABRIC_PROBE_FILE);
      const code = calls++ === 0
        ? `await pi.write({ path: ${file}, content: "hello from probe\\n" }); return await pi.read({ path: ${file} });`
        : undefined;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: code
          ? [{ type: "toolCall", id: "probe-call", name: "fabric_exec", arguments: { code } }]
          : [{ type: "text", text: "Probe finished." }],
        stopReason: code ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: code ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
}
