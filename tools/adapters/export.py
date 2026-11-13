"""Export the harness agents, skills and guard hooks to Copilot (CLI, VS Code Copilot harness, cloud agent), Claude Code, Cursor or
Codex at user or project scope, and an Azure DevOps MCP server to any client; names and folders follow brand.json."""

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any, TypedDict

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
from brand import BRAND  # noqa: E402

EXTENSION = ROOT.parent
PREFIX = BRAND["prefix"]
PRODUCT = BRAND["product"]
STATE = BRAND["state_dir"]
RUNTIME_PATH = f"{STATE}/runtime"
CLOUD_RUNTIME_PATH = f".github/{PREFIX}/runtime"
HOOK_SOURCE = "lite.agent.md"
# Agent ids before the brand settings: exports named them hve-<id>, and these four had other ids.
LEGACY_IDS = {"lite": "creator", "auto": "e2e", "collab": "agile", "prototype-creator": "prototype"}
LEGACY_HOOK_FILES = {"copilot": ".copilot/hooks/hve.json", "cloud": ".github/hooks/hve.json"}
LEGACY_CLOUD_RUNTIME = ".github/hve/runtime"
SKIP_SKILLS = {"pr-push", "export-harness"}
UNVERIFIED_EVENTS = {"SubagentStop", "PreCompact"}  # not confirmed for Codex and Copilot hook files; an unknown event could void the whole file
BATCH_EVENTS = {"PreToolUse", "PostToolUse"}
LAYOUT = {"claude": {"skills": ".claude/skills", "agents": ".claude/agents"},
          "cursor": {"skills": ".cursor/skills", "hooks": ".cursor/hooks.json"},
          "codex": {"skills": ".agents/skills", "hooks": ".codex/hooks.json"},
          "copilot": {"skills": ".copilot/skills", "agents": ".copilot/agents", "hooks": f".copilot/hooks/{PREFIX}.json"},
          "cloud": {"skills": ".github/skills", "agents": ".github/agents", "hooks": f".github/hooks/{PREFIX}.json"}}
USER_CLIENTS = {"claude", "cursor", "copilot"}  # not codex: VS Code and Copilot also read ~/.agents/skills, so a user-scope Codex export
# would load every agent and harness skill a second time in them
PROJECT_CLIENTS = {"claude", "cursor", "codex", "cloud"}
CURSOR_EVENTS = {"SessionStart": "sessionStart", "UserPromptSubmit": "beforeSubmitPrompt", "PreToolUse": "preToolUse",
                 "PostToolUse": "postToolUse", "Stop": "stop"}
LOCAL_ONLY_FIELDS = re.compile(r"^(?:(?:hooks|handoffs):\n(?:[ \t]+.*\n)*|(?:model|reasoning-effort):.*\n)", re.M)
AGENT_NAME = re.compile(r"^name: (.+)$", re.M)
USER_HIDDEN = re.compile(r"^user-invocable: false$", re.M)
STANDALONE_AGENTS = {"azure-devops"}  # hidden in VS Code's picker, but people call it directly in other tools
TOOLS_LINE = re.compile(r"^tools: \[(.*)\]$", re.M)
ADO_DOMAINS = ["core", "work", "work-items", "repositories", "pipelines"]
SETUP_STEPS_PATH = ".github/workflows/copilot-setup-steps.yml"
SETUP_STEPS = "\n".join([
    f"# Written by {PRODUCT} (export.py cloud): the Copilot cloud agent runs this job before it starts, so the guard hooks have Python.",
    "name: Copilot Setup Steps", "on:", "  workflow_dispatch:", f"  push: {{paths: [{SETUP_STEPS_PATH}]}}",
    f"  pull_request: {{paths: [{SETUP_STEPS_PATH}]}}", "jobs:", "  copilot-setup-steps:", "    runs-on: ubuntu-latest",
    "    permissions: {contents: read}", "    steps:", "      - uses: actions/checkout@v5",
    '      - uses: actions/setup-python@v5\n        with: {python-version: "3.12"}',
    f"      - name: Check the {PRODUCT} runtime is committed\n        run: test -f {CLOUD_RUNTIME_PATH}/hooks/agent_compat.py", "",
])
ASK_RECORDS_IGNORE = (f"{STATE}/*", f"!{STATE}/asks/", f"!{STATE}/project/")
ORGANIZATION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,49}$")
HOOK_COMMAND = re.compile(r"""^ {6}command: 'python "\{\{RUNTIME\}\}/([\w./-]+\.py)"((?: [\w-]+)*)'$""")
EMPTY_PROFILE = {"prompt_style": None, "wants_evidence": None, "verbosity": None, "output_format": None, "build_preference": None,
                 "depth_evidence": 0, "explanation_depth": None, "bloat_triggers": []}
INVOKE = {
    "claude": f"claude --agent {PREFIX}-lite (or any {PREFIX}-* agent); accept the workspace trust prompt so the agent's hooks run",
    "cursor": f"type /{PREFIX}-lite in Agent chat, or Alt+Enter on it to keep it as a Custom Mode for the session",
    "codex": f"type ${PREFIX}-lite; start codex from the project root and trust the hooks once with /hooks",
    "copilot": f"pick a {PRODUCT} agent with /agent in Copilot CLI",
    "cloud": f"commit .github/agents, .github/skills, .github/hooks/{PREFIX}.json, {CLOUD_RUNTIME_PATH}, {SETUP_STEPS_PATH} and .gitignore "
             f"to the default branch, then assign an issue to Copilot with a {PRODUCT} agent",
    "vscode": f"start the ado server in the MCP view, sign in, then pick {PRODUCT} azure-devops in the Chat view",
}
GAPS = {
    "claude": ["pr-push is not exported (it needs the VS Code GitHub Pull Requests extension)",
               "AskUserQuestion answers are mapped from question text to header; labels containing commas split wrongly"],
    "cursor": [f"hooks in .cursor/hooks.json apply to every agent, not only {PREFIX}-lite (at user scope only while an ask is open)",
               "Cursor has no context channel on prompt submit or before a tool: the skill loadout notice and harness challenges do not "
               "reach the model; guards (deny), module-size feedback, victory check and session profile do",
               "the sub-agent context hook (SubagentStart) is not exported: Cursor's subagentStart only allows or denies",
               "pr-push is not exported"],
    "codex": [f"hooks in .codex/hooks.json apply to every session, not only ${PREFIX}-lite (at user scope only while an ask is open)",
              "Codex runs project hooks only after /hooks trust, and with the session directory as working directory",
              "Codex cannot stop the agent from PreToolUse: escalation stops are sent as denies", "pr-push is not exported"],
    "copilot": [f"VS Code also lists ~/.copilot/agents: with the {PRODUCT} extension installed every agent shows twice, so there use the "
                f"extension's plugin instead (`copilot --plugin-dir <plugin folder>`; Install for other tools > Copilot CLI shows it)",
                f"hooks in ~/.copilot/hooks/{PREFIX}.json run for every Copilot session but act only while an ask is open",
                "Copilot drops prompt-submit hook output and has no context before a tool: agents load skills from `lifecycle.py contract` "
                "output, and the loadout notice arrives after the first tool call",
                "escalation stops are sent as denies; handoff buttons are VS Code Local only",
                "pr-push is not exported"],
    "cloud": ["the cloud agent is non-interactive: ask-questions gates and guard waivers cannot be answered, so asks run without them",
              f"hooks run in a Linux sandbox from the default branch; {STATE}/runs/ is discarded after the job, while the ask and project "
              f"records ({STATE}/asks/, {STATE}/project/) are committed with the pull request",
              "pr-push is not exported"],
    "vscode": [],
}

Json = dict[str, Any]


class Hook(TypedDict):
    """One hook command of an agent template: runtime script, script arguments, environment and timeout in seconds."""
    script: str
    args: list[str]
    env: dict[str, str]
    timeout: int | None


class Agent(TypedDict):
    """An agent template split into its description, hooks per event and body with the runtime path filled in."""
    description: str
    hooks: dict[str, list[Hook]]
    body: str


class Target(TypedDict):
    """One client export: base folder, runtime folder, the runtime path as agent bodies and hook commands name it, and hook options."""
    client: str
    user: bool
    base: Path
    runtime: Path
    body_ref: str
    hook_ref: str
    python: str
    ask_only: bool


def target(client: str, workspace: Path | None, user: bool, python: str) -> Target:
    """Return where and how to export one client at user scope (home folder) or project scope (workspace)."""
    base = Path.home() if user else workspace
    if base is None:
        raise ValueError("project scope needs a workspace folder; pass one or use --user")
    relative = CLOUD_RUNTIME_PATH if client == "cloud" else RUNTIME_PATH
    runtime = base / relative
    body_ref = runtime.as_posix() if user else relative
    return Target(client=client, user=user, base=base, runtime=runtime, body_ref=body_ref,
                  hook_ref=f"${{CLAUDE_PROJECT_DIR}}/{relative}" if client == "claude" and not user else body_ref,
                  python="python3" if client == "cloud" else python, ask_only=user or client == "cloud")


def parse_agent(path: Path, body_ref: str) -> Agent:
    """Return the description, hooks and body of a VS Code agent template."""
    _, front, body = path.read_text(encoding="utf-8").split("---\n", 2)
    description = re.search(r"^description: (.+)$", front, re.M)
    if not description:
        raise ValueError(f"{path} has no description")
    hooks: dict[str, list[Hook]] = {}
    event = ""
    for line in front.splitlines():
        if match := re.match(r"^  (\w+):$", line):
            event = match[1]
            hooks[event] = []
        elif match := HOOK_COMMAND.match(line):
            hooks[event].append(Hook(script=match[1], args=match[2].split(), env={}, timeout=None))
        elif match := re.match(r"^ {6}timeout: (\d+)$", line):
            hooks[event][-1]["timeout"] = int(match[1])
        elif match := re.match(r"^ {8}(\w+): (\S+)$", line):
            hooks[event][-1]["env"][match[1]] = match[2]
    return Agent(description=description[1], hooks=hooks, body=body.replace("{{RUNTIME}}", body_ref))


def portable_agent(path: Path, body_ref: str) -> str:
    """Return a VS Code agent template as a Copilot custom agent: Local-only fields removed, tool names mapped to Copilot's aliases."""
    _, front, body = path.read_text(encoding="utf-8").split("---\n", 2)
    front = TOOLS_LINE.sub(lambda m: "tools: " + json.dumps(list(dict.fromkeys(t.strip().split("/")[0] for t in m[1].split(",") if t.strip()))),
                           LOCAL_ONLY_FIELDS.sub("", front))
    return f"---\n{front}---\n{body.replace('{{RUNTIME}}', body_ref)}"


def hook_groups(hooks: dict[str, list[Hook]]) -> dict[str, list[list[Hook]]]:
    """Batch multiple PreToolUse or PostToolUse hooks into one in-process run; keep other events one command per hook."""
    return {event: ([items] if event in BATCH_EVENTS and len(items) > 1 else [[h] for h in items]) for event, items in hooks.items()}


def compat_args(client: str, group: list[Hook], ask_only: bool) -> list[str]:
    """Return the agent_compat.py arguments that run one or more '+'-separated hooks for a client."""
    specs = [tok for i, h in enumerate(group)
             for tok in ([*(["+"] if i else []), h["script"], *(f"{k}={v}" for k, v in h["env"].items()), *(["--", *h["args"]] if h["args"] else [])])]
    return [*(["--ask-only"] if ask_only else []), "copilot" if client == "cloud" else client, *specs]


def frontmatter(fields: Json) -> str:
    """Return YAML frontmatter with JSON-quoted values (JSON is valid YAML)."""
    return "---\n" + "".join(f"{key}: {json.dumps(value)}\n" for key, value in fields.items()) + "---\n"


def claude_agent(name: str, agent: Agent, hook_ref: str) -> str:
    """Return a Claude Code subagent file whose frontmatter hooks run the harness hooks through agent_compat.py."""
    lines = ["---", f"name: {name}", f"description: {json.dumps(agent['description'])}"] + (["hooks:"] if agent["hooks"] else [])
    for event, groups in hook_groups(agent["hooks"]).items():
        lines += [f"  {event}:", "    - hooks:"]
        for group in groups:
            args = [f"{hook_ref}/hooks/agent_compat.py", *compat_args("claude", group, False)]
            timeout = max((h["timeout"] for h in group if h["timeout"]), default=None)
            lines += ["        - type: command", "          command: python", f"          args: {json.dumps(args)}",
                      *([f"          timeout: {timeout}"] if timeout else [])]
    return "\n".join([*lines, "---", ""]) + agent["body"]


def shell_command(t: Target, group: list[Hook]) -> str:
    """Return the shell command that runs a hook group through agent_compat.py."""
    return " ".join([t["python"], f'"{t["hook_ref"]}/hooks/agent_compat.py"', *compat_args(t["client"], group, t["ask_only"])])


def handler(t: Target, group: list[Hook]) -> Json:
    """Return one command handler with its timeout, if the template sets one."""
    timeout = max((h["timeout"] for h in group if h["timeout"]), default=None)
    return {"command": shell_command(t, group)} | ({"timeout": timeout} if timeout else {})


def hooks_file(t: Target, agent: Agent) -> Json:
    """Return the hooks file for Cursor (native format), Copilot (version 1, VS Code-compatible events) or Codex (Claude-style format)."""
    grouped = hook_groups(agent["hooks"])
    if t["client"] == "cursor":
        return {"version": 1, "hooks": {CURSOR_EVENTS[e]: [handler(t, g) for g in gs] for e, gs in grouped.items() if e in CURSOR_EVENTS}}
    if t["client"] in ("copilot", "cloud"):
        entry = (lambda g: {"type": "command", "bash": shell_command(t, g), "powershell": "exit 0",
                            "timeoutSec": max((h["timeout"] for h in g if h["timeout"]), default=30)}) if t["client"] == "cloud" \
            else (lambda g: {"type": "command", "command": shell_command(t, g),
                             "timeoutSec": max((h["timeout"] for h in g if h["timeout"]), default=30)})
        return {"version": 1, "hooks": {e: [entry(g) for g in gs] for e, gs in grouped.items() if e not in UNVERIFIED_EVENTS}}
    return {"hooks": {e: [{"hooks": [{"type": "command"} | handler(t, g) for g in gs]}] for e, gs in grouped.items() if e not in UNVERIFIED_EVENTS}}


def write_owned(path: Path, text: str) -> None:
    """Write a file the harness owns; refuse to overwrite one it did not write."""
    if path.exists() and "agent_compat.py" not in path.read_text(encoding="utf-8"):
        raise FileExistsError(f"{path} exists and was not written by {PRODUCT}; merge its entries by hand or move it away")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def ado_server(organization: str, client: str) -> Json:
    """Return the stdio launch of Microsoft's Azure DevOps MCP server for an organization, limited to the harness domains."""
    args = ["-y", "@azure-devops/mcp", organization, "-d", *ADO_DOMAINS]
    if client == "vscode":
        return {"type": "stdio", "command": "npx", "args": args}
    return {"command": "cmd", "args": ["/c", "npx", *args]} if os.name == "nt" else {"command": "npx", "args": args}


def add_ado(workspace: Path, client: str, organization: str) -> Path:
    """Add the ado server to the client's project MCP configuration and return the file."""
    if not ORGANIZATION.match(organization):
        raise ValueError(f"{organization!r} is not an Azure DevOps organization name (letters, digits and hyphens)")
    if client == "codex":
        path = workspace / ".codex" / "config.toml"
        text = path.read_text(encoding="utf-8") if path.exists() else ""
        if "[mcp_servers.ado]" not in text:
            server = ado_server(organization, client)
            path.parent.mkdir(exist_ok=True)
            path.write_text(text + f"\n[mcp_servers.ado]\ncommand = {json.dumps(server['command'])}\nargs = {json.dumps(server['args'])}\n",
                            encoding="utf-8")
        return path
    path, key = {"vscode": (workspace / ".vscode" / "mcp.json", "servers"), "claude": (workspace / ".mcp.json", "mcpServers"),
                 "cursor": (workspace / ".cursor" / "mcp.json", "mcpServers")}[client]
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    data.setdefault(key, {})["ado"] = ado_server(organization, client)
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return path


def commit_ask_records(workspace: Path) -> Path:
    """Make the repository's .gitignore keep the ask and project records under the state folder and ignore the rest; return it."""
    path = workspace / ".gitignore"
    lines = [line for line in (path.read_text(encoding="utf-8").splitlines() if path.exists() else [])
             if line.strip() not in (STATE, f"{STATE}/", f"/{STATE}", f"/{STATE}/")]
    path.write_text("\n".join(lines + [rule for rule in ASK_RECORDS_IGNORE if rule not in lines]) + "\n", encoding="utf-8")
    return path


def copy_runtime(t: Target) -> None:
    """Copy the harness runtime to the target's runtime folder and, at project scope, create the state the hooks read."""
    if t["runtime"].resolve() != ROOT:
        if t["runtime"].exists():
            shutil.rmtree(t["runtime"])
        shutil.copytree(ROOT, t["runtime"], ignore=shutil.ignore_patterns("__pycache__"))
    if t["user"]:
        return
    (t["base"] / STATE / "runs").mkdir(parents=True, exist_ok=True)
    profile = t["base"] / STATE / "user_profile.json"
    if not profile.exists():
        profile.write_text(json.dumps(EMPTY_PROFILE, indent=2) + "\n", encoding="utf-8")


def manifest_file(t: Target) -> Path:
    """Return the record of the paths the last export to this client and scope wrote."""
    return t["base"] / STATE / "exports" / f"{t['client']}.json"


def owned_roots(t: Target) -> list[Path]:
    """Return the folders and files an export to this client may remove: its agent, skill and hook locations, runtimes and workflow."""
    layout = LAYOUT[t["client"]]
    roots = [t["base"] / rel for rel in layout.values()] + [t["runtime"], (t["base"] / LEGACY_CLOUD_RUNTIME).parent]
    return roots + [t["base"] / LEGACY_HOOK_FILES[t["client"]]] if t["client"] in LEGACY_HOOK_FILES else roots


def legacy_paths(t: Target) -> list[Path]:
    """Return what an export from before the brand settings wrote for this client and that is provably the harness's: hve-* agents and
    skills that carry the template's description, name or a runtime reference, the hve.json hook file and the runtime under .github/hve."""
    layout = LAYOUT[t["client"]]
    found = []
    for template in sorted((EXTENSION / "agents").glob("*.agent.md")):
        agent_id = template.name.removesuffix(".agent.md")
        old = f"hve-{LEGACY_IDS.get(agent_id, agent_id)}"
        if t["client"] == "claude":
            path = t["base"] / layout["agents"] / f"{old}.md"
        elif t["client"] in ("copilot", "cloud"):
            path = t["base"] / layout["agents"] / f"{old}.agent.md"
        else:
            path = t["base"] / layout["skills"] / old
        text_file = path / "SKILL.md" if t["client"] in ("cursor", "codex") else path
        if not text_file.is_file():
            continue
        text = text_file.read_text(encoding="utf-8")
        description = parse_agent(template, "")["description"]
        proofs = (description, json.dumps(description), f"name: {old}\n", f"name: {json.dumps(old)}\n", "/runtime/tools/", "/runtime/hooks/")
        if any(proof in text for proof in proofs):
            found.append(path)
    for source in sorted((EXTENSION / "skills").iterdir()):
        copy = t["base"] / layout["skills"] / source.name
        shipped = {p.relative_to(source).as_posix() for p in source.rglob("*") if p.is_file()}
        if source.name not in SKIP_SKILLS and (copy / "SKILL.md").is_file() and \
                re.search(rf"^name: \"?{re.escape(source.name)}\"?$", (copy / "SKILL.md").read_text(encoding="utf-8"), re.M) and \
                {p.relative_to(copy).as_posix() for p in copy.rglob("*") if p.is_file()} <= shipped:
            found.append(copy)
    if "hooks" in layout and (t["base"] / layout["hooks"]).is_file() and \
            "agent_compat.py" in (t["base"] / layout["hooks"]).read_text(encoding="utf-8"):
        found.append(t["base"] / layout["hooks"])
    if t["client"] in LEGACY_HOOK_FILES:
        hooks = t["base"] / LEGACY_HOOK_FILES[t["client"]]
        if hooks.is_file() and "agent_compat.py" in hooks.read_text(encoding="utf-8"):
            found.append(hooks)
    runtime = t["base"] / LEGACY_CLOUD_RUNTIME
    if t["client"] == "cloud" and (runtime / "hooks" / "agent_compat.py").is_file():
        found.append(runtime.parent if [p.name for p in runtime.parent.iterdir()] == ["runtime"] else runtime)
    return found


def remove_stale(t: Target, written: list[Path]) -> list[Path]:
    """Delete what the previous export or a pre-brand export wrote that this export did not, record what it wrote, and return the
    removed paths; only paths inside this client's own locations are ever removed."""
    manifest = manifest_file(t)
    previous = [t["base"] / rel for rel in json.loads(manifest.read_text(encoding="utf-8"))] if manifest.is_file() else []
    keep = {p.resolve() for p in written}
    roots = [r.resolve() for r in owned_roots(t)]
    removed = []
    for path in dict.fromkeys(previous + legacy_paths(t)):
        resolved = path.resolve()
        if resolved in keep or not path.exists() or not any(resolved == r or resolved.is_relative_to(r) for r in roots):
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        removed.append(path)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps([p.relative_to(t["base"]).as_posix() for p in written], indent=2) + "\n", encoding="utf-8")
    return removed


def agent_names() -> dict[str, str]:
    """Return each agent template's display name (as VS Code shows it) mapped to its id."""
    names = {}
    for path in sorted((EXTENSION / "agents").glob("*.agent.md")):
        match = AGENT_NAME.search(path.read_text(encoding="utf-8"))
        if not match:
            raise ValueError(f"{path} has no name")
        names[match[1]] = path.name.removesuffix(".agent.md")
    return names


def name_pattern(names: dict[str, str]) -> re.Pattern[str]:
    """Return a pattern that finds whole agent display names, longest first."""
    return re.compile("(" + "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + r")(?![\w-])")


def exported_agents(names: dict[str, str]) -> list[str]:
    """Return the ids of the agents other tools get: the ones users pick, the standalone ones, and every agent those agents, the exported
    skills or the lifecycles name, transitively; research baselines and unreferenced helpers stay in VS Code."""
    pattern = name_pattern(names)
    texts = {i: (EXTENSION / "agents" / f"{i}.agent.md").read_text(encoding="utf-8") for i in names.values()}
    shared = "".join(p.read_text(encoding="utf-8") for p in sorted((EXTENSION / "skills").rglob("*.md"))
                     if p.relative_to(EXTENSION / "skills").parts[0] not in SKIP_SKILLS)
    shared += "".join(p.read_text(encoding="utf-8") for p in sorted((ROOT / "templates" / "lifecycles").glob("*.json")))
    queue = [i for i, text in texts.items() if not USER_HIDDEN.search(text)] + sorted(STANDALONE_AGENTS)
    queue += [names[m] for m in pattern.findall(shared)]
    seen: set[str] = set()
    while queue:
        agent = queue.pop()
        if agent not in seen:
            seen.add(agent)
            queue += [names[m] for m in pattern.findall(texts[agent])]
    return sorted(seen)


def name_map(text: str, names: dict[str, str], exported: list[str]) -> str:
    """Return a section that maps the agent display names a text uses to their names in other tools, or nothing when it uses none."""
    used = [m for m in dict.fromkeys(name_pattern(names).findall(text)) if names[m] in exported]
    if not used:
        return ""
    rows = "\n".join(f"- `{display}` is `{PREFIX}-{names[display]}`" for display in used)
    return (f"\n\n## {PRODUCT} agent names in this tool\n\nThese instructions name agents as VS Code shows them. Here they are named:\n\n"
            f"{rows}\n\nUse the name on the right when you delegate to or hand off to an agent.\n")


def branded(text: str) -> str:
    """Return agent or skill text with the state folder and product name replaced by the brand's."""
    out = text.replace(".aria/", f"{STATE}/").replace("Frontier HVE", PRODUCT)
    return out if PRODUCT == "ARIA" else re.sub(r"\bARIA\b", PRODUCT, out)


def export_client(t: Target) -> tuple[list[Path], list[Path]]:
    """Write the runtime, skills, the exported agents and the hooks for one client and remove its stale copies; return written and
    removed."""
    copy_runtime(t)
    layout = LAYOUT[t["client"]]
    skills = t["base"] / layout["skills"]
    written = [t["runtime"]]
    for source in sorted((EXTENSION / "skills").iterdir()):
        if source.name not in SKIP_SKILLS:
            shutil.copytree(source, skills / source.name, dirs_exist_ok=True)
            for doc in (skills / source.name).rglob("*.md"):
                doc.write_text(branded(doc.read_text(encoding="utf-8")), encoding="utf-8")
            written.append(skills / source.name)
    names = agent_names()
    exported = exported_agents(names)
    for agent_id in exported:
        template = EXTENSION / "agents" / f"{agent_id}.agent.md"
        name = f"{PREFIX}-{agent_id}"
        names_here = name_map(template.read_text(encoding="utf-8"), names, exported)
        if t["client"] == "claude":
            path = t["base"] / layout["agents"] / f"{name}.md"
            text = claude_agent(name, parse_agent(template, t["body_ref"]), t["hook_ref"]) + names_here
        elif t["client"] in ("copilot", "cloud"):
            path = t["base"] / layout["agents"] / f"{name}.agent.md"
            text = portable_agent(template, t["body_ref"]) + names_here
        else:
            agent = parse_agent(template, t["body_ref"])
            path = skills / name / "SKILL.md"
            fields = {"name": name, "description": agent["description"]} | ({"disable-model-invocation": True} if t["client"] == "cursor" else {})
            text = frontmatter(fields) + agent["body"] + names_here
            if t["client"] == "codex":
                (skills / name / "agents").mkdir(parents=True, exist_ok=True)
                (skills / name / "agents" / "openai.yaml").write_text("policy:\n  allow_implicit_invocation: false\n", encoding="utf-8")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(branded(text), encoding="utf-8")
        written.append(path.parent if path.name == "SKILL.md" else path)
    if "hooks" in layout:
        path = t["base"] / layout["hooks"]
        write_owned(path, json.dumps(hooks_file(t, parse_agent(EXTENSION / "agents" / HOOK_SOURCE, t["body_ref"])), indent=2) + "\n")
        written.append(path)
    if t["client"] == "cloud":
        write_owned(t["base"] / SETUP_STEPS_PATH, SETUP_STEPS)
        written += [t["base"] / SETUP_STEPS_PATH, commit_ask_records(t["base"])]
    return written, remove_stale(t, written)


def export(client: str, workspace: Path | None, organization: str | None, user: bool, python: str, remove: bool = False) -> Json:
    """Export to one client at user or project scope (or, with remove, delete what earlier exports there wrote) and return the written and
    removed paths, how to invoke the agents, and the known gaps."""
    if not (EXTENSION / "agents").is_dir() or not (EXTENSION / "skills").is_dir():
        raise FileNotFoundError(f"{EXTENSION} is not the {PRODUCT} extension folder (agents/, skills/, runtime/): run the copy shipped in it")
    if client == "vscode" and not organization:
        raise ValueError("the vscode target only connects Azure DevOps: pass --ado <organization>")
    if remove and (client == "vscode" or organization):
        raise ValueError("--remove takes a harness client and no --ado")
    if user and client not in USER_CLIENTS and not (remove and client == "codex"):
        raise ValueError(f"{client} has no user scope; user scope supports {sorted(USER_CLIENTS)}")
    if not user and client not in PROJECT_CLIENTS | {"vscode"}:
        raise ValueError(f"{client} installs at user scope only: pass --user (use `cloud` for a repository's Copilot cloud agent)")
    if organization and (user or client == "cloud"):
        raise ValueError("--ado writes a workspace MCP file for vscode, claude, cursor or codex: run it at project scope")
    t = target(client, workspace, user, python)
    if remove:
        # The runtime is shared by every client at the same scope, so a removal keeps it.
        written, removed = [], remove_stale(t, [t["runtime"]])
    else:
        written, removed = ([], []) if client == "vscode" else export_client(t)
    if organization:
        written.append(add_ado(t["base"], client, organization))
    guide = str(ROOT / "docs" / "wiki" / "Adapters.md") if client == "vscode" else f"{t['body_ref']}/docs/wiki/Adapters.md"
    return {"client": client, "scope": "user" if user else "project", "written": [p.relative_to(t["base"]).as_posix() for p in written],
            "removed": [p.relative_to(t["base"]).as_posix() for p in removed], "invoke": INVOKE[client], "gaps": GAPS[client],
            "guide": guide}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client", choices=["copilot", "cloud", "claude", "cursor", "codex", "vscode"])
    parser.add_argument("workspace", type=Path, nargs="?", help="project folder (project scope)")
    parser.add_argument("--user", action="store_true", help="install under the home folder for every workspace")
    parser.add_argument("--python", default="python", help="Python launcher the hooks run with (for example py -3)")
    parser.add_argument("--ado", metavar="ORGANIZATION", help="Azure DevOps organization to connect through @azure-devops/mcp")
    parser.add_argument("--remove", action="store_true", help="delete what earlier exports to this client and scope wrote, and write nothing")
    options = parser.parse_args()
    print(json.dumps(export(options.client, options.workspace.resolve() if options.workspace else None, options.ado, options.user,
                            options.python, options.remove), indent=2))
