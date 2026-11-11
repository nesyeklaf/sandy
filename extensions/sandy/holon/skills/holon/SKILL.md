---
name: holon
description: Check holon files in Git, list drift, view one holon, record evidence and write confirmations with the sandy holon CLI, and fix a missing holon binary. Use when a task touches .holon files, holon lights or drift, or sandy holon reports holon_not_installed.
---

# Holons

`sandy holon` is a thin client of the Rust `holon` binary (github.com/nesyeklaf/holons). It starts one `holon serve` process per model root on a loopback port with a random token, keeps it for 15 minutes of idleness and stops it when the plugin unloads.

- `sandy holon check|drift|view <slug> [--root <dir>] [--now <iso>] [--commit <sha>] [--json]`: `--root` defaults to the repository root. `check` exits 1 when the model has errors.
- `sandy holon evidence record --file <jsonl>` or `--jsonl <text>`: one complete evidence record per line, as in the `shop` fixture's `evidence.jsonl`.
- `sandy holon confirm <slug> --side <I|It|We|They|seam:to> --by <who> --answer <text> [--hesitation <text>]... [--result confirmed|refuted]`: writes `.holons/confirmations/<slug>/…json`.
- `evidence record` sends the whole file as one request; `holon serve` accepts at most 64 MB per request and the plugin does not split files. A larger file fails with `body_too_large`: import it with the standalone `holon evidence import --file <path>`.
- Recording one run from flags (`--holon`, `--side`, `--result`, …) and `--replace` have no `holon serve` route yet and fail with `unsupported_option`. Use `--file`, `--jsonl` or the `holon` CLI.

## Holons thread tab

- Every thread has a Holons tab: the holon editor from holon-ui on the thread environment's directory, served by the same `holon serve` process as the CLI. Edits in the tab write `.holon` files and `.holons/` policy in that directory.
- The tab works only for an environment on the sandy server's own host; a thread without an environment shows a notice, one on another host fails with `remote_workspace`.
- The editor is vendored in `vendor/holon-ui` with the holons commit in `VERSION`. Refresh it with `pnpm sync:holon-ui <holons checkout>`, which runs holon-ui's `pnpm build:lib` and copies the editor, its CSS, the routing and layout workers and `libavoid.wasm`.

## The holon binary

- The plugin runs the binary in `HOLON_BIN` (absolute path), else `holon` on PATH. Set `HOLON_BIN` in the environment of the sandy server (`npx sandy-app env set HOLON_BIN /path/to/holon`) and restart it.
- Without a binary every command fails with `holon_not_installed`. Install it from a checkout of github.com/nesyeklaf/holons with `cargo install --path holon-cli`.
- Every request to the server has a 120 s deadline, for reads and writes. A request that exceeds it fails with `holon_timeout`; the server keeps running and the plugin does not retry.
- A process that does not print its address within 10 seconds fails with `holon_start_timeout` and the tail of its stderr.
- The index database lives in the holon data directory (`$XDG_DATA_HOME/holon`), one per repository.
