"use client";
import type { Dispatch } from "react";
import { Button, Field, FieldLabel, Tabs, Textarea } from "@/components/ui/primitives";
import type { SocialAccount, SocialMedia, ValidationIssue } from "../api";
import { issueMessage, socialText } from "../labels";
import { effectiveMedia, effectiveText, type EditorAction, type EditorState } from "./editor-state";
import { MediaPicker } from "./media-picker";
import { Preview } from "./preview";
import { textHint } from "./limits";

// The texts of a post (S4): one tab for all accounts and one per selected
// account. Every panel stays in the page (inactive ones hidden), so a
// switch keeps what was typed.

export function VariantTabs({
  projectId,
  state,
  dispatch,
  accounts,
  library,
  issues,
  disabled,
  locale,
}: {
  projectId: string;
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  accounts: SocialAccount[];
  library: SocialMedia[];
  issues: Record<string, ValidationIssue[]>;
  disabled?: boolean;
  locale: "en" | "de";
}) {
  const all = socialText(locale);
  const t = all.posts;
  const selected = state.accounts.flatMap((id) => accounts.filter((a) => a.id === id));
  const alt = (ids: string[]) =>
    ids.map((mediaId) => ({ mediaId, altText: library.find((m) => m.id === mediaId)?.altText ?? null }));
  const tabs = [{ key: "base", label: t.tabBase }, ...selected.map((a) => ({ key: a.id, label: a.handle }))];
  return (
    <section aria-label={t.tabsLabel}>
      <Tabs tabs={tabs} value={state.tab} onChange={(tab) => dispatch({ type: "tab", tab })} />
      <div role="tabpanel" aria-label={t.tabBase} hidden={state.tab !== "base"}>
        <Field>
          <FieldLabel htmlFor="social-post-base">{t.baseText}</FieldLabel>
          <Textarea
            id="social-post-base"
            rows={8}
            maxLength={25_000}
            value={state.baseText}
            disabled={disabled}
            onChange={(e) => dispatch({ type: "baseText", text: e.target.value })}
          />
        </Field>
        {selected
          .filter((a) => state.overrides[a.id]?.text == null)
          .map((a) => {
            const hint = textHint(a.platform, state.baseText, {
              xLongPosts: a.settings.xLongPosts,
              hasMedia: effectiveMedia(state, a.id).length > 0,
            });
            return (
              <p key={a.id} className="field-hint">
                {t.limit(all.platform[a.platform], hint.used, hint.limit)} · {a.handle}
              </p>
            );
          })}
        <MediaPicker
          projectId={projectId}
          target="base"
          legend={t.baseMedia}
          library={library}
          selected={state.baseMedia}
          disabled={disabled}
          locale={locale}
          onChange={(mediaIds) => dispatch({ type: "media", target: "base", mediaIds })}
        />
      </div>
      {selected.map((a) => {
        const own = state.overrides[a.id];
        const text = effectiveText(state, a.id);
        const media = effectiveMedia(state, a.id);
        const found = issues[a.id] ?? [];
        return (
          <div key={a.id} role="tabpanel" aria-label={a.handle} hidden={state.tab !== a.id}>
            {own?.text == null ? (
              <p>
                {t.usesBase}{" "}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => dispatch({ type: "override", accountId: a.id, text: state.baseText })}
                >
                  {t.writeOwn}
                </Button>
              </p>
            ) : (
              <Field>
                <FieldLabel htmlFor={`social-post-text-${a.id}`}>{t.ownText(a.handle)}</FieldLabel>
                <Textarea
                  id={`social-post-text-${a.id}`}
                  rows={8}
                  maxLength={25_000}
                  value={own.text}
                  disabled={disabled}
                  onChange={(e) => dispatch({ type: "override", accountId: a.id, text: e.target.value })}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => dispatch({ type: "inherit", accountId: a.id, field: "text" })}
                >
                  {t.useBase}
                </Button>
              </Field>
            )}
            {own?.media == null ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => dispatch({ type: "media", target: a.id, mediaIds: state.baseMedia })}
              >
                {t.ownMedia}
              </Button>
            ) : (
              <>
                <MediaPicker
                  projectId={projectId}
                  target={a.id}
                  legend={t.ownMedia}
                  library={library}
                  selected={own.media}
                  disabled={disabled}
                  locale={locale}
                  onChange={(mediaIds) => dispatch({ type: "media", target: a.id, mediaIds })}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => dispatch({ type: "inherit", accountId: a.id, field: "media" })}
                >
                  {t.useBaseMedia}
                </Button>
              </>
            )}
            <Preview
              projectId={projectId}
              platform={a.platform}
              handle={a.handle}
              text={text}
              media={alt(media)}
              xLongPosts={a.settings.xLongPosts}
              locale={locale}
            />
            {found.length > 0 && (
              <div>
                <p className="field-hint">{t.lastCheck}</p>
                <ul>
                  {found.map((issue) => (
                    <li key={issue.code} className={issue.severity === "error" ? "form-error" : "field-hint"}>
                      {issueMessage(issue.code, locale)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
