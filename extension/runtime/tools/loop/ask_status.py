"""Text status of the workspace's asks for tools without Mission Control: the open ask, its stages, what waits for the user, the latest
journal entries and guard events, and hook errors."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lifecycle import WORKSPACE, active  # noqa: E402
from ask_plan import unfinished  # noqa: E402
from loop_paths import STATE, project_folder  # noqa: E402

SHOWN = 5


def tail_jsonl(paths: list[Path], key: str) -> list[dict[str, object]]:
    """Return the last rows across JSON-lines files, newest first, ordered by key."""
    rows = [json.loads(line) for p in paths for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
    return sorted(rows, key=lambda r: r[key], reverse=True)[:SHOWN]  # type: ignore[arg-type,return-value]


def status(workspace: Path = WORKSPACE) -> str:
    """Return the workspace's status as Markdown: the open ask or the recent asks, stages, open items, journal, guard events, hook errors."""
    state = workspace / STATE
    lines = []
    if (state / "asks" / "active.json").is_file():
        path, data = active(workspace)
        request = data["request"].strip().splitlines()[0][:120]
        lines += [f"**Open ask** `{data['ask']}` ({data['agent']}): {request}", f"**Current stage:** {data['current'] or 'none'}",
                  "**Stages:** " + ", ".join(f"{s['name']} [{s['status']}]" for s in data["stages"])]
        waiting = unfinished(data)
        lines.append("**Not finished:** " + ("; ".join(waiting) if waiting else "nothing; the ask can be closed"))
        plan = path.parent / "plan.md"
        lines.append(f"**Files:** `{path.relative_to(workspace).as_posix()}`" + (f", `{plan.relative_to(workspace).as_posix()}`" if plan.is_file() else ""))
    else:
        asks = sorted((state / "asks").glob("*/contract.json"), reverse=True)[:SHOWN] if (state / "asks").is_dir() else []
        lines.append("**No ask is open.**" + (" Recent asks:" if asks else " No ask has run in this workspace."))
        for contract in asks:
            data = json.loads(contract.read_text(encoding="utf-8"))
            lines.append(f"- `{data['ask']}` ({data['agent']}): stage {data['current'] or 'none'}")
    journal = project_folder(workspace) / "journal.jsonl"
    entries = tail_jsonl([journal] if journal.is_file() else [], "ts")
    if entries:
        lines.append("**Journal (newest first):**")
        lines += [f"- {e['ts']} {e['kind']}: {e['text']}" for e in entries]
    events = tail_jsonl(sorted((state / "runs").glob("*.interventions.jsonl")) if (state / "runs").is_dir() else [], "ts_ms")
    if events:
        lines.append("**Guard events (newest first):**")
        lines += [f"- {e['hook']} {e['kind']}: {e['detail']}" for e in events]
    errors = state / "runs" / "hook-errors.log"
    if errors.is_file():
        count = sum(line.startswith("--- ") for line in errors.read_text(encoding="utf-8").splitlines())
        lines.append(f"**Hook errors:** {count} in `{errors.relative_to(workspace).as_posix()}` (nothing was blocked)")
    return "\n".join(lines)
