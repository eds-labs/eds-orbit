#!/usr/bin/env python3
"""Create a dated task brief under .agentic/tasks/ from the template."""
from pathlib import Path
from datetime import date
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / ".agentic/templates/task-brief.md"
TASK_DIR = ROOT / ".agentic/tasks"

def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9äöüß]+", "-", value)
    value = value.strip("-")
    return value or "task"

def main() -> int:
    if not TEMPLATE.exists():
        print("Missing .agentic/templates/task-brief.md", file=sys.stderr)
        return 1
    title = " ".join(sys.argv[1:]).strip()
    if not title:
        print("Usage: scripts/new_task.py <task title>", file=sys.stderr)
        return 2
    TASK_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{date.today().isoformat()}-{slugify(title)}.md"
    target = TASK_DIR / filename
    if target.exists():
        print(f"Task already exists: {target}", file=sys.stderr)
        return 3
    content = TEMPLATE.read_text(encoding="utf-8")
    content = content.replace("# Task Brief", f"# Task Brief — {title}", 1)
    target.write_text(content, encoding="utf-8")
    print(target)
    return 0

if __name__ == "__main__":
    sys.exit(main())
