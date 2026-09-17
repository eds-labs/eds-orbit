# Engineering Principles

## Prioritäten

1. Korrektheit vor Geschwindigkeit.
2. Kleine, nachvollziehbare Änderungen.
3. Bestehende Architektur respektieren.
4. Domänenlogik klar platzieren, nicht zufällig in UI/Controller verstecken.
5. Keine unnötigen Abhängigkeiten.
6. Tests für neue oder geänderte Logik.
7. Fehler transparent benennen.
8. Keine stillen Breaking Changes.

## Vorgehen bei Unsicherheit

- Zuerst Codebasis untersuchen.
- Annahmen explizit machen.
- Minimal-invasive Lösung bevorzugen.
- Keine großen Refactorings ohne Anlass.
- Wenn mehrere Optionen existieren: kurz Trade-offs nennen und sichere Default-Option wählen.

## Scope Discipline

- Feature-Aufgabe ist kein Refactor-Projekt.
- Bugfix-Aufgabe ist kein Architekturumbau.
- Refactor-Aufgabe darf Verhalten nicht ändern.
- Dokumentationsänderungen nur ergänzen, wenn sie relevant sind.
