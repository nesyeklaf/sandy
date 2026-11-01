---
name: mcp
description: Connect Claude Desktop, Codex or another MCP client on this machine or your tailnet to this sandy.
---

# sandy MCP server

The MCP server plugin lets an MCP client control this sandy. It is off by default. Turn it on in Settings → Plugins or with `sandy plugin enable sandy--mcp`.

## Address

`sandy mcp status [--json]` prints the loopback address: `http://127.0.0.1:<port>/api/v1/plugins/sandy--mcp/http/mcp`. Apps on the same machine use it directly.

Devices on your tailnet or WireGuard network reach the same path on an address listed in `SANDY_SERVER_BIND_HOST`, or through the Tailscale Serve URL of this sandy. There is no public address and no sign-in: the Tailscale and WireGuard keys are the authentication. Requests from web pages are refused.

## What a client can do

Access is all or nothing. A client can run any `sandy` command: it can see everything in this sandy, and it can start and message agents and open terminals, which run commands and change files on the machines this sandy controls. Connect only clients you trust.

## Tools the client sees

- `search` finds `sandy` commands for a task.
- `read` runs a JavaScript snippet that can call only commands that inspect sandy. It is marked read-only so the app can run it without asking you each time; it is not a separate permission.
- `run` runs a JavaScript snippet that can call any `sandy` command.

Snippets call `sandy.cli([...argv])` or `sandy.json([...argv])` and run in a sandbox on the sandy server with no network or file access. A snippet is stopped after 25 seconds, after 3 seconds of computation, or when it runs out of its 64 MB of memory, and runs at most 4 `sandy` commands at a time.

Three commands cannot run over MCP because they need an interactive terminal or never exit: `sandy terminal attach`, `sandy plugin dev`, and `sandy browser watch`.

## Protocol

The endpoint speaks MCP 2026-07-28 and also answers 2025-era clients. It is stateless: there are no sessions.
