# Expertise pack checklist

Use this checklist before authoring, reviewing, packaging or installing an Frontier-HVE expertise pack. Open it any time from **Mission Control → Skills & packs → Pack checklist**. Full reference and worked example: [Expertise packs](Plugins.md). Reference implementation: `examples/plugins/oracle-offering/`.

## 1. Folder and safety rules

- [ ] **Data-only files:** every file is `.md`, `.json`, `.txt`, `LICENSE` or `NOTICE` (no `.py`, `.js`, `.sh`, `.ps1`, hooks or binaries).
- [ ] **Total size under 20 MB** and no symlinks or `..` path segments.
- [ ] **Required root files present:**
  - [ ] `hve-plugin.json` — manifest, routing rules, tool ceiling and asset index.
  - [ ] `README.md` — practice owner, scope and support contact.
  - [ ] `LICENSE` — license terms for distributing the pack.
  - [ ] `registry.json` — skill entries (`name`, `description`, `task_categories`).

```text
<pack-name>/
├── hve-plugin.json          required: manifest, routing and asset index
├── README.md                required: owner, scope and support
├── LICENSE                  required: license text
├── registry.json            required: skills index ([] allowed if none)
├── categories.json          optional: custom task categories
├── agents/*.agent.md        persona instructions (flat frontmatter, no hooks)
├── skills/<skill>/SKILL.md  vetted practice skills
├── templates/*.md           deliverables with hve-template / hve-section markers
├── lifecycles/*.json        optional: lifecycle overlays
├── knowledge/*.md           optional: process-map | runbook | solution | reference
├── evaluation/*.eval.json   optional: domain rubrics with coreShare
└── tests/routing.json       routing positive and negative test cases
```

## 2. Manifest (`hve-plugin.json`)

- [ ] **`name`:** lowercase hyphenated (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), not reserved (`frontier-hve`, `hve`, `core`).
- [ ] **`displayName`, `publisher`, `description`:** non-empty strings (`<publisher>.<name>` becomes the pack ID).
- [ ] **`version`:** exact `MAJOR.MINOR.PATCH` semantic version (bump version whenever any file changes).
- [ ] **`harness`:** `{"apiVersion": 1, "frontierHve": ">=0.8.0 <1.0.0"}` compatible with the installed Frontier-HVE version.
- [ ] **`routing`:**
  - [ ] `domains`: practice domains (for example `["oracle", "database"]`).
  - [ ] `keywords`: plain terms matched against the ask request.
  - [ ] `task_pattern`: valid regular expression matching requests that belong to this practice.
  - [ ] `workspace_signals`: file globs (`**/*.ora`) or `file:text` markers (`pom.xml:ojdbc`) to break ties between packs.
- [ ] **`tools`:** explicit ceiling of VS Code tool IDs its agents may request (reviewed by the user on install).
- [ ] **`agents`, `skills`, `templates`:** every referenced file exists inside the pack folder and no undeclared files sit in `agents/`, `templates/`, `lifecycles/`, `knowledge/` or `evaluation/`.

## 3. Assets and naming conventions

- [ ] **Prefix rule in lifecycles:** pack assets use `<pack>:<name>` (`oracle-offering:oracle-db-architect`, `oracle-offering:oracle-schema-design`, `oracle-offering:assessment`); core Frontier-HVE assets have no prefix (`Frontier-HVE engineer`, `build-approach`, `technicalDesign`).
- [ ] **Agents (`agents/*.agent.md`):**
  - [ ] YAML frontmatter uses only `name`, `description`, `tools`, `agents`, `user-invocable`, `argument-hint` (no `hooks:` block; Frontier-HVE injects core guard hooks on render).
  - [ ] Every tool in an agent's `tools: [...]` is listed in `hve-plugin.json` → `tools`.
- [ ] **Skills (`skills/<name>/SKILL.md`):** listed in `registry.json` with `task_categories` present in core or the pack's `categories.json`.
- [ ] **Templates (`templates/*.md`):** carry valid `<!-- hve-template: ... -->` and `<!-- hve-section: ... -->` markers; custom kinds use ` camelCase` names (`assessment`, `migrationRunbook`).
- [ ] **Knowledge (`knowledge/*.md`, optional):** indexed in `hve-plugin.json` with `id`, `file`, `title`, `kind` (`process-map`, `runbook`, `solution` or `reference`), one-line `use_when`, and `stages` (`[]` for all stages) so agents load documents on demand instead of reading the whole pack.
- [ ] **Evaluation (`evaluation/*.eval.json`, optional):** valid rubric contract declaring `coreShare` so core and practice rubrics compose cleanly.

## 4. Pre-install verification

Run from the repository or installed runtime (`<extension>/runtime/tools/plugins/plugin.py`):

- [ ] **Schema, assets and token audit pass:**
  ```powershell
  python tools/plugins/plugin.py validate <pack-folder>
  ```
- [ ] **Routing tests pass (`should_match` and `should_not_match` in `tests/routing.json`):**
  ```powershell
  python tools/plugins/plugin.py test <pack-folder>
  ```
- [ ] **Deterministic `.hveplugin` archive builds with `SHA256SUMS` (when distributing as a file or index entry):**
  ```powershell
  python tools/plugins/plugin.py pack <pack-folder> --out dist/
  ```

## 5. Installation checklist (for users and teams)

- [ ] **Choose how to supply the pack:**
  - **Try the built-in example:** Mission Control → **Skills & packs** → **Install example pack** (`oracle-offering`).
  - **Local folder or `.hveplugin` archive:** Mission Control → **Skills & packs** → **Install a pack…** → **Folder** or **`.hveplugin file`**.
  - **Git repository:** **Install a pack…** → **Git URL** (`https://...git`).
  - **Approved organization index:** configure `frontierHve.pluginIndex` in Settings, then **Install a pack…** → **Organization index (`name@version`)**.
  - **Repo-committed pack (no global install needed):** commit the folder at `plugins/<pack-name>/` in the workspace.
  - **Team requirement prompt:** list required packs in `frontier-hve.plugins.json` at the repo root so teammates are prompted to install on open.
- [ ] **Verify trust before clicking Install:** check `publisher`, `version`, `sha256`, whether it is verified against `frontierHve.pluginIndex`, and the `Tools its agents may use` list.
- [ ] **Reload Window** when prompted so VS Code registers the rendered `<pack>:<agent>` personas in `chat.pluginLocations`.
- [ ] **Confirm in Mission Control → Skills & packs:** the pack shows as **enabled** with its agent, lifecycle, template and knowledge counts.
