---
name: codex-voice
description: Voice input in sandy through the ChatGPT login of the Codex CLI. Use when the microphone fails with a Cloudflare challenge on Codex, or to check or switch the voice service.
---

# Codex voice

The plugin registers the voice service "Codex voice (ChatGPT login)". It sends recordings to
chatgpt.com/backend-api/transcribe (model gpt-transcribe) with the login in ~/.codex/auth.json
(or $CODEX_HOME/auth.json), using curl. chatgpt.com answers Node's fetch (the builtin Codex
service) with a Cloudflare challenge every time and node:https after a pause; curl gets through.
Needs curl on the sandy server host.

- Select it: `sandy settings ai-services show` lists its id; `sandy settings ai-services set voice <id>`.
- Test: `sandy voice transcribe <file> --type audio/wav`.
- Not ready: the Codex login is missing or expired. Run `codex login` (or any codex command, which refreshes the token).
- Recordings still leave the machine, to OpenAI.
