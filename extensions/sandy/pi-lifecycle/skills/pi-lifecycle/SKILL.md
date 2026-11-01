---
name: pi-lifecycle
description: Show which SANDY sessions have a loaded pi process, when it started or reloaded, its CPU and RAM, and restart or reload pi per session or per host.
---

# pi lifecycle

- `sandy pi-lifecycle status [--json]`: loaded pi processes on every connected host.
- `sandy pi-lifecycle restart <thread> [--force]`: release the session's pi; the next message starts a fresh one. Refuses a running thread without `--force`.
- `sandy pi-lifecycle reload <thread>`: reload extensions, skills and settings once pi is idle. Needs the lifecycle pi extension (install it on the "pi processes" page).
