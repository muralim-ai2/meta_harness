# ARIA rebrand: what changed and what is still named HVE / Frontier

Workspace: `C:\PwC_HarnessEngineering2\aria-harness` (git worktree, branch `aria-rebrand`, from `4e555f2` = Frontier HVE 0.22.1).
Package: `extension/aria-0.23.0.vsix`.

The scope was limited to two changes:

1. **Brand the extension UI as ARIA**, using the ARIA logo.
2. **Rename every agent from `Frontier ...` / `Frontier HVE ...` / `HVE ...` to `ARIA ...`.**

Everything else that still says HVE or Frontier is **listed here and left unchanged**. That includes the `.hve` folder, internal IDs, env vars, file names and prose.

How the remaining items are classified:

| Complexity | Meaning |
|---|---|
| **Simple** | Text only. Nothing reads it, so change it any time. |
| **Medium** | Coupled inside this repo: a writer and a reader, or a name and its tests. Change them together in one commit; the repo tests catch misses. |
| **Complex** | Crosses into things the repo does not control: client workspaces, user settings, files already written on users' machines, published packs or external URLs. Needs a migration step or a compatibility decision. |

Change types: **Text rename**, **Identifier rename**, **Path change** (folder or file location), **File rename**, **Data migration** (rewrite data already on client machines), **Do not change**.

---

## A. Done in this package (0.23.0)

| # | What | Where | Type | Notes |
|---|---|---|---|---|
| A1 | Display name, description, Activity Bar title, settings section title and the 11 command titles become **ARIA** / **ARIA: ...** | `extension/package.json` | Text rename | Command and view **IDs** stay `frontierHve.*` (see B5). |
| A2 | ARIA logo | `extension/ui/media/aria.png` (attached icon, 128x128) is the Extensions view icon (`package.json` `icon`) and the Mission Control header logo (sidebar and dashboard, `.brand-logo` in `app.css`). `extension/ui/media/aria.svg` is a monochrome trace for the Activity Bar, which VS Code renders as a single-colour mask. | Asset + UI | The old hexagon `hve.svg` and the `logo` glyph were removed. |
| A3 | Notifications, quick-pick titles, status bar, output channel, webview tab titles, error prefixes, Settings page labels | `extension/extension.js`, `packs.js`, `render.js`, `ui/mission-control.js`, `ui/analysis.js`, `ui/media/views.js`, `ui/media/pages.js` | Text rename | |
| A4 | Name of the rendered Copilot plugin: `frontier-hve` becomes `aria`, so skills show as `aria:<skill>` in chat | `extension/render.js` | Identifier rename | Nothing referenced `frontier-hve:<skill>`. The plugin folder path is unchanged. |
| A5 | 41 agent names, and the brand prefix of their descriptions (shown in the agent picker) | `extension/agents/*.agent.md`; persona agents are generated from `templates/personas/catalog.json` by `tools/loop/personas.py` | Identifier rename | Full table in section D. |
| A6 | Every functional reference to an agent name | `personas.py` (naming rule `ARIA <id>`), `templates/lifecycles/*.json` (stage `agent`), `examples/plugins/oracle-offering/lifecycles`, agent `agents:` lists and `handoffs`, agent bodies (`run sub-agent ...`, `lifecycle.py contract ... "ARIA Lite"`), `ui/ask-flow.js` (`AGENT = 'ARIA Collab'`), `ui/workflow.js`, `ui/lifecycle-cli.js` (argument allowlist), `tools/adapters/export.py`, skills (`output-evaluation`, `wow-uplift`), wiki, README, tests | Identifier rename | Without this, sub-agent calls, handoff buttons and lifecycle stages would point at agents that no longer exist. |
| A7 | References to command titles (`Frontier HVE: Set up` becomes `ARIA: Set up`, and so on) | `tools/plugins/store.py`, `tools/loop/ask_report.py`, `render.js`, agents, wiki | Text rename | These have to match the new command palette titles. |
| A8 | Version 0.22.1 to **0.23.0** | `extension/package.json`, `package-lock.json` | Required | `extension.js` re-renders agents only when the version changes. At the same version, an upgraded install would keep the old agent names. |
| A9 | Tests updated to the new names, brand and logo | `tests/` | | pytest 124/124, node 127/127, `tsc` clean, isolated VS Code release check 15/15. |

**What users see after installing:** "ARIA" in the Extensions view with the new icon, an ARIA icon in the Activity Bar, "ARIA" plus the logo in the Mission Control header, `ARIA: ...` commands, and agents named ARIA Auto, ARIA Collab, ARIA Lite, ARIA Prototype Creator, ARIA engineer, and so on.

**Upgrade behaviour:** the extension ID is still `muralim-ai2.frontier-hve`, so installing this VSIX **upgrades an existing Frontier HVE install in place**. Settings, the global plugin folder, packs and the Mission Control state carry over. Installing it as a second extension would clash: both would register the same `frontierHve.*` commands.

---

## B. Remaining HVE / Frontier occurrences, classified

Counts cover shipped source plus tests and docs. They exclude history and the build copies in `extension/runtime` and `extension/skills`, which `build.py` regenerates. Per-file counts are in section E.

### B1. The `.hve/` workspace state folder: **Complex**, path change plus data migration

**731 occurrences in 147 files.** This is why the client's manual rename to `.aria` broke things. The folder name is not one setting: it is written as a literal in every layer, and something recreates `.hve` as soon as anything runs.

| Layer | Files (occurrences) | What depends on `.hve` | Kind of change |
|---|---|---|---|
| Hooks (run on every agent event) | `hooks/hve_paths.py` (`STATE_DIR = cwd/.hve`) and 7 more hooks (18) | **`hve_paths.py` runs `mkdir .hve/runs` at import time.** In a renamed workspace, the first hook immediately creates a fresh, empty `.hve/`, and from then on the harness writes there. | Path change (centralise in one constant) |
| Loop and lifecycle tools | `tools/loop/loop_paths.py`, `lifecycle.py`, `ask_*.py`, `environment.py` (28) | Ask folders `.hve/asks/<id>/`, `active.json`, `.hve/project/` (feature list, lock), `.hve/skills/` | Path change |
| Other tools | `tools/observe/*` (40), `tools/skills/*` (9), `tools/templates`, `tools/evaluation`, `tools/map` (`.hve/map`), `tools/git`, `tools/plugins` | Runs, telemetry trim, context-load report, evaluations, solution map | Path change |
| Exporter for other harnesses | `tools/adapters/export.py` | `RUNTIME_PATH = ".hve/runtime"`: user-scope installs put the runtime in **`~/.hve/runtime`** and agent bodies point there. Project scope also creates `<repo>/.hve/runs` and the user profile. | Path change + re-export on client machines |
| Extension host | `extension/extension.js` (14), `package.json` (welcome text) | Set up creates `.hve/runs` and `user_profile.json`, adds `.hve/` to `.gitignore`, and points the **user setting `github.copilot.chat.otel.outfile`** at `<ws>/.hve/runs/copilot-otel.jsonl` | Path change + user-setting migration |
| Mission Control UI | `extension/ui/*` (43 in 13 files) | File watcher `.hve/**/*`, Harness files pane roots, ask list, plan and state readers, chat-to-ask link regex (`chats.js` `ASK_PATH`), Show in Explorer, solution map page | Path change |
| Agent prompts | 22 agents in `extension/agents` (128) | The model is told literally to write `.hve/asks/request.md`, `.hve/evaluations/...`, and so on | Path change (best done with a `{{STATE}}` placeholder that `render.js` fills, like `{{RUNTIME}}`) |
| Skills | `plugins/harness-assist/skills/*` (20 in 10 files), `skills/admitted`, `skills/authored` (12) | Skill instructions name `.hve/...` paths | Path change |
| Docs and tests | `docs/wiki` (102), `README.md` (22), tests (~230) | Documentation and fixtures | Text rename / test update |
| Repo config | `.gitignore` (8), `.vscode/*` (2), `init.sh` (3), `.github/agents` (31, this repo's own dev agents, not shipped) | Ignore rules, dev settings | Path change |
| **Data already on client machines** | `<ws>/.hve/asks/*/contract.json`, `active.json`, `plan.md` | Contracts store **workspace-relative paths that start with `.hve/asks/...`** (`paths.ask`, `plan`, `evidence`, `loop`). The review guard hashes **workspace-relative file paths**, so a move changes the digests and pending reviews show as stale. | **Data migration** |

Recommended approach, as its own change:

1. Put the folder name in one place: a constant in `hooks/hve_paths.py` and `tools/loop/loop_paths.py`, and one JS module for the UI. Replace every literal with it.
2. Give agent and skill text a `{{STATE}}` placeholder rendered at install time.
3. Ship a one-time **migrate** command. It renames `.hve` to `.aria`, rewrites the stored paths in `contract.json`, `active.json` and `plan.md`, updates `.gitignore` and the otel `outfile` setting, and re-runs `export.py` for other harnesses.
4. When both `.hve` and `.aria` exist, fail with a clear message rather than silently picking one.

Until that ships, **clients must keep `.hve`**.

### B2. Agent names stored in client data: **Complex**, data migration

| Where | What | Effect after upgrading to ARIA names | Change |
|---|---|---|---|
| `<ws>/.hve/asks/*/contract.json` | `agent` (for example `"Frontier Lite"`), each `stages[].agent` (for example `"HVE engineer"`), `personas[].agent`, `delegations[].persona` | **Asks started before the upgrade** still name the old agents. An orchestrator that resumes such an ask delegates to `HVE engineer`, which no longer exists, so that stage fails. `lifecycle.py brief` drops the role line for old names but keeps working. Mission Control just displays the old name. New asks are unaffected. | **Data migration**: rewrite the names with the table in section D. Alternatively, finish open asks before upgrading. |
| Users' `~/.claude/agents/hve-*.md`, `~/.copilot/agents`, `.github/agents` written by "Install for other harnesses" | Old agent copies | They keep the old names until the user runs **ARIA: Install for other harnesses** again. | Re-run the export |

### B3. Internal IDs kept on purpose: **Complex**

| Item | Where | Why it is complex | Change |
|---|---|---|---|
| Extension ID `muralim-ai2.frontier-hve` (`name: frontier-hve`) | `package.json`, `package-lock.json`, `tests/mission-control/host`, `release.js`, docs (17 occurrences) | Changing it makes a **different extension**. The global storage path (rendered plugin folder), `chat.pluginLocations`, global state and installed-version tracking all reset, and side-by-side installs clash on command IDs. | Identifier rename + uninstall-old guidance |
| Command, view and container IDs `frontierHve.*` | `package.json`, `extension.js`, `ui/*`, `packs.js`, tests (168) | Users' keybindings and any `command:` links refer to them. | Identifier rename (Medium inside the repo, Complex for users' keybindings) |
| Setting `frontierHve.pluginIndex` | `package.json`, `packs.js`, docs | Organisations set this in user or workspace settings to point at their approved pack index. | Identifier rename + settings migration |
| Rendered-plugin and hook-location settings | `chat.pluginLocations` (keyed by the extension's global storage path), `chat.hookFilesLocations` keys `~/.copilot/hooks/hve.json`, `.github/hooks/hve.json` | Written into users' global settings by Set up and Install. | Leave, or migrate the settings |

### B4. Formats and names that external or client files use: **Complex**

| Item | Where (occurrences) | Who else depends on it | Change |
|---|---|---|---|
| `HVE_*` env vars: `HVE_EVIDENCE`, `HVE_TEMPLATE_TYPES`, `HVE_PLUGIN_HOME`, `HVE_HARNESS`, `HVE_EVALUATION_RUN`, `HVE_HOOK` (test-only: `HVE_VSCODE`, `HVE_HOST_*`) | hooks, `tools/loop`, `tools/evaluation`, `packs.js`, 10 agents, skills, docs, tests (75) | Clients' feature-check scripts read `HVE_EVIDENCE`; CI may set `HVE_PLUGIN_HOME` or `HVE_HARNESS` | Identifier rename (support both names during a transition, or announce the break) |
| Document markers `<!-- hve-template: x@1 -->`, `<!-- hve-section: x -->`, `<!-- hve-document: {...} -->`, `<!-- hve:skills -->`, `<!-- hve:checklist -->` | `templates/deliverables`, `tools/templates/manage.py`, `tools/plugins/manifest.py`, `tools/loop`, `ui/workspace-state.js`, examples, tests (106) | **Already embedded in client PRDs, plans and designs**, and in published pack templates. The parsers match these exact strings. | Identifier rename + data migration, or keep forever |
| Pack format: `hve-plugin.json`, `.hveplugin` packages, `schemas/hve-plugin.schema.json`, manifest key `harness.frontierHve`, workspace file `frontier-hve.plugins.json`, pack store `~/.frontier-hve` | `tools/plugins/*`, `packs.js`, `extension/build.py`, `schemas`, examples, docs, tests (85) | Every published expertise pack, and organisations' pack indexes | Identifier rename + accept both names during a transition |
| Hook file names `hve.json` (`~/.copilot/hooks/hve.json`, `.github/hooks/hve.json`) and `.github/hve/runtime` | `tools/adapters/export.py`, `extension.js`, docs, tests (26) | Files on users' machines and in committed repos (cloud agent). `write_owned` recognises its own files by content, so a rename would leave the old files behind. | Path change + cleanup step |
| Schema `$id` / URLs that use the GitHub repo name `Frontier-HVE` | `package.json` `repository`, `schemas/hve-plugin.schema.json`, `tools/plugins/author.py`, docs (6) | External URL: changes only if the GitHub repository is renamed | Do not change unless the repo is renamed |

### B5. Coupled inside the repo: **Medium**, change writer, reader and tests together

| Item | Writer | Reader | Change |
|---|---|---|---|
| `Frontier HVE deliverable templates: session ...` | `hooks/template_guard.py` | `extension/render.js` `LOCAL_CHECK` tells the agent to look for exactly this line to confirm the guards are running; tests | Text rename of a protocol string, in both places at once |
| `Frontier HVE brief: ask ...` | `tools/loop/lifecycle.py` `brief()` | 18 agent bodies ("You get a Frontier HVE brief"), `ARIA product-manager` ("When your prompt starts with a `Frontier HVE brief`"), persona templates | Text rename of a protocol string, in all places at once |
| `Frontier HVE open ask ...`, `Frontier HVE ask ...` context lines | `hooks/skill_loader.py`, `hooks/compaction.py` | Model only; tests | Text rename (Simple apart from the tests) |
| Agent **file** names `hve-*.agent.md` (41 files) | `extension/agents`; `personas.py` writes `hve-<id>.agent.md` | `export.py` (`glob("hve-*.agent.md")`, `HOOK_SOURCE = "hve-creator.agent.md"`), Claude/Cursor/Codex invoke names (`claude --agent hve-creator`, `/hve-creator`, `$hve-creator`), tests (65) | File rename. Complex for users of other harnesses, whose habits and docs use `hve-creator`, and whose old exported files stay behind. |
| Python module `hooks/hve_paths.py` | `hooks/` | 10 hooks import it, `build.py` copies it, tests | File rename |
| `evaluation/frontier.eval.json` | `evaluation/` | `build.py`, `hve-creator.agent.md`, tests, docs | File rename |
| Webview JS globals `hveVnode`, `hveMarkdown`, `hveViews`, `hvePages`, `hveTelemetry` | `ui/media/*.js` | `ui/media/*.js`, `ui/types.d.ts` (31) | Identifier rename (no outside dependency) |

### B6. Brand prose: **Simple**, text rename, no dependency

| Where | Occurrences | Note |
|---|---|---|
| Agent bodies: "You are ... of the Frontier HVE harness", "Use the Frontier HVE skills" | 27 in 25 agents | Model-facing self-description. Persona bodies come from `templates/personas/*.agent.md`; edit there and run `extension/build.py`. |
| Docs: `docs/wiki/*`, `README.md`, `docs/execution` | ~65 | User documentation |
| Module and file docstrings in `tools/`, `hooks/`, `extension/*.js`, `schemas` | ~25 | Developer-facing |
| `plugins/harness-assist/skills/*` prose (for example check-context-load "Frontier HVE library") | 9 | Model-facing |
| `tools/adapters/export.py` messages ("not written by Frontier HVE", "pick an HVE agent") | 7 | User-facing CLI text |
| Messages in `tools/loop/ask_project.py`, `tools/plugins/plugin.py`, `tools/plugins/store.py` | ~6 | User-facing text from the harness |

### B7. Do not change

| Where | Why |
|---|---|
| `skills/imported/agentx/NOTICE`, `LICENSE`, and `author: "Frontier"` and similar lines in `skills/admitted/*` (~180) | **Third-party attribution.** "Frontier" there is upstream **Frontier Corp / AgentX** (Apache-2.0), not our brand. |
| `> **Modified** by Frontier HVE on 2026-10-12 ...` in `skills/admitted/prd/*` | Apache-2.0 modification notices are a legal record. Add an ARIA line for later edits; do not rewrite the history. |
| `research/`, `tracker.json`, `reference/`, `docs/architecture` (generated), `docs/design` | History and generated artefacts |
| `.github/agents/*`, `.github/copilot-instructions.md` | This repo's own development agents, not shipped in the extension |
| Old `extension/frontier-hve-*.vsix` files | Previous releases |

---

## C. Suggested order for the remaining work

1. **Simple, any time:** B6 prose (agent bodies through `templates/personas`, docs, docstrings, CLI messages) and the B5 webview JS globals.
2. **Medium, one commit each, tests green:** B5 protocol strings (`template_guard.py` with `render.js`; `lifecycle.py brief` with the agent bodies), `hve_paths.py`, `frontier.eval.json`.
3. **Complex, each needs a migration and a release note:** B1 `.hve` (centralise, then migrate), B2 contract agent names, B4 env vars, markers and pack format, B3 IDs and settings, agent file names for other harnesses.

---

## D. Agent rename table

| Agent file | Old name | New name |
|---|---|---|
| `hve-agile.agent.md` | Frontier HVE Collab | **ARIA Collab** |
| `hve-architecture-reviewer.agent.md` | HVE architecture-reviewer | **ARIA architecture-reviewer** |
| `hve-azure-devops.agent.md` | HVE azure-devops | **ARIA azure-devops** |
| `hve-code-reviewer.agent.md` | HVE code-reviewer | **ARIA code-reviewer** |
| `hve-council.agent.md` | HVE council | **ARIA council** |
| `hve-creator-flow.agent.md` | HVE creator-flow | **ARIA creator-flow** |
| `hve-creator-github.agent.md` | HVE creator-github | **ARIA creator-github** |
| `hve-creator.agent.md` | Frontier Lite | **ARIA Lite** |
| `hve-data-scientist.agent.md` | HVE data-scientist | **ARIA data-scientist** |
| `hve-db-architect.agent.md` | HVE db-architect | **ARIA db-architect** |
| `hve-db-engineer.agent.md` | HVE db-engineer | **ARIA db-engineer** |
| `hve-devops-engineer.agent.md` | HVE devops-engineer | **ARIA devops-engineer** |
| `hve-e2e.agent.md` | Frontier HVE Auto | **ARIA Auto** |
| `hve-engineer.agent.md` | HVE engineer | **ARIA engineer** |
| `hve-evaluation-reviewer.agent.md` | HVE evaluation-reviewer | **ARIA evaluation-reviewer** |
| `hve-flow-architect.agent.md` | HVE flow-architect | **ARIA flow-architect** |
| `hve-flow-designer.agent.md` | HVE flow-designer | **ARIA flow-designer** |
| `hve-flow-grower.agent.md` | HVE flow-grower | **ARIA flow-grower** |
| `hve-flow-maintainer.agent.md` | HVE flow-maintainer | **ARIA flow-maintainer** |
| `hve-flow-prototyper.agent.md` | HVE flow-prototyper | **ARIA flow-prototyper** |
| `hve-flow-sweeper.agent.md` | HVE flow-sweeper | **ARIA flow-sweeper** |
| `hve-minimal.agent.md` | HVE minimal | **ARIA minimal** |
| `hve-product-manager.agent.md` | HVE product-manager | **ARIA product-manager** |
| `hve-product-reviewer.agent.md` | HVE product-reviewer | **ARIA product-reviewer** |
| `hve-prototype.agent.md` | Frontier Prototype Creator | **ARIA Prototype Creator** |
| `hve-research-minimal.agent.md` | HVE research-minimal | **ARIA research-minimal** |
| `hve-research-single.agent.md` | HVE research-single | **ARIA research-single** |
| `hve-security-architect.agent.md` | HVE security-architect | **ARIA security-architect** |
| `hve-security-reviewer.agent.md` | HVE security-reviewer | **ARIA security-reviewer** |
| `hve-single.agent.md` | HVE single | **ARIA single** |
| `hve-skill-evaluator.agent.md` | HVE skill-evaluator | **ARIA skill-evaluator** |
| `hve-skill-judge.agent.md` | HVE skill-judge | **ARIA skill-judge** |
| `hve-skill-worker.agent.md` | HVE skill-worker | **ARIA skill-worker** |
| `hve-solution-architect.agent.md` | HVE solution-architect | **ARIA solution-architect** |
| `hve-test-architect.agent.md` | HVE test-architect | **ARIA test-architect** |
| `hve-test-engineer.agent.md` | HVE test-engineer | **ARIA test-engineer** |
| `hve-test-reviewer.agent.md` | HVE test-reviewer | **ARIA test-reviewer** |
| `hve-ui-engineer.agent.md` | HVE ui-engineer | **ARIA ui-engineer** |
| `hve-uplift-judge.agent.md` | HVE uplift-judge | **ARIA uplift-judge** |
| `hve-ux-designer.agent.md` | HVE ux-designer | **ARIA ux-designer** |
| `hve-ux-reviewer.agent.md` | HVE ux-reviewer | **ARIA ux-reviewer** |

---

## E. Per-file occurrence counts (shipped source, tests and docs)

The scanner script assigns each match to the first kind in this list that fits. The "Brand prose" counts **include the third-party attribution in B7** (`skills/imported`, `skills/admitted`), which must not be changed. Do not bulk-replace from this table.

### `.hve` state folder (path) - 731 occurrences in 147 files

| File | Count |
|---|---|
| `tests/test_skills.py` | 27 |
| `docs/wiki/Ways-of-Working.md` | 24 |
| `tests/test_collect.py` | 23 |
| `README.md` | 22 |
| `extension/agents/hve-creator.agent.md` | 22 |
| `tests/test_loop.py` | 20 |
| `docs/wiki/Plugins.md` | 18 |
| `tests/test_adapters.py` | 17 |
| `docs/wiki/Mission-Control.md` | 16 |
| `extension/agents/hve-agile.agent.md` | 16 |
| `extension/agents/hve-e2e.agent.md` | 15 |
| `tests/test_hooks.py` | 15 |
| `.github/agents/creator.agent.md` | 14 |
| `extension/agents/hve-creator-flow.agent.md` | 14 |
| `extension/agents/hve-creator-github.agent.md` | 14 |
| `extension/extension.js` | 14 |
| `tests/mission-control/pane.test.js` | 14 |
| `tests/mission-control/extras.test.js` | 13 |
| `docs/wiki/Adapters.md` | 12 |
| `docs/wiki/Agents.md` | 11 |
| `tools/observe/collect.py` | 11 |
| `extension/agents/hve-single.agent.md` | 10 |
| `tests/test_extension.py` | 10 |
| `tools/loop/ask_report.py` | 10 |
| `tools/observe/provenance.py` | 10 |
| `extension/agents/hve-product-manager.agent.md` | 9 |
| `extension/ui/asks.js` | 9 |
| `.gitignore` | 8 |
| `docs/wiki/Skills.md` | 8 |
| `extension/ui/media/pages.js` | 8 |
| `plugins/harness-assist/skills/output-evaluation/SKILL.md` | 8 |
| `tests/mission-control/newask.test.js` | 8 |
| `tools/observe/bench.py` | 8 |
| `tests/test_evaluation.py` | 7 |
| `tools/observe/otel_trim.py` | 7 |
| `extension/agents/hve-prototype.agent.md` | 6 |
| `extension/ui/harness-tree.js` | 6 |
| `extension/ui/workspace-state.js` | 6 |
| `skills/admitted/dreams/SKILL.md` | 6 |
| `skills/authored/dreams/SKILL.md` | 6 |
| `tests/mission-control/activity.test.js` | 6 |
| `tests/mission-control/state.test.js` | 6 |
| `tests/test_flow_plugin.py` | 6 |
| `tools/loop/lifecycle.py` | 6 |
| `.github/agents/creator-flow.agent.md` | 5 |
| `docs/wiki/Solution-Map.md` | 5 |
| `tests/mission-control/chatstart.test.js` | 5 |
| `tests/mission-control/files.test.js` | 5 |
| `tests/mission-control/fixtures.js` | 5 |
| `tests/mission-control/integration.test.js` | 5 |
| `tests/test_plugins.py` | 5 |
| `tools/loop/loop_paths.py` | 5 |
| `.github/agents/creator-github.agent.md` | 4 |
| `extension/agents/hve-skill-evaluator.agent.md` | 4 |
| `hooks/metrics.py` | 4 |
| `tests/mission-control/controller.test.js` | 4 |
| `tests/mission-control/sessions.test.js` | 4 |
| `tests/test_ui_reviews.py` | 4 |
| `tools/templates/manage.py` | 4 |
| `docs/wiki/Install.md` | 3 |
| `extension/ui/ask-flow.js` | 3 |
| `hooks/loop_guard.py` | 3 |
| `init.sh` | 3 |
| `tests/mission-control/host/index.js` | 3 |
| `tests/test_metrics.py` | 3 |
| `tools/adapters/export.py` | 3 |
| `tools/evaluation/workflow.py` | 3 |
| `tools/loop/loop.py` | 3 |
| `tools/skills/context_load.py` | 3 |
| `tools/skills/recommend.py` | 3 |
| `.github/agents/single.agent.md` | 2 |
| `docs/wiki/Evaluation.md` | 2 |
| `docs/wiki/Templates.md` | 2 |
| `extension/agents/hve-db-engineer.agent.md` | 2 |
| `extension/agents/hve-devops-engineer.agent.md` | 2 |
| `extension/agents/hve-engineer.agent.md` | 2 |
| `extension/agents/hve-test-engineer.agent.md` | 2 |
| `extension/agents/hve-ui-engineer.agent.md` | 2 |
| `extension/ui/actions.js` | 2 |
| `extension/ui/lifecycle-cli.js` | 2 |
| `extension/ui/mission-control.js` | 2 |
| `hooks/agent_compat.py` | 2 |
| `hooks/compaction.py` | 2 |
| `hooks/hve_paths.py` | 2 |
| `hooks/interventions.py` | 2 |
| `hooks/skill_loader.py` | 2 |
| `plugins/harness-assist/scripts/guardrail.py` | 2 |
| `plugins/harness-assist/skills/delivery-coach/SKILL.md` | 2 |
| `plugins/harness-assist/skills/export-harness/SKILL.md` | 2 |
| `templates/personas/builder.agent.md` | 2 |
| `tests/mission-control/asks.test.js` | 2 |
| `tests/mission-control/plan.test.js` | 2 |
| `tests/mission-control/preview.js` | 2 |
| `tests/test_map.py` | 2 |
| `tests/test_personas.py` | 2 |
| `tools/git/parallel_options.py` | 2 |
| `tools/loop/ask_project.py` | 2 |
| `.github/agents/flow-architect.agent.md` | 1 |
| `.github/agents/flow-designer.agent.md` | 1 |
| `.github/agents/flow-grower.agent.md` | 1 |
| `.github/agents/flow-maintainer.agent.md` | 1 |
| `.github/agents/flow-prototyper.agent.md` | 1 |
| `.github/agents/flow-sweeper.agent.md` | 1 |
| `.vscode/mcp.json` | 1 |
| `.vscode/settings.json` | 1 |
| `docs/wiki/Home.md` | 1 |
| `extension/agents/hve-azure-devops.agent.md` | 1 |
| `extension/agents/hve-data-scientist.agent.md` | 1 |
| `extension/agents/hve-db-architect.agent.md` | 1 |
| `extension/agents/hve-flow-grower.agent.md` | 1 |
| `extension/agents/hve-security-architect.agent.md` | 1 |
| `extension/agents/hve-solution-architect.agent.md` | 1 |
| `extension/agents/hve-test-architect.agent.md` | 1 |
| `extension/agents/hve-ux-designer.agent.md` | 1 |
| `extension/package.json` | 1 |
| `extension/ui/activity.js` | 1 |
| `extension/ui/analysis.js` | 1 |
| `extension/ui/chats.js` | 1 |
| `extension/ui/extras.js` | 1 |
| `extension/ui/workflow.js` | 1 |
| `hooks/agent_ledger.py` | 1 |
| `plugins/harness-assist/skills/check-context-load/SKILL.md` | 1 |
| `plugins/harness-assist/skills/explain-walkthrough/SKILL.md` | 1 |
| `plugins/harness-assist/skills/feature-checklist/SKILL.md` | 1 |
| `plugins/harness-assist/skills/parallel-options/SKILL.md` | 1 |
| `plugins/harness-assist/skills/run-tests/SKILL.md` | 1 |
| `plugins/harness-assist/skills/solution-map/SKILL.md` | 1 |
| `skills/registry.json` | 1 |
| `templates/personas/designer.agent.md` | 1 |
| `tests/mission-control/activation.test.js` | 1 |
| `tests/mission-control/ui.test.js` | 1 |
| `tests/mission-control/workflow.test.js` | 1 |
| `tests/test_backlog.py` | 1 |
| `tests/test_telemetry_switch.py` | 1 |
| `tests/test_templates.py` | 1 |
| `tools/loop/flow.py` | 1 |
| `tools/loop/lifecycle_catalog.py` | 1 |
| `tools/map/extract.py` | 1 |
| `tools/map/solution_map.py` | 1 |
| `tools/observe/blind.py` | 1 |
| `tools/observe/compare.py` | 1 |
| `tools/observe/otel_prune.py` | 1 |
| `tools/observe/trajectory.py` | 1 |
| `tools/plugins/route.py` | 1 |
| `tools/skills/eval_skill.py` | 1 |
| `tools/skills/evaluate.py` | 1 |
| `tools/skills/micro_eval.py` | 1 |

### `frontierHve.*` VS Code IDs - 168 occurrences in 28 files

| File | Count |
|---|---|
| `tests/mission-control/activation.test.js` | 23 |
| `extension/package.json` | 16 |
| `tests/mission-control/controller.test.js` | 11 |
| `tests/mission-control/sessions.test.js` | 10 |
| `extension/ui/mission-control.js` | 9 |
| `tests/mission-control/extras.test.js` | 9 |
| `extension/extension.js` | 8 |
| `tests/mission-control/newask.test.js` | 8 |
| `tests/mission-control/pane.test.js` | 8 |
| `tests/mission-control/release.js` | 8 |
| `tests/mission-control/host/index.js` | 7 |
| `tests/mission-control/files.test.js` | 6 |
| `tests/mission-control/handoff.test.js` | 6 |
| `tests/mission-control/chatstart.test.js` | 5 |
| `tests/mission-control/telemetry.test.js` | 5 |
| `extension/ui/lifecycle-cli.js` | 4 |
| `tests/mission-control/asks.test.js` | 4 |
| `tests/mission-control/layout.test.js` | 4 |
| `tests/mission-control/workflow.test.js` | 4 |
| `docs/wiki/Plugins.md` | 3 |
| `extension/ui/actions.js` | 2 |
| `tests/mission-control/plan.test.js` | 2 |
| `extension/packs.js` | 1 |
| `extension/ui/extras.js` | 1 |
| `tests/mission-control/bridge.test.js` | 1 |
| `tests/test_plugins.py` | 1 |
| `tools/plugins/manifest.py` | 1 |
| `tools/plugins/plugin.py` | 1 |

### `hve-*` / `hve:*` document markers - 106 occurrences in 17 files

| File | Count |
|---|---|
| `tests/test_templates.py` | 13 |
| `templates/deliverables/technical-design-v1.md` | 11 |
| `extension/ui/workspace-state.js` | 10 |
| `templates/deliverables/prd-v1.md` | 10 |
| `templates/deliverables/test-strategy-v1.md` | 10 |
| `tools/loop/ask_plan.py` | 8 |
| `examples/plugins/oracle-offering/templates/oracle-solution-design-v1.md` | 7 |
| `examples/plugins/oracle-offering/templates/oracle-assessment-v1.md` | 6 |
| `examples/plugins/oracle-offering/templates/oracle-migration-runbook-v1.md` | 5 |
| `tests/mission-control/plan.test.js` | 5 |
| `docs/wiki/Plugins.md` | 4 |
| `tests/mission-control/state.test.js` | 4 |
| `tools/templates/manage.py` | 4 |
| `docs/wiki/Templates.md` | 3 |
| `tools/plugins/author.py` | 3 |
| `tests/test_collect.py` | 2 |
| `tools/plugins/manifest.py` | 1 |

### Pack format names - 85 occurrences in 23 files

| File | Count |
|---|---|
| `docs/wiki/Plugins.md` | 19 |
| `tests/test_plugins.py` | 11 |
| `extension/packs.js` | 8 |
| `tools/plugins/manifest.py` | 8 |
| `tools/plugins/plugin.py` | 7 |
| `schemas/hve-plugin.schema.json` | 4 |
| `tools/plugins/author.py` | 4 |
| `tests/mission-control/host/index.js` | 3 |
| `tools/plugins/store.py` | 3 |
| `docs/wiki/Adapters.md` | 2 |
| `examples/plugins/oracle-offering/hve-plugin.json` | 2 |
| `extension/package.json` | 2 |
| `tests/mission-control/release.js` | 2 |
| `docs/wiki/Agents.md` | 1 |
| `docs/wiki/Install.md` | 1 |
| `docs/wiki/Solution-Map.md` | 1 |
| `extension/build.py` | 1 |
| `extension/ui/media/pages.js` | 1 |
| `tests/mission-control/activation.test.js` | 1 |
| `tests/mission-control/activity.test.js` | 1 |
| `tests/mission-control/sessions.test.js` | 1 |
| `tests/mission-control/vscode-stub.js` | 1 |
| `tools/loop/lifecycle_catalog.py` | 1 |

### `HVE_*` environment variables - 75 occurrences in 35 files

| File | Count |
|---|---|
| `tests/mission-control/release.js` | 8 |
| `tests/mission-control/host/index.js` | 4 |
| `tests/test_templates.py` | 4 |
| `docs/wiki/Evaluation.md` | 3 |
| `extension/agents/hve-creator.agent.md` | 3 |
| `extension/agents/hve-e2e.agent.md` | 3 |
| `extension/agents/hve-product-manager.agent.md` | 3 |
| `hooks/template_guard.py` | 3 |
| `plugins/harness-assist/skills/delivery-coach/SKILL.md` | 3 |
| `tests/mission-control/controller.test.js` | 3 |
| `tests/test_extension.py` | 3 |
| `tools/evaluation/workflow.py` | 3 |
| `tools/loop/environment.py` | 3 |
| `docs/wiki/Agents.md` | 2 |
| `extension/agents/hve-agile.agent.md` | 2 |
| `extension/packs.js` | 2 |
| `plugins/harness-assist/skills/feature-checklist/SKILL.md` | 2 |
| `tests/test_loop.py` | 2 |
| `tools/loop/loop.py` | 2 |
| `tools/plugins/store.py` | 2 |
| `docs/wiki/Install.md` | 1 |
| `docs/wiki/Plugins.md` | 1 |
| `docs/wiki/Templates.md` | 1 |
| `docs/wiki/Ways-of-Working.md` | 1 |
| `examples/plugins/oracle-offering/agents/oracle-engineer.agent.md` | 1 |
| `extension/agents/hve-creator-flow.agent.md` | 1 |
| `extension/agents/hve-db-engineer.agent.md` | 1 |
| `extension/agents/hve-devops-engineer.agent.md` | 1 |
| `extension/agents/hve-engineer.agent.md` | 1 |
| `extension/agents/hve-test-engineer.agent.md` | 1 |
| `extension/agents/hve-ui-engineer.agent.md` | 1 |
| `templates/personas/builder.agent.md` | 1 |
| `tests/test_plugins.py` | 1 |
| `tools/loop/lifecycle.py` | 1 |
| `tools/loop/loop_paths.py` | 1 |

### `hve-*` agent file names / stems - 65 occurrences in 15 files

| File | Count |
|---|---|
| `tests/test_extension.py` | 16 |
| `tests/test_adapters.py` | 12 |
| `docs/wiki/Adapters.md` | 11 |
| `tools/adapters/export.py` | 6 |
| `docs/wiki/Agents.md` | 5 |
| `docs/wiki/Ways-of-Working.md` | 4 |
| `README.md` | 3 |
| `docs/wiki/Evaluation.md` | 1 |
| `docs/wiki/Install.md` | 1 |
| `tests/mission-control/bridge.test.js` | 1 |
| `tests/mission-control/controller.test.js` | 1 |
| `tests/mission-control/helpers.js` | 1 |
| `tests/mission-control/preview.js` | 1 |
| `tests/mission-control/release.js` | 1 |
| `tests/test_personas.py` | 1 |

### Model protocol strings (`Frontier HVE brief`, ...) - 31 occurrences in 31 files

| File | Count |
|---|---|
| `docs/wiki/Plugins.md` | 1 |
| `docs/wiki/Ways-of-Working.md` | 1 |
| `examples/plugins/oracle-offering/LICENSE` | 1 |
| `extension/agents/hve-architecture-reviewer.agent.md` | 1 |
| `extension/agents/hve-code-reviewer.agent.md` | 1 |
| `extension/agents/hve-data-scientist.agent.md` | 1 |
| `extension/agents/hve-db-architect.agent.md` | 1 |
| `extension/agents/hve-db-engineer.agent.md` | 1 |
| `extension/agents/hve-devops-engineer.agent.md` | 1 |
| `extension/agents/hve-engineer.agent.md` | 1 |
| `extension/agents/hve-product-manager.agent.md` | 1 |
| `extension/agents/hve-product-reviewer.agent.md` | 1 |
| `extension/agents/hve-security-architect.agent.md` | 1 |
| `extension/agents/hve-security-reviewer.agent.md` | 1 |
| `extension/agents/hve-solution-architect.agent.md` | 1 |
| `extension/agents/hve-test-architect.agent.md` | 1 |
| `extension/agents/hve-test-engineer.agent.md` | 1 |
| `extension/agents/hve-test-reviewer.agent.md` | 1 |
| `extension/agents/hve-ui-engineer.agent.md` | 1 |
| `extension/agents/hve-ux-designer.agent.md` | 1 |
| `extension/agents/hve-ux-reviewer.agent.md` | 1 |
| `extension/render.js` | 1 |
| `hooks/agent_compat.py` | 1 |
| `hooks/compaction.py` | 1 |
| `hooks/skill_loader.py` | 1 |
| `hooks/template_guard.py` | 1 |
| `templates/personas/builder.agent.md` | 1 |
| `templates/personas/designer.agent.md` | 1 |
| `templates/personas/reviewer.agent.md` | 1 |
| `tools/loop/lifecycle.py` | 1 |
| `tools/plugins/author.py` | 1 |

### Webview JS globals (`hveVnode`, ...) - 31 occurrences in 7 files

| File | Count |
|---|---|
| `extension/ui/media/pages.js` | 9 |
| `extension/ui/media/telemetry.js` | 7 |
| `extension/ui/types.d.ts` | 5 |
| `extension/ui/media/app.js` | 3 |
| `extension/ui/media/markdown.js` | 3 |
| `extension/ui/media/views.js` | 3 |
| `extension/ui/media/vnode.js` | 1 |

### Hook file names (`hve.json`, `.github/hve/runtime`) - 26 occurrences in 5 files

| File | Count |
|---|---|
| `docs/wiki/Adapters.md` | 11 |
| `tools/adapters/export.py` | 6 |
| `extension/extension.js` | 4 |
| `tests/test_adapters.py` | 4 |
| `plugins/harness-assist/skills/export-harness/SKILL.md` | 1 |

### `hve_paths` Python module - 18 occurrences in 18 files

| File | Count |
|---|---|
| `README.md` | 1 |
| `extension/build.py` | 1 |
| `hooks/agent_ledger.py` | 1 |
| `hooks/budget.py` | 1 |
| `hooks/error_guard.py` | 1 |
| `hooks/graph_refresh.py` | 1 |
| `hooks/guard_policy.py` | 1 |
| `hooks/interventions.py` | 1 |
| `hooks/loop_guard.py` | 1 |
| `hooks/metrics.py` | 1 |
| `hooks/profile_detector.py` | 1 |
| `hooks/skill_loader.py` | 1 |
| `tests/test_flow_plugin.py` | 1 |
| `tests/test_hooks.py` | 1 |
| `tests/test_loop.py` | 1 |
| `tests/test_metrics.py` | 1 |
| `tests/test_skills.py` | 1 |
| `tools/loop/ask_report.py` | 1 |

### `frontier-hve` extension / package id - 17 occurrences in 13 files

| File | Count |
|---|---|
| `docs/wiki/Install.md` | 2 |
| `extension/package-lock.json` | 2 |
| `schemas/hve-plugin.schema.json` | 2 |
| `tests/mission-control/host/runner/package.json` | 2 |
| `README.md` | 1 |
| `docs/wiki/Plugins.md` | 1 |
| `docs/wiki/Templates.md` | 1 |
| `extension/package.json` | 1 |
| `plugins/harness-assist/skills/deliverable-templates/SKILL.md` | 1 |
| `tests/mission-control/activation.test.js` | 1 |
| `tests/mission-control/release.js` | 1 |
| `tools/plugins/manifest.py` | 1 |
| `tools/templates/manage.py` | 1 |

### `frontier.eval.json` and similar file names - 11 occurrences in 9 files

| File | Count |
|---|---|
| `docs/wiki/Evaluation.md` | 2 |
| `tests/test_plugins.py` | 2 |
| `.github/agents/creator.agent.md` | 1 |
| `extension/agents/hve-creator.agent.md` | 1 |
| `extension/build.py` | 1 |
| `plugins/harness-assist/skills/output-evaluation/SKILL.md` | 1 |
| `tests/test_evaluation.py` | 1 |
| `tests/test_extension.py` | 1 |
| `tools/plugins/manifest.py` | 1 |

### `Frontier-HVE` GitHub URL - 6 occurrences in 6 files

| File | Count |
|---|---|
| `docs/artifacts/learnings/LEARNING-deliverable-templates.md` | 1 |
| `docs/wiki/Plugins.md` | 1 |
| `examples/plugins/oracle-offering/hve-plugin.json` | 1 |
| `extension/package.json` | 1 |
| `schemas/hve-plugin.schema.json` | 1 |
| `tools/plugins/author.py` | 1 |

### Brand prose (`Frontier HVE`, `Frontier`, `HVE`) - 334 occurrences in 139 files

| File | Count |
|---|---|
| `README.md` | 23 |
| `skills/admitted/impeccable-integration/references/responsibility-and-commands.md` | 18 |
| `skills/imported/agentx/design/impeccable-integration/references/responsibility-and-commands.md` | 18 |
| `skills/admitted/impeccable-integration/SKILL.md` | 13 |
| `skills/imported/agentx/design/impeccable-integration/SKILL.md` | 13 |
| `skills/imported/agentx/NOTICE` | 12 |
| `docs/wiki/Adapters.md` | 11 |
| `skills/admitted/karpathy-guidelines/SKILL.md` | 7 |
| `skills/imported/agentx/development/karpathy-guidelines/SKILL.md` | 7 |
| `tools/adapters/export.py` | 7 |
| `docs/wiki/Agents.md` | 6 |
| `docs/wiki/Install.md` | 6 |
| `docs/wiki/Mission-Control.md` | 5 |
| `docs/wiki/Ways-of-Working.md` | 5 |
| `skills/admitted/diagram-as-code/SKILL.md` | 5 |
| `skills/admitted/impeccable-integration/references/setup-and-routing.md` | 5 |
| `skills/imported/agentx/design/impeccable-integration/references/setup-and-routing.md` | 5 |
| `skills/imported/agentx/diagrams/diagram-as-code/SKILL.md` | 5 |
| `tests/mission-control/host/index.js` | 4 |
| `docs/wiki/Plugins.md` | 3 |
| `skills/admitted/azure-foundry/SKILL.md` | 3 |
| `skills/admitted/code-optimization/SKILL.md` | 3 |
| `skills/admitted/prototype-audit/references/passes-5-9.md` | 3 |
| `skills/imported/agentx/ai-systems/azure-foundry/SKILL.md` | 3 |
| `skills/imported/agentx/design/prototype-audit/references/passes-5-9.md` | 3 |
| `skills/imported/agentx/development/code-optimization/SKILL.md` | 3 |
| `skills/imported/agentx/product/prd/SKILL.md` | 3 |
| `tools/loop/environment.py` | 3 |
| `docs/wiki/Home.md` | 2 |
| `extension/agents/hve-creator-flow.agent.md` | 2 |
| `extension/agents/hve-creator-github.agent.md` | 2 |
| `plugins/harness-assist/skills/export-harness/SKILL.md` | 2 |
| `plugins/harness-assist/skills/recommend-skills/SKILL.md` | 2 |
| `skills/admitted/iterative-retrieval/SKILL.md` | 2 |
| `skills/admitted/prd/SKILL.md` | 2 |
| `skills/admitted/prototype-audit/SKILL.md` | 2 |
| `skills/admitted/usability-heuristics/SKILL.md` | 2 |
| `skills/admitted/yaml-pipelines/SKILL.md` | 2 |
| `skills/authored/NOTICE` | 2 |
| `skills/imported/agentx/ai-systems/iterative-retrieval/SKILL.md` | 2 |
| `skills/imported/agentx/design/prototype-audit/SKILL.md` | 2 |
| `skills/imported/agentx/design/usability-heuristics/SKILL.md` | 2 |
| `skills/imported/agentx/operations/yaml-pipelines/SKILL.md` | 2 |
| `tests/mission-control/release.js` | 2 |
| `tests/test_adapters.py` | 2 |
| `tests/test_extension.py` | 2 |
| `tests/test_plugins.py` | 2 |
| `tools/plugins/author.py` | 2 |
| `tools/plugins/plugin.py` | 2 |
| `.github/agents/creator-github.agent.md` | 1 |
| `docs/execution/plans/EXEC-PLAN-deliverable-templates.md` | 1 |
| `docs/wiki/Product-Manager.md` | 1 |
| `docs/wiki/Solution-Map.md` | 1 |
| `docs/wiki/Templates.md` | 1 |
| `evaluation/frontier.eval.json` | 1 |
| `examples/plugins/oracle-offering/README.md` | 1 |
| `examples/plugins/oracle-offering/agents/oracle-db-architect.agent.md` | 1 |
| `examples/plugins/oracle-offering/agents/oracle-engineer.agent.md` | 1 |
| `examples/plugins/oracle-offering/hve-plugin.json` | 1 |
| `extension/agents/hve-agile.agent.md` | 1 |
| `extension/agents/hve-architecture-reviewer.agent.md` | 1 |
| `extension/agents/hve-azure-devops.agent.md` | 1 |
| `extension/agents/hve-code-reviewer.agent.md` | 1 |
| `extension/agents/hve-creator.agent.md` | 1 |
| `extension/agents/hve-data-scientist.agent.md` | 1 |
| `extension/agents/hve-db-architect.agent.md` | 1 |
| `extension/agents/hve-db-engineer.agent.md` | 1 |
| `extension/agents/hve-devops-engineer.agent.md` | 1 |
| `extension/agents/hve-e2e.agent.md` | 1 |
| `extension/agents/hve-engineer.agent.md` | 1 |
| `extension/agents/hve-product-manager.agent.md` | 1 |
| `extension/agents/hve-product-reviewer.agent.md` | 1 |
| `extension/agents/hve-prototype.agent.md` | 1 |
| `extension/agents/hve-security-architect.agent.md` | 1 |
| `extension/agents/hve-security-reviewer.agent.md` | 1 |
| `extension/agents/hve-solution-architect.agent.md` | 1 |
| `extension/agents/hve-test-architect.agent.md` | 1 |
| `extension/agents/hve-test-engineer.agent.md` | 1 |
| `extension/agents/hve-test-reviewer.agent.md` | 1 |
| `extension/agents/hve-ui-engineer.agent.md` | 1 |
| `extension/agents/hve-ux-designer.agent.md` | 1 |
| `extension/agents/hve-ux-reviewer.agent.md` | 1 |
| `hooks/template_guard.py` | 1 |
| `init.sh` | 1 |
| `plugins/harness-assist/skills/check-context-load/SKILL.md` | 1 |
| `plugins/harness-assist/skills/deliverable-templates/SKILL.md` | 1 |
| `plugins/harness-assist/skills/output-evaluation/SKILL.md` | 1 |
| `plugins/harness-assist/skills/prototype-guardrail/SKILL.md` | 1 |
| `plugins/harness-assist/skills/solution-map/SKILL.md` | 1 |
| `schemas/hve-plugin.schema.json` | 1 |
| `skills/admitted/agent-memory-systems/SKILL.md` | 1 |
| `skills/admitted/ai-safety-and-red-teaming/SKILL.md` | 1 |
| `skills/admitted/core-principles/SKILL.md` | 1 |
| `skills/admitted/dataverse-plugins/SKILL.md` | 1 |
| `skills/admitted/documentation/SKILL.md` | 1 |
| `skills/admitted/environment-variables/SKILL.md` | 1 |
| `skills/admitted/foundry-sdk/SKILL.md` | 1 |
| `skills/admitted/frontend-ui/SKILL.md` | 1 |
| `skills/admitted/mcp-apps-development/SKILL.md` | 1 |
| `skills/admitted/model-driven-app/SKILL.md` | 1 |
| `skills/admitted/power-automate-desktop/SKILL.md` | 1 |
| `skills/admitted/prd/references/pbi-examples.md` | 1 |
| `skills/admitted/prd/references/requirements-quality.md` | 1 |
| `skills/admitted/prd/references/worked-example.md` | 1 |
| `skills/admitted/prototype-audit/references/passes-0-4.md` | 1 |
| `skills/admitted/prototype-craft/assets/prototype-tokens.css` | 1 |
| `skills/admitted/reasoning-models/SKILL.md` | 1 |
| `skills/admitted/systematic-debugging/SKILL.md` | 1 |
| `skills/admitted/working-prototype-app/SKILL.md` | 1 |
| `skills/imported/agentx/ai-systems/agent-memory-systems/SKILL.md` | 1 |
| `skills/imported/agentx/ai-systems/ai-safety-and-red-teaming/SKILL.md` | 1 |
| `skills/imported/agentx/ai-systems/foundry-sdk/SKILL.md` | 1 |
| `skills/imported/agentx/ai-systems/mcp-apps-development/SKILL.md` | 1 |
| `skills/imported/agentx/ai-systems/reasoning-models/SKILL.md` | 1 |
| `skills/imported/agentx/architecture/core-principles/SKILL.md` | 1 |
| `skills/imported/agentx/design/frontend-ui/SKILL.md` | 1 |
| `skills/imported/agentx/design/prototype-audit/references/passes-0-4.md` | 1 |
| `skills/imported/agentx/design/prototype-craft/assets/prototype-tokens.css` | 1 |
| `skills/imported/agentx/design/working-prototype-app/SKILL.md` | 1 |
| `skills/imported/agentx/development/documentation/SKILL.md` | 1 |
| `skills/imported/agentx/development/systematic-debugging/SKILL.md` | 1 |
| `skills/imported/agentx/low-code/dataverse-plugins/SKILL.md` | 1 |
| `skills/imported/agentx/low-code/environment-variables/SKILL.md` | 1 |
| `skills/imported/agentx/low-code/model-driven-app/SKILL.md` | 1 |
| `skills/imported/agentx/low-code/power-automate-desktop/SKILL.md` | 1 |
| `templates/deliverables/config.schema.json` | 1 |
| `templates/personas/builder.agent.md` | 1 |
| `templates/personas/catalog.json` | 1 |
| `templates/personas/designer.agent.md` | 1 |
| `templates/personas/reviewer.agent.md` | 1 |
| `tests/mission-control/host/runner/package.json` | 1 |
| `tests/test_skills.py` | 1 |
| `tests/test_templates.py` | 1 |
| `tools/evaluation/contract.py` | 1 |
| `tools/evaluation/reflection.py` | 1 |
| `tools/loop/ask_project.py` | 1 |
| `tools/plugins/manifest.py` | 1 |
| `tools/skills/context_load.py` | 1 |
| `tools/templates/manage.py` | 1 |
