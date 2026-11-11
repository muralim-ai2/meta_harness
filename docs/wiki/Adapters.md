# Adapters: ARIA in every harness (Copilot, Claude Code, Cursor, Codex, cloud agent) and Azure DevOps

Use the ARIA agents, skills and guard hooks outside VS Code's Local harness. Connect Azure DevOps through Microsoft's Azure DevOps MCP server.

> **Status:** built and protocol-tested (`tests/test_adapters.py`). Live runs verified: VS Code Local, VS Code Copilot mode (10–11 Nov, including Mission Control Live and Telemetry), and Claude Code / Claude mode (11 Nov). Cursor, Codex and the cloud agent have not been run live yet, and the Azure DevOps server has not been started from this setup. Report what fails under tracker issue `N27`. Decisions: `D-042`, `D-050`. Research note: `research/findings/phase-10-adapters.md`.

## Names and folders come from brand.json

`brand.json` (in the repository root, copied into every runtime) sets three things, and every harness follows them:

| Key | Default | Used for |
|---|---|---|
| `product` | `ARIA` | Product name in messages and reports |
| `prefix` | `aria` | Exported agent names (`aria-lite`, `aria-auto`, `aria-collab`, `aria-prototype-creator`, ...), hook files (`~/.copilot/hooks/aria.json`, `.github/hooks/aria.json`), the cloud runtime (`.github/aria/runtime/`) and the VS Code plugin name (`aria:<skill>`) |
| `state_dir` | `.aria` | The workspace state folder (asks, project, runs, skills) and the runtime folder (`.aria/runtime/`, `~/.aria/runtime/`); agent and skill text is rewritten to it on export and render |

Agent templates in `extension/agents/` carry no prefix: `lite`, `auto`, `collab`, `prototype-creator`, `engineer`, and so on (the id is the display name without the product). Exports add the prefix.

## Where the extension's agents run

- The extension registers its agents through `chat.pluginLocations`. VS Code's **Local** and **Copilot** harnesses both list them, and **Copilot CLI** loads the same plugin with `copilot --plugin-dir <plugin folder>`. **Claude** reads `.claude/agents`; **Codex** and **Cursor** read their own folders; the **cloud agent** reads only the repository.
- The plugin agents' own hooks run through `agent_compat.py vscode`, which reads the Local payload (it has a tool call id) and the Copilot payload (it has none) and answers in each harness's format. Before 0.28.0 the hooks ran the guards directly: in the Copilot harness a guard crashed on the missing tool call id, and Copilot turns a crashing `preToolUse` hook into a deny of every tool.
- `handoffs:` work only in Local (VS Code docs).
- Cursor is a separate editor that does not run VS Code chat.

**For the other tools:** run **ARIA: Install for other harnesses**. It installs the agents, the harness skills and the guard hooks in each harness's own folders, from the same agent templates, copies the runtime, checks each install and lists its first-run steps. The agents' ask contract (`lifecycle.py contract`, `brief`, `report`, `status`) is a terminal command, so skills, briefs, provenance and status work even where a hook channel is missing.

## At a glance

| Client | Scope | What you get | Hooks live in | Hook scope |
|---|---|---|---|---|
| Copilot CLI | user | nothing copied: `copilot --plugin-dir <plugin folder>` loads the extension's plugin (agents, skills, agent hooks) | the agent file | only while that agent runs |
| Copilot CLI without the extension | user | `~/.copilot/agents/aria-*.agent.md`, `~/.copilot/skills/`, `~/.copilot/hooks/aria.json` (`export.py copilot --user`) | `~/.copilot/hooks/aria.json` | every Copilot session, acting only while an ask is open |
| Copilot cloud agent | project | `.github/agents/`, `.github/skills/`, `.github/hooks/aria.json`, `.github/aria/runtime/`, `.github/workflows/copilot-setup-steps.yml`, `.gitignore` rules (you commit them) | `.github/hooks/aria.json` | every cloud job, acting only while an ask is open |
| Claude Code | user or project | `.claude/agents/aria-*.md`, `.claude/skills/`, `.mcp.json` (project) | the agent file | only while that agent runs |
| Cursor | user or project | `.cursor/skills/` (agents as skills), `.cursor/hooks.json`, `.cursor/mcp.json` (project) | `.cursor/hooks.json` | every agent (user scope: only while an ask is open) |
| Codex CLI | project only | `.agents/skills/` (agents as skills), `.codex/hooks.json`, `.codex/config.toml` | `.codex/hooks.json` | every session |
| VS Code | project | `.vscode/mcp.json` (Azure DevOps only; agents come from the extension) | the agent file | only while that agent runs |

User scope writes under your home folder (`~/...`) and works in every workspace; nothing is committed. Codex has no user scope: VS Code and Copilot also read `~/.agents/skills`, so a user-wide Codex install loaded every agent and harness skill a second time there. Install also sets `chat.hookFilesLocations` so VS Code's Local harness does not run the Copilot and cloud hook files (current and pre-brand names) on top of the agents' own hooks.

**Which agents each client gets:** the four you pick (`aria-lite`, `aria-auto`, `aria-collab`, `aria-prototype-creator`), `aria-azure-devops`, and every agent those agents, the exported skills or the lifecycles name (engineer, personas, reviewers, council, judges). Research baselines (`minimal`, `single`, `research-*`) and unreferenced helpers (the flow and GitHub creators) stay in VS Code. Each exported agent ends with a short table that maps the VS Code agent names it mentions (`ARIA engineer`) to the names in that tool (`aria-engineer`).

**Skills:** the harness skills (`delivery-coach`, `feature-checklist`, `run-tests`, `code-review`, `parallel-options`, `explain-walkthrough`, `prototype-guardrail`, `recommend-skills`, `check-context-load`, `harness-status` and the rest of `extension/skills/`). `pr-push` stays in VS Code because it needs the GitHub Pull Requests extension. Copilot agents lose the Local-only fields (hooks, handoffs) and keep only the read-only and blind agents' tool lists, as Copilot aliases (`read`, `search`, `execute`).

**Overlap in VS Code:** VS Code also reads `~/.copilot/agents`, `.github/agents`, `~/.claude/agents` and `~/.claude/skills`. A Copilot install from before 0.28.0 put a second copy of every agent in `~/.copilot/agents` ("Folder: agents" next to "Plugin: aria"); the prompt after the update, or **Install for other harnesses**, removes it. A user-scope Claude install or a cloud export in the open repository still adds its own copy; pick **Plugin: aria** in VS Code.

## Before you start

- **ARIA extension 0.27.6 or later:** installed in VS Code. Cursor can install the same VSIX. The exporter and the harness runtime ship inside it, at `<extension folder>/runtime/` (for example `~/.vscode/extensions/pwc.frontier-hve-<version>/runtime/`). In this repository, run `python extension/build.py` first and use `extension/runtime/`.
- **Python:** 3.11 or newer on `PATH` as `python`. Every hook runs `python` (`python3` in the cloud).
- **For Azure DevOps:**
  - Node.js 20 or newer.
  - An account with access to the organization.
  - On Microsoft-managed devices, an npm registry that works. Check `npm config get registry`; the general proxy is `https://packagefeedproxy.microsoft.io/npm/`.

## Export

**From chat:** pick an ARIA agent in VS Code and type `/export-harness`. The agent asks which harnesses and scope, and the Azure DevOps organization, runs the exporter and shows how to start each client.

**From the Command Palette:** **ARIA: Install for other harnesses** checks Copilot CLI against the extension's plugin (nothing is copied), installs Claude Code and Cursor at user scope, and Codex and the cloud agent into the open workspace (the cloud agent after a confirmation). Every run also removes older user-wide Codex and Copilot copies (`~/.agents/skills`, `~/.codex/hooks.json`, `~/.copilot/agents`, `~/.copilot/skills`, `~/.copilot/hooks`), which VS Code would list a second time. Then it checks each install and opens **ARIA install** in the Output panel with the results and each tool's first-run steps.

**From a terminal**, in the project root:

```powershell
$ext = Get-ChildItem "$HOME/.vscode/extensions/pwc.frontier-hve-*" | Sort-Object LastWriteTime | Select-Object -Last 1
$tools = "$($ext.FullName)/runtime/tools/adapters"
python $tools/export.py copilot --user             # Copilot CLI on a machine without the extension, every workspace
python $tools/export.py claude --user              # Claude Code, every workspace
python $tools/export.py cloud .                    # Copilot cloud agent: writes .github/ for you to commit
python $tools/export.py claude . --ado contoso     # Claude Code for this project (+ Azure DevOps)
python $tools/export.py cursor . --ado contoso     # Cursor
python $tools/export.py codex  . --ado contoso     # Codex CLI (project only)
python $tools/export.py vscode . --ado contoso     # Azure DevOps for VS Code only
python $tools/export.py codex --user --remove      # remove an older user-wide Codex install
python $tools/check.py claude .                    # check an install and print its first-run steps
python $tools/check.py copilot --plugin "$env:APPDATA/Code/User/globalStorage/pwc.frontier-hve/plugin"   # check Copilot CLI with the extension's plugin
```

`--user` works for `copilot` (only scope), `claude` and `cursor`; `--python "py -3"` sets the launcher the hooks use. `--ado` is optional at project scope for `claude`, `cursor` and `codex`, and required for `vscode`. `--remove` deletes what earlier exports to that client and scope wrote and writes nothing; it keeps the runtime, which other clients share. The exporter prints a JSON report with these fields:
- `written`: every file and folder it created or updated.
- `removed`: copies an earlier export left that this one no longer writes, including pre-brand `hve-*` agents and skills and `hve.json` hook files.
- `invoke`: how to start the agents.
- `gaps`: what does not work in that client.
- `guide`: this page inside the copied runtime.

What it writes:
- **`.aria/runtime/`:** a copy of the harness (hooks, loop tools, skill library, licenses). Every client's hooks run from here.
- **`.aria/runs/` and `.aria/user_profile.json`:** the state the hooks read. An existing profile is kept.
- **`.aria/exports/<client>.json`:** what this export wrote, so the next export removes what it no longer writes.
- **The client's agent, skill, hook and MCP files**, as listed in the table above.

Safety rules:
- A hooks file or setup workflow that ARIA did not write is never overwritten. The export stops and names the file; merge it by hand.
- Removal only touches paths inside the client's own agent, skill, hook and runtime locations, and pre-brand copies only when their text proves ARIA wrote them (the template's description or name, or a runtime reference).
- MCP files are merged: only the `ado` entry is added or replaced.
- The organization name must be letters, digits and hyphens.
- Running the export again is safe.

**The install check (`check.py`)** runs, per client: the Python launcher (found and 3.11+), the copied runtime, and one PreToolUse hook on a harmless read in a scratch workspace, with the client's own payload. It fails when the launcher does not start (for example `python3` on Windows), a guard crashes (the hook-errors log in the scratch workspace), or a harmless read is denied. For the cloud agent it checks the setup workflow and the hook file instead of running Linux commands.

## Use the agents

### Copilot CLI and the VS Code Copilot harness
1. In VS Code, set Session Target **Copilot** (or **Local**) and pick **ARIA Lite** (Plugin: aria). Its own hooks run in both harnesses.
2. In Copilot CLI, start `copilot --plugin-dir "$env:APPDATA/Code/User/globalStorage/pwc.frontier-hve/plugin"` and pick **ARIA Lite** with `/agent`. This is the plugin VS Code renders and updates, so nothing needs exporting again after an update.
3. Without the extension, `export.py copilot --user` installs copies instead. The first thing the agent runs is `lifecycle.py contract ...`; from then on `~/.copilot/hooks/aria.json` acts in that workspace. `lifecycle.py close` stops it; `lifecycle.py open <slug>` reopens an ask.

### Copilot cloud agent
1. Run `export.py cloud .`. Besides the agents, skills, hooks and runtime it writes:
   - `.github/workflows/copilot-setup-steps.yml`: installs Python 3.12 before each job and fails if the runtime is not committed. An existing workflow you wrote is never overwritten; add its steps by hand.
   - `.gitignore` rules `.aria/*`, `!.aria/asks/`, `!.aria/project/`: the ask and project records are committed with the pull request; hook run state in `.aria/runs/` is not. A plain `.aria/` rule is replaced.
   - Hook entries carry a `bash` command (`python3`, run by the cloud's Linux sandbox) and a `powershell` no-op. Local Copilot sessions also load `.github/hooks/`; on Windows they skip these entries and rely on the user-level Copilot hooks. On macOS and Linux they run them as well as the user-level hooks (unverified).
2. Review and commit `.github/agents`, `.github/skills`, `.github/hooks/aria.json`, `.github/aria/runtime`, the workflow and `.gitignore` to the default branch.
3. Assign an issue to Copilot and pick an ARIA agent. The job is non-interactive: plan and gate questions are skipped; the pull request carries the work and the ask records.

### Claude Code
1. Run `claude --agent aria-lite`. The header shows `@aria-lite`.
2. Accept the workspace trust prompt. Until you do, Claude Code skips the agent's hooks.
3. To delegate to another agent, use its exported name, for example `@"aria-azure-devops (agent)"`. Skills appear under `/`.
4. To make Lite the default for this project, add `"agent": "aria-lite"` to `.claude/settings.json`.

### Cursor
1. Type `/aria-lite` in Agent chat for one message. To keep it on for the whole session, press **Alt+Enter** on it (Custom Mode).
2. The hooks in `.cursor/hooks.json` apply to every agent chat in this project. Check them in **Customize → Hooks**; the Hooks output channel shows errors.
3. If you also exported for Claude Code, Cursor loads `.claude/skills/` as well and lists each skill twice. Keep one export per project, or turn off **Settings → Agents → Third-Party Imports**.

### Codex CLI
1. Start `codex` from the project root. Project hooks run in the session directory and use `.aria/runtime/...` relative paths.
2. Trust the project. Then open `/hooks`, then review and trust the ARIA hooks. Codex skips untrusted hooks.
3. Type `$aria-lite` or `$aria-azure-devops`, or pick them from `/skills`. These skills are never invoked automatically.

### Status without Mission Control
In any tool, ask for the status or use the `harness-status` skill. It runs `lifecycle.py status`: the open ask (or the recent asks), its stages, what is not finished, the newest journal entries and guard events, and the number of hook errors.

### Mission Control while another tool works
When Claude Code, Codex, Cursor or Copilot CLI runs hooks for the open ask, the hooks record the tool in `.aria/runs/client.json`. Mission Control then shows **Working in <tool>** with a **Copy start command** button, and New ask, Request changes and the other chat actions copy the message for you to paste into that tool instead of opening Copilot Chat. The notice clears once a Copilot chat in this window is newer, or after two hours. Asks, Plan, Accept, Mark done, Progress, Skills and guard events work as before, because they read the files in `.aria/`.

## Azure DevOps

The adapter uses Microsoft's official server, [`@azure-devops/mcp`](https://github.com/microsoft/azure-devops-mcp) (MIT). It loads only the `core`, `work`, `work-items`, `repositories` and `pipelines` tool groups, which keeps the tool list and its context cost small.

**Connect:**
1. Export with `--ado <organization>` for your client.
2. Start the `ado` server:
   - **VS Code:** MCP view.
   - **Claude Code:** `/mcp`.
   - **Cursor:** **Settings → Tools & Integrations**.
   - **Codex:** restart; check with `codex mcp list`.
3. The first tool call opens a browser to sign in with a Microsoft account that can access the organization.

**Other sign-in methods:** add them to the `ado` server's `args` in the client's MCP file. Never put tokens in a config file.
- `"--authentication", "azcli"` uses your `az login` session.
- `"--authentication", "env"` uses the Azure credential chain.
- `"--authentication", "pat"` reads `PERSONAL_ACCESS_TOKEN` from the environment.

Microsoft also offers a hosted remote server (`https://mcp.dev.azure.com/<organization>`, type `http`). The exporter does not configure it, because the remote server cannot be limited to tool groups.

**The ARIA azure-devops agent:**
- **Feature list to work items:** one work item per feature in the project's `.aria/project/feature_list.json` (or `feature_list.json` when no ask is open). The check command becomes the acceptance criterion.
- **Status sync:** state updates from `tracker.json`, with the check command and its exit code as a comment.
- **Pull requests:** for feature branches you ticked, linked to their work items. It never pushes.
- **Builds:** latest pipeline result, failing stage and first error line.

Every write is listed first and asked with an `ado-write` question; only ticked changes are made. It never deletes work items, abandons pull requests or edits pipelines.

Example prompts:
- `List ADO projects`
- `Create work items for the features in feature_list.json in project Contoso`
- `Sync the tracker status to the work items`
- `Why did the last build on feature/login fail?`

## What the guards do in each client

| Harness behaviour | VS Code | Claude Code | Cursor | Codex |
|---|---|---|---|---|
| Block edits of the loop files (`feature_list.json`, `progress.txt`, `tracker.json`) and loop state (`.harness/` or the ask's `loop/`) | yes | yes | yes | yes (also `apply_patch`) |
| Block git-hook bypass | yes | yes | yes | yes |
| Ask you to confirm a force push, an unticked branch or a push outside a GitHub review loop, naming why with links to the loop state, tick and PR record files (never a block) | yes, confirmation prompt | yes, confirmation prompt | no prompt: Cursor accepts "ask" but does not enforce it yet | no prompt: a warning and agent context |
| Module-size feedback (files over 500 lines) | yes | yes | yes, as context | yes |
| Victory check when the agent stops with failing features | yes | yes | yes, as a follow-up message | yes |
| Escalation stops the agent | yes | yes | denies tools only | denies tools only |
| Skill loadout notice (which library skills to read) | yes | yes | no | yes |
| User profile at session start | yes | yes | yes | yes |
| Harness challenges on wasteful prompts | yes | yes | no | yes |
| Context for sub-agents | yes | yes | no | yes |
| Ticks in ask-questions recorded (manual checks, choices) | yes | yes (assumed answer format) | no | no |
| Prototype guardrail after edits | yes | yes | yes | yes |

A guard that fails (a crash, a missing script, an unexpected payload) never blocks. It is skipped, and the tool call goes ahead. The error is written to `.aria/runs/hook-errors.log` (`~/.aria/runs/` outside a project). It is also shown in Mission Control as a guard event, and as a warning or agent context where the client has one.

## Update, re-export, remove

- **After updating the extension:** run the install or export again. `~/.aria/runtime/`, `.aria/runtime/` and `.github/aria/runtime/` are copies and do not update themselves. The export removes the copies the earlier one left (see `removed`).
- **Share with your team:** commit the agent, skill and hook files if you like. They point to `.aria/runtime/`, which is git-ignored, so each clone runs the export once.
- **Remove:** run `export.py <client> [--user | .] --remove`, then delete `.aria/runtime/` if no other client uses it, and the `ado` entry in the MCP file.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Claude Code ignores the hooks | Folder not trusted, or Claude was not started with `--agent` | Accept the trust prompt; start `claude --agent aria-lite` |
| `python` not found in hook errors | Python is not on `PATH` for the client | Install Python 3.11+ and restart the client |
| Hook error `...skills.json missing: the UserPromptSubmit skill_loader hook did not run` | The hooks were added mid-session | Send a new prompt, or start a new session |
| Copilot CLI: `Denied by preToolUse hook: hook errored` or `git push is only allowed for GitHub review loops` | An older runtime from before 0.27.5: those versions turned a guard crash into a deny | Update the extension and run the Copilot export again. Guard failures are then logged to `.aria/runs/hook-errors.log` and never block; send that file if errors repeat |
| Copilot on Windows: every tool `Denied by preToolUse hook from ".github_hooks_hve.json" (hook errored)`; the session log shows `Python was not found` | A cloud export from before 0.27.6 runs `python3`, which on Windows is the Microsoft Store alias; Copilot fails closed on a crashing `preToolUse` hook | Run the cloud export again (0.27.6 or later): its entries are a no-op in local Windows sessions |
| Cursor blocks every tool call | Cursor may treat an empty `preToolUse` response as invalid (unverified) | Report under `N27`; meanwhile remove the `preToolUse` entries from `.cursor/hooks.json` |
| Codex runs no hooks | Hooks not trusted, or Codex was started in a subfolder | `/hooks` → trust; start Codex in the project root |
| Export stops: `... was not written by ARIA` | You already have your own hooks file | Merge the entries from a scratch export by hand |
| Export stops: `... is not the ARIA extension folder` | It was run from `.aria/runtime/` | Run the copy in the installed extension, or `extension/runtime/` after `python extension/build.py` |
| No `ado` tools | Server not started, sign-in not completed, or npm cannot reach the registry | Start the server; sign in; check `npm config get registry` |
| `npm error ... ECONNRESET` | Network or proxy | Fix the registry or network, then start the server again |
| Every skill listed twice in Cursor | Both the Claude Code and Cursor exports are in one project | Keep one export, or turn off Cursor's third-party imports |
| Each ARIA agent appears twice in VS Code ("Folder: agents" and "Plugin: aria") | A Copilot install from before 0.28.0 in `~/.copilot/agents`, the old user-wide Codex install in `~/.agents/skills`, a user-scope Claude install, or a cloud export in the open repository | Accept the prompt after the update, or run Install for other harnesses once: it removes the Copilot and Codex copies. Otherwise pick Plugin: aria |
| VS Code Copilot harness: every tool `Denied by preToolUse hook from "agent" (hook errored)` once an ask is open | Before 0.28.0 the plugin agent's guards read only the Local payload and crashed on Copilot's | Update to 0.28.0 and reload the window |
| `hve-*` agents still listed next to `aria-*` | Copies from an export before the brand settings | Run the install again: the export removes them (`removed` in the report) |

## How it works (maintainers)

- **`tools/adapters/export.py`** reads the VS Code agent templates in `extension/agents/`, including their hooks, so all clients share one definition. It then writes each client's native files.
- **`hooks/agent_compat.py [--ask-only] <client> <script> [KEY=VALUE ...] [-- args]`** runs any harness hook unchanged in another client (`--ask-only`: do nothing unless the project has `.aria/asks/active.json`, used by hook files every session runs):
  - **Copilot:** PascalCase events give VS Code-compatible payloads; `tool_result.text_result_for_llm` becomes `tool_response`, the timestamp stands in for the missing tool call id, and outputs are flattened (`permissionDecision`, `additionalContext`, `decision`). Copilot drops prompt-submit output and has no context before a tool, so the skill loader derives the loadout from the open ask on the first tool call.
  - **Tool names:** `Bash`/`PowerShell`/`Shell` → `run_in_terminal`, `Write` → `create_file`, `Edit` → `replace_string_in_file`, `Read` → `read_file`, `AskUserQuestion` → `vscode_askQuestions`.
  - **Fields:** `file_path` → `filePath`.
  - **Cursor:** event names and `conversation_id` are mapped.
  - **Stop:** a timestamp is added.
  - **Responses:** mapped back to each client's format. Claude and Codex get a top-level Stop `decision`. Codex gets no `continue` on PreToolUse, because Codex would let the tool run. Cursor gets `permission`, `agent_message`, `additional_context` and `followup_message`.
  - **Environment:** what VS Code sets per hook (`HARNESS_PROJECT`, `HARNESS_STOP_POLICY`, `HARNESS_SKILLS_MIN_STATUS`) is passed as `KEY=VALUE` arguments.
  - **vscode:** the plugin agents' own hooks. A tool event with a tool call id is the Local harness and gets the hook's output unchanged; one without is the Copilot harness and gets Copilot's flat output; other events get both shapes. Client records for Mission Control's companion mode are not written: these are VS Code's own harnesses.
- **Tests:** `python tests/test_adapters.py` exports all four targets into a temp folder. It then runs the exported hook commands with each client's documented payloads.
- **New client:** add its skill folder to `SKILL_DIRS`, its event names, its hook file format in `hooks_file`, its payload and response mapping in `agent_compat.py`, and a test with that client's documented payloads.
