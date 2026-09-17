# Environment Variable Policy

## Regeln

- Neue Env Vars müssen in `.env.example` dokumentiert werden.
- Keine echten Secrets in `.env.example`.
- Client-seitige Variablen brauchen bewusste Freigabe.
- Runtime Validation bevorzugen.
- Env Vars pro Umgebung trennen.

## Naming

- Public Browser Values: `NEXT_PUBLIC_*`, `PUBLIC_*` oder stack-spezifisch
- Server-only Secrets: niemals mit Public-Präfix
- Provider Keys: `<PROVIDER>_<PURPOSE>_KEY`
- URLs: `<SERVICE>_URL`

## Codex-Regel

Wenn eine Änderung eine neue Env Var benötigt, muss Codex:

1. `.env.example` aktualisieren.
2. Dokumentation ergänzen.
3. server/client Sichtbarkeit prüfen.
4. Start-/Build-Fehler bei fehlender Variable berücksichtigen.
