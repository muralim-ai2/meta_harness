"""Locate the loop files. With an ask open, the product's feature list, progress, tracker and lock live in .aria/project/ (shared by
every ask of the workspace's one project) and each ask keeps its own attempts, evidence, PR records, choices and tool log in
.aria/asks/<ask>/loop/. With no ask open (research runs) everything stays in the project root and .harness/. The project's journal of
decisions, issues and pitfalls is .aria/project/journal.jsonl."""

import json
import re
from datetime import datetime, timezone
from pathlib import Path

LOOP_FILES = ("feature_list.json", "progress.txt", "tracker.json", "feature_list.add.json")
ASK_ID = re.compile(r"^\d{8}-\d{4}-[a-z0-9][a-z0-9-]{0,40}$")
JOURNAL_KINDS = ("decision", "issue", "pitfall")


def ask_folder(project: Path) -> Path | None:
    """Return the open ask's folder under the project, or None when no ask is open there."""
    active = project / ".aria" / "asks" / "active.json"
    if not active.is_file():
        return None
    ask = json.loads(active.read_text(encoding="utf-8"))["active"]
    if not ASK_ID.match(ask):
        raise ValueError(f"{active}: ask id {ask!r} must match {ASK_ID.pattern} (<YYYYMMDD>-<HHMM>-<slug>)")
    return active.parent / ask


def project_folder(project: Path) -> Path:
    """Return the folder holding the project's shared files: project.json, the feature list, progress, tracker and loop lock."""
    return project / ".aria" / "project"


def append_journal(project: Path, ask: str, stage: str | None, kind: str, text: str, why: str) -> dict[str, str | None]:
    """Append a decision, issue or pitfall of an ask to the project's journal and return the row."""
    if kind not in JOURNAL_KINDS or not text.strip():
        raise ValueError(f"a journal entry needs a kind in {JOURNAL_KINDS} and a non-empty text")
    row = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "ask": ask, "stage": stage, "kind": kind, "text": text.strip(),
           "why": why.strip()}
    with (project_folder(project) / "journal.jsonl").open("a", encoding="utf-8") as journal:
        journal.write(json.dumps(row) + "\n")
    return row


def loop_dir(project: Path) -> Path:
    """Return the folder holding feature_list.json, progress.txt and tracker.json."""
    return project if ask_folder(project) is None else project_folder(project)


def state_file(project: Path) -> Path:
    """Return the loop's lock and progress state (state.json), shared by every ask of the project."""
    return project / ".harness" / "state.json" if ask_folder(project) is None else project_folder(project) / "state.json"


def state_dir(project: Path) -> Path:
    """Return the open ask's loop folder (attempts, evidence, PR records, choices, checks, tool log, flow), or .harness/ without an ask."""
    ask = ask_folder(project)
    return project / ".harness" if ask is None else ask / "loop"


def evidence_dir(project: Path) -> Path:
    """Return the folder feature checks write screenshots and logs to, one subfolder per feature (exported as HVE_EVIDENCE)."""
    return state_dir(project) / "evidence"


def ask_evidence(project: Path, ask: str | None) -> Path:
    """Return the evidence folder of the ask that added a feature (None: a loop run without an ask)."""
    if ask is None:
        return project / ".harness" / "evidence"
    if not ASK_ID.match(ask):
        raise ValueError(f"ask id {ask!r} must match {ASK_ID.pattern}")
    return project / ".aria" / "asks" / ask / "loop" / "evidence"
