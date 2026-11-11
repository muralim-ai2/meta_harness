"""Sub-agent compaction brief, PreCompact tracking, and one-time post-compaction working-set re-hydration."""

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from brand import BRAND

STATE = BRAND["state_dir"]
SESSION_ID = re.compile(r"^[\w-]+$")
FRONT_DESC = re.compile(r"^description:\s*>?-?\s*\n?\s*(.+)$", re.M)
SUBAGENT_CONTEXT = ("Return only what the parent agent needs, under 2,000 tokens: findings, decisions, file paths with line ranges, "
                    "and command exit codes. Summarize tool output; never paste it raw. "
                    "Work in exactly one role (frontend, backend, data, or infra), the one your task names; if the task spans "
                    "several roles, do only your role's part and name the rest in your reply.")


def compact_file(workspace: Path, session_id: str) -> Path:
    """Return the session's compaction marker path after validating the session id."""
    if not SESSION_ID.match(session_id):
        raise ValueError(f"unsafe session_id {session_id!r}")
    return workspace / STATE / "runs" / f"{session_id}.compact.json"


def skill_desc(workspace: Path, entry: dict[str, Any], rel_path: str) -> str:
    """Return a short one-line description for a skill from its contract row or SKILL.md frontmatter."""
    raw = str(entry.get("description") or "").strip()
    if not raw and (workspace / rel_path).is_file():
        head = (workspace / rel_path).read_text(encoding="utf-8")[:800]
        match = FRONT_DESC.search(head)
        raw = match[1].strip() if match else ""
    line = " ".join(raw.split())
    return line if len(line) <= 140 else line[:137] + "..."


def ask_context(workspace: Path) -> str:
    """Return the active ask's candidate skills (with descriptions to skim) and the SKILLS-USED reply rule, or nothing when no ask is active."""
    active = workspace / STATE / "asks" / "active.json"
    if not active.is_file():
        return ""
    slug = json.loads(active.read_text(encoding="utf-8"))["active"]
    contract = json.loads((active.parent / slug / "contract.json").read_text(encoding="utf-8"))
    items = []
    for row in contract["skills"]["selected"]:
        rel = f"{STATE}/skills/{row['name'].replace(':', '__')}/SKILL.md"
        desc = skill_desc(workspace, row, rel)
        items.append(f"{row['name']}: {desc} ({rel})" if desc else rel)
    listed = "; ".join(items) or "none"
    return (f" {BRAND['product']} ask {slug} (folder {contract['paths']['ask']}, evidence {contract['paths']['evidence']}; never search the "
            f"workspace for plan.md or feature_list.json): unless your brief lists a reduced skill set, skim these descriptions, skip skills "
            f"outside your task, and read SKILL.md only for the ones you choose ({listed}). "
            "End your reply with one line: SKILLS-USED: <the skills you actually followed, or none>.")


def record_precompact(workspace: Path, session_id: str, trigger: str) -> None:
    """Record that the host compacted this session so the next turn re-hydrates the working set once."""
    path = compact_file(workspace, session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"pending": True, "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "trigger": trigger}),
                    encoding="utf-8")


def map_anchor(workspace: Path) -> str:
    """Return a compact module summary from the workspace or snapshot solution map, or nothing when no map exists."""
    for rel in (Path(STATE) / "map" / "map.json", Path("docs/architecture/solution-map.json")):
        if (workspace / rel).is_file():
            data = json.loads((workspace / rel).read_text(encoding="utf-8"))
            mods = [f"{n['id'].removeprefix('mod:')}: {n.get('purpose', '')}" for n in data.get("nodes", []) if n.get("level") == "module"][:8]
            return (f"Solution map (commit {data.get('commit', 'unknown')}, {STATE}/map/overview.md — never read map.json directly; "
                    f"use `solution_map.py explain|impact|search`): " + "; ".join(mods))
    return ""


def consume_rehydration(workspace: Path, session_id: str) -> str | None:
    """If this session was just compacted, clear the pending flag and return a compact working-set anchor from disk."""
    path = compact_file(workspace, session_id)
    if not path.is_file():
        return None
    state = json.loads(path.read_text(encoding="utf-8"))
    if not state.get("pending"):
        return None
    state["pending"] = False
    path.write_text(json.dumps(state), encoding="utf-8")
    parts = [f"{BRAND['product']} post-compaction anchor (do not re-read unchanged files to rediscover structure):"]
    active = workspace / STATE / "asks" / "active.json"
    if active.is_file():
        slug = json.loads(active.read_text(encoding="utf-8"))["active"]
        contract = json.loads((active.parent / slug / "contract.json").read_text(encoding="utf-8"))
        p = contract["paths"]
        open_stages = [s["name"] for s in contract.get("stages", []) if s.get("status") in ("planned", "active")]
        parts.append(f"Open ask {slug}: current stage {contract.get('current') or 'none'}, open stages {open_stages or 'none'}, "
                     f"plan {p['plan']}, evidence {p['evidence']}, features {p['feature_list']}.")
        fl = workspace / p["feature_list"]
        if fl.is_file():
            failing = [f["name"] for f in json.loads(fl.read_text(encoding="utf-8")) if not f.get("passes")][:8]
            if failing:
                parts.append(f"Remaining features: {', '.join(failing)}.")
    journal = workspace / STATE / "project" / "journal.jsonl"
    if journal.is_file():
        entries = [json.loads(line) for line in journal.read_text(encoding="utf-8").splitlines() if line.strip()][-5:]
        if entries:
            parts.append("Recent journal: " + "; ".join(f"[{e['kind']}] {e['text']}" for e in entries) + ".")
    mapped = map_anchor(workspace)
    if mapped:
        parts.append(mapped)
    return " ".join(parts)


def main() -> None:
    """Handle SubagentStart (return-size cap and candidate skills) and PreCompact (mark session for working-set re-hydration)."""
    payload = json.load(sys.stdin)
    event = payload["hook_event_name"]
    if event == "SubagentStart":
        context = SUBAGENT_CONTEXT + ask_context(Path.cwd())
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "SubagentStart", "additionalContext": context}}))
    elif event == "PreCompact":
        record_precompact(Path.cwd(), str(payload.get("session_id") or "default"), str(payload.get("trigger") or "auto"))
    else:
        raise ValueError(f"compaction.py does not handle hook event {event!r}")


if __name__ == "__main__":
    main()
