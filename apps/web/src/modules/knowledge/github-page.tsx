"use client";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { action, useMutation, useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Input,
  Loading,
  Textarea,
} from "@/components/ui/primitives";
import type { KnowledgeDraft } from "../../../../../packages/schemas/src/knowledge-workspace";
import { knowledgeCopy, type KnowledgeCopy } from "./workspace-text";
import { Field, WorkspaceError } from "./workspace-parts";

type Github = {
  configured: boolean;
  installUrl: string | null;
  connections: { id: string; account: string }[];
};
type Repo = {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
};

/** The one-time GitHub App setup, apart from adding a repository as knowledge. */
export function KnowledgeGithubPage() {
  const { project, locale, isOwner } = useWorkspace();
  const shell = useShell();
  const t = knowledgeCopy[locale];
  const status = useResource<{ configured: boolean }>(
    isOwner ? `/projects/${project.id}/knowledge/github` : null,
  );
  if (!isOwner) return <Alert>{t.readOnly}</Alert>;
  return (
    <div className="knowledge-workspace stack-gap">
      <header className="knowledge-heading">
        <div>
          <h1>{t.configure}</h1>
          <p>{t.githubSetupHint}</p>
        </div>
        <AppLink className="text-link" href={shell.hrefOf("knowledge-import")}>
          {t.add}
        </AppLink>
      </header>
      {status.loading && <Loading label={t.configure} />}
      {status.error && <WorkspaceError code={status.error.message} t={t} />}
      {status.data && (
        <p>
          <Badge tone={status.data.configured ? "success" : "neutral"}>
            {status.data.configured ? t.configured : t.notConfigured}
          </Badge>
        </p>
      )}
      <section className="knowledge-form">
        <GithubConfiguration t={t} onSaved={status.refresh} />
      </section>
    </div>
  );
}
function GithubConfiguration({
  t,
  onSaved,
}: {
  t: KnowledgeCopy;
  onSaved: () => void;
}) {
  const { project } = useWorkspace();
  const mutation = useMutation(onSaved);
  const [config, setConfig] = useState({
    appId: "",
    slug: "",
    clientId: "",
    clientSecret: "",
    privateKey: "",
  });
  // This section is embedded in the source form; use a button rather than a nested form.
  return (
    <div className="knowledge-app-settings stack-gap">
      {(
        ["appId", "slug", "clientId", "clientSecret", "privateKey"] as const
      ).map((k) => (
        <Field key={k} label={t[k]}>
          {k === "privateKey" ? (
            <Textarea
              autoComplete="off"
              value={config[k]}
              onChange={(e) => setConfig({ ...config, [k]: e.target.value })}
            />
          ) : (
            <Input
              type={k === "clientSecret" ? "password" : "text"}
              autoComplete="off"
              value={config[k]}
              onChange={(e) => setConfig({ ...config, [k]: e.target.value })}
            />
          )}
        </Field>
      ))}
      {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      <Button
        type="button"
        variant="outline"
        disabled={mutation.pending}
        onClick={async () => {
          const saved = await mutation.run(() =>
            action(project.id, "knowledge-github-configure", config),
          );
          if (saved)
            setConfig({
              appId: "",
              slug: "",
              clientId: "",
              clientSecret: "",
              privateKey: "",
            });
        }}
      >
        {t.appSave}
      </Button>
    </div>
  );
}

/** The repository step of the add flow; credentials stay on the page above. */
export function GithubSource({
  draft,
  change,
  t,
  beforeConnect,
}: {
  draft: KnowledgeDraft;
  change: (v: Partial<KnowledgeDraft>) => void;
  t: KnowledgeCopy;
  beforeConnect: () => Promise<string | null>;
}) {
  const { project } = useWorkspace();
  const shell = useShell();
  const status = useResource<Github>(
    `/projects/${project.id}/knowledge/github`,
  );
  const repositories = useResource<{ items: Repo[] }>(
    draft.connectionId
      ? `/projects/${project.id}/knowledge/github/repositories?connectionId=${draft.connectionId}`
      : null,
  );
  const mutation = useMutation(status.refresh);
  return (
    <div className="stack-gap">
      {status.loading && <Loading label={t.githubSetup} />}
      {status.error && <WorkspaceError code={status.error.message} t={t} />}
      {status.data && !status.data.configured && (
        <Alert>
          <p>{t.githubNotSetUp}</p>
          <AppLink
            className="text-link"
            href={shell.hrefOf("knowledge-github")}
          >
            {t.githubSetUpLink}
          </AppLink>
        </Alert>
      )}
      {status.data?.configured && (
        <>
          <p>{t.configured}</p>
          <div className="form-actions">
            {status.data.installUrl && (
              <a
                className="text-link"
                target="_blank"
                rel="noreferrer"
                href={status.data.installUrl}
              >
                {t.install}
                <ExternalLink aria-hidden="true" />
              </a>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={mutation.pending}
              onClick={async () => {
                const draftId = await beforeConnect();
                if (!draftId) return;
                const result = await mutation.run(() =>
                  action<{ url: string }>(
                    project.id,
                    "knowledge-github-connect",
                    { draftId },
                  ),
                );
                if (result) window.location.assign(result.url);
              }}
            >
              {t.connect}
            </Button>
          </div>
        </>
      )}
      {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      <Field label={t.connection}>
        <select
          className="input"
          required
          value={draft.connectionId ?? ""}
          onChange={(e) =>
            change({
              connectionId: e.target.value,
              repositoryId: undefined,
              repository: undefined,
            })
          }
        >
          <option value="">{t.connection}</option>
          {status.data?.connections?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.account}
            </option>
          ))}
        </select>
      </Field>
      {repositories.loading && draft.connectionId && (
        <Loading label={t.loadRepos} />
      )}
      {repositories.error && (
        <WorkspaceError code={repositories.error.message} t={t} />
      )}
      {repositories.data && !repositories.data.items.length && (
        <Alert>{t.noRepos}</Alert>
      )}
      <Field label={t.repository}>
        <select
          className="input"
          required
          value={draft.repositoryId ?? ""}
          onChange={(e) => {
            const repo = repositories.data?.items.find(
              (r) => r.id === Number(e.target.value),
            );
            if (repo)
              change({
                repositoryId: repo.id,
                repository: repo.full_name,
                branch: repo.default_branch,
              });
          }}
        >
          <option value="">{t.selectRepo}</option>
          {repositories.data?.items.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t.branch}>
        <Input
          value={draft.branch ?? ""}
          onChange={(e) => change({ branch: e.target.value || undefined })}
        />
      </Field>
      <Field label={t.paths}>
        <Textarea
          required
          value={draft.paths.join("\n")}
          onChange={(e) => change({ paths: e.target.value.split("\n") })}
        />
      </Field>
      <p>{t.pathsHint}</p>
    </div>
  );
}
