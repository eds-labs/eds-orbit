from __future__ import annotations

import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch


REPOSITORY_ROOT = Path(__file__).resolve().parent.parent


def load_script(name: str):
    path = REPOSITORY_ROOT / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"test_{name}_module", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


new_task = load_script("new_task")
new_operational_doc = load_script("new_operational_doc")
install_framework = load_script("install_framework")
agentic_check = load_script("agentic_check")
agentic_ops_check = load_script("agentic_ops_check")


def quietly(callback):
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        return callback()


class GeneratorTests(unittest.TestCase):
    def test_scripts_resolve_repository_root_independently_of_cwd(self) -> None:
        for module in (new_task, new_operational_doc, agentic_check, agentic_ops_check):
            self.assertEqual(REPOSITORY_ROOT, module.ROOT)
        self.assertEqual(REPOSITORY_ROOT, install_framework.SOURCE_ROOT)

    def test_slugify_is_filename_safe(self) -> None:
        self.assertEqual("über-prüfung-2026", new_task.slugify(" Über Prüfung 2026! "))
        self.assertEqual("änderung-live", new_operational_doc.slugify("Änderung / Live"))

    def test_new_task_creates_one_brief_and_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            template = root / ".agentic/templates/task-brief.md"
            template.parent.mkdir(parents=True)
            template.write_text("# Task Brief\n\n## Ziel\n", encoding="utf-8")
            task_dir = root / ".agentic/tasks"
            with (
                patch.object(new_task, "TEMPLATE", template),
                patch.object(new_task, "TASK_DIR", task_dir),
                patch.object(sys, "argv", ["new_task.py", "Sicherer", "Test"]),
            ):
                self.assertEqual(0, quietly(new_task.main))
                self.assertEqual(3, quietly(new_task.main))
            files = list(task_dir.glob("*.md"))
            self.assertEqual(1, len(files))
            self.assertIn("# Task Brief — Sicherer Test", files[0].read_text(encoding="utf-8"))

    def test_operational_generator_uses_selected_template(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            template = root / ".agentic/templates/risk-assessment-advanced.md"
            template.parent.mkdir(parents=True)
            template.write_text("## Risk Level\n", encoding="utf-8")
            with (
                patch.object(new_operational_doc, "ROOT", root),
                patch.object(sys, "argv", ["new_operational_doc.py", "risk", "Neue API"]),
            ):
                self.assertEqual(0, quietly(new_operational_doc.main))
            files = list((root / "docs/operations/risk").glob("*.md"))
            self.assertEqual(1, len(files))
            self.assertTrue(files[0].read_text(encoding="utf-8").startswith("# Neue API\n"))

    def test_installer_dry_run_and_apply_never_overwrite_conflicts(self) -> None:
        with tempfile.TemporaryDirectory() as source_directory, tempfile.TemporaryDirectory() as target_directory:
            source = Path(source_directory)
            target = Path(target_directory)
            (source / "AGENTS.md").write_text("source\n", encoding="utf-8")
            (source / "VERSION").write_text("1.0.0\n", encoding="utf-8")
            (target / "AGENTS.md").write_text("target\n", encoding="utf-8")
            with (
                patch.object(install_framework, "SOURCE_ROOT", source),
                patch.object(install_framework, "INSTALL_ENTRIES", ["AGENTS.md", "VERSION"]),
            ):
                plan = install_framework.build_plan(target)
                self.assertEqual((Path("VERSION"),), plan.create)
                self.assertEqual((Path("AGENTS.md"),), plan.conflicts)
                install_framework.apply_plan(target, plan)
            self.assertEqual("target\n", (target / "AGENTS.md").read_text(encoding="utf-8"))
            self.assertEqual("1.0.0\n", (target / "VERSION").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
