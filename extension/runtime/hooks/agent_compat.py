"""Run a harness hook for Copilot, Claude Code, Cursor, Codex or a VS Code plugin agent (Local or Copilot harness): map the client's payload
to the VS Code shape the hooks read, run the hook, map its output back."""

import contextlib
import io
import json
import os
import re
import runpy
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from brand import BRAND

Client = Literal["claude", "cursor", "codex", "copilot", "vscode"]
Json = dict[str, Any]
Spec = tuple[str, dict[str, str], list[str]]

STATE = BRAND["state_dir"]

RUNTIME = Path(__file__).resolve().parents[1]
CLIENTS = ("claude", "cursor", "codex", "copilot", "vscode")
WORKSPACE_MODULES = ("hve_paths", "interventions", "guard_policy", "loop_paths", "lifecycle", "recommend")
_BOUND_PROJECT: Path | None = None
TOOL_NAMES = {"Bash": "run_in_terminal", "PowerShell": "run_in_terminal", "Shell": "run_in_terminal", "exec_command": "run_in_terminal",
              "Write": "create_file", "Edit": "replace_string_in_file", "MultiEdit": "multi_replace_string_in_file", "Read": "read_file",
              "Grep": "grep_search", "Glob": "file_search", "LS": "list_dir", "TodoWrite": "manage_todo_list",
              "AskUserQuestion": "vscode_askQuestions"}
CURSOR_EVENTS = {"sessionStart": "SessionStart", "beforeSubmitPrompt": "UserPromptSubmit", "preToolUse": "PreToolUse",
                 "postToolUse": "PostToolUse", "stop": "Stop"}
PROJECT_DIR_ENV = {"claude": "CLAUDE_PROJECT_DIR", "cursor": "CURSOR_PROJECT_DIR"}
USAGE = ("usage: agent_compat.py [--ask-only] <claude|cursor|codex|copilot|vscode> <script> [KEY=VALUE ...] [-- args] [+ <script> ...]\n"
         f"  --ask-only: do nothing unless the project has an open {BRAND['product']} ask ({STATE}/asks/active.json), for hook files every session runs\n"
         "  vscode: a VS Code plugin agent's own hooks, which run in the Local harness or the Copilot harness")


def ask_answers(tool_input: Json, response: Any) -> Json:
    """Return Claude Code AskUserQuestion answers (question text -> comma-joined labels) keyed by header, as VS Code reports them."""
    answers = (json.loads(response) if isinstance(response, str) else response)["answers"]
    return {"answers": {q["header"]: {"selected": [label.strip() for label in answers[q["question"]].split(",")]}
                        if q["question"] in answers else {"skipped": True} for q in tool_input["questions"]}}


def copilot_response(payload: Json) -> Any:
    """Return a Copilot PostToolUse result: Copilot CLI sends tool_result, VS Code's Copilot harness running the same hook file sends
    tool_response."""
    if "tool_result" in payload:
        return payload["tool_result"]["text_result_for_llm"]
    if "tool_response" in payload:
        return payload["tool_response"]
    raise ValueError(f"Copilot PostToolUse payload has neither tool_result nor tool_response; its fields are {sorted(payload)}")


def tool_input_of(payload: Json) -> Any:
    """Return the tool input in VS Code's shape: JSON text (Copilot CLI passes arguments it did not parse) becomes its object, other text
    (apply_patch's raw patch) becomes {'input': text} as VS Code's own apply_patch sends it, and file_path becomes filePath."""
    tool_input = payload["tool_input"]
    if isinstance(tool_input, str):
        tool_input = json.loads(tool_input) if tool_input.lstrip().startswith("{") else {"input": tool_input}
    if isinstance(tool_input, dict) and "file_path" in tool_input:
        return {k: v for k, v in tool_input.items() if k != "file_path"} | {"filePath": tool_input["file_path"]}
    return tool_input


def to_vscode(payload: Json, client: Client) -> Json:
    """Return the payload with VS Code event names, session id, tool names, file path field and Stop fields."""
    event = CURSOR_EVENTS[payload["hook_event_name"]] if client == "cursor" else payload["hook_event_name"]
    out = payload | {"hook_event_name": event, "session_id": payload["conversation_id"] if client == "cursor" else payload["session_id"]}
    if "tool_name" in payload:
        tool_input = tool_input_of(payload)
        out |= {"tool_name": TOOL_NAMES.get(payload["tool_name"], payload["tool_name"]), "tool_input": tool_input}
        if "tool_use_id" not in out:
            # Clients such as Copilot (and Cursor synthetic/omitted calls) may send no tool_use_id; synthesize a deterministic one.
            out["tool_use_id"] = f"{client}-{payload.get('timestamp') or payload.get('generation_id') or 'call'}"
        if event == "PostToolUse":
            if client == "cursor":
                response = payload["tool_output"]
            elif client in ("copilot", "vscode"):
                response = copilot_response(payload)
            else:
                response = payload["tool_response"]
            out["tool_response"] = ask_answers(tool_input, response) if payload["tool_name"] == "AskUserQuestion" and client == "claude" else response
    if event == "Stop":
        out |= {"timestamp": datetime.now(timezone.utc).isoformat(),
                "stop_hook_active": payload["loop_count"] > 0 if client == "cursor" else payload["stop_hook_active"]}
    return out


def to_cursor(output: Json, event: str) -> Json:
    """Return Cursor's native response for a hook output already in Claude Code form; Cursor has no context channel on prompt submit."""
    specific = output.get("hookSpecificOutput", {})
    if event == "PreToolUse":
        if specific.get("permissionDecision") == "ask":
            reason = specific["permissionDecisionReason"]
            return {"permission": "ask", "user_message": reason, "agent_message": reason}
        if specific.get("permissionDecision") != "deny":
            return {}
        reason = specific["permissionDecisionReason"]
        return {"permission": "deny", "user_message": reason, "agent_message": reason}
    if event == "Stop":
        return {"followup_message": output["reason"]} if output.get("decision") == "block" else {}
    if event in ("PostToolUse", "SessionStart"):
        context = [output["reason"]] if output.get("decision") == "block" else []
        context += [specific["additionalContext"]] if "additionalContext" in specific else []
        return {"additional_context": "\n".join(context)} if context else {}
    return {"continue": True}


def to_copilot(output: Json, event: str) -> Json:
    """Return Copilot's flat hook output: deny with a reason, context where Copilot reads it, or a Stop block."""
    specific = output.get("hookSpecificOutput", {})
    if event == "PreToolUse":
        if specific.get("permissionDecision") in ("deny", "ask"):
            return {"permissionDecision": specific["permissionDecision"], "permissionDecisionReason": specific["permissionDecisionReason"]}
        # Copilot cannot stop the agent from PreToolUse: an escalation stop becomes a deny.
        return {"permissionDecision": "deny", "permissionDecisionReason": output["stopReason"]} if output.get("continue") is False else {}
    if event == "Stop":
        return {"decision": "block", "reason": output["reason"]} if output.get("decision") == "block" else {}
    if event in ("PostToolUse", "SessionStart", "SubagentStart"):
        context = [output["reason"]] if output.get("decision") == "block" else []
        context += [specific["additionalContext"]] if "additionalContext" in specific else []
        return {"additionalContext": "\n".join(context)} if context else {}
    return {}


def from_vscode(output: Json, event: str, client: Client) -> Json:
    """Return a hook's VS Code output in the client's format; an empty dict is no decision."""
    specific = output.get("hookSpecificOutput", {})
    if event == "Stop" and "decision" in specific:
        output = {k: v for k, v in output.items() if k != "hookSpecificOutput"} | {"decision": specific["decision"], "reason": specific["reason"]}
    if client == "codex" and event == "PreToolUse":
        output = {k: v for k, v in output.items() if k not in ("continue", "stopReason")}
        if specific.get("permissionDecision") == "ask":
            # Codex reports "ask" as a failed hook run: surface the confirmation as a warning and model context instead.
            output = {"systemMessage": specific["permissionDecisionReason"],
                      "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": specific["additionalContext"]}}
    if client == "copilot":
        return to_copilot(output, event)
    return to_cursor(output, event) if client == "cursor" else output


def for_vscode(local: Json, copilot: Callable[[], Json], payload: Json) -> Json:
    """Return a plugin agent's hook output for the VS Code harness that sent the payload: Local sends a tool call id and Copilot none, and
    for events without a tool call, which look alike, both shapes together."""
    if "tool_name" in payload:
        return local if "tool_use_id" in payload else copilot()
    return local | copilot()


def warning(message: str, event: str, client: Client) -> Json:
    """Return the client's non-blocking way to show a message for the event, or an empty answer where it has none."""
    if client in ("claude", "codex"):
        context = {"hookSpecificOutput": {"hookEventName": event, "additionalContext": message}} if event in ("PostToolUse", "SessionStart") else {}
        return {"systemMessage": message} | context
    if client == "copilot":
        return {"additionalContext": message} if event in ("PostToolUse", "SessionStart", "SubagentStart") else {}
    if event in ("PostToolUse", "SessionStart"):
        return {"additional_context": message}
    return {} if event in ("PreToolUse", "Stop") else {"continue": True}


def hook_failed(payload: Json, client: Client, script: Path, project: Path, error: str) -> Json:
    """Log a failed hook run with its error, record it for Mission Control, and return a warning that lets the tool call go ahead."""
    event = CURSOR_EVENTS.get(payload.get("hook_event_name", ""), payload.get("hook_event_name", "unknown event"))
    tool = payload.get("tool_name")
    state = project / STATE if (project / STATE).is_dir() else Path.home() / STATE
    log = state / "runs" / "hook-errors.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with log.open("a", encoding="utf-8") as f:
        f.write(f"--- {now} {client} {script.name} {event} {tool or ''}\npayload: {json.dumps(payload)[:4000]}\n{error.strip()}\n")
    last = error.strip().splitlines()[-1] if error.strip() else "no error output"
    where = log.relative_to(project).as_posix() if log.is_relative_to(project) else str(log)
    message = (f"{BRAND['product']} hook {script.name} failed on {tool or event} and was skipped, so nothing was blocked: {last}. Full error: {where}. "
               "Mention it to the user in one line, then continue.")
    session = str(payload.get("session_id") or payload.get("conversation_id") or "")
    if state.parent == project and re.fullmatch(r"[\w-]+", session):
        with (log.parent / f"{session}.interventions.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"ts_ms": time.time() * 1000, "session_id": session, "hook": script.stem, "kind": "hook_error",
                                "detail": f"{last}. Nothing was blocked. Full error: `{where}`", "blindspot": None}) + "\n")
    if client == "vscode":
        return for_vscode(warning(message, event, "claude"), lambda: warning(message, event, "copilot"), payload)
    return warning(message, event, client)


def record_client(project: Path, client: Client, session: str) -> None:
    """Record that this client last ran a hook for the project's open ask, so Mission Control can say where the work happens."""
    runs = project / STATE / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    (runs / "client.json").write_text(json.dumps({"client": client, "session": session,
                                                  "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}), encoding="utf-8")


def parse_specs(tokens: list[str]) -> list[Spec]:
    """Parse one or more '+'-separated hook specs (<script> [KEY=VALUE ...] [-- args]) from CLI arguments."""
    groups: list[list[str]] = [[]]
    for token in tokens:
        if token == "+":
            groups.append([])
        else:
            groups[-1].append(token)
    if not tokens or any(not group for group in groups):
        raise SystemExit(USAGE)
    specs: list[Spec] = []
    for group in groups:
        raw_script, rest = group[0], group[1:]
        split = rest.index("--") if "--" in rest else len(rest)
        if any("=" not in pair for pair in rest[:split]):
            raise SystemExit(USAGE)
        env = {key: value for key, _, value in (pair.partition("=") for pair in rest[:split])}
        specs.append((raw_script, env, rest[split + 1:]))
    return specs


def exec_hook(script: Path, hook_payload: Json, env: dict[str, str], script_args: list[str]) -> Json | None:
    """Execute one hook script in-process with isolated stdin, stdout, stderr, argv and environment, returning its parsed JSON output."""
    old_env, old_argv, old_stdin, old_path = os.environ.copy(), sys.argv[:], sys.stdin, sys.path[:]
    out_buf, err_buf = io.StringIO(), io.StringIO()
    try:
        os.environ.update(env)
        sys.argv = [str(script), *script_args]
        sys.stdin = io.StringIO(json.dumps(hook_payload))
        if str(script.parent) not in sys.path[:1]:
            sys.path.insert(0, str(script.parent))
        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):
            try:
                runpy.run_path(str(script), run_name="__main__")
            except SystemExit as exc:
                if exc.code not in (None, 0):
                    detail = f"{err_buf.getvalue()}{exc.code if isinstance(exc.code, str) else ''}".strip()
                    raise RuntimeError(f"{script.name} exited {exc.code}:\n{detail}") from exc
    finally:
        os.environ.clear()
        os.environ.update(old_env)
        sys.argv[:] = old_argv
        sys.stdin = old_stdin
        sys.path[:] = old_path
    if err_buf.getvalue():
        sys.stderr.write(err_buf.getvalue())
    text = out_buf.getvalue().strip()
    return json.loads(text) if text else None


def merge_vscode(outputs: list[Json], event: str) -> Json:
    """Combine multiple in-process hook outputs in VS Code format so denies beat asks and messages/context concatenate cleanly."""
    if len(outputs) == 1:
        return outputs[0]
    merged: Json = {}
    if any(o.get("continue") is False for o in outputs):
        merged["continue"] = False
        stops = [o["stopReason"] for o in outputs if o.get("continue") is False and o.get("stopReason")]
        if stops:
            merged["stopReason"] = "\n\n".join(dict.fromkeys(stops))
    blocks = [o["reason"] for o in outputs if o.get("decision") == "block" and o.get("reason")]
    if blocks:
        merged["decision"] = "block"
        merged["reason"] = "\n\n".join(dict.fromkeys(blocks))
    messages = [o["systemMessage"] for o in outputs if o.get("systemMessage")]
    if messages:
        merged["systemMessage"] = "\n\n".join(dict.fromkeys(messages))
    specifics = [o["hookSpecificOutput"] for o in outputs if isinstance(o.get("hookSpecificOutput"), dict)]
    spec: Json = {"hookEventName": event}
    stop_blocks = [s["reason"] for s in specifics if s.get("decision") == "block" and s.get("reason")]
    if stop_blocks:
        spec["decision"] = "block"
        spec["reason"] = "\n\n".join(dict.fromkeys(stop_blocks))
    denies = [s["permissionDecisionReason"] for s in specifics if s.get("permissionDecision") == "deny"]
    asks = [s["permissionDecisionReason"] for s in specifics if s.get("permissionDecision") == "ask"]
    if denies:
        spec["permissionDecision"] = "deny"
        spec["permissionDecisionReason"] = "\n\n".join(dict.fromkeys(denies))
    elif asks:
        spec["permissionDecision"] = "ask"
        spec["permissionDecisionReason"] = "\n\n".join(dict.fromkeys(asks))
    contexts = [s["additionalContext"] for s in specifics if s.get("additionalContext")]
    if contexts:
        spec["additionalContext"] = "\n\n".join(dict.fromkeys(contexts))
    if len(spec) > 1:
        merged["hookSpecificOutput"] = spec
    return merged


def bind_workspace(project: Path) -> None:
    """Drop cached workspace-relative modules only when switching workspace directories inside the same Python process."""
    global _BOUND_PROJECT
    resolved = project.resolve()
    if _BOUND_PROJECT != resolved:
        for mod in WORKSPACE_MODULES:
            sys.modules.pop(mod, None)
        _BOUND_PROJECT = resolved


def run(client: Client, specs: list[Spec], payload: Json, project: Path, ask_only: bool) -> Json | None:
    """Run one or more hooks in-process on the translated payload and return the client-formatted output, isolating per-hook crashes."""
    hook_payload = to_vscode(payload, client)
    event = hook_payload["hook_event_name"]
    asking = (project / STATE / "asks" / "active.json").is_file()
    if ask_only and not asking:
        return {} if client == "codex" and event == "Stop" else None
    if asking and client != "vscode":
        record_client(project, client, str(hook_payload["session_id"]))
    outputs: list[Json] = []
    warnings: list[Json] = []
    previous_cwd = Path.cwd()
    os.chdir(project)
    bind_workspace(project)
    try:
        for raw_script, env, script_args in specs:
            script = (RUNTIME / raw_script).resolve()
            try:
                if not script.is_relative_to(RUNTIME) or not script.is_file():
                    raise FileNotFoundError(f"{raw_script} is not a script under {RUNTIME}; re-run the ARIA export to refresh the runtime")
                res = exec_hook(script, hook_payload, env, script_args)
                if res:
                    outputs.append(res)
                if res and res.get("continue") is False:
                    break
            except Exception:  # noqa: BLE001 - a broken guard must be surfaced (logged, recorded, shown), never block the agent
                warnings.append(hook_failed(payload, client, script, project, traceback.format_exc()))
    finally:
        os.chdir(previous_cwd)
    if outputs:
        raw = merge_vscode(outputs, event)
        output = for_vscode(raw, lambda: from_vscode(raw, event, "copilot"), payload) if client == "vscode" else from_vscode(raw, event, client)
        return output if output or warnings or (client == "codex" and event == "Stop") else None
    if warnings:
        return warnings[-1]
    return {} if client == "codex" and event == "Stop" else None


def main() -> None:
    """Translate stdin, run one or more runtime hooks in-process, and print the translated output; failing hooks are logged and skipped."""
    args = sys.argv[1:]
    ask_only = args[:1] == ["--ask-only"]
    args = args[1:] if ask_only else args
    if len(args) < 2 or args[0] not in CLIENTS:
        raise SystemExit(USAGE)
    client: Client = args[0]  # type: ignore[assignment]
    specs = parse_specs(args[1:])
    payload: Json = {}
    project = Path.cwd()
    first_script = (RUNTIME / specs[0][0]).resolve()
    try:
        payload = json.load(sys.stdin)
        # VS Code starts a plugin agent's hooks in the workspace, as the hooks themselves assume.
        project = Path(os.environ[PROJECT_DIR_ENV[client]]) if client in PROJECT_DIR_ENV else Path.cwd() if client == "vscode" \
            else Path(payload["cwd"])
        output = run(client, specs, payload, project, ask_only)
    except Exception:  # noqa: BLE001 - a broken guard must be surfaced (logged, recorded, shown), never block the agent
        output = hook_failed(payload, client, first_script, project, traceback.format_exc())
    if output is not None:
        print(json.dumps(output))


if __name__ == "__main__":
    main()
