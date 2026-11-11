---
name: harness-status
description: Show where the work stands without Mission Control - the open ask, its stages, what is not finished, the latest journal entries, guard events and hook errors. Use when the user asks for status, progress or what is blocked, in Claude Code, Codex, Cursor or Copilot CLI.
---

# Harness status

Run `python <tools>/loop/lifecycle.py status` from the project root (`<tools>` is the harness tools folder named in your agent instructions) and show its output to the user as it is.

- With an ask open, it lists the ask, its current stage, every stage with its status, what is not finished, and the contract and plan files.
- With no ask open, it lists the recent asks and their stages.
- It always adds the newest journal entries (decisions, issues, pitfalls), the newest guard events and the number of hook errors.

Then add one line on what to do next: answer what waits for the user, or continue the current stage. Do not edit any file the status names.
