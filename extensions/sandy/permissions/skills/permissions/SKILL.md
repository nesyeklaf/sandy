---
name: permissions
description: Check or change pi's permission mode and command blocklist (ssh etc.) with the sandy permissions command. Use when the user asks about permission modes, blocked commands, or why a command was blocked.
---

# Permissions

pi blocks listed programs (default ssh, scp, sftp, rsync, sshfs, mosh) in every mode, yolo included. Exceptions are exact word prefixes, default `ssh AI`; a following option such as `ssh AI -o …` is not covered.

- `sandy permissions status`: settings and the pi config file
- `sandy permissions mode ask|auto|yolo`
- `sandy permissions block <program>` / `unblock <program>`
- `sandy permissions allow "<rule>"` / `disallow "<rule>"`

Only change these when the user asks. The check is a best-effort parse of the command line, not a sandbox: variables and scripts are not resolved. A blocked command stays blocked; do not look for a way around it, report it.
