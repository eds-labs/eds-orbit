from __future__ import annotations

import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path


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


check_framework = load_script("check_framework")


def quietly(callback, *args):
    with redirect_stdout(io.StringIO()):
        return callback(*args)


class FrameworkCheckTests(unittest.TestCase):
    def test_dependency_runtime_is_excluded_but_source_still_checked(self) -> None:
        self.write("node_modules/vendor/old-copy.md", "external package")
        self.write(".runtime/private.env", "local runtime")
        self.write("apps/api/guide-old.md", "source duplicate")
        reporter = check_framework.Reporter()
        quietly(check_framework.check_hygiene, reporter)
        self.assertEqual(1, len(reporter.errors))
        self.assertIn("apps/api/guide-old.md", reporter.errors[0])

    def test_required_restore_runbook_is_not_a_duplicate_backup(self) -> None:
        self.write("docs/BACKUP_RESTORE.md", "# Restore runbook\n")
        self.write("docs/BACKUP_RESTORE_TEST_RESULT.json", "{}")
        self.write("scripts/backup-restore-test.ts", "// Restore acceptance source")
        reporter = check_framework.Reporter()
        quietly(check_framework.check_hygiene, reporter)
        self.assertEqual([], reporter.errors)
        self.write("docs/guide-backup.md", "unintended duplicate")
        reporter = check_framework.Reporter()
        quietly(check_framework.check_hygiene, reporter)
        self.assertTrue(any("guide-backup.md" in message for message in reporter.errors))

    def setUp(self) -> None:
        self.original_root = check_framework.ROOT
        self.temp_directory = tempfile.TemporaryDirectory()
        check_framework.ROOT = Path(self.temp_directory.name)

    def tearDown(self) -> None:
        check_framework.ROOT = self.original_root
        self.temp_directory.cleanup()

    def write(self, relative_path: str, content: str) -> Path:
        path = check_framework.ROOT / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def create_version_files(self, version: str, metadata_version: str | None = None) -> None:
        self.write("VERSION", f"{version}\n")
        self.write(
            ".agentic/framework-version.yaml",
            "framework:\n"
            f'  version: "{metadata_version or version}"\n'
            "components:\n"
            "  agentic_scaffold:\n"
            '    status: "integrated"\n'
            "  stack_presets:\n"
            '    status: "integrated"\n'
            "  operational_governance:\n"
            '    status: "integrated"\n',
        )

    def test_consistent_dynamic_version_passes(self) -> None:
        self.create_version_files("2.3.4")
        reporter = check_framework.Reporter()

        quietly(check_framework.check_framework_version, reporter)

        self.assertEqual([], reporter.errors)
        self.assertTrue(any("2.3.4" in message for message in reporter.ok))

    def test_version_drift_fails(self) -> None:
        self.create_version_files("2.3.4", metadata_version="2.3.5")
        reporter = check_framework.Reporter()

        quietly(check_framework.check_framework_version, reporter)

        self.assertTrue(any("Versionsdrift" in message for message in reporter.errors))

    def test_backtick_path_check_finds_missing_root_path(self) -> None:
        self.write("docs/guide.md", "Nutze `.agentic/missing.md`.\n")
        reporter = check_framework.Reporter()

        quietly(check_framework.check_backtick_paths, reporter)

        self.assertTrue(any(".agentic/missing.md" in message for message in reporter.errors))

    def test_backtick_path_check_accepts_existing_glob_and_ellipsis(self) -> None:
        self.write(".agents/skills/example/SKILL.md", "# Example\n")
        self.write("docs/guide.md", "Nutze `.agents/skills/*/SKILL.md` und `.agentic/rules/...`.\n")
        reporter = check_framework.Reporter()

        quietly(check_framework.check_backtick_paths, reporter)

        self.assertEqual([], reporter.errors)

    def test_basic_yaml_check_rejects_obvious_invalid_line(self) -> None:
        path = self.write("broken.yaml", "valid: true\nnot yaml\n")
        reporter = check_framework.Reporter()

        quietly(check_framework.validate_yaml_basics, path, reporter)

        self.assertTrue(any("ungültige YAML-Zeile" in message for message in reporter.errors))


if __name__ == "__main__":
    unittest.main()
