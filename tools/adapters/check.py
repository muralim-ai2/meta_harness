"""Check that an export works on this machine: the Python launcher, the copied runtime, the hook file, and one harmless hook run with the
client's own payload (which catches a launcher that cannot start or a hook that crashes); then list the client's first-run steps. For
Copilot with the VS Code extension, --plugin checks the extension's plugin instead, which Copilot loads with no copy."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export import LAYOUT, PREFIX, PRODUCT, RUNTIME_PATH, SETUP_STEPS_PATH, STATE, Json, Target, target  # noqa: E402

MIN_PYTHON = (3, 11)
NEXT_STEPS = {
    "copilot": ["Start Copilot CLI with `copilot`, type /agent and pick a {product} agent.",
                "The hooks act once the agent has opened an ask with its first command (`lifecycle.py contract`)."],
    "claude": ["Start `claude --agent {prefix}-lite` from the project root.",
               "Accept the workspace trust prompt: until you do, Claude Code skips the agent's hooks."],
    "cursor": ["Type /{prefix}-lite in Agent chat.", "Check that Customize > Hooks lists the hooks; the Hooks output channel shows errors."],
    "codex": ["Start `codex` from the project root and trust the project.", "Open /hooks and trust the hooks: Codex skips untrusted hooks.",
              "Type ${prefix}-lite."],
    "cloud": ["Commit the written files to the default branch.", "Run Actions > Copilot Setup Steps once and check that it is green.",
              "Assign an issue to Copilot and pick a {product} agent."],
}
READ = {"tool_name": "Read", "tool_input": {"file_path": "README.md"}}
COPILOT_READ = {"hook_event_name": "PreToolUse", "session_id": "check", "timestamp": "2026-01-01T00:00:00Z", "tool_name": "view",
                "tool_input": {"path": "README.md"}}
PLUGIN_STEPS = ["Start Copilot CLI with `copilot --plugin-dir \"{plugin}\"`, type /agent and pick a {product} agent.",
                "In VS Code, pick the {product} agent with Session Target Copilot or Local: nothing else to install."]
FIRST_PRE_TOOL = re.compile(r"^  PreToolUse:\n(?:.*\n)*? {6}command: '(.+)'$", re.M)


class Check(TypedDict):
    """One check: what was checked, whether it passed, and what was found."""

    name: str
    ok: bool
    detail: str


def python_check(python: str) -> Check:
    """Return whether the hooks' Python launcher starts and is 3.11 or newer."""
    launcher = python.split()
    if shutil.which(launcher[0]) is None:
        return Check(name="python", ok=False, detail=f"`{launcher[0]}` is not on PATH")
    result = subprocess.run([*launcher, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], capture_output=True, text=True)
    if result.returncode != 0:
        return Check(name="python", ok=False, detail=f"`{python}` does not start: {(result.stderr or result.stdout).strip()[:200]}")
    version = tuple(int(n) for n in result.stdout.split())
    return Check(name="python", ok=version >= MIN_PYTHON, detail=f"`{python}` is Python {version[0]}.{version[1]}")


def pre_tool_command(t: Target) -> tuple[str | list[str], Json, dict[str, str]]:
    """Return the client's first PreToolUse hook command (made absolute so it runs from any folder), a harmless Read payload in the
    client's format, and the environment the client sets."""
    base, runtime = t["base"], t["runtime"].as_posix()
    if t["client"] == "claude":
        agent = (base / LAYOUT["claude"]["agents"] / f"{PREFIX}-lite.md").read_text(encoding="utf-8")
        block = agent.split("  PreToolUse:\n", 1)[1]
        args = json.loads(re.search(r"^ +args: (.+)$", block, re.M)[1])  # type: ignore[index]
        return ["python", *(a.replace("${CLAUDE_PROJECT_DIR}", base.as_posix()) for a in args)], \
            {"hook_event_name": "PreToolUse", "session_id": "check", "transcript_path": "t", "permission_mode": "default", "tool_use_id": "c1",
             **READ}, {"CLAUDE_PROJECT_DIR": ""}
    hooks = json.loads((base / LAYOUT[t["client"]]["hooks"]).read_text(encoding="utf-8"))["hooks"]
    if t["client"] == "cursor":
        command = hooks["preToolUse"][0]["command"]
        payload: Json = {"hook_event_name": "preToolUse", "conversation_id": "check", **READ}
    elif t["client"] == "codex":
        command = hooks["PreToolUse"][0]["hooks"][0]["command"]
        payload = {"hook_event_name": "PreToolUse", "session_id": "check", "transcript_path": "t", "tool_use_id": "c1", **READ}
    else:
        command = hooks["PreToolUse"][0]["command"]
        payload = COPILOT_READ
    return command.replace(f'"{RUNTIME_PATH}/', f'"{runtime}/'), payload, {"CURSOR_PROJECT_DIR": ""} if t["client"] == "cursor" else {}


def hook_check(command: str | list[str], payload: Json, env: dict[str, str]) -> Check:
    """Run a PreToolUse hook command on a harmless read in a scratch workspace and return whether it ran without a block or a crash."""
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / STATE / "runs").mkdir(parents=True)
        env = {key: tmp for key in env}
        result = subprocess.run(command, shell=isinstance(command, str), cwd=tmp, input=json.dumps(payload | {"cwd": tmp}),
                                capture_output=True, text=True, env=os.environ | env, timeout=120)
        errors = Path(tmp) / STATE / "runs" / "hook-errors.log"
        crashed = errors.read_text(encoding="utf-8").strip().splitlines()[-1] if errors.is_file() else ""
    if result.returncode != 0:
        return Check(name="hook run", ok=False, detail=f"exit {result.returncode}: {(result.stderr or result.stdout).strip()[:300]}")
    if crashed:
        return Check(name="hook run", ok=False, detail=f"a guard crashed (nothing was blocked): {crashed[:300]}")
    if '"deny"' in result.stdout:
        return Check(name="hook run", ok=False, detail=f"a harmless read was denied: {result.stdout.strip()[:300]}")
    return Check(name="hook run", ok=True, detail="a PreToolUse hook ran on a harmless read and allowed it")


def plugin_check(plugin: Path, python: str) -> Json:
    """Return the checks of Copilot loading the extension's rendered plugin, and its first-run steps."""
    agent = plugin / "com.github.copilot" / "agents" / "lite.agent.md"
    checks = [python_check(python), Check(name="plugin", ok=agent.is_file(), detail=plugin.as_posix())]
    if all(c["ok"] for c in checks):
        match = FIRST_PRE_TOOL.search(agent.read_text(encoding="utf-8"))
        if not match:
            raise ValueError(f"{agent} has no PreToolUse hook command")
        checks.append(hook_check(match[1], COPILOT_READ, {}))
    steps = [s.format(product=PRODUCT, plugin=plugin.as_posix()) for s in PLUGIN_STEPS]
    return {"client": "copilot", "scope": "plugin", "ok": all(c["ok"] for c in checks), "checks": checks, "next": steps}


def check(client: str, workspace: Path | None, user: bool, python: str) -> Json:
    """Return the checks of one installed client and its first-run steps."""
    t = target(client, workspace, user, python)
    checks = [python_check(t["python"]) if client != "cloud" else Check(name="python", ok=True, detail="the setup workflow installs it")]
    runtime_ok = (t["runtime"] / "hooks" / "agent_compat.py").is_file()
    checks.append(Check(name="runtime", ok=runtime_ok, detail=t["runtime"].as_posix()))
    if client == "cloud":
        setup = t["base"] / SETUP_STEPS_PATH
        checks.append(Check(name="setup workflow", ok=setup.is_file(), detail=setup.relative_to(t["base"]).as_posix()))
        hooks = json.loads((t["base"] / LAYOUT["cloud"]["hooks"]).read_text(encoding="utf-8"))["hooks"]
        bash = hooks["PreToolUse"][0]["bash"]
        checks.append(Check(name="hook file", ok=bash.startswith("python3 ") and t["runtime"].relative_to(t["base"]).as_posix() in bash,
                            detail=bash[:160]))
    elif runtime_ok and checks[0]["ok"]:
        checks.append(hook_check(*pre_tool_command(t)))
    steps = [s.format(product=PRODUCT, prefix=PREFIX) for s in NEXT_STEPS[client]]
    return {"client": client, "scope": "user" if user else "project", "ok": all(c["ok"] for c in checks), "checks": checks, "next": steps}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client", choices=sorted(NEXT_STEPS))
    parser.add_argument("workspace", type=Path, nargs="?", help="project folder (project scope)")
    parser.add_argument("--user", action="store_true", help="check the install under the home folder")
    parser.add_argument("--python", default="python", help="Python launcher the hooks run with")
    parser.add_argument("--plugin", type=Path, help="copilot only: check the extension's rendered plugin folder instead of an export")
    options = parser.parse_args()
    if options.plugin and (options.client != "copilot" or options.workspace or options.user):
        parser.error("--plugin checks copilot alone, with no workspace or --user")
    print(json.dumps(plugin_check(options.plugin.resolve(), options.python) if options.plugin else
                     check(options.client, options.workspace.resolve() if options.workspace else None, options.user, options.python),
                     indent=2))
