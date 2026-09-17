# Workflow: Bugfix

## 1. Reproduktion

- Fehlerbeschreibung zusammenfassen.
- Reproduktionspfad finden.
- Logs/Stacktraces prüfen.
- Erwartetes vs. tatsächliches Verhalten notieren.

## 2. Ursache

- Root Cause identifizieren.
- Nicht nur Symptom patchen.
- Ähnliche Stellen suchen.

## 3. Fix

- Kleinste sichere Änderung.
- Regressionstest hinzufügen.
- Keine breiten Refactorings.

## 4. Verifikation

- Test, der vorher fehlschlagen würde und nachher besteht.
- Relevante bestehende Tests ausführen.

## Output

- Root Cause
- Fix
- Regressionstest
- Verifikation
