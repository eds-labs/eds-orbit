# Branch Policy — EDS Orbit

## Owner-approved workflow (2026-10-19)

- Commit and push routine authorized changes directly to `main`.
- No required pull request, merge queue or pre-push CI status checks.
- Use isolated worktrees where concurrent work needs protection, then integrate the current `origin/main` and push a fast-forward to `main`.
- Never force-push or overwrite unrelated changes.
- Run the relevant local quality checks and report their results. GitHub Actions runs after pushes as background feedback.
- Production deployment and other consequential operations still require their own explicit authorization.

## Versioning

- SemVer for libraries/APIs.
- App versions for mobile/desktop.
- Uniquely versioned migrations.
