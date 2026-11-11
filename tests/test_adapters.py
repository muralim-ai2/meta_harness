"""Tests of the client adapters: export structure for Claude Code, Cursor, Codex and VS Code, and the exported hooks run with each
client's documented hook payloads through agent_compat.py."""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
EXTENSION = REPO / "extension"
EXPORT = EXTENSION / "runtime" / "tools" / "adapters" / "export.py"
PROFILE = {"prompt_style": None, "wants_evidence": None, "verbosity": None, "output_format": None, "build_preference": "pro_code",
           "depth_evidence": 0, "explanation_depth": None, "bloat_triggers": []}

Json = dict[str, Any]
# The agents users pick, the standalone Azure DevOps agent, and every agent they, the skills or the lifecycles name.
EXPORTED_AGENTS = {f"aria-{name}" for name in (
    "lite", "auto", "collab", "prototype-creator", "azure-devops", "engineer", "product-manager", "council", "evaluation-reviewer",
    "uplift-judge", "skill-evaluator", "skill-judge", "skill-worker", "architecture-reviewer", "code-reviewer", "data-scientist",
    "db-architect", "db-engineer", "devops-engineer", "product-reviewer", "security-architect", "security-reviewer", "solution-architect",
    "test-architect", "test-engineer", "test-reviewer", "ui-engineer", "ux-designer", "ux-reviewer")}


def export(ws: Path, client: str, *extra: str) -> Json:
    """Run the built exporter for a client into ws and return its JSON report."""
    result = subprocess.run([sys.executable, str(EXPORT), client, str(ws), *extra], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def guard_mode(runtime: Path, mode: str) -> None:
    """Set the exported loop guard to enforce (deny) or advise (surface to the user)."""
    (runtime / "hooks" / "guard_mode.json").write_text(json.dumps({"loop_guard": mode}), encoding="utf-8")


def exported_workspace(tmp: str) -> Path:
    """Build the extension and export all three clients plus the Azure DevOps server into a fresh workspace, loop guard enforcing."""
    subprocess.run([sys.executable, str(EXTENSION / "build.py")], check=True, capture_output=True)
    ws = Path(tmp) / "ws"
    ws.mkdir()
    for client in ("claude", "cursor", "codex", "vscode"):
        export(ws, client, "--ado", "contoso")
    (ws / ".aria" / "user_profile.json").write_text(json.dumps(PROFILE), encoding="utf-8")
    guard_mode(ws / ".aria" / "runtime", "enforce")
    return ws


def claude_hooks(ws: Path) -> dict[str, list[list[str]]]:
    """Return the exec-form argument vectors per event from the exported aria-lite subagent, with the project dir filled in."""
    hooks: dict[str, list[list[str]]] = {}
    front = (ws / ".claude" / "agents" / "aria-lite.md").read_text(encoding="utf-8").split("---\n")[1]
    for line in front.splitlines():
        if match := re.match(r"^  (\w+):$", line):
            event = match[1]
            hooks[event] = []
        elif match := re.match(r"^ {10}args: (.+)$", line):
            hooks[event].append([a.replace("${CLAUDE_PROJECT_DIR}", str(ws)) for a in json.loads(match[1])])
    return hooks


def fire(ws: Path, client: str, payload: Json) -> list[Json]:
    """Run every exported hook of the client for the payload's event, the way the client runs them; return the non-empty outputs."""
    event = payload["hook_event_name"]
    env = os.environ | {"CLAUDE_PROJECT_DIR": str(ws), "CURSOR_PROJECT_DIR": str(ws)}
    if client == "claude":
        runs = [dict(args=[sys.executable, *argv], shell=False) for argv in claude_hooks(ws)[event]]
    elif client == "cursor":
        runs = [dict(args=h["command"], shell=True) for h in json.loads((ws / ".cursor" / "hooks.json").read_text())["hooks"][event]]
    else:
        groups = json.loads((ws / ".codex" / "hooks.json").read_text())["hooks"][event]
        runs = [dict(args=h["command"], shell=True) for g in groups for h in g["hooks"]]
    outputs = []
    for run in runs:
        result = subprocess.run(run["args"], shell=run["shell"], cwd=ws, input=json.dumps(payload), capture_output=True, text=True, env=env)
        assert result.returncode == 0, (client, event, run["args"], result.stderr)
        outputs += [json.loads(result.stdout)] if result.stdout.strip() else []
    return outputs


def start_loop(ws: Path, passes: bool = False, escalated: bool = False, in_ask: bool = False) -> None:
    """Write the loop state the guards read: one feature and the loop state file, in .aria/project/ when an ask is open."""
    files, state_folder = (ws / ".aria" / "project", ws / ".aria" / "project") if in_ask else (ws, ws / ".harness")
    state_folder.mkdir(parents=True, exist_ok=True)
    (files / "feature_list.json").write_text(json.dumps([{"name": "login", "description": "d", "verify": "exit 0", "passes": passes}]))
    state = {"current": None, "review": "local", "escalated": escalated, "help": {"question": "Which database?"}}
    (state_folder / "state.json").write_text(json.dumps(state), encoding="utf-8")


def test_export_structure() -> None:
    """Each client gets the runtime, skills (minus VS Code-only ones), its agents, hooks naming real scripts, and the ado server."""
    with tempfile.TemporaryDirectory() as tmp:
        ws = exported_workspace(tmp)
        runtime = ws / ".aria" / "runtime"
        assert (runtime / "hooks" / "agent_compat.py").is_file() and (runtime / "skills" / "licenses" / "agentx" / "LICENSE").is_file()
        assert (runtime / "tools" / "templates" / "manage.py").is_file()
        assert (runtime / "templates" / "deliverables" / "test-strategy-v1.md").is_file()
        for skills in (".claude/skills", ".cursor/skills", ".agents/skills"):
            names = {p.parent.name for p in (ws / skills).glob("*/SKILL.md")}
            assert {"delivery-coach", "feature-checklist", "deliverable-templates"} <= names and not {"pr-push", "export-harness"} & names, (skills, names)
            for skill in (ws / skills).glob("*/SKILL.md"):
                assert re.search(rf"^name: \"?{skill.parent.name}\"?$", skill.read_text(encoding="utf-8"), re.M), skill
        agents = {p.stem for p in (ws / ".claude" / "agents").glob("*.md")}
        assert agents == EXPORTED_AGENTS, sorted(agents ^ EXPORTED_AGENTS)
        auto = (ws / ".claude" / "agents" / "aria-auto.md").read_text(encoding="utf-8")
        assert "## ARIA agent names in this tool" in auto and "- `ARIA engineer` is `aria-engineer`" in auto, auto[-800:]
        assert "`ARIA research-single`" not in auto
        sys.path.insert(0, str(REPO / "hooks"))
        import agent_compat
        hooks_by_event = claude_hooks(ws)
        assert len(hooks_by_event["PreToolUse"]) == 1 and len(hooks_by_event["PostToolUse"]) == 1, hooks_by_event
        specs = [spec for args in hooks_by_event.values() for a in args for spec in agent_compat.parse_specs(a[2:])]
        assert {s[0] for s in specs} == {"hooks/profile_detector.py", "hooks/skill_loader.py", "hooks/compaction.py", "hooks/loop_guard.py",
                                         "hooks/module_guard.py", "hooks/template_guard.py", "hooks/agent_ledger.py", "hooks/error_guard.py",
                                         "scripts/choice_recorder.py", "scripts/guardrail.py"}
        assert all((runtime / s[0]).is_file() for s in specs)
        manager = (ws / ".claude" / "agents" / "aria-product-manager.md").read_text(encoding="utf-8")
        assert "hooks:" in manager and manager.count("hooks/template_guard.py") == 3
        assert ("scripts/guardrail.py", {}, ["--hook"]) in specs, specs
        creator = (ws / ".claude" / "agents" / "aria-lite.md").read_text(encoding="utf-8")
        assert "{{RUNTIME}}" not in creator and ".aria/runtime/tools/loop/loop.py" in creator
        cursor = json.loads((ws / ".cursor" / "hooks.json").read_text())
        assert cursor["version"] == 1 and set(cursor["hooks"]) == {"sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUse", "stop"}
        assert "disable-model-invocation: true" in (ws / ".cursor" / "skills" / "aria-lite" / "SKILL.md").read_text(encoding="utf-8")
        codex = json.loads((ws / ".codex" / "hooks.json").read_text())
        assert set(codex["hooks"]) == {"SessionStart", "UserPromptSubmit", "SubagentStart", "PreToolUse", "PostToolUse", "Stop"}
        assert "allow_implicit_invocation: false" in (ws / ".agents" / "skills" / "aria-lite" / "agents" / "openai.yaml").read_text()
        for path, key in ((".mcp.json", "mcpServers"), (".cursor/mcp.json", "mcpServers"), (".vscode/mcp.json", "servers")):
            server = json.loads((ws / path).read_text())[key]["ado"]
            assert "@azure-devops/mcp" in server["args"] and server["args"][-5:] == ["core", "work", "work-items", "repositories", "pipelines"]
        assert "[mcp_servers.ado]" in (ws / ".codex" / "config.toml").read_text()


def test_export_refuses_foreign_files_and_bad_organizations() -> None:
    """A hooks file the harness did not write is kept, a re-export is idempotent, and an unsafe organization name is rejected."""
    with tempfile.TemporaryDirectory() as tmp:
        ws = exported_workspace(tmp)
        export(ws, "codex", "--ado", "contoso")
        assert (ws / ".codex" / "config.toml").read_text().count("[mcp_servers.ado]") == 1
        (ws / ".cursor" / "hooks.json").write_text('{"version": 1, "hooks": {"stop": [{"command": "./mine.sh"}]}}')
        result = subprocess.run([sys.executable, str(EXPORT), "cursor", str(ws)], capture_output=True, text=True)
        assert result.returncode != 0 and "not written by ARIA" in result.stderr
        assert "mine.sh" in (ws / ".cursor" / "hooks.json").read_text()
        result = subprocess.run([sys.executable, str(EXPORT), "vscode", str(ws), "--ado", "x; rm -rf /"], capture_output=True, text=True)
        assert result.returncode != 0 and "organization name" in result.stderr


def test_reexport_removes_stale_and_pre_brand_copies() -> None:
    """A re-export removes the hve-* agents, skills, hook file and cloud runtime an earlier export wrote, and what the last export wrote
    that this one does not; files the harness did not write and paths outside the client's folders are kept."""
    with tempfile.TemporaryDirectory() as tmp:
        ws = Path(tmp) / "ws"
        (ws / ".claude" / "agents").mkdir(parents=True)
        lite = (EXTENSION / "agents" / "lite.agent.md").read_text(encoding="utf-8")
        description = re.search(r"^description: (.+)$", lite, re.M)[1]  # type: ignore[index]
        (ws / ".claude" / "agents" / "hve-creator.md").write_text(f'---\nname: hve-creator\ndescription: {json.dumps(description)}\n---\n')
        (ws / ".claude" / "agents" / "hve-mine.md").write_text("---\nname: hve-mine\ndescription: my own agent\n---\n")
        (ws / ".claude" / "agents" / "hve-single.md").write_text("---\nname: something-else\ndescription: not ours\n---\n")
        (ws / ".cursor" / "skills" / "hve-e2e").mkdir(parents=True)
        (ws / ".cursor" / "skills" / "hve-e2e" / "SKILL.md").write_text('---\nname: "hve-e2e"\n---\nRun python ".aria/runtime/tools/loop/x.py"\n')
        (ws / ".github" / "hve" / "runtime" / "hooks").mkdir(parents=True)
        (ws / ".github" / "hve" / "runtime" / "hooks" / "agent_compat.py").write_text("")
        (ws / ".github" / "hooks").mkdir(parents=True)
        (ws / ".github" / "hooks" / "hve.json").write_text('{"hooks": {"Stop": [{"bash": "python3 agent_compat.py"}]}}')
        (ws / ".github" / "agents").mkdir(parents=True)
        (ws / ".github" / "agents" / "hve-collab-notes.agent.md").write_text("my notes")
        assert set(export(ws, "claude")["removed"]) == {".claude/agents/hve-creator.md"}
        assert (ws / ".claude" / "agents" / "hve-mine.md").is_file() and (ws / ".claude" / "agents" / "hve-single.md").is_file()
        assert set(export(ws, "cursor")["removed"]) == {".cursor/skills/hve-e2e"}
        assert set(export(ws, "cloud")["removed"]) == {".github/hve", ".github/hooks/hve.json"}
        assert (ws / ".github" / "agents" / "hve-collab-notes.agent.md").is_file()
        manifest = ws / ".aria" / "exports" / "claude.json"
        listed = json.loads(manifest.read_text(encoding="utf-8"))
        assert ".claude/agents/aria-lite.md" in listed
        (ws / ".claude" / "agents" / "aria-retired.md").write_text("old")
        (ws / "README.md").write_text("keep me")
        manifest.write_text(json.dumps(listed + [".claude/agents/aria-retired.md", "README.md", "../outside.txt"]), encoding="utf-8")
        (Path(tmp) / "outside.txt").write_text("keep me")
        assert export(ws, "claude")["removed"] == [".claude/agents/aria-retired.md"]
        assert (ws / "README.md").is_file() and (Path(tmp) / "outside.txt").is_file()


def test_install_check_catches_a_bad_launcher_and_a_crashing_guard() -> None:
    """check.py passes a fresh install, names the first-run steps, and fails when the hooks' Python launcher does not start or a guard
    crashes on a harmless read."""
    with tempfile.TemporaryDirectory() as tmp:
        ws = exported_workspace(tmp)
        checker = EXTENSION / "runtime" / "tools" / "adapters" / "check.py"

        def run(*args: str) -> Json:
            return json.loads(subprocess.run([sys.executable, str(checker), *args], capture_output=True, text=True, check=True).stdout)

        for client in ("claude", "cursor", "codex"):
            report = run(client, str(ws))
            assert report["ok"] and [c["name"] for c in report["checks"]] == ["python", "runtime", "hook run"], report
        assert any("claude --agent aria-lite" in step for step in run("claude", str(ws))["next"])
        missing = run("cursor", str(ws), "--python", "no-such-python-launcher")
        assert not missing["ok"] and missing["checks"][0]["name"] == "python" and len(missing["checks"]) == 2, missing
        (ws / ".aria" / "runtime" / "hooks" / "error_guard.py").write_text("raise RuntimeError('guard broke')\n", encoding="utf-8")
        crashed = run("claude", str(ws))
        assert not crashed["ok"] and "guard broke" in crashed["checks"][-1]["detail"], crashed


def test_codex_user_scope_is_removed_not_installed() -> None:
    """Codex installs per project only, because VS Code and Copilot also read ~/.agents/skills; --remove deletes the agents, harness skills
    and hook file an older user-scope Codex export left there, and keeps the shared runtime and the user's own skills."""
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / "home"
        env = os.environ | {"HOME": str(home), "USERPROFILE": str(home)}
        skills = home / ".agents" / "skills"
        (skills / "hve-creator").mkdir(parents=True)
        (skills / "hve-creator" / "SKILL.md").write_text('---\nname: "hve-creator"\n---\nbody\n', encoding="utf-8")
        shutil.copytree(EXTENSION / "skills" / "delivery-coach", skills / "delivery-coach")
        (skills / "my-skill").mkdir()
        (skills / "my-skill" / "SKILL.md").write_text("---\nname: my-skill\n---\n", encoding="utf-8")
        (home / ".codex").mkdir()
        (home / ".codex" / "hooks.json").write_text('{"hooks": {"Stop": [{"command": "python agent_compat.py"}]}}', encoding="utf-8")
        (home / ".aria" / "runtime" / "hooks").mkdir(parents=True)
        (home / ".aria" / "runtime" / "hooks" / "agent_compat.py").write_text("", encoding="utf-8")
        refused = subprocess.run([sys.executable, str(EXPORT), "codex", "--user"], capture_output=True, text=True, env=env)
        assert refused.returncode != 0 and "has no user scope" in refused.stderr, refused.stderr
        removed = subprocess.run([sys.executable, str(EXPORT), "codex", "--user", "--remove"], capture_output=True, text=True, env=env)
        assert removed.returncode == 0, removed.stderr
        report = json.loads(removed.stdout)
        assert set(report["removed"]) == {".agents/skills/hve-creator", ".agents/skills/delivery-coach", ".codex/hooks.json"}, report
        assert report["written"] == [] and (skills / "my-skill" / "SKILL.md").is_file()
        assert (home / ".aria" / "runtime" / "hooks" / "agent_compat.py").is_file()


def test_claude_code_hooks() -> None:
    """Claude Code payloads: profile context, skill loadout, guards, module size, ticked check, victory check and escalation stop."""
    with tempfile.TemporaryDirectory() as tmp:
        ws = exported_workspace(tmp)
        base = {"session_id": "c1", "cwd": str(ws), "transcript_path": "t", "permission_mode": "default"}
        start = fire(ws, "claude", base | {"hook_event_name": "SessionStart", "source": "startup"})
        assert any("Delivery" in o["hookSpecificOutput"]["additionalContext"] for o in start), start
        fire(ws, "claude", base | {"hook_event_name": "UserPromptSubmit", "prompt": "Design an accessible signup page UI with clear forms"})
        assert json.loads((ws / ".aria" / "runs" / "c1.skills.json").read_text())["skills"]
        read = {"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": str(ws / "README.md")}, "tool_use_id": "t1"}
        notice = fire(ws, "claude", base | read)
        assert any(".aria/skills/" in o["hookSpecificOutput"].get("additionalContext", "") for o in notice), notice
        start_loop(ws)
        write = {"hook_event_name": "PreToolUse", "tool_name": "Write", "tool_use_id": "t2",
                 "tool_input": {"file_path": str(ws / "feature_list.json"), "content": "[]"}}
        denied = fire(ws, "claude", base | write)
        assert denied[0]["hookSpecificOutput"]["permissionDecision"] == "deny" and "loop scripts" in json.dumps(denied), denied
        guard_mode(ws / ".aria" / "runtime", "advise")
        advised = fire(ws, "claude", base | write)
        assert any(o.get("systemMessage", "").startswith("Advisory alert (experimental)") for o in advised), advised
        assert not any(o.get("hookSpecificOutput", {}).get("permissionDecision") == "deny" for o in advised), advised
        guard_mode(ws / ".aria" / "runtime", "enforce")
        push = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "t3", "tool_input": {"command": "git push -f origin main"}}
        confirm = fire(ws, "claude", base | push)[0]["hookSpecificOutput"]
        assert confirm["permissionDecision"] == "ask" and "force push" in confirm["permissionDecisionReason"], confirm
        (ws / "big.py").write_text("x = 1\n" * 600)
        post = {"hook_event_name": "PostToolUse", "tool_name": "Write", "tool_use_id": "t4", "tool_input": {"file_path": str(ws / "big.py")},
                "tool_response": {"filePath": str(ws / "big.py"), "type": "create"}}
        assert any(o.get("decision") == "block" and "big.py (600 lines)" in o["reason"] for o in fire(ws, "claude", base | post))
        question = {"question": "Does login work? [project: .]", "header": "check:login", "multiSelect": False,
                    "options": [{"label": "looks right"}, {"label": "needs changes"}]}
        ask = {"hook_event_name": "PostToolUse", "tool_name": "AskUserQuestion", "tool_use_id": "t5", "tool_input": {"questions": [question]},
               "tool_response": {"questions": [question], "answers": {question["question"]: "looks right"}}}
        fire(ws, "claude", base | ask)
        assert json.loads((ws / ".harness" / "checks" / "login.json").read_text())["result"] == "looks right"
        stop = fire(ws, "claude", base | {"hook_event_name": "Stop", "stop_hook_active": False, "last_assistant_message": "done"})
        assert stop[0]["decision"] == "block" and "login" in stop[0]["reason"] and "hookSpecificOutput" not in stop[0], stop
        start_loop(ws, escalated=True)
        halted = fire(ws, "claude", base | push | {"tool_input": {"command": "ls"}})
        assert halted[0]["continue"] is False and "Which database?" in halted[0]["stopReason"], halted


def test_cursor_hooks() -> None:
    """Cursor native payloads get Cursor native answers: deny with messages, additional_context and followup_message."""
    with tempfile.TemporaryDirectory() as tmp:
        ws = exported_workspace(tmp)
        base = {"conversation_id": "u1", "generation_id": "g1", "model": "m", "cursor_version": "2.4", "workspace_roots": [str(ws)]}
        start = fire(ws, "cursor", base | {"hook_event_name": "sessionStart", "session_id": "u1", "composer_mode": "agent"})
        assert any("Delivery" in output.get("additional_context", "") for output in start), start
        prompt = fire(ws, "cursor", base | {"hook_event_name": "beforeSubmitPrompt", "prompt": "Build a login form", "attachments": []})
        assert prompt == [{"continue": True}] * len(prompt), prompt
        start_loop(ws)
        write = {"hook_event_name": "preToolUse", "tool_name": "Write", "tool_use_id": "t1", "cwd": str(ws),
                 "tool_input": {"file_path": str(ws / "progress.txt"), "content": "done"}}
        denied = fire(ws, "cursor", base | write)
        assert denied[0]["permission"] == "deny" and "loop scripts" in denied[0]["agent_message"], denied
        harmless = fire(ws, "cursor", base | write | {"tool_name": "Read", "tool_input": {"file_path": str(ws / "app.py")}})
        assert all(o.get("permission") != "deny" for o in harmless), harmless
        push = fire(ws, "cursor", base | write | {"tool_name": "Shell", "tool_input": {"command": "git push origin feature/login"}})
        assert any(o.get("permission") == "ask" and "Push check" in o["user_message"] for o in push), push
        (ws / "big.py").write_text("x = 1\n" * 600)
        post = {"hook_event_name": "postToolUse", "tool_name": "Write", "tool_use_id": "t2", "cwd": str(ws), "duration": 5,
                "tool_input": {"file_path": str(ws / "big.py")}, "tool_output": "{}"}
        assert any("big.py (600 lines)" in o.get("additional_context", "") for o in fire(ws, "cursor", base | post))
        stop = fire(ws, "cursor", base | {"hook_event_name": "stop", "status": "completed", "loop_count": 0})
        assert "login" in stop[0]["followup_message"], stop
        assert fire(ws, "cursor", base | {"hook_event_name": "stop", "status": "completed", "loop_count": 1}) == []


def test_exported_template_stop_gate() -> None:
    """All adapters convey missing deliverables; Cursor reentry stays bounded."""
    with tempfile.TemporaryDirectory() as tmp:
        ws = exported_workspace(tmp)
        for client in ("claude", "cursor", "codex"):
            base = {"session_id": "templates", "conversation_id": "templates", "cwd": str(ws)}
            prompt_event = "beforeSubmitPrompt" if client == "cursor" else "UserPromptSubmit"
            fire(ws, client, base | {"hook_event_name": prompt_event, "prompt": "Create a PRD"})
            stop_event = "stop" if client == "cursor" else "Stop"
            blocked = fire(ws, client, base | {"hook_event_name": stop_event, "stop_hook_active": False, "loop_count": 0})
            message = "followup_message" if client == "cursor" else "reason"
            assert any("no initialized prd" in output.get(message, "") for output in blocked), (client, blocked)
            if client == "cursor":
                assert any("report" in output.get(message, "") for output in blocked)
                assert fire(ws, client, base | {"hook_event_name": "stop", "loop_count": 1}) == []


def test_codex_hooks() -> None:
    """Codex payloads: apply_patch guarded, no unsupported continue on PreToolUse, Stop always answers JSON."""
    with tempfile.TemporaryDirectory() as tmp:
        ws = exported_workspace(tmp)
        base = {"session_id": "x1", "cwd": str(ws), "transcript_path": None, "model": "gpt", "turn_id": "r1", "permission_mode": "default"}
        fire(ws, "codex", base | {"hook_event_name": "UserPromptSubmit", "prompt": "Fix the login check"})
        start_loop(ws, passes=True)
        assert fire(ws, "codex", base | {"hook_event_name": "Stop", "stop_hook_active": False, "last_assistant_message": None}) == [{}, {}]
        start_loop(ws, escalated=True)
        patch = "*** Begin Patch\n*** Update File: progress.txt\n@@\n-a\n+b\n*** End Patch\n"
        denied = fire(ws, "codex", base | {"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "tool_use_id": "t1",
                                           "tool_input": {"command": patch}})
        guard = next(o for o in denied if o.get("hookSpecificOutput", {}).get("permissionDecision") == "deny")
        assert "Which database?" in guard["hookSpecificOutput"]["permissionDecisionReason"] and "continue" not in guard, denied
        start_loop(ws)
        pushed = fire(ws, "codex", base | {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "t2",
                                           "tool_input": {"command": "git push origin feature/login"}})
        warning = next(o for o in pushed if "Push check" in o.get("systemMessage", ""))
        assert "permissionDecision" not in warning["hookSpecificOutput"] and "Push check" in warning["hookSpecificOutput"]["additionalContext"], pushed
        stop = fire(ws, "codex", base | {"hook_event_name": "Stop", "stop_hook_active": False, "last_assistant_message": "done"})
        blocking = next(output for output in stop if output.get("decision") == "block")
        assert "login" in blocking["reason"], stop
        sub = fire(ws, "codex", base | {"hook_event_name": "SubagentStart", "agent_id": "a1", "agent_type": "default"})
        assert sub and "additionalContext" in sub[0]["hookSpecificOutput"], sub


def fire_copilot(hooks: Json, ws: Path, payload: Json, env: dict[str, str]) -> list[Json]:
    """Run every Copilot hook command for the payload's event from the workspace; return the non-empty outputs."""
    outputs = []
    for entry in hooks["hooks"][payload["hook_event_name"]]:
        result = subprocess.run(entry["command"], shell=True, cwd=ws, input=json.dumps(payload), capture_output=True, text=True, env=env)
        assert result.returncode == 0, (entry["command"], result.stderr)
        outputs += [json.loads(result.stdout)] if result.stdout.strip() else []
    return outputs


def test_copilot_user_scope_and_cloud_exports() -> None:
    """Copilot gets every HVE agent at user scope without Local-only fields, and hooks that act only while an ask is open; the
    cloud agent gets a committed runtime and python3 hooks; scopes a client lacks are refused."""
    subprocess.run([sys.executable, str(EXTENSION / "build.py")], check=True, capture_output=True)
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp) / "home"
        home.mkdir()
        env = os.environ | {"HOME": str(home), "USERPROFILE": str(home)}
        result = subprocess.run([sys.executable, str(EXPORT), "copilot", "--user"], capture_output=True, text=True, env=env)
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["scope"] == "user"
        guard_mode(home / ".aria" / "runtime", "enforce")
        agents = home / ".copilot" / "agents"
        assert {p.name.removesuffix(".agent.md") for p in agents.glob("*.agent.md")} == EXPORTED_AGENTS
        creator = (agents / "aria-lite.agent.md").read_text(encoding="utf-8")
        front = creator.split("---\n")[1]
        assert "hooks:" not in front and "{{RUNTIME}}" not in creator and "tools:" not in front, front
        assert f"{(home / '.aria' / 'runtime').as_posix()}/tools/loop/lifecycle.py" in creator
        assert 'tools: ["read", "search"]' in (agents / "aria-evaluation-reviewer.agent.md").read_text(encoding="utf-8")
        assert "handoffs" not in (agents / "aria-product-manager.agent.md").read_text(encoding="utf-8").split("---\n")[1]
        hooks = json.loads((home / ".copilot" / "hooks" / "aria.json").read_text(encoding="utf-8"))
        commands = [h["command"] for entries in hooks["hooks"].values() for h in entries]
        assert hooks["version"] == 1 and "SubagentStart" in hooks["hooks"] and all("--ask-only copilot" in c for c in commands), commands
        ws = Path(tmp) / "ws"
        ws.mkdir()
        start_loop(ws)
        write = {"hook_event_name": "PreToolUse", "session_id": "p1", "timestamp": "2026-10-19T08:00:00Z", "cwd": str(ws),
                 "tool_name": "Write", "tool_input": {"file_path": str(ws / "feature_list.json"), "content": "[]"}}
        assert fire_copilot(hooks, ws, write, env) == [], "no open ask: the user-level hooks stay out of the way"
        assert not (ws / ".aria" / "runs" / "client.json").exists(), "no open ask: nothing records the tool"
        (ws / "req.md").write_text("Build a login page", encoding="utf-8")
        lifecycle = home / ".aria" / "runtime" / "tools" / "loop" / "lifecycle.py"
        made = subprocess.run([sys.executable, str(lifecycle), "contract", "direct", "login", "ARIA Lite", "req.md"], cwd=ws,
                              capture_output=True, text=True, env=env)
        assert made.returncode == 0, made.stderr
        paths = json.loads(made.stdout)["paths"]
        start_loop(ws, in_ask=True)
        write["tool_input"]["file_path"] = str(ws / paths["feature_list"])  # type: ignore[index]
        denied = fire_copilot(hooks, ws, write, env)
        assert any(o.get("permissionDecision") == "deny" and "loop scripts" in o["permissionDecisionReason"] for o in denied), denied
        recorded = json.loads((ws / ".aria" / "runs" / "client.json").read_text(encoding="utf-8"))
        assert (recorded["client"], recorded["session"]) == ("copilot", "p1"), recorded
        assert (ws / ".aria" / "runs" / "p1.skills.json").is_file(), "the loadout comes from the ask when the prompt hook did not run"
        stop = {"hook_event_name": "Stop", "session_id": "p1", "timestamp": "2026-10-19T08:01:00Z", "cwd": str(ws),
                "transcript_path": "t", "stop_reason": "end_turn", "stop_hook_active": False}
        assert any(o.get("decision") == "block" and "login" in o["reason"] for o in fire_copilot(hooks, ws, stop, env))
        sub = fire_copilot(hooks, ws, {"hook_event_name": "SubagentStart", "session_id": "p1", "cwd": str(ws), "agent_id": "a",
                                       "agent_type": "task"}, env)
        assert any("SKILLS-USED" in o.get("additionalContext", "") for o in sub), sub
        read_only = {"hook_event_name": "PreToolUse", "session_id": "p1", "timestamp": "2026-10-19T08:02:00Z", "cwd": str(ws), "tool_name": "bash",
                     "tool_input": json.dumps({"command": "gh pr view 54 --json state,url && git status --short --branch"})}
        assert fire_copilot(hooks, ws, read_only, env) == [], "arguments sent as JSON text are read as the object they encode"
        errors = ws / ".aria" / "runs" / "hook-errors.log"
        assert not errors.exists(), errors.read_text(encoding="utf-8")
        (home / ".aria" / "runtime" / "hooks" / "loop_guard.py").write_text("raise RuntimeError('guard broke')\n", encoding="utf-8")
        assert fire_copilot(hooks, ws, write, env) == [{}], "a crashing guard is skipped (an empty answer allows), never turned into a deny"
        assert "RuntimeError: guard broke" in errors.read_text(encoding="utf-8")
        alert = json.loads((ws / ".aria" / "runs" / "p1.interventions.jsonl").read_text(encoding="utf-8").splitlines()[-1])
        assert (alert["hook"], alert["kind"]) == ("loop_guard", "hook_error") and "Nothing was blocked" in alert["detail"], alert
        cloud = Path(tmp) / "repo"
        cloud.mkdir()
        (cloud / ".gitignore").write_text("node_modules/\n.aria/\n", encoding="utf-8")
        report = export(cloud, "cloud")
        assert (cloud / ".github" / "aria" / "runtime" / "hooks" / "agent_compat.py").is_file() and report["scope"] == "project"
        setup = (cloud / ".github" / "workflows" / "copilot-setup-steps.yml").read_text(encoding="utf-8")
        assert "  copilot-setup-steps:" in setup and "actions/setup-python" in setup and ".github/aria/runtime/hooks/agent_compat.py" in setup
        assert (cloud / ".gitignore").read_text(encoding="utf-8").splitlines() == ["node_modules/", ".aria/*", "!.aria/asks/", "!.aria/project/"]
        subprocess.run(["git", "init", "-q"], cwd=cloud, check=True)
        ignored = subprocess.run(["git", "check-ignore", ".aria/asks/login/contract.json", ".aria/project/journal.jsonl", ".aria/runs/p1.jsonl"],
                                 cwd=cloud, capture_output=True, text=True)
        assert ignored.stdout.split() == [".aria/runs/p1.jsonl"], "ask and project records are committed; hook run state is not"
        assert {".github/workflows/copilot-setup-steps.yml", ".gitignore"} <= set(report["written"]), report["written"]
        assert export(cloud, "cloud")["written"] == report["written"], "running the cloud export again is safe"
        (cloud / ".github" / "workflows" / "copilot-setup-steps.yml").write_text("name: mine\n", encoding="utf-8")
        mine = subprocess.run([sys.executable, str(EXPORT), "cloud", str(cloud)], capture_output=True, text=True, env=env)
        assert mine.returncode != 0 and "not written by ARIA" in mine.stderr, "a setup workflow the user wrote is never overwritten"
        assert ".github/aria/runtime/tools/loop/lifecycle.py" in (cloud / ".github" / "agents" / "aria-lite.agent.md").read_text(encoding="utf-8")
        cloud_hooks = json.loads((cloud / ".github" / "hooks" / "aria.json").read_text(encoding="utf-8"))
        assert all(h["bash"].startswith('python3 ".github/aria/runtime/hooks/agent_compat.py" --ask-only copilot') and h["powershell"] == "exit 0"
                   and "command" not in h for entries in cloud_hooks["hooks"].values() for h in entries), cloud_hooks
        for args, needle in ((["cloud", "--user"], "has no user scope"), (["copilot", str(cloud)], "user scope only")):
            refused = subprocess.run([sys.executable, str(EXPORT), *args], capture_output=True, text=True, env=env)
            assert refused.returncode != 0 and needle in refused.stderr, refused.stderr


def test_wiki_is_shipped_and_linked() -> None:
    """The adapter guide ships in the runtime where the skill, agent and export report point, and wiki links resolve."""
    for page in (REPO / "docs" / "wiki").glob("*.md"):
        for link in re.findall(r"\]\(([^)#:]+)\)", page.read_text(encoding="utf-8")):
            assert (page.parent / link).is_file(), (page.name, link)
    skill = (REPO / "plugins" / "harness-assist" / "skills" / "export-harness" / "SKILL.md").read_text(encoding="utf-8")
    agent = (EXTENSION / "agents" / "azure-devops.agent.md").read_text(encoding="utf-8")
    assert "<tools>/../docs/wiki/Adapters.md" in skill and "{{RUNTIME}}/docs/wiki/Adapters.md" in agent
    with tempfile.TemporaryDirectory() as tmp:
        ws = exported_workspace(tmp)
        report = export(ws, "claude")
        assert (ws / report["guide"]).is_file() and (ws / ".aria" / "runtime" / "tools" / ".." / "docs" / "wiki" / "Adapters.md").is_file()
        assert ".aria/runtime/docs/wiki/Adapters.md" in (ws / ".claude" / "agents" / "aria-azure-devops.md").read_text(encoding="utf-8")
        assert Path(export(ws, "vscode", "--ado", "contoso")["guide"]).is_file()


def test_copilot_post_tool_use_payload_shapes() -> None:
    """A Copilot PostToolUse maps Copilot CLI's tool_result and the VS Code harness's tool_response (the same hook file runs in both),
    and any other shape fails naming its fields instead of a bare KeyError."""
    sys.path.insert(0, str(REPO / "hooks"))
    import agent_compat
    base = {"hook_event_name": "PostToolUse", "session_id": "s1", "timestamp": "2026-11-09T10:00:00Z", "cwd": ".", "tool_name": "bash",
            "tool_input": {"command": "ls"}}
    cli = agent_compat.to_vscode(base | {"tool_result": {"result_type": "success", "text_result_for_llm": "a.txt"}}, "copilot")
    assert (cli["tool_response"], cli["tool_name"], cli["tool_use_id"]) == ("a.txt", "bash", "copilot-2026-11-09T10:00:00Z"), cli
    assert agent_compat.to_vscode(base | {"tool_response": "b.txt"}, "copilot")["tool_response"] == "b.txt"
    try:
        agent_compat.to_vscode(base, "copilot")
    except ValueError as error:
        assert "neither tool_result nor tool_response" in str(error) and "tool_input" in str(error), error
    else:
        raise AssertionError("a PostToolUse without a result must fail with a clear message")


def test_copilot_apply_patch_text_becomes_vscode_input() -> None:
    """Copilot CLI's freeform apply_patch text maps to VS Code's {'input': patch} shape, and every added, updated, deleted and moved
    path in it is found."""
    sys.path.insert(0, str(REPO / "hooks"))
    import agent_compat
    from module_guard import edited_paths
    patch = ("*** Begin Patch\n*** Add File: a.py\n+x\n*** Update File: b.md\n*** Move to: docs/b.md\n@@\n-a\n+b\n"
             "*** Delete File: c.txt\n*** End Patch\n")
    out = agent_compat.to_vscode({"hook_event_name": "PreToolUse", "session_id": "s1", "timestamp": "2026-11-09T10:00:00Z", "cwd": ".",
                                  "tool_name": "apply_patch", "tool_input": patch}, "copilot")
    assert out["tool_input"] == {"input": patch}, out
    assert edited_paths(out["tool_input"]) == ["a.py", "b.md", "docs/b.md", "c.txt"]


def test_plugin_agent_hooks_answer_the_local_and_copilot_harness() -> None:
    """VS Code also runs a plugin agent's own hooks in its Copilot harness, with Copilot's payload (no tool call id, arguments as JSON
    text): the rendered hooks allow a harmless read there instead of crashing (which Copilot turns into a deny of every tool), and deny a
    locked file in each harness's own format."""
    subprocess.run([sys.executable, str(EXTENSION / "build.py")], check=True, capture_output=True)
    with tempfile.TemporaryDirectory() as tmp:
        extension = Path(tmp) / "extension"
        for part in ("agents", "skills", "runtime"):
            shutil.copytree(EXTENSION / part, extension / part)
        guard_mode(extension / "runtime", "enforce")
        plugin = Path(tmp) / "plugin"
        script = (f"require({json.dumps(str(EXTENSION / 'render.js'))}).renderPlugin({json.dumps(str(extension))}, "
                  f"{json.dumps(str(plugin))}, '0.0.0-test', 'python')")
        subprocess.run(["node", "-e", script], check=True, capture_output=True)
        front = (plugin / "com.github.copilot" / "agents" / "lite.agent.md").read_text(encoding="utf-8").split("---\n")[1]
        commands: dict[str, list[str]] = {}
        for line in front.splitlines():
            if match := re.match(r"^  (\w+):$", line):
                event = match[1]
                commands[event] = []
            elif match := re.match(r"^ {6}command: '(.+)'$", line):
                commands[event].append(match[1])
        assert all("agent_compat.py\" vscode " in c for cs in commands.values() for c in cs), commands
        ws = Path(tmp) / "ws"
        (ws / ".aria" / "runs").mkdir(parents=True)
        start_loop(ws)
        env = os.environ | {"HARNESS_PROJECT": ".", "HARNESS_STOP_POLICY": "once", "HARNESS_SKILLS_MIN_STATUS": "provisional"}

        def fire_plugin(payload: Json) -> list[Json]:
            outputs = []
            for command in commands[payload["hook_event_name"]]:
                result = subprocess.run(command, shell=True, cwd=ws, input=json.dumps(payload), capture_output=True, text=True, env=env)
                assert result.returncode == 0, (command, result.stderr)
                outputs += [json.loads(result.stdout)] if result.stdout.strip() else []
            return outputs

        copilot = {"hook_event_name": "PreToolUse", "session_id": "p1", "timestamp": "2026-11-10T10:00:00Z", "cwd": str(ws)}
        fire_plugin(copilot | {"hook_event_name": "UserPromptSubmit", "prompt": "Build a login page"})
        read = fire_plugin(copilot | {"tool_name": "view", "tool_input": json.dumps({"path": str(ws / "README.md")})})
        assert not any("deny" in json.dumps(o) for o in read), read
        errors = ws / ".aria" / "runs" / "hook-errors.log"
        assert not errors.exists(), errors.read_text(encoding="utf-8")
        write = {"tool_name": "Write", "tool_input": {"file_path": str(ws / "feature_list.json"), "content": "[]"}}
        denied = fire_plugin(copilot | write)
        assert any(o.get("permissionDecision") == "deny" and "hookSpecificOutput" not in o for o in denied), denied
        local = {"hook_event_name": "PreToolUse", "session_id": "l1", "timestamp": "2026-11-10T10:01:00Z", "cwd": str(ws),
                 "tool_name": "create_file", "tool_input": {"filePath": str(ws / "feature_list.json"), "content": "[]"}, "tool_use_id": "t1"}
        fire_plugin({"hook_event_name": "UserPromptSubmit", "session_id": "l1", "timestamp": "2026-11-10T10:01:00Z", "cwd": str(ws),
                     "prompt": "Build a login page"})
        denied = fire_plugin(local)
        assert any(o.get("hookSpecificOutput", {}).get("permissionDecision") == "deny" and "permissionDecision" not in o for o in denied), denied
        stop = fire_plugin({"hook_event_name": "Stop", "session_id": "l1", "timestamp": "2026-11-10T10:02:00Z", "cwd": str(ws),
                            "stop_hook_active": False})
        assert any(o.get("decision") == "block" and o["hookSpecificOutput"]["decision"] == "block" for o in stop), stop
        assert not errors.exists(), errors.read_text(encoding="utf-8")
        assert not (ws / ".aria" / "runs" / "client.json").exists(), "VS Code's own harnesses are not another tool"
        checker = extension / "runtime" / "tools" / "adapters" / "check.py"
        checked = subprocess.run([sys.executable, str(checker), "copilot", "--plugin", str(plugin)], capture_output=True, text=True)
        report = json.loads(checked.stdout)
        assert report["ok"] and [c["name"] for c in report["checks"]] == ["python", "plugin", "hook run"], report
        assert any(f'copilot --plugin-dir "{plugin.resolve().as_posix()}"' in step for step in report["next"]), report["next"]


if __name__ == "__main__":
    test_export_structure()
    test_export_refuses_foreign_files_and_bad_organizations()
    test_reexport_removes_stale_and_pre_brand_copies()
    test_codex_user_scope_is_removed_not_installed()
    test_install_check_catches_a_bad_launcher_and_a_crashing_guard()
    test_claude_code_hooks()
    test_cursor_hooks()
    test_exported_template_stop_gate()
    test_codex_hooks()
    test_copilot_user_scope_and_cloud_exports()
    test_wiki_is_shipped_and_linked()
    test_plugin_agent_hooks_answer_the_local_and_copilot_harness()
    print("test_adapters: OK")
