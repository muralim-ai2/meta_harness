"""Brand settings shared by hooks and tools, read from brand.json at the runtime root: product name, agent prefix and state folder."""

import json
import re
from pathlib import Path
from typing import TypedDict

BRAND_FILE = Path(__file__).resolve().parents[1] / "brand.json"


class Brand(TypedDict):
    """brand.json: product display name, prefix for exported agent, skill and hook file names, and the workspace state folder."""

    product: str
    prefix: str
    state_dir: str


def load(path: Path) -> Brand:
    """Return the validated brand settings in path."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if set(data) != set(Brand.__annotations__):
        raise ValueError(f"{path} must have exactly the keys {sorted(Brand.__annotations__)}, not {sorted(data)}")
    if not re.fullmatch(r"[a-z][a-z0-9]{1,15}", data["prefix"]):
        raise ValueError(f"{path}: prefix {data['prefix']!r} must be 2-16 lowercase letters or digits, starting with a letter")
    if not re.fullmatch(r"\.[a-z][a-z0-9-]{1,15}", data["state_dir"]):
        raise ValueError(f"{path}: state_dir {data['state_dir']!r} must be a dot folder name such as .aria")
    if not data["product"].strip():
        raise ValueError(f"{path}: product must not be empty")
    return Brand(product=data["product"], prefix=data["prefix"], state_dir=data["state_dir"])


BRAND = load(BRAND_FILE)
