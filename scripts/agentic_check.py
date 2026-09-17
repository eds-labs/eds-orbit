#!/usr/bin/env python3
"""Lightweight scaffold check for the Codex Agentic Coding Scaffold.

No external dependencies. It verifies that the important files exist and prints
next steps for customization. It does not execute project commands.
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = [
    "AGENTS.md",
    ".agentic/project-profile.yaml",
    ".agentic/rules/engineering-principles.md",
    ".agentic/rules/testing.md",
    ".agentic/rules/security.md",
    ".agentic/quality-gates/definition-of-done.md",
    ".agents/skills/agentic-feature/SKILL.md",
    ".agents/skills/agentic-bugfix/SKILL.md",
]

OPTIONAL = [
    ".codex/config.toml",
    ".codex/config.example.toml",
    ".github/pull_request_template.md",
]

def main() -> int:
    missing = [p for p in REQUIRED if not (ROOT / p).exists()]
    print("Codex Agentic Scaffold Check")
    print("=" * 34)
    if missing:
        print("Missing required files:")
        for p in missing:
            print(f"  - {p}")
        return 1

    print("Required files: OK")
    print("\nOptional files:")
    for p in OPTIONAL:
        status = "OK" if (ROOT / p).exists() else "not present"
        print(f"  - {p}: {status}")

    profile = ROOT / ".agentic/project-profile.yaml"
    text = profile.read_text(encoding="utf-8", errors="replace")
    if "REPLACE_ME" in text:
        print("\nNext step: edit .agentic/project-profile.yaml and replace REPLACE_ME placeholders.")
    else:
        print("\nProject profile appears customized.")

    print("\nSuggested Codex prompt:")
    print("Nutze das Agentic-Coding-Gerüst, lies AGENTS.md und project-profile.yaml, wähle App-Profil und Workflow, plane zuerst.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
