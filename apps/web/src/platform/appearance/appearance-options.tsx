"use client";

import { useSyncExternalStore } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { Text } from "@/lib/i18n";
import {
  appearanceMode,
  appearanceModes,
  appearanceStorageKey,
  type AppearanceMode,
} from "./preference";

const changed = "orbit:appearance";
const choices = {
  light: { Icon: Sun, label: "appearanceLight" },
  dark: { Icon: Moon, label: "appearanceDark" },
  system: { Icon: Monitor, label: "appearanceSystem" },
} as const;

function applyMode(mode: AppearanceMode) {
  if (mode === "system") delete document.documentElement.dataset.appearance;
  else document.documentElement.dataset.appearance = mode;
}

function subscribe(onChange: () => void) {
  function storageChanged(event: StorageEvent) {
    if (event.key !== appearanceStorageKey && event.key !== null) return;
    applyMode(appearanceMode(event.newValue));
    onChange();
  }
  window.addEventListener("storage", storageChanged);
  window.addEventListener(changed, onChange);
  return () => {
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener(changed, onChange);
  };
}

function readMode() {
  return appearanceMode(document.documentElement.dataset.appearance);
}

function selectMode(mode: AppearanceMode) {
  applyMode(mode);
  try {
    window.localStorage.setItem(appearanceStorageKey, mode);
  } catch {
    // The selection still applies to this page.
  }
  window.dispatchEvent(new Event(changed));
}

export function AppearanceOptions({ t }: { t: Text }) {
  const mode = useSyncExternalStore(
    subscribe,
    readMode,
    () => "system" as const,
  );
  return (
    <div
      className="appearance-options"
      role="group"
      aria-label={t("appearance")}
    >
      <span className="appearance-label" aria-hidden="true">
        {t("appearance")}
      </span>
      {appearanceModes.map((choice) => {
        const { Icon, label } = choices[choice];
        return (
          <button
            key={choice}
            type="button"
            role="menuitemradio"
            aria-checked={mode === choice}
            className="user-menu-item appearance-option"
            onClick={() => selectMode(choice)}
          >
            <Icon aria-hidden="true" />
            <span>{t(label)}</span>
            {mode === choice && <Check aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
