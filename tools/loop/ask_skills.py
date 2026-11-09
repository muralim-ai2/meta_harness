"""Skills of an ask: install them into the workspace, keep a chosen set, score the shortlist, list the library skills the ask does not
have yet, and add one the user picks."""

import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "plugins"))
sys.path.insert(0, str(ROOT / "tools" / "skills"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
from recommend import STATUS_ORDER, library_entries, rank, skill_dir  # noqa: E402
from ask_plan import refresh  # noqa: E402

WORKSPACE = Path.cwd()
ROW_FIELDS = ("name", "description", "status", "reason", "relevance", "skill_tokens", "path")

Json = dict[str, Any]


def install(rows: list[Json]) -> None:
    """Copy skills into <workspace>/.aria/skills/<name>/ ('<pack>:<skill>' into '<pack>__<skill>') so every harness reads them in the
    workspace."""
    for row in rows:
        shutil.copytree(ROOT / row["path"], WORKSPACE / ".aria" / "skills" / skill_dir(row["name"]), dirs_exist_ok=True)


def save(path: Path, data: Json) -> None:
    """Refresh the ask's plan blocks and write its contract."""
    refresh(path.parent, data)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def total(s: Json) -> None:
    """Recount the ask's skill tokens and whether they exceed the loadout guideline."""
    s["tokens"] = sum(r["skill_tokens"] for r in s["selected"])
    s["over_budget"] = len(s["selected"]) > s["budget"]["max_skills"] or s["tokens"] > s["budget"]["max_tokens"]


def decide(data: Json, choice: str, why: str) -> None:
    """Record a skills decision in the ask's contract."""
    data["decisions"].append({"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "stage": "skills", "choice": choice, "why": why})


def choose(path: Path, data: Json, choice: str) -> Json:
    """Keep the suggested skill set, all skills, or the named ones (comma-separated), and record the choice and its token cost."""
    s = data["skills"]
    names = s["suggested"] if choice == "suggested" else [r["name"] for r in s["selected"]] if choice == "all" else \
        [n.strip() for n in choice.split(",")]
    unknown = sorted(set(names) - {r["name"] for r in s["selected"]})
    if unknown:
        raise ValueError(f"skills {unknown} are not in the ask's skills; choose from {[r['name'] for r in s['selected']]}")
    s["selected"] = [r for r in s["selected"] if r["name"] in names]
    total(s)
    s["choice"] = {"choice": choice, "tokens": s["tokens"], "over_guideline_tokens": max(0, s["tokens"] - s["budget"]["max_tokens"])}
    decide(data, choice, f"{len(s['selected'])} skills, {s['tokens']:,} tokens")
    save(path, data)
    return s["choice"] | {"skills": [r["name"] for r in s["selected"]]}


def score(path: Path, data: Json, scores: dict[str, Json]) -> Json:
    """Record the agent's 0-10 relevance score for this ask ({name: {score, why}}) on every shortlisted skill, rank the shortlist by it, and
    suggest the required skills plus the top-scored up to the loadout's skill count for the user to confirm."""
    s = data["skills"]
    names = {r["name"] for r in s["selected"]}
    if set(scores) != names:
        raise ValueError(f"score every shortlisted skill once: missing {sorted(names - set(scores))}, unknown {sorted(set(scores) - names)}")
    bad = [n for n, v in scores.items() if not isinstance(v["score"], int) or not 0 <= v["score"] <= 10 or not v["why"].strip()]
    if bad:
        raise ValueError(f"skills {bad} need an integer score from 0 to 10 and a one-line why")
    s["selected"] = sorted((r | scores[r["name"]] for r in s["selected"]),
                           key=lambda r: (r["reason"] != "required", -r["score"], -r["relevance"]))
    room = s["budget"]["max_skills"]
    top = [r for i, r in enumerate(s["selected"]) if r["reason"] == "required" or (r["score"] > 0 and i < room)]
    s["suggested"], s["suggested_tokens"] = [r["name"] for r in top], sum(r["skill_tokens"] for r in top)
    save(path, data)
    return {"shortlist": len(s["selected"]), "tokens": s["tokens"], "suggested_tokens": s["suggested_tokens"],
            "suggested": [{k: r[k] for k in ("name", "score", "why", "skill_tokens")} for r in top]}


def packs(data: Json) -> tuple[Json, ...]:
    """Return the expertise packs the ask chose."""
    return tuple(store.pack(WORKSPACE, p["name"]) for p in data["packs"])


def available(data: Json) -> list[Json]:
    """Return the library, workspace and chosen-pack skills the ask does not have yet, with their description, status and tokens."""
    have = {r["name"] for r in data["skills"]["selected"]}
    return [{k: e[k] for k in ("name", "description", "status", "skill_tokens")} for e in library_entries(packs(data))
            if e["name"] not in have and e["status"] in STATUS_ORDER]


def add(path: Path, data: Json, name: str) -> Json:
    """Add a library skill to the ask by name, install it and record the choice; agents load it from the next prompt."""
    s = data["skills"]
    if name in {r["name"] for r in s["selected"]}:
        raise ValueError(f"skill {name} is already one of the ask's skills")
    row = next(r for r in rank("", "provisional", (name,), packs(data))["load"] if r["name"] == name)
    install([row])
    s["selected"].append({k: row[k] for k in ROW_FIELDS} | {"reason": "added"})
    total(s)
    decide(data, f"added {name}", f"{len(s['selected'])} skills, {s['tokens']:,} tokens")
    save(path, data)
    return {"added": name, "skill_tokens": row["skill_tokens"], "skills": [r["name"] for r in s["selected"]], "tokens": s["tokens"],
            "over_budget": s["over_budget"]}
