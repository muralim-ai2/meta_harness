"""Skills of an ask: install them into the workspace, keep a chosen set, score the shortlist, list the library skills the ask does not
have yet, and add one the user picks."""

import json
import re
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
from recommend import STATUS_ORDER, library_entries, rank, skill_dir, stems  # noqa: E402
from ask_plan import refresh  # noqa: E402
from loop_paths import STATE  # noqa: E402

WORKSPACE = Path.cwd()
ROW_FIELDS = ("name", "description", "status", "reason", "relevance", "skill_tokens", "path")
FRONT_DESC = re.compile(r"^description:\s*>?-?\s*\n?\s*(.+)$", re.M)
CODE_EXTS = {".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".cs", ".java", ".go", ".sql", ".tf", ".bicep"}
GENERIC_STEMS = {"design", "system", "build", "builds", "create", "review", "source", "manage", "produc", "applic", "servic", "projec", "workfl"}

Json = dict[str, Any]


def install(rows: list[Json]) -> None:
    """Copy skills into <workspace>/.aria/skills/<name>/ ('<pack>:<skill>' into '<pack>__<skill>') so every harness reads them in the
    workspace."""
    for row in rows:
        shutil.copytree(ROOT / row["path"], WORKSPACE / STATE / "skills" / skill_dir(row["name"]), dirs_exist_ok=True)


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


def brief_skills(data: Json, stage: Json, task_row: Json | None, role: Json | None, context_text: str) -> list[str]:
    """Return a role- and stage-reduced candidate skill list for a sub-agent brief while keeping generic task delegations intact."""
    selected = {r["name"]: r for r in data["skills"]["selected"]}
    other_stages = {k for s in data["stages"] if s["name"] != stage["name"] for k in s["skills"]}
    ask_pinned = {r["name"] for r in data["skills"]["selected"]
                  if r.get("reason") == "added" or (r.get("reason") == "required" and r["name"] not in other_stages)}
    role_words = f"{role['title']} {role['goal']} {role.get('focus', '')} {' '.join(role.get('keywords', []))}" if role else ""
    want = stems(f"{stage['name']} {stage['goal']} {role_words} {context_text}") - GENERIC_STEMS
    if task_row is not None:
        pool = list(task_row["skills"])
        if role is None or len(pool) <= 4:
            return pool
        pinned = {*stage["skills"], *(s for s in role.get("skills", []) if s in pool), *(ask_pinned & set(pool))}
        kept = [s for s in pool if s in pinned]
        matched = [s for s in pool if s not in kept and (want & stems(f"{s.replace('-', ' ')} {selected.get(s, {}).get('description', '')}"))]
        reduced = (kept + matched)[:max(5, len(kept))]
        return reduced if reduced else pool[:4]
    kept = list(dict.fromkeys([
        *stage["skills"],
        *(s for s in (role or {}).get("skills", []) if s in selected),
        *(r["name"] for r in data["skills"]["selected"] if r["name"] in ask_pinned),
    ]))
    matched = [r["name"] for r in data["skills"]["selected"]
               if r["name"] not in kept and (want & stems(f"{r['name'].replace('-', ' ')} {r.get('description', '')}"))]
    reduced = (kept + matched)[:max(6, len(kept))]
    return reduced if reduced else [r["name"] for r in data["skills"]["selected"][:5]]


def format_brief_skills(workspace: Path, skills: list[str], data: Json) -> str:
    """Format candidate skills with one-line descriptions so the sub-agent skims and reads only the SKILL.md files it chooses."""
    if not skills:
        return "- Candidate skills: no library skills"
    by_name = {r["name"]: str(r.get("description") or "").strip() for r in data["skills"]["selected"]}
    entries = []
    for name in skills:
        rel = f"{STATE}/skills/{skill_dir(name)}/SKILL.md"
        desc = by_name.get(name, "")
        if not desc and (workspace / rel).is_file():
            match = FRONT_DESC.search((workspace / rel).read_text(encoding="utf-8")[:800])
            desc = match[1].strip() if match else ""
        clean = " ".join(desc.split())
        if len(clean) > 130:
            clean = clean[:127] + "..."
        entries.append(f"{name}: {clean} ({rel})" if clean else rel)
    return ("- Candidate skills (skim descriptions, skip any that do not fit this step, and read SKILL.md only for the ones you choose): "
            + "; ".join(entries))


def ensure_map(workspace: Path) -> Json:
    """Build or refresh .aria/map/ automatically for medium and large repositories; skip small workspaces."""
    map_dir = ROOT / "tools" / "map"
    if not (map_dir / "solution_map.py").is_file():
        return {"enabled": False, "size": "small"}
    if str(map_dir) not in sys.path:
        sys.path.insert(0, str(map_dir))
    import extract  # noqa: E402
    import map_build  # noqa: E402
    import solution_map  # noqa: E402
    config = map_build.load_config(workspace, None)
    map_file = workspace / STATE / "map" / "map.json"
    if map_file.is_file():
        loaded = solution_map.load(workspace, map_file)
        if solution_map.status(workspace, loaded)["stale"]:
            built = map_build.build(workspace, config)
            solution_map.write(workspace, map_file.parent, built)
        else:
            built = loaded.data
        return {"enabled": True, "size": built["size"]["class"], "commit": built["commit"], "overview": f"{STATE}/map/overview.md"}
    exclude = [re.compile(x) for x in config.get("exclude", [])]
    code_paths = [p for p in extract.list_files(workspace, exclude) if Path(p).suffix.lower() in CODE_EXTS]
    if len(code_paths) < map_build.SIZE["medium"][0]:
        lines = sum(len((workspace / p).read_bytes().splitlines()) for p in code_paths)
        if lines < map_build.SIZE["medium"][1]:
            return {"enabled": False, "size": "small"}
    built = map_build.build(workspace, config)
    if built["size"]["class"] == "small":
        return {"enabled": False, "size": "small"}
    solution_map.write(workspace, map_file.parent, built)
    return {"enabled": True, "size": built["size"]["class"], "commit": built["commit"], "overview": f"{STATE}/map/overview.md"}


def map_brief_lines(workspace: Path, query_text: str) -> list[str]:
    """Return compact Solution Map touchpoints and mapped test files for a sub-agent brief when a map exists."""
    map_dir = ROOT / "tools" / "map"
    has_map = (workspace / STATE / "map" / "map.json").is_file() or (workspace / "docs" / "architecture" / "solution-map.json").is_file()
    if not has_map or not (map_dir / "solution_map.py").is_file():
        return []
    if str(map_dir) not in sys.path:
        sys.path.insert(0, str(map_dir))
    import solution_map  # noqa: E402
    loaded = solution_map.load(workspace, None)
    raw_hits = [h for h in solution_map.search(loaded, query_text, limit=12) if h["id"].startswith("file:")]
    code_hits = [h for h in raw_hits if Path(h["source"]).suffix.lower() in CODE_EXTS]
    hits = (code_hits + [h for h in raw_hits if h not in code_hits])[:5]
    tests = solution_map.impact(loaded, [h["id"] for h in hits])["tests"][:5] if hits else []
    files = ", ".join(f"{h['source']} ({h['purpose']})" if h.get("purpose") else h["source"] for h in hits) or f"see {STATE}/map/overview.md"
    suffix = f". Mapped tests: {', '.join(tests)}" if tests else ""
    return [(f"- Solution map touchpoints (use `solution_map.py explain|impact|search` or {STATE}/map/overview.md; "
             f"never read map.json directly): {files}{suffix}")]
