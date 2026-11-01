// sandy-plugin-codex-voice: voice input through the ChatGPT login of the Codex CLI.
// The builtin Codex voice service sends with fetch and gets a Cloudflare challenge; this one uses curl.
// It runs in the server process and reads ~/.codex/auth.json there, so it needs the sandy server and the
// Codex login on the same machine.
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { readCredentials, transcribe } from "./transcribe.ts";

export default async function plugin(sandy: SandyPluginApi) {
  sandy.experimental_aiServices.register({
    id: "chatgpt",
    displayName: "Codex voice (ChatGPT login)",
    transcribe: (audio, { signal, hint }) => transcribe(audio, hint, signal),
    status: async () => {
      const auth = await readCredentials();
      if (!auth.ok) return { ready: false, message: auth.message };
      if (auth.credentials.expired) return { ready: false, message: "The Codex login expired. Run codex once or codex login on this host." };
      return { ready: true };
    },
  });
}
