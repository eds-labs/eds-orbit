"use client";
import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  Languages,
  Link2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { action, useMutation, type Project } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge, Button, Input } from "@/components/ui/primitives";
import {
  AGENT_CONTENT_LANGUAGES,
  COMMON_CONTENT_LANGUAGES,
  LINK_GROUP_LABELS,
  LINK_TYPE_LABELS,
  MAX_PROJECT_LINKS,
  PROJECT_LINK_TYPES,
  languageName,
  linkProblems,
  projectLinksOf,
  type LinkProblem,
  type ProjectLink,
  type ProjectLinkGroup,
  type ProjectLinkType,
} from "./catalog";
import {
  addLanguage,
  cleanLinks,
  moveLink,
  removeLanguage,
  setDefaultLanguage,
  type LanguageState,
} from "./editing";
import { projectSettingsText, type ProjectSettingsTextKey } from "./texts";

// The project-wide content languages and profile links (Settings → Project,
// plans/project-configuration-i18n.md). Owners edit; everyone else reads.
// Both save through the owner action "project-settings".

type Props = { project: Project; isOwner: boolean; locale: Locale };

/** The project's languages, the default first-class even for old data. */
export function languagesOf(
  project: Pick<Project, "language" | "contentLanguages">,
) {
  const list = project.contentLanguages?.length
    ? [...project.contentLanguages]
    : [project.language];
  return list.includes(project.language) ? list : [project.language, ...list];
}

/**
 * The project's content languages as select options (the default first),
 * keeping `current` (an existing record's language) even when it is no
 * longer a project language.
 */
export function contentLanguageOptions(
  project: Pick<Project, "language" | "contentLanguages">,
  locale: Locale,
  current?: string,
) {
  const codes = languagesOf(project).sort((a, b) =>
    a === project.language ? -1 : b === project.language ? 1 : 0,
  );
  if (current && !codes.includes(current)) codes.push(current);
  return codes.map((code) => ({
    value: code,
    label: `${languageName(code, locale)} (${code})`,
  }));
}

function saveSettings(project: Project, change: Record<string, unknown>) {
  return action(project.id, "project-settings", {
    name: project.name,
    timezone: project.timezone,
    ...change,
  });
}

export function ContentLanguagesPanel({ project, isOwner, locale }: Props) {
  const text = projectSettingsText(locale);
  const saved: LanguageState = {
    languages: languagesOf(project),
    defaultLanguage: project.language,
  };
  const [draft, setDraft] = useState<LanguageState | null>(null);
  const [problem, setProblem] = useState<ProjectSettingsTextKey | null>(null);
  const [custom, setCustom] = useState("");
  const mutation = useMutation();
  const state = draft ?? saved;
  const apply = (next: LanguageState | { error: ProjectSettingsTextKey }) => {
    if ("error" in next) setProblem(next.error);
    else {
      setProblem(null);
      setDraft(next);
    }
  };
  const nonAgent = state.languages.filter(
    (l) => !(AGENT_CONTENT_LANGUAGES as readonly string[]).includes(l),
  );
  return (
    <section
      className="panel project-config-panel"
      aria-labelledby="content-languages"
    >
      <div className="panel-head">
        <div>
          <h2 id="content-languages">
            <Languages aria-hidden className="panel-title-icon" />
            {text("languagesHeading")}
          </h2>
          <p>{text("languagesHint")}</p>
        </div>
        {isOwner && !draft && (
          <Button variant="outline" size="sm" onClick={() => setDraft(saved)}>
            <Pencil data-icon="inline-start" />
            {text("edit")}
          </Button>
        )}
      </div>
      <div className="panel-body">
        {!draft ? (
          <ul className="language-chips" aria-label={text("languagesHeading")}>
            {state.languages.map((code) => (
              <li key={code} className="language-chip">
                <span>{languageName(code, locale)}</span>
                <code>{code}</code>
                {code === state.defaultLanguage && (
                  <Badge tone="blue">{text("defaultBadge")}</Badge>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="project-config-editor">
            <fieldset className="language-edit-list">
              <legend>{text("defaultLanguage")}</legend>
              {state.languages.map((code) => (
                <div key={code} className="language-edit-row">
                  <label>
                    <input
                      type="radio"
                      name="default-content-language"
                      checked={code === state.defaultLanguage}
                      onChange={() => setDraft(setDefaultLanguage(state, code))}
                    />
                    <span>{languageName(code, locale)}</span>
                    <code>{code}</code>
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${text("removeLanguage")}: ${languageName(code, locale)}`}
                    onClick={() => apply(removeLanguage(state, code))}
                  >
                    <X />
                  </Button>
                </div>
              ))}
            </fieldset>
            <div className="language-add">
              <label className="field">
                <span className="field-label">{text("addLanguage")}</span>
                <select
                  className="input"
                  value=""
                  onChange={(e) =>
                    e.target.value && apply(addLanguage(state, e.target.value))
                  }
                >
                  <option value="">{text("chooseLanguage")}</option>
                  {COMMON_CONTENT_LANGUAGES.filter(
                    (c) => !state.languages.includes(c),
                  )
                    .map((c) => ({ c, name: languageName(c, locale) }))
                    .sort((a, b) => a.name.localeCompare(b.name, locale))
                    .map(({ c, name }) => (
                      <option key={c} value={c}>
                        {name} ({c})
                      </option>
                    ))}
                </select>
              </label>
              <form
                className="field"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = addLanguage(state, custom);
                  apply(next);
                  if (!("error" in next)) setCustom("");
                }}
              >
                <label className="field-label" htmlFor="custom-language-code">
                  {text("otherCode")}
                </label>
                <div className="inline-input">
                  <Input
                    id="custom-language-code"
                    value={custom}
                    maxLength={20}
                    placeholder="pt-BR"
                    onChange={(e) => setCustom(e.target.value)}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={!custom.trim()}
                  >
                    {text("addCode")}
                  </Button>
                </div>
                <small className="field-hint">{text("otherCodeHint")}</small>
              </form>
            </div>
            {problem && <Alert kind="error">{text(problem)}</Alert>}
            {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
            <div className="panel-actions">
              <Button
                disabled={mutation.pending}
                onClick={() =>
                  void mutation
                    .run(() =>
                      saveSettings(project, {
                        contentLanguages: state.languages,
                        defaultContentLanguage: state.defaultLanguage,
                      }),
                    )
                    .then((result) => {
                      if (result) window.location.reload();
                    })
                }
              >
                {mutation.pending ? text("saving") : text("save")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(null);
                  setProblem(null);
                }}
              >
                {text("cancel")}
              </Button>
            </div>
          </div>
        )}
        {nonAgent.length > 0 && (
          <p className="panel-note">{text("agentLanguagesNote")}</p>
        )}
        {!isOwner && <p className="panel-note">{text("ownerOnly")}</p>}
      </div>
    </section>
  );
}

const PROBLEM_TEXT: Record<LinkProblem, ProjectSettingsTextKey> = {
  label_required: "labelRequired",
  url_invalid: "urlInvalid",
  https_required: "httpsRequired",
  host_mismatch: "hostMismatch",
  duplicate: "duplicateUrl",
};
const GROUPS: ProjectLinkGroup[] = ["web", "social", "app", "other"];
const typesOf = (group: ProjectLinkGroup) =>
  (Object.keys(PROJECT_LINK_TYPES) as ProjectLinkType[]).filter(
    (type) => PROJECT_LINK_TYPES[type].group === group,
  );

export function ProfileLinksPanel({ project, isOwner, locale }: Props) {
  const text = projectSettingsText(locale);
  const saved = projectLinksOf(project.links);
  const [draft, setDraft] = useState<ProjectLink[] | null>(null);
  const [checked, setChecked] = useState(false);
  const mutation = useMutation();
  const problems = draft ? linkProblems(draft) : [];
  const change = (index: number, patch: Partial<ProjectLink>) =>
    setDraft((links) =>
      (links ?? []).map((link, i) => {
        if (i !== index) return link;
        const next = { ...link, ...patch };
        // A new platform names its own default label while the old one was untouched.
        if (patch.type && link.label === LINK_TYPE_LABELS[link.type][locale])
          next.label =
            patch.type === "custom" ? "" : LINK_TYPE_LABELS[patch.type][locale];
        return next;
      }),
    );
  return (
    <section
      className="panel project-config-panel"
      aria-labelledby="profile-links"
    >
      <div className="panel-head">
        <div>
          <h2 id="profile-links">
            <Link2 aria-hidden className="panel-title-icon" />
            {text("linksHeading")}
          </h2>
          <p>{text("linksHint")}</p>
        </div>
        {isOwner && !draft && (
          <Button variant="outline" size="sm" onClick={() => setDraft(saved)}>
            <Pencil data-icon="inline-start" />
            {text("edit")}
          </Button>
        )}
      </div>
      <div className="panel-body">
        <p className="panel-note">{text("linksChannelsNote")}</p>
        {!draft ? (
          saved.length ? (
            GROUPS.filter((g) =>
              saved.some((l) => PROJECT_LINK_TYPES[l.type].group === g),
            ).map((group) => (
              <div key={group} className="link-group">
                <h3>{LINK_GROUP_LABELS[group][locale]}</h3>
                <ul className="profile-link-list">
                  {saved
                    .filter((l) => PROJECT_LINK_TYPES[l.type].group === group)
                    .map((link) => (
                      <li key={link.url}>
                        <div>
                          <strong>{link.label}</strong>
                          <small>{LINK_TYPE_LABELS[link.type][locale]}</small>
                        </div>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <span className="profile-link-url">{link.url}</span>
                          <ExternalLink aria-label={text("openLink")} />
                        </a>
                      </li>
                    ))}
                </ul>
              </div>
            ))
          ) : (
            <p className="panel-note">{text("noLinks")}</p>
          )
        ) : (
          <div className="project-config-editor">
            {draft.length === 0 && (
              <p className="panel-note">{text("noLinks")}</p>
            )}
            <ol className="link-edit-list">
              {draft.map((link, index) => {
                const problem = checked ? problems[index] : null;
                const errorId = `link-error-${index}`;
                return (
                  <li key={index} className="link-edit-row">
                    <label className="field">
                      <span className="field-label">{text("linkType")}</span>
                      <select
                        className="input"
                        value={link.type}
                        onChange={(e) =>
                          change(index, {
                            type: e.target.value as ProjectLinkType,
                          })
                        }
                      >
                        {GROUPS.map((group) => (
                          <optgroup
                            key={group}
                            label={LINK_GROUP_LABELS[group][locale]}
                          >
                            {typesOf(group).map((type) => (
                              <option key={type} value={type}>
                                {LINK_TYPE_LABELS[type][locale]}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-label">{text("linkLabel")}</span>
                      <Input
                        value={link.label}
                        maxLength={80}
                        aria-invalid={problem === "label_required" || undefined}
                        aria-describedby={problem ? errorId : undefined}
                        onChange={(e) =>
                          change(index, { label: e.target.value })
                        }
                      />
                    </label>
                    <label className="field link-url-field">
                      <span className="field-label">{text("linkUrl")}</span>
                      <Input
                        type="url"
                        inputMode="url"
                        value={link.url}
                        maxLength={2000}
                        placeholder="https://"
                        aria-invalid={
                          (problem && problem !== "label_required") || undefined
                        }
                        aria-describedby={problem ? errorId : undefined}
                        onChange={(e) => change(index, { url: e.target.value })}
                      />
                    </label>
                    <div className="row-actions link-row-actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${text("moveUp")}: ${link.label || index + 1}`}
                        disabled={index === 0}
                        onClick={() => setDraft(moveLink(draft, index, -1))}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${text("moveDown")}: ${link.label || index + 1}`}
                        disabled={index === draft.length - 1}
                        onClick={() => setDraft(moveLink(draft, index, 1))}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${text("removeLink")}: ${link.label || index + 1}`}
                        onClick={() =>
                          setDraft(draft.filter((_, i) => i !== index))
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    {problem && (
                      <small id={errorId} className="link-error" role="alert">
                        {text(PROBLEM_TEXT[problem])}
                      </small>
                    )}
                  </li>
                );
              })}
            </ol>
            <Button
              variant="outline"
              size="sm"
              disabled={draft.length >= MAX_PROJECT_LINKS}
              onClick={() =>
                setDraft([
                  ...draft,
                  {
                    type: "website",
                    label: LINK_TYPE_LABELS.website[locale],
                    url: "",
                  },
                ])
              }
            >
              <Plus data-icon="inline-start" />
              {text("addLink")}
            </Button>
            {draft.length >= MAX_PROJECT_LINKS && (
              <p className="panel-note">{text("tooManyLinks")}</p>
            )}
            {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
            <div className="panel-actions">
              <Button
                disabled={mutation.pending}
                onClick={() => {
                  setChecked(true);
                  const links = cleanLinks(draft);
                  if (linkProblems(links).some(Boolean)) return;
                  void mutation
                    .run(() => saveSettings(project, { links }))
                    .then((result) => {
                      if (result) window.location.reload();
                    });
                }}
              >
                {mutation.pending ? text("saving") : text("save")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(null);
                  setChecked(false);
                }}
              >
                {text("cancel")}
              </Button>
            </div>
          </div>
        )}
        {!isOwner && <p className="panel-note">{text("ownerOnly")}</p>}
      </div>
    </section>
  );
}
