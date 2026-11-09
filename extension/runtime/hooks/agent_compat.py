"""Run a harness hook for Copilot, Claude Code, Cursor or Codex: map the client's payload to the VS Code shape the hooks read, run the hook, map its output back."""

import json
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

Client = Literal["claude", "cursor", "codex", "copilot"]
Json = dict[str, Any]

RUNTIME = Path(__file__).resolve().parents[1]
CLIENTS = ("claude", "cursor", "codex", "copilot")
TOOL_NAMES = {"Bash": "run_in_terminal", "PowerShell": "run_in_terminal", "Shell": "run_in_terminal", "exec_command": "run_in_terminal",
              "Write": "create_file", "Edit": "replace_string_in_file", "MultiEdit": "multi_replace_string_in_file", "Read": "read_file",
              "Grep": "grep_search", "Glob": "file_search", "LS": "list_dir", "TodoWrite": "manage_todo_list",
              "AskUserQuestion": "vscode_askQuestions"}
CURSOR_EVENTS = {"sessionStart": "SessionStart", "beforeSubmitPrompt": "UserPromptSubmit", "preToolUse": "PreToolUse",
                 "postToolUse": "PostToolUse", "stop": "Stop"}
PROJECT_DIR_ENV = {"claude": "CLAUDE_PROJECT_DIR", "cursor": "CURSOR_PROJECT_DIR"}
USAGE = ("usage: agent_compat.py [--ask-only] <claude|cursor|codex|copilot> <script under the runtime> [KEY=VALUE ...] [-- script args]\n"
         "  --ask-only: do nothing unless the project has an open Frontier HVE ask (.aria/asks/active.json), for hook files every session runs")


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
        if client == "copilot":
            # Copilot sends no tool call id; the timestamp identifies the call within the session.
            out["tool_use_id"] = f"copilot-{payload['timestamp']}"
        if event == "PostToolUse":
            if client == "cursor":
                response = payload["tool_output"]
            elif client == "copilot":
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
    state = project / ".aria" if (project / ".aria").is_dir() else Path.home() / ".aria"
    log = state / "runs" / "hook-errors.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with log.open("a", encoding="utf-8") as f:
        f.write(f"--- {now} {client} {script.name} {event} {tool or ''}\npayload: {json.dumps(payload)[:4000]}\n{error.strip()}\n")
    last = error.strip().splitlines()[-1] if error.strip() else "no error output"
    where = log.relative_to(project).as_posix() if log.is_relative_to(project) else str(log)
    message = (f"ARIA hook {script.name} failed on {tool or event} and was skipped, so nothing was blocked: {last}. Full error: {where}. "
               "Mention it to the user in one line, then continue.")
    session = str(payload.get("session_id") or payload.get("conversation_id") or "")
    if state.parent == project and re.fullmatch(r"[\w-]+", session):
        with (log.parent / f"{session}.interventions.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"ts_ms": time.time() * 1000, "session_id": session, "hook": script.stem, "kind": "hook_error",
                                "detail": f"{last}. Nothing was blocked. Full error: `{where}`", "blindspot": None}) + "\n")
    return warning(message, event, client)


def run(client: Client, script: Path, payload: Json, project: Path, env: dict[str, str], script_args: list[str], ask_only: bool) -> Json | None:
    """Run the hook on the translated payload and return its output in the client's format, or None when it has nothing to say."""
    hook_payload = to_vscode(payload, client)
    event = hook_payload["hook_event_name"]
    if ask_only and not (project / ".aria" / "asks" / "active.json").is_file():
        return {} if client == "codex" and event == "Stop" else None
    result = subprocess.run([sys.executable, str(script), *script_args], input=json.dumps(hook_payload), capture_output=True,
                            text=True, cwd=project, env=os.environ | env)
    if result.returncode != 0:
        raise RuntimeError(f"{script.name} exited {result.returncode}:\n{result.stderr}")
    sys.stderr.write(result.stderr)
    output = from_vscode(json.loads(result.stdout) if result.stdout.strip() else {}, event, client)
    return output if output or (client == "codex" and event == "Stop") else None


def main() -> None:
    """Translate stdin, run the named runtime hook with the given environment, and print its translated output; a hook that fails is
    logged and skipped, never turned into a block."""
    args = sys.argv[1:]
    ask_only = args[:1] == ["--ask-only"]
    args = args[1:] if ask_only else args
    if len(args) < 2 or args[0] not in CLIENTS:
        raise SystemExit(USAGE)
    client, script, rest = args[0], (RUNTIME / args[1]).resolve(), args[2:]
    split = rest.index("--") if "--" in rest else len(rest)
    env = {key: value for key, _, value in (pair.partition("=") for pair in rest[:split])}
    payload: Json = {}
    project = Path.cwd()
    try:
        payload = json.load(sys.stdin)
        project = Path(os.environ[PROJECT_DIR_ENV[client]]) if client in PROJECT_DIR_ENV else Path(payload["cwd"])
        if not script.is_relative_to(RUNTIME) or not script.is_file():
            raise FileNotFoundError(f"{args[1]} is not a script under {RUNTIME}; re-run the ARIA export to refresh the runtime")
        output = run(client, script, payload, project, env, rest[split + 1:], ask_only)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 - a broken guard must be surfaced (logged, recorded, shown), never block the agent
        output = hook_failed(payload, client, script, project, traceback.format_exc())  # type: ignore[arg-type]
    if output is not None:
        print(json.dumps(output))


if __name__ == "__main__":
    main()
