import {
  LANGUAGE_CODE_PATTERN,
  MAX_CONTENT_LANGUAGES,
  normalizeLanguageCode,
  type ProjectLink,
} from "./catalog";

// Pure editing steps of the project settings editors, tested without a DOM.

export type LanguageState = { languages: string[]; defaultLanguage: string };
export type LanguageError =
  | "invalidCode"
  | "duplicateLanguage"
  | "tooManyLanguages"
  | "oneLanguageRequired";

export function addLanguage(
  state: LanguageState,
  raw: string,
): LanguageState | { error: LanguageError } {
  const code = normalizeLanguageCode(raw);
  if (!LANGUAGE_CODE_PATTERN.test(code)) return { error: "invalidCode" };
  if (state.languages.includes(code)) return { error: "duplicateLanguage" };
  if (state.languages.length >= MAX_CONTENT_LANGUAGES)
    return { error: "tooManyLanguages" };
  return { ...state, languages: [...state.languages, code] };
}

/** Removing the default makes the first remaining language the default. */
export function removeLanguage(
  state: LanguageState,
  code: string,
): LanguageState | { error: LanguageError } {
  const languages = state.languages.filter((l) => l !== code);
  if (!languages.length) return { error: "oneLanguageRequired" };
  return {
    languages,
    defaultLanguage:
      state.defaultLanguage === code ? languages[0]! : state.defaultLanguage,
  };
}

export function setDefaultLanguage(
  state: LanguageState,
  code: string,
): LanguageState {
  return state.languages.includes(code)
    ? { ...state, defaultLanguage: code }
    : state;
}

/** The list with the link at `index` moved by `delta` (-1 up, +1 down). */
export function moveLink(
  links: readonly ProjectLink[],
  index: number,
  delta: -1 | 1,
): ProjectLink[] {
  const target = index + delta;
  if (target < 0 || target >= links.length) return [...links];
  const next = [...links];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Links as the server takes them: names and addresses trimmed. */
export function cleanLinks(links: readonly ProjectLink[]): ProjectLink[] {
  return links.map((l) => ({
    type: l.type,
    label: l.label.trim(),
    url: l.url.trim(),
  }));
}
