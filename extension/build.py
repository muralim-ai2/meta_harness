"""Assemble an extension directory (runtime/, skills/, agents/, package.json, icons and brand.css) from brand.json, optionally packaging an isolated branded VSIX."""

import argparse
import json
import py_compile
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

EXTENSION = Path(__file__).resolve().parent
REPO = EXTENSION.parent
PLUGIN_SRC = REPO / "plugins" / "harness-assist"
FILES = {
    "hooks": ["brand.py", "hve_paths.py", "interventions.py", "profile_detector.py", "compaction.py", "loop_guard.py", "flow_guard.py",
              "module_guard.py", "no_fallback.py", "skill_loader.py", "agent_compat.py", "template_guard.py", "guard_policy.py",
              "plan_check.py", "metrics.py", "agent_ledger.py", "error_guard.py", "guard_mode.json"],
    "tools/adapters": ["export.py", "check.py"],
    "tools/templates": ["manage.py"],
    "tools/backlog": ["backlog.py"],
    "tools/evaluation": ["contract.py", "workflow.py", "reflection.py", "compose.py"],
    "tools/observe": ["provenance.py", "otel_trim.py"],
    "tools/plugins": ["manifest.py", "route.py", "store.py", "plugin.py", "author.py"],
    "schemas": ["hve-plugin.schema.json"],
    "evaluation": ["frontier.eval.json"],
    "tools/loop": ["loop.py", "diagnose.py", "flow.py", "lifecycle.py", "lifecycle_catalog.py", "ask_plan.py", "ask_packs.py", "ask_report.py",
                   "ask_status.py", "ask_project.py", "ask_skills.py", "personas.py", "stage_evidence.py", "loop_paths.py", "environment.py"],
    "tools/git": ["branch_workflow.py", "parallel_options.py"],
    "tools/prototype": ["check.py"],
    "tools/skills": ["recommend.py", "scan.py", "triage.py", "onboard.py", "micro_eval.py", "evaluate.py", "context_load.py"],
    "tools/map": ["extract.py", "map_build.py", "solution_map.py"],
    "tools/map/explorer": ["explorer.html", "explorer.css", "graph.js", "query.js", "views.js", "app.js"],
    "skills": ["registry.json", "categories.json"],
}
SCRIPTS = ["choice_recorder.py", "guardrail.py", "enterprise_catalog.json"]
RUNTIME_REF = re.compile(r"\{\{RUNTIME\}\}/([\w./-]+\.py)")
COMMANDS = (
    ("setup", "{product}: Set up"),
    ("installHarnesses", "{product}: Install for other harnesses (Copilot CLI, Claude, Codex, Cursor, cloud agent)"),
    ("researchTelemetry", "{product}: Turn on research telemetry (benchmarks only)"),
    ("researchTelemetryOff", "{product}: Turn off research telemetry"),
    ("installPlugin", "{product}: Install plugin (expertise pack)"),
    ("managePlugins", "{product}: Manage plugins (expertise packs)"),
    ("openMissionControl", "{product}: Open Mission Control"),
    ("refreshMissionControl", "{product}: Refresh Mission Control"),
    ("selectWorkspace", "{product}: Select Mission Control workspace"),
    ("newAsk", "{product}: New ask"),
    ("editPlan", "{product}: Edit plan"),
)


def resolve_asset(rel: str, brand_file: Path) -> Path:
    """Resolve a brand asset path relative to the brand file's folder first, then the repository root."""
    for base in (brand_file.parent, REPO):
        candidate = (base / rel).resolve()
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"brand asset {rel!r} (from {brand_file}) does not exist")


def rebrand_text(text: str, product: str, state_dir: str) -> str:
    """Rewrite state_dir, Frontier HVE prose and, when product is not ARIA, ARIA display names."""
    out = text.replace(".aria/", f"{state_dir}/").replace("Frontier HVE", product)
    return out if product == "ARIA" else re.sub(r"\bARIA\b", product, out)


def stamp_extension(target_ext: Path, brand_cfg: dict[str, str], brand_file: Path) -> None:
    """Copy configured brand icons into ui/media/, write brand.css, and stamp target_ext/package.json."""
    product, prefix, state_dir = brand_cfg["product"], brand_cfg["prefix"], brand_cfg["state_dir"]
    default_aria = prefix == "aria" and "command_prefix" not in brand_cfg and "extension_name" not in brand_cfg
    cmd_prefix = brand_cfg.get("command_prefix") or ("frontierHve" if default_aria else prefix)
    ext_name = brand_cfg.get("extension_name") or ("frontier-hve" if default_aria else prefix)
    publisher = brand_cfg.get("publisher") or "pwc"
    media = target_ext / "ui" / "media"
    logo_src = resolve_asset(brand_cfg.get("logo", "extension/ui/media/aria.png"), brand_file)
    icon_src = resolve_asset(brand_cfg.get("activity_icon", "extension/ui/media/aria.svg"), brand_file)
    logo_dest = media / logo_src.name
    icon_dest = media / icon_src.name
    if logo_src.resolve() != logo_dest.resolve():
        shutil.copy2(logo_src, logo_dest)
    if icon_src.resolve() != icon_dest.resolve():
        shutil.copy2(icon_src, icon_dest)
    (media / "brand.css").write_text(f":root {{ --brand-logo: url('{logo_dest.name}'); }}\n", encoding="utf-8")
    pkg_path = target_ext / "package.json"
    pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    pkg["name"] = ext_name
    pkg["displayName"] = product
    pkg["publisher"] = publisher
    pkg["description"] = f"Enterprise AI harness for GitHub Copilot: {product} agents with a verified feature loop, graph workflow, guards and human-ticked PRs."
    pkg["icon"] = f"ui/media/{logo_dest.name}"
    contributes = pkg["contributes"]
    contributes["viewsContainers"] = {"activitybar": [{"id": cmd_prefix, "title": product, "icon": f"ui/media/{icon_dest.name}"}]}
    contributes["views"] = {cmd_prefix: [
        {"type": "webview", "id": f"{cmd_prefix}.missionControl", "name": "Mission Control"},
        {"id": f"{cmd_prefix}.harnessFiles", "name": "Harness files"},
    ]}
    contributes["viewsWelcome"] = [{
        "view": f"{cmd_prefix}.harnessFiles",
        "contents": f"No {state_dir}/ or .harness/ folder in this workspace yet. Asks, plans, evidence, run records and loop files appear here as soon as an agent or the harness writes them.\n[New ask](command:{cmd_prefix}.newAsk)",
    }]
    contributes["commands"] = [{"command": f"{cmd_prefix}.{suffix}", "title": title.format(product=product)} for suffix, title in COMMANDS]
    contributes["configuration"] = {
        "title": product,
        "properties": {
            f"{cmd_prefix}.pluginIndex": {
                "type": "string",
                "default": "",
                "description": "Organization expertise pack index (path or https URL) that lists approved packs, versions, hashes and revocations.",
            }
        },
    }
    pkg_path.write_text(json.dumps(pkg, indent=2) + "\n", encoding="utf-8")


def assemble(target_ext: Path, brand_file: Path) -> list[str]:
    """Assemble runtime/, skills/, agents/ and branded manifest/assets inside target_ext; return referenced runtime scripts."""
    sys.path.insert(0, str(REPO / "hooks"))
    import brand as brand_mod  # noqa: E402
    brand_cfg = dict(brand_mod.load(brand_file))
    runtime_dir = target_ext / "runtime"
    skills_dir = target_ext / "skills"
    agents_dir = target_ext / "agents"
    for folder in (runtime_dir, skills_dir):
        if folder.exists():
            shutil.rmtree(folder)
    for folder, names in FILES.items():
        (runtime_dir / folder).mkdir(parents=True)
        for name in names:
            shutil.copy2(REPO / folder / name, runtime_dir / folder / name)
    (runtime_dir / "brand.json").write_text(json.dumps(brand_cfg, indent=2) + "\n", encoding="utf-8")
    (runtime_dir / "scripts").mkdir()
    for name in SCRIPTS:
        shutil.copy2(PLUGIN_SRC / "scripts" / name, runtime_dir / "scripts" / name)
    shutil.copytree(PLUGIN_SRC / "skills", skills_dir)
    shutil.copytree(REPO / "skills" / "admitted", runtime_dir / "skills" / "admitted")
    shutil.copy2(REPO / "skills" / "authored" / "NOTICE", runtime_dir / "skills" / "NOTICE")
    (runtime_dir / "skills" / "licenses" / "agentx").mkdir(parents=True)
    for name in ("LICENSE", "NOTICE"):
        shutil.copy2(REPO / "skills" / "imported" / "agentx" / name, runtime_dir / "skills" / "licenses" / "agentx" / name)
    shutil.copytree(REPO / "docs" / "wiki", runtime_dir / "docs" / "wiki")
    for wiki_page in (runtime_dir / "docs" / "wiki").glob("*.md"):
        wiki_page.write_text(rebrand_text(wiki_page.read_text(encoding="utf-8"), brand_cfg["product"], brand_cfg["state_dir"]), encoding="utf-8")
    shutil.copytree(REPO / "examples" / "plugins" / "oracle-offering", runtime_dir / "examples" / "plugins" / "oracle-offering")
    shutil.copytree(REPO / "templates" / "deliverables", runtime_dir / "templates" / "deliverables")
    shutil.copytree(REPO / "templates" / "lifecycles", runtime_dir / "templates" / "lifecycles")
    shutil.copytree(REPO / "templates" / "personas", runtime_dir / "templates" / "personas")
    sys.path.insert(0, str(REPO / "tools" / "loop"))
    import personas  # noqa: E402
    personas.write(agents_dir, product=brand_cfg["product"])
    if target_ext.resolve() != EXTENSION.resolve() and brand_cfg["product"] != "ARIA":
        for agent_path in agents_dir.glob("*.agent.md"):
            agent_path.write_text(rebrand_text(agent_path.read_text(encoding="utf-8"), brand_cfg["product"], brand_cfg["state_dir"]), encoding="utf-8")
    stamp_extension(target_ext, brand_cfg, brand_file)
    for path in runtime_dir.rglob("*.py"):
        if runtime_dir / "skills" not in path.parents:
            py_compile.compile(str(path), doraise=True)
    for cache in list(runtime_dir.rglob("__pycache__")):
        shutil.rmtree(cache)
    referenced = sorted({ref for agent in agents_dir.glob("*.agent.md")
                         for ref in RUNTIME_REF.findall(agent.read_text(encoding="utf-8"))})
    missing = [ref for ref in referenced if not (runtime_dir / ref).is_file()]
    if missing:
        raise FileNotFoundError(f"agent templates reference runtime files that the build did not copy: {missing}")
    return referenced


def copy_extension_skeleton(dest: Path) -> None:
    """Copy tracked extension sources into dest without runtime/, skills/, node_modules/ or packaged archives."""
    ignore = shutil.ignore_patterns("node_modules", "runtime", "skills", "__pycache__", "*.vsix", "*.zip")
    shutil.copytree(EXTENSION, dest, ignore=ignore)


def package_vsix(ext_dir: Path, out_vsix: Path) -> None:
    """Package ext_dir into out_vsix using the repository's @vscode/vsce CLI."""
    vsce = EXTENSION / "node_modules" / "@vscode" / "vsce" / "vsce"
    if not vsce.is_file():
        raise FileNotFoundError(f"{vsce} not found; run `npm --prefix extension ci` first")
    out_vsix.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["node", str(vsce), "package", "--no-dependencies", "--skip-license", "--allow-missing-repository",
                    "--out", str(out_vsix.resolve())], cwd=ext_dir, check=True)


def build(brand_file: Path = REPO / "brand.json", stage_dir: Path | None = None, package_out: Path | None = None) -> list[str]:
    """Build in place (default) or in an isolated staging folder when packaging a separate brand without mutating extension/."""
    brand_file = brand_file.resolve()
    isolated = stage_dir is not None or (package_out is not None and brand_file != (REPO / "brand.json").resolve())
    if not isolated:
        refs = assemble(EXTENSION, brand_file)
        if package_out is not None:
            package_vsix(EXTENSION, package_out)
        return refs
    if stage_dir is not None:
        if stage_dir.exists():
            shutil.rmtree(stage_dir)
        copy_extension_skeleton(stage_dir)
        refs = assemble(stage_dir, brand_file)
        if package_out is not None:
            package_vsix(stage_dir, package_out)
        return refs
    with tempfile.TemporaryDirectory(prefix="aria-vsix-") as tmp:
        staged = Path(tmp) / "extension"
        copy_extension_skeleton(staged)
        refs = assemble(staged, brand_file)
        if package_out is not None:
            package_vsix(staged, package_out)
        return refs


def main() -> None:
    """CLI entry point for in-place builds and isolated multi-brand VSIX packaging."""
    parser = argparse.ArgumentParser(description="Assemble the extension runtime and optionally package a branded VSIX.")
    parser.add_argument("--brand", type=Path, default=REPO / "brand.json", help="Path to brand.json (defaults to repo brand.json)")
    parser.add_argument("--stage", type=Path, help="Optional staging directory for an isolated branded extension build")
    parser.add_argument("--package", type=Path, help="Optional output .vsix path to package")
    args = parser.parse_args()
    refs = build(args.brand, args.stage, args.package)
    target = args.stage or (args.package if args.package else EXTENSION)
    print(f"runtime and skills assembled for {args.brand.name} -> {target}; agents reference {len(refs)} runtime files, all present")


if __name__ == "__main__":
    main()
