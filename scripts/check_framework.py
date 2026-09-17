#!/usr/bin/env python3
"""Validate the integrated Codex Project Framework without dependencies.

Run from the repository root:
    python3 scripts/check_framework.py
"""

from __future__ import annotations

import argparse
import json
import re
import os
import sys
from pathlib import Path
from urllib.parse import unquote

try:
    import yaml
except ModuleNotFoundError:  # Optional local dependency; required in CI.
    yaml = None

try:
    from jsonschema import Draft202012Validator, FormatChecker
except ModuleNotFoundError:  # Optional local dependency; required in CI.
    Draft202012Validator = None
    FormatChecker = None


ROOT = Path(__file__).resolve().parent.parent

REQUIRED_FILES = [
    ".gitignore",
    "AGENTS.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "VERSION",
    "requirements-validation.txt",
    "scripts/install_framework.py",
    ".agentic/README.md",
    ".agentic/framework-version.yaml",
    ".agentic/project-profile.yaml",
    ".agentic/schemas/framework-version.schema.json",
    ".agentic/schemas/project-profile.schema.json",
    ".agentic/schemas/stack-preset.schema.json",
    ".github/workflows/framework-check.yml",
]

REQUIRED_DIRECTORIES = [
    ".agentic/routing",
    ".agentic/rules",
    ".agentic/agents",
    ".agentic/workflows",
    ".agentic/app-profiles",
    ".agentic/stack-presets",
    ".agentic/app-structures",
    ".agentic/environments",
    ".agentic/deployment-presets",
    ".agentic/quality-gates",
    ".agentic/config",
    ".agentic/database",
    ".agentic/security",
    ".agentic/observability",
    ".agentic/ci",
    ".agentic/contracts",
    ".agentic/testing",
    ".agentic/design",
    ".agentic/dependencies",
    ".agentic/governance",
    ".agentic/operations",
    ".agentic/compliance",
    ".agentic/repo-strategies",
    ".agentic/jobs",
    ".agentic/ai",
    ".agentic/templates",
    ".agentic/context",
    ".agentic/memory",
    ".agentic/schemas",
    ".agents/skills",
    "scripts",
    "tests",
    "docs/adr",
]

SKILL_SECTIONS = [
    "Name",
    "Zweck",
    "Auslöser",
    "Voraussetzungen",
    "Vorgehen",
    "Erwarteter Output",
    "Sicherheitsregeln",
    "Abschlusskriterien",
]

PROFILE_SCHEMA = {
    "project": ["name", "type", "stage", "description"],
    "stack": [
        "frontend",
        "backend",
        "database",
        "orm",
        "auth",
        "package_manager",
        "test_runner",
        "deployment",
    ],
    "architecture": ["style", "api_style", "repository_strategy"],
    "environment": ["default", "production_protected"],
    "commands": ["install", "dev", "lint", "typecheck", "test", "build"],
    "security": ["risk_level", "tenant_isolation", "secrets_policy"],
    "quality": ["required_checks", "documentation_required"],
}

WORKFLOWS = {
    "Feature": ["feature.md"],
    "Bugfix": ["bugfix.md"],
    "Refactor": ["refactor.md"],
    "Migration": ["migration.md"],
    "Release": ["release.md"],
    "Incident": ["incident.md", "incident-fix.md"],
    "Review": ["review.md", "pr-review.md"],
}

QUALITY_GATES = {
    "Definition of Done": ["definition-of-done.md"],
    "Review Checklist": ["review-checklist.md"],
    "Security Checklist": ["security-checklist.md"],
    "Production Readiness": ["production-readiness.md", "production-readiness-checklist.md"],
    "Stack Fit": ["stack-fit.md", "stack-fit-checklist.md"],
    "Release Checklist": ["release-checklist.md"],
}

OPERATIONAL_RULES = {
    "lokale Entwicklung": [".agentic/environments/local.md"],
    "Preview": [".agentic/environments/preview.md"],
    "Staging": [".agentic/environments/staging.md"],
    "Production": [".agentic/environments/production.md"],
    "Secrets": [".agentic/config/secrets-policy.md"],
    "Datenbankmigrationen": [".agentic/database/migration-policy.md"],
    "Backups": [".agentic/database/backup-policy.md"],
    "Rollbacks": [".agentic/database/rollback-policy.md"],
    "Logging": [".agentic/observability/logging.md"],
    "Monitoring": [".agentic/observability/metrics.md", ".agentic/observability/alerting.md"],
    "CI/CD": [".agentic/ci/required-checks.md", ".agentic/ci/release-pipeline.md"],
    "menschliche Freigaben": [".agentic/governance/human-approval.md"],
}

AGENTS_REFERENCES = [
    ".agentic/project-profile.yaml",
    ".agentic/routing/risk-classification.md",
    ".agentic/environments/",
    ".agentic/app-profiles/",
    ".agentic/routing/stack-selection.md",
    ".agentic/stack-presets/",
    ".agentic/app-structures/",
    ".agentic/workflows/",
    ".agentic/agents/",
    ".agents/skills/",
    ".agentic/security/",
    ".agentic/database/",
    ".agentic/quality-gates/",
    "menschliche freigabe",
]

REQUIRED_APP_PROFILES = [
    "ai-agent-app.md",
    "automation-script.md",
    "backend-api.md",
    "browser-extension.md",
    "cli-tool.md",
    "data-pipeline.md",
    "desktop-app.md",
    "fullstack-saas.md",
    "mobile-app.md",
    "web-frontend.md",
]

SCHEMA_TARGETS = {
    ".agentic/framework-version.yaml": ".agentic/schemas/framework-version.schema.json",
    ".agentic/project-profile.yaml": ".agentic/schemas/project-profile.schema.json",
}

FRAMEWORK_PATH_PREFIXES = (
    ".agentic/",
    ".agents/",
    ".codex/",
    ".github/",
    "docs/",
    "scripts/",
    "tests/",
)

SECRET_PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "AWS access key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "OpenAI-style key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "Slack token": re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    "Google API key": re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b"),
}

TEXT_SUFFIXES = {
    ".md",
    ".yaml",
    ".yml",
    ".py",
    ".toml",
    ".txt",
    ".example",
}


class Reporter:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.ok: list[str] = []

    def error(self, message: str) -> None:
        self.errors.append(message)
        print(f"[ERROR] {message}")

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        print(f"[WARN]  {message}")

    def success(self, message: str) -> None:
        self.ok.append(message)
        print(f"[OK]    {message}")


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


# Installed dependencies and local runtime outputs are not framework source.
# Keep all application/config/documentation sources under the original checks.
EXCLUDED_RUNTIME_DIRS = {".git", "node_modules", ".next", ".runtime", ".venv", "playwright-report", "test-results", "coverage"}

def source_paths(pattern: str = "*"):
    for directory, dirs, files in os.walk(ROOT):
        dirs[:] = [name for name in dirs if name not in EXCLUDED_RUNTIME_DIRS]
        for name in dirs + files:
            path = Path(directory) / name
            if path.match(pattern):
                yield path


def text_files() -> list[Path]:
    result: list[Path] = []
    for path in source_paths():
        if not path.is_file() or ".git" in path.parts:
            continue
        if path.suffix.lower() in TEXT_SUFFIXES or path.name in {"AGENTS.md", "VERSION"}:
            result.append(path)
    return sorted(result)


def top_level_scalar(text: str, key: str) -> str | None:
    match = re.search(rf"(?m)^{re.escape(key)}:\s*([^#\n]+?)\s*(?:#.*)?$", text)
    if not match:
        return None
    return match.group(1).strip().strip("'\"")


def nested_scalar(text: str, section: str, key: str) -> str | None:
    lines = text.splitlines()
    start = next((index for index, line in enumerate(lines) if line.rstrip() == f"{section}:"), None)
    if start is None:
        return None
    for line in lines[start + 1 :]:
        if line and not line.startswith((" ", "\t", "#")):
            break
        match = re.match(rf"^  {re.escape(key)}:\s*([^#\n]+?)\s*(?:#.*)?$", line)
        if match:
            return match.group(1).strip().strip("'\"")
    return None


def nested_keys(text: str, section: str) -> set[str]:
    lines = text.splitlines()
    start = next((index for index, line in enumerate(lines) if line.rstrip() == f"{section}:"), None)
    if start is None:
        return set()
    keys: set[str] = set()
    for line in lines[start + 1 :]:
        if line and not line.startswith((" ", "\t", "#")):
            break
        match = re.match(r"^  ([A-Za-z_][A-Za-z0-9_-]*):", line)
        if match:
            keys.add(match.group(1))
    return keys


def validate_yaml_basics(path: Path, reporter: Reporter) -> None:
    text = read_text(path)
    if not text.strip():
        reporter.error(f"Leere YAML-Datei: {relative(path)}")
        return
    if "\t" in text:
        reporter.error(f"Tab-Einrückung in YAML-Datei: {relative(path)}")
    top_keys: list[str] = []
    for number, raw_line in enumerate(text.splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if not raw_line.startswith((" ", "-")):
            match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):", raw_line)
            if not match:
                reporter.error(f"Offensichtlich ungültige YAML-Zeile: {relative(path)}:{number}")
            else:
                top_keys.append(match.group(1))
        if stripped.startswith("-") and stripped not in {"-", "---"} and not re.match(r"^-\s+\S", stripped):
            reporter.error(f"Ungültiger YAML-Listeneintrag: {relative(path)}:{number}")
    duplicates = sorted({key for key in top_keys if top_keys.count(key) > 1})
    if duplicates:
        reporter.error(f"Doppelte YAML-Schlüssel auf oberster Ebene in {relative(path)}: {', '.join(duplicates)}")


def check_required_structure(reporter: Reporter) -> None:
    missing_files = [item for item in REQUIRED_FILES if not (ROOT / item).is_file()]
    missing_dirs = [item for item in REQUIRED_DIRECTORIES if not (ROOT / item).is_dir()]
    for item in missing_files:
        reporter.error(f"Pflichtdatei fehlt: {item}")
    for item in missing_dirs:
        reporter.error(f"Pflichtverzeichnis fehlt: {item}")
    if not missing_files and not missing_dirs:
        reporter.success("Pflichtdateien und Pflichtverzeichnisse sind vollständig")

    for item in REQUIRED_FILES:
        path = ROOT / item
        if path.is_file() and not read_text(path).strip():
            reporter.error(f"Wichtige Datei ist leer: {item}")


def check_project_profile(reporter: Reporter) -> None:
    path = ROOT / ".agentic/project-profile.yaml"
    if not path.is_file():
        return
    text = read_text(path)
    for section, required_keys in PROFILE_SCHEMA.items():
        present = nested_keys(text, section)
        missing = [key for key in required_keys if key not in present]
        if missing:
            reporter.error(f"Projektprofil, Bereich {section}: fehlende Schlüssel {', '.join(missing)}")
    placeholder_count = text.count("REPLACE_ME")
    if placeholder_count:
        reporter.warn(
            f"Projektprofil ist eine neutrale Vorlage mit {placeholder_count} REPLACE_ME-Platzhaltern; "
            "vor Projektnutzung vollständig ausfüllen"
        )
    else:
        reporter.success("Projektprofil enthält alle Pflichtbereiche ohne Platzhalter")


def check_framework_version(reporter: Reporter) -> None:
    path = ROOT / ".agentic/framework-version.yaml"
    version_path = ROOT / "VERSION"
    if not path.is_file() or not version_path.is_file():
        return
    text = read_text(path)
    version = read_text(version_path).strip()
    metadata_version = nested_scalar(text, "framework", "version")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        reporter.error(f"VERSION ist keine gültige SemVer-Version: {version or '<leer>'}")
    if version != metadata_version:
        reporter.error(
            f"Versionsdrift: VERSION={version!r}, framework-version.yaml={metadata_version!r}"
        )

    component_errors: list[str] = []
    if yaml is not None:
        try:
            data = yaml.safe_load(text)
            components = data.get("components", {}) if isinstance(data, dict) else {}
            for component in ("agentic_scaffold", "stack_presets", "operational_governance"):
                if not isinstance(components.get(component), dict) or components[component].get("status") != "integrated":
                    component_errors.append(component)
        except Exception:
            component_errors = ["agentic_scaffold", "stack_presets", "operational_governance"]
    else:
        for component in ("agentic_scaffold", "stack_presets", "operational_governance"):
            pattern = rf"(?ms)^  {re.escape(component)}:\s*$.*?^    status:\s*[\"']?integrated[\"']?\s*$"
            if not re.search(pattern, text):
                component_errors.append(component)
    if component_errors:
        reporter.error(f"Komponenten nicht als integrated markiert: {', '.join(component_errors)}")
    elif version == metadata_version:
        reporter.success(f"Framework-Version {version} ist über VERSION und Framework-Metadaten konsistent")


def check_skills(reporter: Reporter) -> tuple[int, dict[str, Path]]:
    root = ROOT / ".agents/skills"
    skills: dict[str, Path] = {}
    if not root.is_dir():
        return 0, skills
    skill_dirs = sorted(path for path in root.iterdir() if path.is_dir())
    for directory in skill_dirs:
        file = directory / "SKILL.md"
        if not file.is_file():
            reporter.error(f"Skill-Verzeichnis ohne SKILL.md: {relative(directory)}")
            continue
        text = read_text(file)
        if not text.strip():
            reporter.error(f"Leere SKILL.md: {relative(file)}")
            continue
        name = top_level_scalar(text, "name")
        if not name:
            reporter.error(f"Skill ohne Frontmatter-Name: {relative(file)}")
            continue
        if name in skills:
            reporter.error(f"Doppelter Skill-Name {name}: {relative(skills[name])} und {relative(file)}")
        else:
            skills[name] = file
        if name != directory.name:
            reporter.error(f"Skill-Name und Verzeichnis weichen ab: {name} != {directory.name}")
        headings = set(re.findall(r"(?m)^## (.+?)\s*$", text))
        missing = [section for section in SKILL_SECTIONS if section not in headings]
        if missing:
            reporter.error(f"Skill {name} ohne Pflichtabschnitte: {', '.join(missing)}")
    if len(skills) == len(skill_dirs) and skill_dirs:
        reporter.success(f"{len(skills)} eindeutige Skills mit vollständigem Skill-Vertrag")
    return len(skills), skills


def check_stack_presets(reporter: Reporter) -> tuple[int, set[str]]:
    root = ROOT / ".agentic/stack-presets"
    preset_files = sorted(root.glob("*.yaml")) if root.is_dir() else []
    ids: dict[str, Path] = {}
    labels: dict[str, Path] = {}
    structure_refs: set[str] = set()
    required_keys = [
        "description",
        "application_type",
        "platforms",
        "recommended_tools",
        "testing",
        "structure_ref",
        "deployment_hint",
    ]
    for path in preset_files:
        text = read_text(path)
        preset_id = top_level_scalar(text, "id")
        label = top_level_scalar(text, "label")
        if not preset_id:
            reporter.error(f"Stack-Preset ohne id: {relative(path)}")
            continue
        if preset_id in ids:
            reporter.error(f"Doppelter Stack-Preset-Name {preset_id}: {relative(ids[preset_id])} und {relative(path)}")
        else:
            ids[preset_id] = path
        if preset_id != path.stem:
            reporter.error(f"Preset-ID und Dateiname weichen ab: {preset_id} != {path.stem}")
        if not label:
            reporter.error(f"Stack-Preset ohne label: {relative(path)}")
        elif label in labels:
            reporter.error(f"Doppeltes Stack-Preset-Label {label}: {relative(labels[label])} und {relative(path)}")
        else:
            labels[label] = path
        missing = [key for key in required_keys if not re.search(rf"(?m)^{re.escape(key)}:", text)]
        if missing:
            reporter.error(f"Stack-Preset {preset_id} ohne Pflichtfelder: {', '.join(missing)}")
        structure_ref = top_level_scalar(text, "structure_ref")
        if structure_ref:
            structure_refs.add(structure_ref)
            if not (ROOT / structure_ref).is_file():
                reporter.error(f"Stack-Preset {preset_id} verweist auf fehlende Struktur: {structure_ref}")
    if len(ids) == len(preset_files) and preset_files:
        reporter.success(f"{len(ids)} eindeutige Stack-Presets mit vollständigen Metadaten")
    return len(ids), structure_refs


def check_app_structures(structure_refs: set[str], reporter: Reporter) -> None:
    root = ROOT / ".agentic/app-structures"
    files = sorted(root.glob("*.md")) if root.is_dir() else []
    unreferenced = [relative(path) for path in files if relative(path) not in structure_refs]
    if unreferenced:
        for item in unreferenced:
            reporter.error(f"App-Struktur keinem Stack-Preset zugeordnet: {item}")
    elif files:
        reporter.success(f"Alle {len(files)} App-Strukturen sind einem Stack-Preset zugeordnet")


def check_workflows_and_gates(reporter: Reporter) -> tuple[int, int]:
    workflow_root = ROOT / ".agentic/workflows"
    for label, candidates in WORKFLOWS.items():
        if not any((workflow_root / candidate).is_file() for candidate in candidates):
            reporter.error(f"Pflichtworkflow fehlt: {label}")
    workflow_count = len(list(workflow_root.glob("*.md"))) if workflow_root.is_dir() else 0
    if all(any((workflow_root / candidate).is_file() for candidate in names) for names in WORKFLOWS.values()):
        reporter.success(f"Pflichtworkflows vollständig; {workflow_count} Workflows insgesamt")

    gate_root = ROOT / ".agentic/quality-gates"
    for label, candidates in QUALITY_GATES.items():
        if not any((gate_root / candidate).is_file() for candidate in candidates):
            reporter.error(f"Pflicht-Quality-Gate fehlt: {label}")
    gate_count = len(list(gate_root.glob("*.md"))) if gate_root.is_dir() else 0
    if all(any((gate_root / candidate).is_file() for candidate in names) for names in QUALITY_GATES.values()):
        reporter.success(f"Pflicht-Quality-Gates vollständig; {gate_count} Gates insgesamt")
    return workflow_count, gate_count


def check_operational_rules(reporter: Reporter) -> None:
    missing: list[str] = []
    for label, paths in OPERATIONAL_RULES.items():
        if not all((ROOT / path).is_file() for path in paths):
            missing.append(label)
            reporter.error(f"Betriebsregel fehlt oder ist unvollständig: {label}")
    if not missing:
        reporter.success("Betriebsregeln für Environments, Secrets, Datenbank, Observability, CI/CD und Freigaben vollständig")


def check_agents_references(reporter: Reporter) -> None:
    path = ROOT / "AGENTS.md"
    if not path.is_file():
        return
    text = read_text(path).lower()
    missing = [reference for reference in AGENTS_REFERENCES if reference.lower() not in text]
    if missing:
        reporter.error(f"AGENTS.md referenziert nicht alle Kernbereiche: {', '.join(missing)}")
    else:
        reporter.success("AGENTS.md referenziert Projektprofil, Routing, Profile, Presets, Rollen, Skills, Policies, Gates und Freigaben")


def check_app_profiles(reporter: Reporter) -> None:
    profile_root = ROOT / ".agentic/app-profiles"
    agents_text = read_text(ROOT / "AGENTS.md") if (ROOT / "AGENTS.md").is_file() else ""
    missing_files = [name for name in REQUIRED_APP_PROFILES if not (profile_root / name).is_file()]
    missing_routes = [name for name in REQUIRED_APP_PROFILES if f".agentic/app-profiles/{name}" not in agents_text]
    for name in missing_files:
        reporter.error(f"Pflicht-App-Profil fehlt: {name}")
    for name in missing_routes:
        reporter.error(f"AGENTS.md routet App-Profil nicht: {name}")
    if not missing_files and not missing_routes:
        reporter.success(f"Alle {len(REQUIRED_APP_PROFILES)} App-Profile existieren und sind in AGENTS.md geroutet")


def without_fenced_code(text: str) -> str:
    return re.sub(r"```.*?```|~~~.*?~~~", "", text, flags=re.DOTALL)


def check_markdown_links(reporter: Reporter) -> None:
    broken: list[str] = []
    for path in sorted(source_paths("*.md")):
        if ".git" in path.parts:
            continue
        text = without_fenced_code(read_text(path))
        for match in re.finditer(r"!?\[[^\]]*\]\(([^)]+)\)", text):
            raw_target = match.group(1).strip()
            if raw_target.startswith("<") and raw_target.endswith(">"):
                raw_target = raw_target[1:-1]
            target = raw_target.split(maxsplit=1)[0].split("#", 1)[0]
            if not target or re.match(r"^(?:[a-z][a-z0-9+.-]*:|/|#)", target, re.IGNORECASE):
                continue
            resolved = (path.parent / unquote(target)).resolve()
            try:
                resolved.relative_to(ROOT.resolve())
            except ValueError:
                continue
            if not resolved.exists():
                broken.append(f"{relative(path)} -> {target}")
    for item in broken:
        reporter.error(f"Defekter relativer Markdown-Verweis: {item}")
    if not broken:
        reporter.success("Keine offensichtlich defekten relativen Markdown-Verweise")


def check_backtick_paths(reporter: Reporter) -> None:
    broken: set[str] = set()
    ignored_documents = {ROOT / "docs/framework-merge-report.md"}
    root_files = {"AGENTS.md", "README.md", "MANIFEST.md", "VERSION", "CHANGELOG.md"}
    for path in sorted(source_paths("*.md")):
        if ".git" in path.parts or path in ignored_documents:
            continue
        text = without_fenced_code(read_text(path))
        for raw_target in re.findall(r"`([^`]+)`", text):
            target = raw_target.strip().split("#", 1)[0]
            if (
                not target
                or "..." in target
                or any(character in target for character in "<>|{}")
                or " " in target
            ):
                continue
            if not (target.startswith(FRAMEWORK_PATH_PREFIXES) or target in root_files):
                continue
            if "*" in target or "?" in target or "[" in target:
                if not list(ROOT.glob(target)):
                    broken.add(f"{relative(path)} -> {target}")
            elif not (ROOT / target).exists():
                broken.add(f"{relative(path)} -> {target}")
    for item in sorted(broken):
        reporter.error(f"Defekter Framework-Pfad in Backticks: {item}")
    if not broken:
        reporter.success("Alle root-relativen Framework-Pfade in Backticks sind auflösbar")


def check_hygiene(reporter: Reporter) -> None:
    temporary_names = {
        "tmp",
        "temp",
        "temporary",
        "extract",
        "extracted",
        "unpacked",
        "merge-temp",
        "__pycache__",
    }
    suspicious_token = re.compile(r"(?:^|[._ -])(copy|backup|old|temp|conflict)(?:$|[._ -])", re.IGNORECASE)
    duplicate_suffix = re.compile(r"\s+\d+(?=\.[^.]+$)")
    temporary_dirs: list[str] = []
    suspicious_files: list[str] = []
    allowed_policy_names = {"backup-policy.md"}
    for path in source_paths():
        if ".git" in path.parts:
            continue
        if path.is_dir() and (path.name.lower() in temporary_names or path.name.lower().endswith(".egg-info")):
            temporary_dirs.append(relative(path))
        if path.is_file() and path.name not in allowed_policy_names and relative(path) not in {"docs/BACKUP_RESTORE.md", "docs/BACKUP_RESTORE_TEST_RESULT.json", "scripts/backup-restore-test.ts"} and (
            suspicious_token.search(path.name) or duplicate_suffix.search(path.name)
        ):
            suspicious_files.append(relative(path))
    for item in temporary_dirs:
        reporter.error(f"Temporäres Entpackverzeichnis vorhanden: {item}")
    for item in suspicious_files:
        reporter.error(f"Verdächtiger Dateiname (copy/backup/old/temp/conflict oder nummeriertes Duplikat): {item}")

    markers: list[str] = []
    secrets: list[str] = []
    for path in text_files():
        text = read_text(path)
        if re.search(r"(?m)^(?:<{7}|={7}|>{7})(?:\s|$)", text):
            markers.append(relative(path))
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(text):
                secrets.append(f"{relative(path)} ({label})")
    for item in markers:
        reporter.error(f"Konfliktmarker gefunden: {item}")
    for item in secrets:
        reporter.error(f"Mögliches echtes Secret gefunden: {item}")
    if not temporary_dirs and not suspicious_files and not markers and not secrets:
        reporter.success("Keine temporären Verzeichnisse, verdächtigen Duplikate, Konfliktmarker oder bekannten Secret-Muster")


def validate_with_schema(data: object, schema_path: Path, target_path: Path, reporter: Reporter) -> None:
    if Draft202012Validator is None or FormatChecker is None:
        return
    schema = json.loads(read_text(schema_path))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(data), key=lambda error: list(error.absolute_path))
    for error in errors:
        location = ".".join(str(item) for item in error.absolute_path) or "<root>"
        reporter.error(f"Schemafehler in {relative(target_path)} bei {location}: {error.message}")


def check_yaml_files(reporter: Reporter, require_full_validation: bool) -> None:
    yaml_files = sorted(list(source_paths("*.yaml")) + list(source_paths("*.yml")))
    yaml_files = [path for path in yaml_files if ".git" not in path.parts]
    for path in yaml_files:
        validate_yaml_basics(path, reporter)
    if yaml is None:
        message = "PyYAML fehlt; vollständiges YAML-Parsing und Schema-Validierung wurden nicht ausgeführt"
        if require_full_validation:
            reporter.error(message)
        else:
            reporter.warn(f"{message}. Installiere optional: python -m pip install -r requirements-validation.txt")
        return

    parsed: dict[Path, object] = {}
    for path in yaml_files:
        try:
            parsed[path] = yaml.safe_load(read_text(path))
        except Exception as error:
            reporter.error(f"Ungültiges YAML in {relative(path)}: {error}")

    if Draft202012Validator is None or FormatChecker is None:
        message = "jsonschema fehlt; formale Schema-Validierung wurde nicht ausgeführt"
        if require_full_validation:
            reporter.error(message)
        else:
            reporter.warn(f"{message}. Installiere optional: python -m pip install -r requirements-validation.txt")
    else:
        schema_error_count = len(reporter.errors)
        for target, schema in SCHEMA_TARGETS.items():
            target_path = ROOT / target
            if target_path in parsed:
                validate_with_schema(parsed[target_path], ROOT / schema, target_path, reporter)
        stack_schema = ROOT / ".agentic/schemas/stack-preset.schema.json"
        for target_path in sorted((ROOT / ".agentic/stack-presets").glob("*.yaml")):
            if target_path in parsed:
                validate_with_schema(parsed[target_path], stack_schema, target_path, reporter)
        if len(reporter.errors) == schema_error_count:
            reporter.success("Projektprofil, Framework-Version und alle Stack-Presets gegen JSON Schema geprüft")

    if len(parsed) == len(yaml_files):
        reporter.success(f"{len(yaml_files)} YAML-Dateien vollständig geparst")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-full-validation",
        action="store_true",
        help="Fehlschlagen, wenn PyYAML oder jsonschema für die vollständige Validierung fehlen.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    reporter = Reporter()
    print("Codex Project Framework Check")
    print("=" * 36)

    check_required_structure(reporter)
    check_project_profile(reporter)
    check_framework_version(reporter)
    skill_count, _ = check_skills(reporter)
    preset_count, structure_refs = check_stack_presets(reporter)
    check_app_structures(structure_refs, reporter)
    workflow_count, gate_count = check_workflows_and_gates(reporter)
    check_operational_rules(reporter)
    check_agents_references(reporter)
    check_app_profiles(reporter)
    check_markdown_links(reporter)
    check_backtick_paths(reporter)
    check_hygiene(reporter)
    check_yaml_files(reporter, args.require_full_validation)

    integrated_files = sum(1 for path in source_paths() if path.is_file() and ".git" not in path.parts)
    print("\nInventory")
    print(f"  Integrated files: {integrated_files}")
    print(f"  Skills: {skill_count}")
    print(f"  Stack presets: {preset_count}")
    print(f"  Workflows: {workflow_count}")
    print(f"  Quality gates: {gate_count}")
    print("\nResult")
    print(f"  Errors: {len(reporter.errors)}")
    print(f"  Warnings: {len(reporter.warnings)}")
    if reporter.errors:
        print("  Status: FAILED")
        return 1
    print("  Status: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
