# ARIA release notes: 0.25.0 to 0.27.5

**Period:** 4 to 9 November 2026 · **Latest build:** `aria-0.27.5.vsix` · **Releases covered:** 11

This round of releases makes ARIA dependable to work with day to day. Guardrails no longer get in your way, Mission Control shows what the agent is really doing, and you can review and steer the work without leaving it.

---

## Highlights

### 1. Guardrails that never block your work
ARIA's hooks now flag problems instead of stopping you.
- If a hook fails, the agent carries on.
- The error is logged to `.aria/runs/hook-errors.log` and shown in Mission Control.

Pushes no longer fail with "only allowed for GitHub review loops". ARIA now asks you to confirm and says why.

### 2. Mission Control shows what is really happening
- **Live** follows the chat that is actually working on your ask.
- An **Open chat** button takes you straight to that chat.

### 3. Steer the work from the Plan tab
- **Request changes** opens the ask's chat with your request filled in, ready to send. The stage goes back to active until the agent has finished.
- **Mark done** closes a stage the chat shows is finished.
- **Accept** now works even while the agent is busy writing files.

### 4. Review without hunting for files
- Every file you are asked to review is a link: in chat, in Needs you, in guard alerts and on the Plan tab.
- Each task's **Show changes** opens its commits in VS Code's diff view.
- The sidebar shows your whole project as a folder tree.

### 5. A project journal that remembers
The Progress tab keeps a running log of the project's **decisions, issues and pitfalls**. Every ARIA agent adds to it as it works, so the reasons behind the work are not lost when a chat ends.

### 6. Skills you can trust
- While an ask is open, the agent uses the **ask's own skills**, not whatever a chat message happens to mention.
- "Skills used" now means skills the agent actually read.
- The Skills and Telemetry tabs now give the same numbers.
- You can **add a skill** to an ask in two clicks.

---

## Upgrade in three steps

1. **Install:** in VS Code, go to **Extensions**, then **...**, then **Install from VSIX...**, and choose `aria-0.27.5.vsix`. Reload when asked.
2. **Coming from 0.24 or older?**. On first start, accept **Uninstall old ARIA** and reload. Your `.aria/` folders and installed packs are kept.
3. **Using Copilot CLI, Claude Code, Cursor or Codex?** Run **Install for other tools** again from Mission Control > Settings. Those tools use their own copy of ARIA, which does not update itself.

> **Tip:** if you still see `KeyError: 'tool_result'` or "hook errored" in Copilot CLI, step 3 was skipped. The old copy in `~/.aria/runtime` is still being used.

---

## What's new, by area

### Reliability and guardrails
| | |
|---|---|
| **Hooks never block** | A failing hook is skipped, logged to `.aria/runs/hook-errors.log` and shown in Mission Control as "Nothing was blocked". Real rules (protected loop files, git-hook bypass, escalations) still apply. |
| **Copilot hooks fixed** | Hooks now read tool results from Copilot in VS Code and from Copilot CLI alike. They also read tool arguments whether Copilot CLI sends them as an object or as JSON text. |
| **`apply_patch` edits** | Edits made with `apply_patch` are no longer refused. Every file a patch adds, updates, deletes or moves is checked. |
| **Push confirmation** | A force push, an unticked branch or a push under local review asks you to confirm, with links to the files behind the reason. Locally reviewed branches can be opened as **draft PRs**. |

### Mission Control: Live
| | |
|---|---|
| **Follows the working chat** | Live shows the ask's most recently active chat. If you pick an older chat, Live moves on once a newer one becomes active. |
| **Waiting for your Allow** | The Now card names the step waiting for you. Needs you has an **Open chat** button. Requests left for more than an hour no longer count as waiting. |
| **Clearer between steps** | Between steps, Now names the last step ("After: Edited index.html"). |

### Plan and sign-off
| | |
|---|---|
| **Request changes goes to the agent** | Your request is recorded and the stage goes back to active. The ask's chat opens with your message ready to send. The Plan tab then follows it: "sent to the agent", then "done again: review it again". |
| **Mark done** | Sets a planned or active stage to done when the chat shows it is finished. The harness still checks the stage's evidence. |
| **Accept without a written plan** | Small asks with no `plan.md` can be accepted. |
| **No more "Workspace state changed"** | A decision is checked only against the item you acted on, so a busy agent no longer gets in the way. |

### Progress
| | |
|---|---|
| **Project journal** | A timeline of decisions, issues and pitfalls for the whole project, newest first. Entries from other asks are marked. |

### Skills
| | |
|---|---|
| **Ask-scoped skills** | With an ask open, the agent is allowed only the ask's skills plus the current stage's. |
| **Used means read** | Skill counts and skill tokens reflect the skill files the agent actually opened. |
| **Add a skill** | **Skills & packs > Add a skill...** lists the library and expertise-pack skills the ask does not have yet, with the new token total. From chat, use `lifecycle.py skills add <name>`. |
| **Plain-word reasons** | Each skill says why it was chosen, for example "matches words in your request", and shows a "read in this chat" mark. |

### Telemetry
| | |
|---|---|
| **Cache tokens tile** | Shows the share of input tokens read from the prompt cache, when research telemetry is on. |
| **Clickable tiles** | Turns, tool calls and chat tokens open Live with the matching filter. The skill tiles open Skills & packs. |

### Navigation and polish
| | |
|---|---|
| **Project tree in the sidebar** | Your whole workspace, without `.git` and `node_modules`; any file opens with one click. |
| **Hover only where it matters** | Only clickable elements highlight. |
| **Better examples** | New-ask examples read like real project requests. |
| **Tidier Skills layout** | Each skill takes two lines, not four, in narrow panels. |

---

## Version by version

| Version | Date | What changed |
|---|---|---|
| **0.27.5** | 9 Nov | A failing hook never blocks: skipped, logged and shown in Mission Control |
| **0.27.4** | 9 Nov | Live follows the active ask's latest chat; old requests no longer show as waiting |
| **0.27.3** | 9 Nov | Request changes goes to the agent in Chat |
| **0.27.2** | 9 Nov | Ask-scoped skills; skill counts show skills actually read |
| **0.27.1** | 9 Nov | Waiting-for-Allow shown; decisions work while the agent is busy |
| **0.27.0** | 9 Nov | Add a skill; task changes and Show changes; project tree; hover clean-up |
| **0.26.3** | 9 Nov | `apply_patch` fix; push confirmations instead of blocks; review files as links |
| **0.26.2** | 9 Nov | Copilot hook fix; Mission Control follows the working chat |
| **0.26.1** | 6 Nov | Cache tokens tile on Telemetry |
| **0.26.0** | 6 Nov | Project journal; Mark done; Accept without a written plan; better new-ask examples |
| **0.25.0** | 4 Nov | Published by pwc, with a guided switch from the old copy |

---

## Good to know

- **Adding a stage to an ask** is recorded in the plan only. A command to add it to the ask's contract is planned.
- **Push confirmation** shows as a warning in Codex. Cursor accepts it but does not enforce it yet.
- **If a hook error appears,** your work is not blocked. Send us `.aria/runs/hook-errors.log` and we will take a look.
