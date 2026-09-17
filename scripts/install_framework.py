#!/usr/bin/env python3
"""Plan or apply a non-overwriting framework installation into another repository."""

from __future__ import annotations

import argparse
import filecmp
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parent.parent
INSTALL_ENTRIES = [
    ".agentic",
    ".agents",
    ".codex",
    ".github/pull_request_template.md",
    ".github/workflows/framework-check.yml",
    ".gitignore",
    "AGENTS.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "MANIFEST.md",
    "README.md",
    "SECURITY.md",
    "VERSION",
    "docs/adr",
    "requirements-validation.txt",
    "scripts",
    "tests",
]


@dataclass(frozen=True)
class InstallPlan:
    create: tuple[Path, ...]
    identical: tuple[Path, ...]
    conflicts: tuple[Path, ...]


def source_files() -> list[Path]:
    files: set[Path] = set()
    for entry in INSTALL_ENTRIES:
        path = SOURCE_ROOT / entry
        if path.is_file():
            files.add(path)
        elif path.is_dir():
            files.update(candidate for candidate in path.rglob("*") if candidate.is_file())
    return sorted(files)


def build_plan(target_root: Path) -> InstallPlan:
    create: list[Path] = []
    identical: list[Path] = []
    conflicts: list[Path] = []
    for source in source_files():
        relative_path = source.relative_to(SOURCE_ROOT)
        target = target_root / relative_path
        if not target.exists():
            create.append(relative_path)
        elif target.is_file() and filecmp.cmp(source, target, shallow=False):
            identical.append(relative_path)
        else:
            conflicts.append(relative_path)
    return InstallPlan(tuple(create), tuple(identical), tuple(conflicts))


def apply_plan(target_root: Path, plan: InstallPlan) -> None:
    for relative_path in plan.create:
        source = SOURCE_ROOT / relative_path
        target = target_root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="Zielrepository")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Fehlende Dateien kopieren. Bestehende Dateien werden niemals überschrieben.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    target_root = args.target.expanduser().resolve()
    source_root = SOURCE_ROOT.resolve()
    if target_root == source_root or source_root in target_root.parents:
        print("Target must be outside the framework source repository.", file=sys.stderr)
        return 2

    plan = build_plan(target_root)
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"Framework installation plan ({mode})")
    print(f"  Create: {len(plan.create)}")
    print(f"  Identical: {len(plan.identical)}")
    print(f"  Conflicts: {len(plan.conflicts)}")
    for path in plan.conflicts:
        print(f"  CONFLICT {path.as_posix()}")

    if args.apply:
        target_root.mkdir(parents=True, exist_ok=True)
        apply_plan(target_root, plan)
        print(f"Created {len(plan.create)} files; existing files were not overwritten.")
    else:
        print("No files changed. Re-run with --apply to copy missing files.")
    return 1 if plan.conflicts else 0


if __name__ == "__main__":
    raise SystemExit(main())
