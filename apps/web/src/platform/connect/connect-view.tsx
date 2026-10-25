"use client";
import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { ApiError, post, useResource } from "@/lib/api";
import type { Text } from "@/lib/i18n";
import { useStandalone } from "@/platform/shell/standalone-context";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Field,
  FieldGroup,
  Input,
  Loading,
} from "@/components/ui/primitives";
import {
  acceptedScopes,
  clientHost,
  EXPLICIT_SCOPES,
  connectStep,
  signedQuery,
  submitConsent,
  submitSelection,
  websiteHost,
  type Selection,
} from "./oauth-flow";

// The /connect page of the OAuth authorization an MCP client starts (Track M,
// WP-M1): first the user picks the workspace and projects, then consents.
// Better Auth sends the browser here with a signed query; the API verifies it,
// so nothing on this page is a security decision.

type Client = { id: string; name: string | null; uri: string | null };
type Project = { id: string; name: string };
type Workspace = {
  id: string;
  name: string;
  role: string;
  projects: Project[];
};
type ConnectRequest = {
  client: Client;
  scopes: string[];
  selection: Selection | null;
  workspaces: Workspace[];
};

const navigate = (url: string) => window.location.assign(url);

/** Scopes that are only shown; the user cannot choose them. */
const INFORMATIONAL = new Set(["openid", "email", "profile", "offline_access"]);
const SCOPE_TEXT: Record<string, Parameters<Text>[0]> = {
  openid: "connectScopeOpenid",
  email: "connectScopeEmail",
  profile: "connectScopeProfile",
  offline_access: "connectScopeOfflineAccess",
  "orbit:read": "connectScopeRead",
  "orbit:propose": "connectScopePropose",
  "orbit:write": "connectScopeWrite",
  "orbit:support": "connectScopeSupport",
  "orbit:finance.read": "connectScopeFinanceRead",
  "orbit:finance.extract": "connectScopeFinanceExtract",
  "orbit:work": "connectScopeWork",
};
const scopeText = (t: Text, scope: string) =>
  t(SCOPE_TEXT[scope] ?? "connectScopeOther");

const codeOf = (error: unknown) =>
  error instanceof ApiError
    ? error.code
    : error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "REQUEST_FAILED";

/** The client's name is chosen by the client; the host of its id is not. */
function ClientIdentity({ t, client }: { t: Text; client: Client }) {
  const website = websiteHost(client.uri);
  return (
    <>
      <p className="connect-lead">
        <strong>{client.name || clientHost(client.id)}</strong>{" "}
        {t("connectWants")}
      </p>
      <dl className="detail-grid connect-identity">
        <dt>{t("connectClientHost")}</dt>
        <dd>
          <code>{clientHost(client.id)}</code>
        </dd>
        {website && (
          <>
            <dt>{t("connectClientWebsite")}</dt>
            <dd>{website}</dd>
          </>
        )}
      </dl>
    </>
  );
}

/** A refused or expired request: say what happened and that nothing was shared. */
export function ConnectProblem({ t, code }: { t: Text; code: string }) {
  const message =
    code === "NO_PROJECTS"
      ? t("connectNoProjects")
      : code === "OAUTH_REQUEST_EXPIRED"
        ? t("connectExpired")
        : code === "OAUTH_REQUEST_INVALID"
          ? t("connectInvalid")
          : t("connectFailed");
  const known = [
    "NO_PROJECTS",
    "OAUTH_REQUEST_EXPIRED",
    "OAUTH_REQUEST_INVALID",
  ].includes(code);
  return (
    <Empty icon={ShieldCheck} title={t("connectTitle")} description={message}>
      {!known && (
        <p className="panel-note">
          {t("connectCode")}: <code>{code}</code>
        </p>
      )}
    </Empty>
  );
}

export function SelectStep({
  t,
  client,
  workspaces,
  workspaceId,
  onWorkspace,
  allProjects,
  onAllProjects,
  projectIds,
  onToggleProject,
  onContinue,
  pending,
  error,
}: {
  t: Text;
  client: Client;
  workspaces: readonly Workspace[];
  workspaceId: string;
  onWorkspace: (id: string) => void;
  allProjects: boolean;
  onAllProjects: (all: boolean) => void;
  projectIds: ReadonlySet<string>;
  onToggleProject: (id: string) => void;
  onContinue: () => void;
  pending: boolean;
  error: string | null;
}) {
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const projects = workspace?.projects ?? [];
  const ready = projects.length > 0 && (allProjects || projectIds.size > 0);
  return (
    <>
      <ClientIdentity t={t} client={client} />
      <h2>{t("connectSelectTitle")}</h2>
      <p className="panel-note">{t("connectSelectHint")}</p>
      <FieldGroup>
        <Field>
          <label className="field-label" htmlFor="connect-workspace">
            {t("connectWorkspace")}
          </label>
          <select
            id="connect-workspace"
            className="input"
            value={workspaceId}
            onChange={(event) => onWorkspace(event.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.role})
              </option>
            ))}
          </select>
        </Field>
        <fieldset className="connect-projects">
          <legend className="field-label">{t("connectProjects")}</legend>
          {projects.length === 0 ? (
            <Alert kind="warning">{t("connectNoProjectsInWorkspace")}</Alert>
          ) : (
            <>
              <label className="connect-choice">
                <Input
                  type="checkbox"
                  checked={allProjects}
                  onChange={(event) => onAllProjects(event.target.checked)}
                />
                <span>
                  <strong>{t("connectAllProjects")}</strong>
                  <small>{t("connectAllProjectsHint")}</small>
                </span>
              </label>
              {!allProjects &&
                projects.map((project) => (
                  <label className="connect-choice" key={project.id}>
                    <Input
                      type="checkbox"
                      checked={projectIds.has(project.id)}
                      onChange={() => onToggleProject(project.id)}
                    />
                    <span>{project.name}</span>
                  </label>
                ))}
            </>
          )}
        </fieldset>
      </FieldGroup>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="form-actions">
        <Button disabled={pending || !ready} onClick={onContinue}>
          {t("connectContinue")}
        </Button>
      </div>
    </>
  );
}

export function ConsentStep({
  t,
  client,
  scopes,
  workspace,
  projects,
  allCurrent,
  propose,
  onPropose,
  extraScopes = [],
  onExtraScope,
  onAccept,
  onDeny,
  pending,
  error,
}: {
  t: Text;
  client: Client;
  scopes: readonly string[];
  workspace: { name: string; role: string };
  projects: readonly Project[];
  allCurrent: boolean;
  propose: boolean;
  onPropose: (on: boolean) => void;
  extraScopes?: readonly string[];
  onExtraScope?: (scope: string, on: boolean) => void;
  onAccept: () => void;
  onDeny: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <>
      <ClientIdentity t={t} client={client} />
      <h2>{t("connectConsentTitle")}</h2>
      <dl className="detail-grid connect-identity">
        <dt>{t("connectWorkspace")}</dt>
        <dd>
          {workspace.name} <Badge>{workspace.role}</Badge>
        </dd>
        <dt>{t("connectProjects")}</dt>
        <dd>
          {allCurrent
            ? t("connectAllProjects")
            : projects.map((p) => p.name).join(", ")}
        </dd>
      </dl>
      <h3 className="field-heading">{t("connectAccess")}</h3>
      <ul className="connect-scopes">
        {scopes.map((scope) => (
          <li key={scope}>
            {(
              ["orbit:read", "orbit:propose", ...EXPLICIT_SCOPES] as string[]
            ).includes(scope) ? (
              <label className="connect-choice">
                <Input
                  type="checkbox"
                  name="scope"
                  value={scope}
                  checked={
                    scope === "orbit:read"
                      ? true
                      : scope === "orbit:propose"
                        ? propose
                        : extraScopes.includes(scope)
                  }
                  disabled={scope === "orbit:read"}
                  onChange={(event) =>
                    scope === "orbit:propose"
                      ? onPropose(event.target.checked)
                      : onExtraScope?.(scope, event.target.checked)
                  }
                />
                <span>
                  <strong>
                    <code>{scope}</code>
                  </strong>
                  <small>
                    {scopeText(t, scope)}
                    {" · "}
                    {scope === "orbit:read"
                      ? t("connectScopeReadOnly")
                      : t("connectScopeOptional")}
                  </small>
                </span>
              </label>
            ) : (
              <div className="connect-choice">
                <span>
                  <strong>
                    <code>{scope}</code>
                  </strong>
                  <small>
                    {INFORMATIONAL.has(scope)
                      ? scopeText(t, scope)
                      : t("connectScopeOther")}
                  </small>
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="form-actions">
        <Button variant="outline" disabled={pending} onClick={onDeny}>
          {t("connectDeny")}
        </Button>
        <Button disabled={pending} onClick={onAccept}>
          {t("connectAllow")}
        </Button>
      </div>
    </>
  );
}

/** The first workspace the user can share a project from, or the one already chosen. */
function initialWorkspace(request: ConnectRequest) {
  return (
    request.selection?.workspaceId ??
    (request.workspaces.find((w) => w.projects.length) ?? request.workspaces[0])
      ?.id ??
    ""
  );
}

function ConnectFlow({
  t,
  query,
  request,
}: {
  t: Text;
  query: string;
  request: ConnectRequest;
}) {
  const step = connectStep(query, request.selection);
  const [workspaceId, setWorkspaceId] = useState(() =>
    initialWorkspace(request),
  );
  const projectsOf = (id: string) =>
    request.workspaces.find((w) => w.id === id)?.projects ?? [];
  // A single project needs no choosing; a returning selection is kept.
  const [allProjects, setAllProjects] = useState(
    request.selection?.allCurrentProjects ?? false,
  );
  const [projectIds, setProjectIds] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        request.selection?.projectIds ??
          (projectsOf(initialWorkspace(request)).length === 1
            ? projectsOf(initialWorkspace(request)).map((p) => p.id)
            : []),
      ),
  );
  const [propose, setPropose] = useState(true);
  const [extraScopes, setExtraScopes] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function attempt(task: () => Promise<void>) {
    setPending(true);
    setFailure(null);
    try {
      await task();
      // The page is leaving for the next step or the client: stay busy.
    } catch (error) {
      setFailure(codeOf(error));
      setPending(false);
    }
  }

  // A request that cannot continue replaces the page; the rest is a message.
  const fatal =
    failure === "OAUTH_REQUEST_EXPIRED" || failure === "OAUTH_REQUEST_INVALID";
  if (fatal) return <ConnectProblem t={t} code={failure} />;
  const message = failure
    ? failure === "NO_PROJECTS"
      ? t("connectNoProjects")
      : t("connectFailed")
    : null;

  if (step === "select")
    return (
      <SelectStep
        t={t}
        client={request.client}
        workspaces={request.workspaces}
        workspaceId={workspaceId}
        onWorkspace={(id) => {
          setWorkspaceId(id);
          setAllProjects(false);
          const projects = projectsOf(id);
          setProjectIds(
            new Set(projects.length === 1 ? [projects[0]!.id] : []),
          );
        }}
        allProjects={allProjects}
        onAllProjects={setAllProjects}
        projectIds={projectIds}
        onToggleProject={(id) =>
          setProjectIds((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
          })
        }
        onContinue={() =>
          void attempt(() =>
            submitSelection(post, navigate, {
              oauthQuery: query,
              workspaceId,
              projectIds: allProjects ? "all_current" : [...projectIds],
            }),
          )
        }
        pending={pending}
        error={message}
      />
    );

  const chosen = request.workspaces.find(
    (w) => w.id === request.selection?.workspaceId,
  );
  const answer = (accept: boolean) =>
    void attempt(() =>
      submitConsent(post, navigate, {
        oauthQuery: query,
        accept,
        scopes: acceptedScopes(request.scopes, propose, extraScopes),
      }),
    );
  return (
    <ConsentStep
      t={t}
      client={request.client}
      scopes={request.scopes}
      workspace={{
        name: chosen?.name ?? request.selection!.workspaceId,
        role: chosen?.role ?? "",
      }}
      projects={request.selection!.projectIds.map((id) => ({
        id,
        name: chosen?.projects.find((p) => p.id === id)?.name ?? id,
      }))}
      allCurrent={request.selection!.allCurrentProjects}
      extraScopes={extraScopes}
      onExtraScope={(scope, on) =>
        setExtraScopes((prior) =>
          on
            ? [...new Set([...prior, scope])]
            : prior.filter((s) => s !== scope),
        )
      }
      propose={propose}
      onPropose={setPropose}
      onAccept={() => answer(true)}
      onDeny={() => answer(false)}
      pending={pending}
      error={message}
    />
  );
}

/** /connect and /connect/login once signed in: selection, then consent. */
export function ConnectView() {
  const { t, identity } = useStandalone();
  // The URL is read after mount: the page is also rendered on the server.
  const [query, setQuery] = useState<string | null | undefined>(undefined);
  useEffect(() => setQuery(signedQuery(window.location.search)), []);
  const request = useResource<ConnectRequest>(
    query ? `/mcp-connect/request?${query}` : null,
  );
  const code =
    query === null
      ? "OAUTH_REQUEST_INVALID"
      : request.error instanceof ApiError
        ? request.error.code
        : request.error
          ? "REQUEST_FAILED"
          : null;
  return (
    <section className="panel connect-card" aria-labelledby="connect-title">
      <div className="panel-head">
        <h1 id="connect-title">{t("connectTitle")}</h1>
        {identity && (
          <small className="connect-user">
            {t("connectSignedInAs")} {identity.user.email}
          </small>
        )}
      </div>
      <div className="connect-body">
        {query === undefined || (query && request.loading) ? (
          <Loading label={t("loading")} />
        ) : code ? (
          <ConnectProblem t={t} code={code} />
        ) : query && request.data ? (
          <ConnectFlow t={t} query={query} request={request.data} />
        ) : null}
      </div>
    </section>
  );
}

const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * /connect/error: Better Auth sends refused authorizations here. The message
 * is fixed; only the error code is echoed, as text and only if it looks like
 * one (the description is chosen by whoever built the request).
 */
export function ConnectErrorPage({ t, search }: { t: Text; search: string }) {
  const code = new URLSearchParams(search).get("error");
  return (
    <section className="panel connect-card">
      <div className="connect-body">
        <Empty
          icon={ShieldCheck}
          title={t("connectErrorTitle")}
          description={t("connectErrorHint")}
        >
          {code && ERROR_CODE.test(code) && (
            <p className="panel-note">
              {t("connectCode")}: <code>{code}</code>
            </p>
          )}
        </Empty>
      </div>
    </section>
  );
}

export function ConnectErrorView() {
  const { t } = useStandalone();
  const [search, setSearch] = useState("");
  useEffect(() => setSearch(window.location.search), []);
  return <ConnectErrorPage t={t} search={search} />;
}
