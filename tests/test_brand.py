"""Tests of the brand settings: brand.json is valid, ships in the runtime, and Python and the extension read the same values."""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EXTENSION = REPO / "extension"
sys.path.insert(0, str(REPO / "hooks"))
import brand  # noqa: E402


def raises(fn: object, *args: object) -> str:
    """Call fn with args and return the message of the ValueError it must raise."""
    try:
        fn(*args)  # type: ignore[operator]
    except ValueError as error:
        return str(error)
    raise AssertionError(f"{fn} did not raise for {args}")


def test_brand_file_is_valid() -> None:
    """The repository brand loads and names ARIA with the aria prefix, .aria state folder, and ARIA logo and Activity Bar icon."""
    assert brand.BRAND == {
        "product": "ARIA",
        "prefix": "aria",
        "state_dir": ".aria",
        "logo": "extension/ui/media/aria.png",
        "activity_icon": "extension/ui/media/aria.svg",
    }, brand.BRAND


def test_invalid_brands_are_refused() -> None:
    """Missing or extra keys, a prefix that cannot name files, and a state folder that is not a dot folder are refused."""
    good = {"product": "ARIA", "prefix": "aria", "state_dir": ".aria"}
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "brand.json"
        for bad, needle in (({k: v for k, v in good.items() if k != "prefix"}, "exactly the keys"), (good | {"extra": 1}, "exactly the keys"),
                            (good | {"prefix": "Aria-X"}, "prefix"), (good | {"state_dir": "aria"}, "state_dir"),
                            (good | {"product": " "}, "product")):
            path.write_text(json.dumps(bad), encoding="utf-8")
            assert needle in raises(brand.load, path), bad
        path.write_text(json.dumps(good | {"prefix": "hve", "state_dir": ".hve"}), encoding="utf-8")
        assert brand.load(path)["state_dir"] == ".hve"


def test_runtime_and_extension_read_the_same_brand() -> None:
    """The build copies brand.json and brand.py into the runtime, and extension/brand.js reads the same values."""
    subprocess.run([sys.executable, str(EXTENSION / "build.py")], check=True, capture_output=True)
    runtime = EXTENSION / "runtime"
    assert json.loads((runtime / "brand.json").read_text(encoding="utf-8")) == brand.BRAND
    shipped = subprocess.run([sys.executable, "-c", "import json, brand; print(json.dumps(brand.BRAND))"], cwd=runtime / "hooks",
                             capture_output=True, text=True, check=True)
    assert json.loads(shipped.stdout) == brand.BRAND
    node = subprocess.run(["node", "-e", f"process.stdout.write(JSON.stringify(require({json.dumps(str(EXTENSION / 'brand.js'))}).BRAND))"],
                          capture_output=True, text=True, check=True)
    assert json.loads(node.stdout) == brand.BRAND


def test_another_brand_moves_the_state_folder_and_export_names() -> None:
    """With brand.json set to another prefix and state folder, asks, status and exports use them and nothing writes .aria."""
    subprocess.run([sys.executable, str(EXTENSION / "build.py")], check=True, capture_output=True)
    with tempfile.TemporaryDirectory() as tmp:
        ext = Path(tmp) / "ext"
        for part in ("runtime", "agents", "skills"):
            shutil.copytree(EXTENSION / part, ext / part)
        (ext / "runtime" / "brand.json").write_text(json.dumps({"product": "HVE", "prefix": "hve", "state_dir": ".hve"}), encoding="utf-8")
        ws = Path(tmp) / "ws"
        ws.mkdir()
        (ws / "req.md").write_text("Build a login page", encoding="utf-8")
        lifecycle = ext / "runtime" / "tools" / "loop" / "lifecycle.py"
        made = subprocess.run([sys.executable, str(lifecycle), "contract", "direct", "login", "HVE Lite", "req.md"], cwd=ws, capture_output=True,
                              text=True)
        assert made.returncode == 0, made.stderr
        assert (ws / ".hve" / "asks" / "active.json").is_file()
        shown = subprocess.run([sys.executable, str(lifecycle), "status"], cwd=ws, capture_output=True, text=True)
        assert shown.returncode == 0 and "**Open ask**" in shown.stdout, shown.stderr
        exported = subprocess.run([sys.executable, str(ext / "runtime" / "tools" / "adapters" / "export.py"), "claude", str(ws)], capture_output=True,
                                  text=True)
        assert exported.returncode == 0, exported.stderr
        assert (ws / ".hve" / "runtime" / "hooks" / "agent_compat.py").is_file() and (ws / ".claude" / "agents" / "hve-lite.md").is_file()
        lite = (ws / ".claude" / "agents" / "hve-lite.md").read_text(encoding="utf-8")
        assert ".hve/asks/" in lite and ".aria/" not in lite
        assert ".aria/" not in "".join(p.read_text(encoding="utf-8") for p in (ws / ".claude" / "skills").rglob("*.md"))
        for name in ("render.js", "brand.js"):
            shutil.copy(EXTENSION / name, ext / name)
        plugin = Path(tmp) / "plugin"
        script = (f"process.stdout.write(JSON.stringify(require({json.dumps(str(ext / 'render.js'))}).renderPlugin({json.dumps(str(ext))}, "
                  f"{json.dumps(str(plugin))}, '0.0.0-test', 'python')))")
        subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
        assert json.loads((plugin / "plugin.json").read_text(encoding="utf-8"))["name"] == "hve"
        rendered = "".join(p.read_text(encoding="utf-8") for p in plugin.rglob("*.md"))
        assert ".hve/asks/" in rendered and ".aria/" not in rendered
        assert not (ws / ".aria").exists(), sorted(p.as_posix() for p in (ws / ".aria").rglob("*"))


def test_two_separate_branded_vsix_builds() -> None:
    """An isolated --brand --package build creates a separate side-by-side VSIX with its own logo, Activity Bar SVG, IDs and agents without touching ARIA."""
    import zipfile
    subprocess.run([sys.executable, str(EXTENSION / "build.py")], check=True, capture_output=True)
    aria_pkg_before = (EXTENSION / "package.json").read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "nova-logo.png").write_bytes((EXTENSION / "ui" / "media" / "aria.png").read_bytes())
        (root / "nova-bar.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>', encoding="utf-8")
        nova_brand = {
            "product": "NOVA",
            "prefix": "nova",
            "state_dir": ".nova",
            "logo": "nova-logo.png",
            "activity_icon": "nova-bar.svg",
        }
        brand_path = root / "nova.brand.json"
        brand_path.write_text(json.dumps(nova_brand), encoding="utf-8")
        nova_vsix = root / "nova.vsix"
        subprocess.run([sys.executable, str(EXTENSION / "build.py"), "--brand", str(brand_path), "--package", str(nova_vsix)],
                       check=True, capture_output=True, text=True)
        assert (EXTENSION / "package.json").read_text(encoding="utf-8") == aria_pkg_before
        with zipfile.ZipFile(nova_vsix) as zf:
            names = set(zf.namelist())
            assert "extension/ui/media/nova-logo.png" in names
            assert "extension/ui/media/nova-bar.svg" in names
            assert "url('nova-logo.png')" in zf.read("extension/ui/media/brand.css").decode()
            pkg = json.loads(zf.read("extension/package.json"))
            assert pkg["name"] == "nova" and pkg["displayName"] == "NOVA" and pkg["icon"] == "ui/media/nova-logo.png"
            assert pkg["contributes"]["viewsContainers"]["activitybar"] == [{"id": "nova", "title": "NOVA", "icon": "ui/media/nova-bar.svg"}]
            assert pkg["contributes"]["commands"][0] == {"command": "nova.setup", "title": "NOVA: Set up"}
            assert "nova.pluginIndex" in pkg["contributes"]["configuration"]["properties"]
            lite = zf.read("extension/agents/lite.agent.md").decode()
            assert "name: NOVA Lite" in lite and ".nova/" in lite
            engineer = zf.read("extension/agents/engineer.agent.md").decode()
            assert "name: NOVA engineer" in engineer and "Frontier HVE" not in engineer


if __name__ == "__main__":
    test_brand_file_is_valid()
    test_invalid_brands_are_refused()
    test_runtime_and_extension_read_the_same_brand()
    test_another_brand_moves_the_state_folder_and_export_names()
    test_two_separate_branded_vsix_builds()
    print("test_brand: OK")
