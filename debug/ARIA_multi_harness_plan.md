# ARIA in every harness: what we have to build

**Date:** 10 November 2026 · **Baseline:** `aria-0.27.5` · **Tracker:** `N27`, plan step 10.5 · **Decisions:** `D-042`, `D-050`

## Goal

1. Make the ARIA agents, skills and guards available in GitHub Copilot: Copilot CLI, the VS Code Copilot harness and the Copilot cloud agent.
2. Prove that the same agents work in Claude Code, Cursor and Codex.
3. Make the Mission Control UI work in Cursor and on GitHub. These are the only UI targets; the other harnesses run without a UI.

## Where we are

| Target | Built | Tested live |
|---|---|---|
| VS Code, Local harness | Agents, hooks and Mission Control | Yes |
| Copilot CLI and VS Code Copilot harness | Plugin (`--plugin-dir`) + `export.py copilot --user` + Mission Control Live & Telemetry from `~/.copilot/session-state` | Yes (VS Code Copilot mode, 10–11 Nov) |
| Copilot cloud agent | `export.py cloud .` | No |
| Claude Code | `export.py claude` and `agent_compat.py` mappings | Yes (Claude mode verified working, 11 Nov) |
| Cursor, Codex | `export.py <client>` and `agent_compat.py` mappings | No. Only tested against documented payloads (`tests/test_adapters.py`) |
| Mission Control in Cursor | VSIX installs; chat features assume Copilot Chat | No |
| Mission Control on GitHub | Nothing | No |

## Built in 0.28.0: brand settings and the experience in other tools

| # | What | Where | Tests |
|---|---|---|---|
| 1 | `brand.json` sets the product name, the agent prefix (`aria`) and the state folder (`.aria`). Hooks, tools, exports, Mission Control and the rendered plugin read it | `brand.json`, `hooks/brand.py`, `extension/brand.js` | `tests/test_brand.py`, including a full run with `hve`/`.hve` that writes no `.aria` |
| 2 | Agent templates have no prefix (`lite`, `auto`, `collab`, `prototype-creator`, ...). Exports name them `aria-<id>`; hook files `aria.json`; cloud runtime `.github/aria/runtime` | `extension/agents/`, `tools/adapters/export.py` | `test_adapters`, `test_extension` |
| 3 | Re-exports remove what the last export wrote and no longer writes, plus provably-ours pre-brand `hve-*` copies and `hve.json` files; `--remove` deletes an install | `export.py` (`<state>/exports/<client>.json`) | `test_reexport_removes_stale_and_pre_brand_copies` |
| 4 | Only the agents users pick, `aria-azure-devops` and the agents they, the skills or the lifecycles name are exported; each gets a table mapping VS Code names to the tool's names | `export.py` | `test_export_structure` |
| 5 | Codex installs per project only; every install removes an older user-wide Codex install (it doubled every agent and skill in VS Code) | `export.py`, `extension.js` | `test_codex_user_scope_is_removed_not_installed` |
| 6 | `harness-status` skill and `lifecycle.py status`: status without Mission Control | `tools/loop/ask_status.py` | `test_status_for_tools_without_mission_control` |
| 7 | Install check per tool (launcher, runtime, a harmless hook run) and first-run steps, shown in the **ARIA install** output | `tools/adapters/check.py`, `extension.js` | `test_install_check_catches_a_bad_launcher_and_a_crashing_guard` |
| 8 | Companion mode: hooks record the tool working on the open ask; Mission Control shows **Working in <tool>**, copies its start command, and copies chat messages instead of opening Copilot Chat | `hooks/agent_compat.py`, `extension/ui/companion.js` | `tests/mission-control/companion.test.js` |
| 9 | A6 fixed. Plugin agents' hooks run through `agent_compat.py vscode`, so they work in the Local and Copilot harnesses (before, `loop_guard.py` crashed on Copilot's payload with no `tool_use_id` once an ask was open, and Copilot denied every tool). Copilot CLI loads the same plugin (`copilot --plugin-dir`) instead of copies in `~/.copilot`, which VS Code listed as a second "Folder: agents" entry; install and the post-update prompt remove those copies | `hooks/agent_compat.py`, `extension/render.js`, `extension/extension.js`, `tools/adapters/check.py --plugin` | `test_plugin_agent_hooks_answer_the_local_and_copilot_harness` |

**Still open:**
- **Product name in the UI and agent names.** `product` is used in exports, reports and new messages; the display names (`ARIA Lite`), Mission Control labels and many messages still say ARIA. A blind rename is unsafe: skills use "ARIA" for WAI-ARIA accessibility attributes.
- **Kept on purpose, because client data or published packs use them:** the extension id `frontier-hve` and `frontierHve.*` command ids, the pack format (`hve-plugin.json`, `~/.frontier-hve`), document markers (`<!-- hve-template -->`), `HVE_*` environment variables, the module name `hve_paths.py`.
- **Live from hook events** (a Live timeline for other tools) is not built; guard events already show.
- **Overlap in VS Code** with `~/.claude/agents`/`~/.claude/skills` after a user-scope Claude install, and with `.github/agents` in a repository that has a cloud export: still a second entry per agent.
- **Companion mode for Copilot CLI** only sees the export without the extension: hooks cannot tell Copilot CLI with the plugin from VS Code's Copilot harness, so neither records a client.
- **Logo and design** (Mission Control icon, colours, layout) are not brand settings.

---

## Workstream A: Copilot (CLI and VS Code Copilot harness)

**Already there:** **Install for other tools** in Mission Control, or `export.py copilot --user`, writes:
- `~/.copilot/agents/hve-*.agent.md`
- `~/.copilot/skills/`
- `~/.copilot/hooks/hve.json`
- `~/.aria/runtime/`

The hooks act only while an ask is open.

| # | To do | Why |
|---|---|---|
| A1 | Live run in Copilot CLI: `/agent` lists the `hve-*` agents, `lifecycle.py contract` runs, an edit to `feature_list.json` is denied, the victory check fires at stop, and `hook-errors.log` stays empty | Never run live |
| A2 | Live run in VS Code with Session Target **Copilot**: confirm it lists `~/.copilot/agents` and reads `~/.copilot/skills` | Both assumed, not confirmed |
| A3 | Re-export automatically when the extension version changes | `~/.aria/runtime` goes stale after an update. That causes the `KeyError: 'tool_result'` and "hook errored" reports |
| A4 | Decide on model pins | The export strips `model` and `reasoning-effort`, so exported agents run on whatever model the user picks |
| A5 | Mission Control Live for Copilot CLI sessions | Live reads only `GitHub.copilot-chat/transcripts`. The tabs built from `.aria/` files still work |
| A6 | Duplicate agents in the VS Code Copilot harness picker: each ARIA agent appears as "Folder: agents" and as "Plugin: aria" | The Copilot harness now also lists the extension's plugin agents, so the earlier "Local only" premise is out of date. Decide which source to keep, and check whether the plugin agents' own hooks run there |

**First live run (10 Nov, `aria-testy`, VS Code Copilot harness, extension 0.27.4):** every tool call was denied with `Denied by preToolUse hook from ".github_hooks_hve.json" (hook errored)`.
- **Cause:** the repo also had a cloud export. Its `.github/hooks/hve.json` ran `python3`, which on Windows is the Microsoft Store alias ("Python was not found"). Local Copilot sessions load `.github/hooks/` as well as the user-level hooks, and Copilot fails closed on a crashing `preToolUse` hook.
- **Fixed in 0.27.6:** the cloud entries use `bash` (`python3`) with a `powershell` no-op.
- **Also found:**
  - the extension installed was 0.27.4, so `~/.aria/runtime` lacked the 0.27.5 never-block fix;
  - the agent picker showed duplicates (A6).

## Workstream B: Copilot cloud agent

**Already there:** `export.py cloud .` writes `.github/agents`, `.github/skills`, `.github/hooks/hve.json` and `.github/hve/runtime` (171 files, 1.2 MB). The hooks run with `python3` and act only while an ask is open.

| # | To do | Why |
|---|---|---|
| B1 | Done (export writes it): `.github/workflows/copilot-setup-steps.yml` installs Python 3.12 and fails if the runtime is not committed | Every hook needs Python. If Python is missing, every guard is skipped and nothing is guarded |
| B2 | Non-interactive mode for the cloud-exported agents | The agents ask questions and stop at gates; the cloud agent cannot answer either. In the cloud, the agents should write assumptions and gate decisions into the PR description instead |
| B3 | Check that `lifecycle.py contract` runs first in a cloud job and creates `.aria/asks/active.json` | Without it, the ask-only hooks never act |
| B4 | Decided: commit them. The cloud export sets `.gitignore` to `.aria/*`, `!.aria/asks/`, `!.aria/project/`; `loop.py init` no longer adds `.aria/` over it | The PR carries the plan, evidence and journal as provenance; `.aria/runs/` stays out |
| B5 | Update path for `.github/hve/runtime` (re-export per release, possibly from a workflow) | The committed copy does not update itself |
| B6 | Org-wide agents: check whether agents in the organisation's `.github-private` repository reach every repo | This would avoid copying the agents into each repo. Hooks and the runtime stay per repo |
| B7 | Prerequisites page: Copilot plan, organisation policy enabling the coding agent, repository access | Teams need this before step one |
| B8 | Live run: assign a two-feature issue to Copilot with `hve-creator` and check the PR, the guard denials and the victory check | Never run live |

## Workstream C: Claude Code, Cursor and Codex

Run the same live script per client and report under `N27`:
1. Run the export in a scratch repo.
2. Start `hve-creator` and give it a two-feature task.
3. Check:
   - the agent is listed;
   - the contract runs;
   - an edit to `feature_list.json` is denied;
   - the victory check fires;
   - `hook-errors.log` stays empty;
   - an Azure DevOps read works.

Open assumptions to confirm:
- Cursor accepts an empty `preToolUse` response.
- The keys in Claude's `AskUserQuestion` answers.
- Codex reads `~/.agents/skills`.
- Cursor reads `~/.cursor/skills`.

Also open: plan step 10.5 (same prompt in each client, metrics within 5%).

## Workstream D: Mission Control in Cursor

Works as is, because these features only read and write `.aria/` files:
- asks, Plan, Accept, Mark done;
- the Progress journal;
- Skills;
- the harness and project file trees.

| # | To do | Why |
|---|---|---|
| D1 | Feed Live, Now and Needs you from hook events in `.aria/runs/` instead of Copilot transcripts | Cursor writes no `GitHub.copilot-chat/transcripts`. Hook events come through `agent_compat.py` in every client, so the same fix covers Claude Code, Codex and Copilot CLI |
| D2 | Detect the host (`vscode.env.appName`) and replace `workbench.action.chat.*` in Open chat, Request changes and New ask | These commands come from Copilot Chat and are not in Cursor. Fallback: put the request text on the clipboard and open Cursor's Agent chat |
| D3 | Check that Cursor's VS Code base meets `engines.vscode ^1.100.0` | Otherwise the VSIX will not install |
| D4 | Skip `chat.pluginLocations` registration in Cursor and offer the Cursor export instead | Plugin locations do nothing in Cursor |

## Workstream E: Mission Control on GitHub (open)

What "GitHub" means here is not decided yet:

| Option | What the UI can be |
|---|---|
| GitHub Desktop | Desktop cannot run extensions. Needs a standalone Mission Control (a local page served from `.aria/`) used next to Desktop |
| GitHub Codespaces | The VSIX runs as it does in VS Code |
| github.com and the cloud agent | The PR is the UI: a status comment or check built from the ask's plan, evidence and guard events |

---

## Order

1. Copilot and the cloud agent: A1–A3, then B1–B3 and B8.
2. Live checks in Claude Code, Cursor and Codex (C).
3. Hook-driven Live and host detection (D1, D2). This makes the UI work in Cursor.
4. Decide what "GitHub" means for the UI, then build E.

## Open questions

1. What does "GitHub" mean for the UI: Desktop, Codespaces or github.com?
2. Should exported agents keep the model pins where the client allows it?
3. In the cloud, should `.aria/` ask files be committed with the PR? Decided: yes.
4. Who runs the live checks in each client?
