"""Persona catalog: validate it, render persona agents from their kind's template, and find the personas a stage or request needs."""

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
from brand import BRAND  # noqa: E402
CATALOG = ROOT / "templates" / "personas" / "catalog.json"
TEMPLATES = ROOT / "templates" / "personas"
AGENTS = ROOT / "extension" / "agents"
KINDS = ("existing", "builder", "designer", "reviewer")
FIELDS = {"existing": ("id", "agent", "kind", "title", "goal", "skills", "keywords"),
          "builder": ("id", "agent", "kind", "title", "goal", "focus", "skills", "keywords"),
          "designer": ("id", "agent", "kind", "title", "goal", "produces", "focus", "skills", "keywords"),
          "reviewer": ("id", "agent", "kind", "title", "goal", "focus", "skills", "keywords")}
ID = re.compile(r"^[a-z][a-z-]{1,30}$")

Json = dict[str, Any]


def load(path: Path = CATALOG) -> list[Json]:
    """Return the validated personas of a catalog."""
    personas = json.loads(path.read_text(encoding="utf-8"))["personas"]
    seen: set[str] = set()
    for p in personas:
        if p.get("kind") not in KINDS:
            raise ValueError(f"persona {p.get('id')!r} kind must be one of {KINDS}")
        missing = [f for f in FIELDS[p["kind"]] if not p.get(f) and f != "skills"]
        if missing:
            raise ValueError(f"persona {p['id']!r} is missing {missing}")
        if not ID.match(p["id"]) or p["id"] in seen:
            raise ValueError(f"persona id {p['id']!r} must be unique and match {ID.pattern}")
        if p["kind"] != "existing" and p["agent"] not in (f"ARIA {p['id']}", f"{BRAND['product']} {p['id']}"):
            raise ValueError(f"rendered persona {p['id']!r} must be named '{BRAND['product']} {p['id']}', not {p['agent']!r}")
        seen.add(p["id"])
    return personas


def description(p: Json, product: str | None = None) -> str:
    """Return a persona's agent description as a plain YAML scalar."""
    brand_product = product or BRAND["product"]
    text = f"{brand_product} {p['title']} persona. {p['goal']}"
    if ": " in text or text[0] in "'\"" or "#" in text:
        raise ValueError(f"persona {p['id']!r} description must be a plain YAML scalar (no ': ', quotes or '#'): {text}")
    return text


def render(p: Json, product: str | None = None) -> str:
    """Return the agent file of a rendered persona from its kind's template."""
    brand_product = product or BRAND["product"]
    text = (TEMPLATES / f"{p['kind']}.agent.md").read_text(encoding="utf-8").replace("Frontier HVE", brand_product)
    agent_name = f"{brand_product} {p['id']}" if p["agent"].startswith("ARIA ") else p["agent"]
    values = {"name": agent_name, "description": description(p, brand_product), "title": p["title"], "goal": p["goal"],
              "focus": p["focus"], "produces": p.get("produces", "")}
    out = re.sub(r"\{\{(name|description|title|goal|focus|produces)\}\}", lambda m: values[m[1]], text)
    return out.replace("\n---\n", f"\n---\n\n<!-- Generated from templates/personas/catalog.json ({p['id']}); edit the catalog, not this file. -->\n", 1)


def write(folder: Path = AGENTS, path: Path = CATALOG, product: str | None = None) -> list[str]:
    """Write every rendered persona's agent file into a folder and return the file names."""
    names = []
    for p in load(path):
        if p["kind"] == "existing":
            continue
        name = f"{p['id']}.agent.md"
        (folder / name).write_text(render(p, product), encoding="utf-8")
        names.append(name)
    return names


def stale(folder: Path = AGENTS, path: Path = CATALOG) -> list[str]:
    """Return the rendered persona files that are missing or differ from the catalog."""
    return [f"{p['id']}.agent.md" for p in load(path) if p["kind"] != "existing"
            and (not (folder / f"{p['id']}.agent.md").is_file()
                 or (folder / f"{p['id']}.agent.md").read_text(encoding="utf-8") != render(p))]


def match(text: str, path: Path = CATALOG) -> list[Json]:
    """Return the personas whose keywords appear in a text, best first, with the words that matched."""
    lowered = f" {text.lower()} "
    found = []
    for p in load(path):
        hits = [k for k in p["keywords"] if re.search(rf"(?<![a-z]){re.escape(k)}(?![a-z])", lowered)]
        if hits:
            found.append({"id": p["id"], "agent": p["agent"], "kind": p["kind"], "title": p["title"], "matched": hits})
    return sorted(found, key=lambda r: -len(r["matched"]))


def by_agent(path: Path = CATALOG) -> dict[str, Json]:
    """Return personas indexed by configured display/prefix name, legacy ARIA/HVE names, and raw id."""
    indexed: dict[str, Json] = {}
    for p in load(path):
        pid = p["id"]
        keys = (p["agent"], p["agent"].lower().replace(" ", "-"), f"{BRAND['product']} {pid}", f"{BRAND['prefix']}-{pid}",
                f"ARIA {pid}", f"aria-{pid}", f"HVE {pid}", f"hve-{pid}", pid)
        for key in keys:
            indexed[key] = p
    return indexed


def main() -> None:
    """CLI: list | show <id> | match <text> | render [folder] | check [folder]."""
    args = sys.argv[1:]
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    if args[:1] == ["list"]:
        out: Any = [{k: p[k] for k in ("id", "agent", "kind", "title", "goal")} for p in load()]
    elif args[:1] == ["show"] and len(args) == 2:
        out = next(p for p in load() if p["id"] == args[1])
    elif args[:1] == ["match"] and len(args) == 2:
        out = match(args[1])
    elif args[:1] == ["render"] and len(args) <= 2:
        out = write(Path(args[1]) if len(args) == 2 else AGENTS)
    elif args[:1] == ["check"] and len(args) <= 2:
        out = {"stale": stale(Path(args[1]) if len(args) == 2 else AGENTS)}
    else:
        raise SystemExit(main.__doc__)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
