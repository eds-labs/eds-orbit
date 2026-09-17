#!/usr/bin/env python3
"""Small structural check for the Operational Governance add-on.

Run from project root:
    python scripts/agentic_ops_check.py
"""
from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent

REQUIRED = [
    ".agentic/routing/risk-classification.md",
    ".agentic/environments/production.md",
    ".agentic/config/secrets-policy.md",
    ".agentic/database/migration-policy.md",
    ".agentic/security/roles-and-permissions.md",
    ".agentic/security/tenant-isolation.md",
    ".agentic/observability/error-handling.md",
    ".agentic/ci/required-checks.md",
    ".agentic/templates/project-bootstrap-questionnaire.md",
    ".agentic/quality-gates/production-readiness-checklist.md",
]

RECOMMENDED_SKILLS = [
    ".agents/skills/risk-review/SKILL.md",
    ".agents/skills/production-change/SKILL.md",
    ".agents/skills/db-migration-review/SKILL.md",
    ".agents/skills/deployment-plan/SKILL.md",
]

KEYWORDS_FOR_AGENTS = [
    "risk-classification",
    "Operational Governance",
    "human approval",
    "Production",
]


def main() -> int:
    root = ROOT
    missing = [p for p in REQUIRED if not (root / p).exists()]
    missing_skills = [p for p in RECOMMENDED_SKILLS if not (root / p).exists()]

    print("Agentic Operational Governance Check")
    print("=" * 42)

    if missing:
        print("\nMissing required files:")
        for p in missing:
            print(f"  - {p}")
    else:
        print("\nRequired files: OK")

    if missing_skills:
        print("\nMissing recommended Codex skills:")
        for p in missing_skills:
            print(f"  - {p}")
    else:
        print("Recommended skills: OK")

    agents = root / "AGENTS.md"
    if agents.exists():
        text = agents.read_text(encoding="utf-8", errors="ignore")
        hits = [k for k in KEYWORDS_FOR_AGENTS if k.lower() in text.lower()]
        if hits:
            print("AGENTS.md operational snippet: looks present")
        else:
            print("AGENTS.md operational snippet: not detected")
            print("  Suggestion: integrate risk, environment, production and human-approval rules into AGENTS.md")
    else:
        print("AGENTS.md: missing")

    if missing:
        print("\nResult: incomplete")
        return 1

    print("\nResult: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
