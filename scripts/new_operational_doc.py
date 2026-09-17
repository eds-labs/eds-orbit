#!/usr/bin/env python3
"""Create a simple operational document from a built-in template.

Examples:
    python scripts/new_operational_doc.py production-change "Add billing webhook"
    python scripts/new_operational_doc.py incident "Payment webhook failures"
"""
from __future__ import annotations

from pathlib import Path
import re
import sys
from datetime import date

ROOT = Path(__file__).resolve().parent.parent

TEMPLATE_MAP = {
    "production-change": ".agentic/templates/production-change-plan.md",
    "deployment": ".agentic/templates/deployment-plan.md",
    "db-migration": ".agentic/templates/db-migration-plan.md",
    "incident": ".agentic/templates/incident-runbook.md",
    "risk": ".agentic/templates/risk-assessment-advanced.md",
    "provider": ".agentic/templates/provider-evaluation.md",
}


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9äöüß]+", "-", value)
    value = value.strip("-")
    return value or "untitled"


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] not in TEMPLATE_MAP:
        print("Usage: python scripts/new_operational_doc.py <type> <title>")
        print("Types:", ", ".join(sorted(TEMPLATE_MAP)))
        return 2

    doc_type = sys.argv[1]
    title = " ".join(sys.argv[2:])
    root = ROOT
    template = root / TEMPLATE_MAP[doc_type]
    if not template.exists():
        print(f"Template not found: {template}")
        return 1

    out_dir = root / "docs" / "operations" / doc_type
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{date.today().isoformat()}-{slugify(title)}.md"
    if out.exists():
        print(f"Already exists: {out}")
        return 1

    content = template.read_text(encoding="utf-8")
    content = f"# {title}\n\n" + content
    out.write_text(content, encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
