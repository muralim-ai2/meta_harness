"""Brand settings shared by hooks, tools and build, read from brand.json: product, prefix, state_dir, icons and optional extension IDs."""

import json
import re
from pathlib import Path, PurePosixPath
from typing import NotRequired, TypedDict

BRAND_FILE = Path(__file__).resolve().parents[1] / "brand.json"
REQUIRED = {"product", "prefix", "state_dir"}
OPTIONAL = {"logo", "activity_icon", "publisher", "extension_name", "command_prefix"}


class Brand(TypedDict):
    """brand.json: product display name, prefix, workspace state folder, and optional UI icon/extension identifiers."""

    product: str
    prefix: str
    state_dir: str
    logo: NotRequired[str]
    activity_icon: NotRequired[str]
    publisher: NotRequired[str]
    extension_name: NotRequired[str]
    command_prefix: NotRequired[str]


def _rel_asset(path: Path, key: str, value: object, suffixes: tuple[str, ...]) -> str:
    """Validate a forward-slash relative asset path ending in one of suffixes with no parent traversal."""
    if not isinstance(value, str) or not value.strip() or "\\" in value:
        raise ValueError(f"{path}: {key} must be a forward-slash relative path, not {value!r}")
    rel = PurePosixPath(value)
    if rel.is_absolute() or ".." in rel.parts or not value.lower().endswith(suffixes):
        raise ValueError(f"{path}: {key} {value!r} must be a relative path ending in {suffixes}")
    return value


def load(path: Path) -> Brand:
    """Return the validated brand settings in path."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not REQUIRED <= set(data) or set(data) - (REQUIRED | OPTIONAL):
        raise ValueError(f"{path} must have exactly the keys {sorted(REQUIRED)} (optional {sorted(OPTIONAL)}), not {sorted(data)}")
    if not isinstance(data["prefix"], str) or not re.fullmatch(r"[a-z][a-z0-9]{1,15}", data["prefix"]):
        raise ValueError(f"{path}: prefix {data['prefix']!r} must be 2-16 lowercase letters or digits, starting with a letter")
    if not isinstance(data["state_dir"], str) or not re.fullmatch(r"\.[a-z][a-z0-9-]{1,15}", data["state_dir"]):
        raise ValueError(f"{path}: state_dir {data['state_dir']!r} must be a dot folder name such as .aria")
    if not isinstance(data["product"], str) or not data["product"].strip():
        raise ValueError(f"{path}: product must not be empty")
    out: dict[str, str] = {"product": data["product"], "prefix": data["prefix"], "state_dir": data["state_dir"]}
    if "logo" in data:
        out["logo"] = _rel_asset(path, "logo", data["logo"], (".png", ".svg"))
    if "activity_icon" in data:
        out["activity_icon"] = _rel_asset(path, "activity_icon", data["activity_icon"], (".svg",))
    for key, pattern in (("publisher", r"[a-z0-9][a-z0-9-]{1,39}"),
                         ("extension_name", r"[a-z0-9][a-z0-9-]{1,39}"),
                         ("command_prefix", r"[a-zA-Z][a-zA-Z0-9]{1,31}")):
        if key in data:
            if not isinstance(data[key], str) or not re.fullmatch(pattern, data[key]):
                raise ValueError(f"{path}: {key} {data[key]!r} must match {pattern}")
            out[key] = data[key]
    return Brand(**out)  # type: ignore[typeddict-item]


BRAND = load(BRAND_FILE)
