import type { Locale } from "@/lib/i18n";

export const widgetText = (locale: Locale) =>
  locale === "de"
    ? {
        dashboard: "Dashboard",
        customize: "Dashboard anpassen",
        add: "Widget hinzufügen",
        added: "Hinzugefügt",
        catalog: "Widget-Katalog",
        catalogEmpty: "Für dieses Projekt sind keine Widgets verfügbar.",
        empty: "Dieses Dashboard enthält keine Widgets.",
        move: "Widget verschieben",
        options: "Widget-Optionen",
        size: "Größe",
        compact: "Kompakt",
        wide: "Breit",
        earlier: "Nach vorne",
        later: "Nach hinten",
        remove: "Entfernen",
        save: "Speichern",
        saving: "Wird gespeichert …",
        saved: "Dashboard gespeichert.",
        cancel: "Abbrechen",
        restore: "Standard wiederherstellen",
        retry: "Erneut versuchen",
        loadError: "Das gespeicherte Dashboard konnte nicht geladen werden.",
        unavailable: "Dieses Widget konnte nicht geladen werden.",
        saveError:
          "Das Dashboard konnte nicht gespeichert werden. Dein Entwurf bleibt geöffnet.",
        conflict:
          "Das Dashboard wurde inzwischen auf einem anderen Gerät oder Tab geändert.",
        reload: "Aktuelles Layout laden und Entwurf verwerfen",
        limit: "Das Dashboard hat die maximale Anzahl an Widgets erreicht.",
        instructions:
          "Drücke die Leertaste, um ein Widget aufzunehmen. Links und oben gehen zur vorherigen Position, rechts und unten zur nächsten. Drücke erneut die Leertaste zum Ablegen oder Escape zum Abbrechen.",
        pickedUp: (title: string) => `${title} aufgenommen.`,
        at: (title: string, index: number, count: number) =>
          `${title} an Position ${index} von ${count}.`,
        dragCanceled: "Verschieben abgebrochen.",
      }
    : {
        dashboard: "Dashboard",
        customize: "Customize dashboard",
        add: "Add widget",
        added: "Added",
        catalog: "Widget catalog",
        catalogEmpty: "No widgets are available in this project.",
        empty: "This dashboard has no widgets.",
        move: "Move widget",
        options: "Widget options",
        size: "Size",
        compact: "Compact",
        wide: "Wide",
        earlier: "Move earlier",
        later: "Move later",
        remove: "Remove",
        save: "Save",
        saving: "Saving…",
        saved: "Dashboard saved.",
        cancel: "Cancel",
        restore: "Restore default",
        retry: "Try again",
        loadError: "Your saved dashboard could not be loaded.",
        unavailable: "This widget could not be loaded.",
        saveError:
          "The dashboard could not be saved. Your draft is still open.",
        conflict:
          "The dashboard has changed in another tab or on another device.",
        reload: "Load current layout and discard draft",
        limit: "This dashboard has reached its widget limit.",
        instructions:
          "Press Space to pick up a widget. Left and up move to the previous position, right and down to the next. Press Space again to drop it or Escape to cancel.",
        pickedUp: (title: string) => `Picked up ${title}.`,
        at: (title: string, index: number, count: number) =>
          `${title} at position ${index} of ${count}.`,
        dragCanceled: "Move canceled.",
      };
