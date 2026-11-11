"""Workspace state locations for harness hooks: <workspace>/<state folder from brand.json>, since hooks run with the workspace root as
working directory."""

from pathlib import Path

from brand import BRAND

STATE_DIR = Path.cwd() / BRAND["state_dir"]
RUNS_DIR = STATE_DIR / "runs"
OUTPUTS_DIR = STATE_DIR / "outputs"
PROFILE_FILE = STATE_DIR / "user_profile.json"
BLINDSPOTS_FILE = STATE_DIR / "blindspots" / "detected_blindspots.jsonl"
# Hooks can be the first harness code to run in a new workspace.
RUNS_DIR.mkdir(parents=True, exist_ok=True)
