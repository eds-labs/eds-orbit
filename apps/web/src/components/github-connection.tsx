"use client";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { collectionPath, post, useMutation, type Entity } from "@/lib/api";
import { Alert, Badge, Button, Modal } from "./ui/primitives";
import { DataForm, str, type FormField, type FormValues } from "./form";
import { useWorkspace } from "./workspace-context";

/**
 * The GitHub blog target in the connector screen (R81, spec §5): the form
 * for the website repository and its fine-grained token, the token renewal
 * and the "Verbindung prüfen" verification. The token is a password field
 * and is never shown again after saving.
 */

/** The only target profile Orbit knows (R81). */
export const GITHUB_BLOG_PROFILE = "uliquid-blog-json-v1";

export function githubConnectorFields(de: boolean): FormField[] {
  return [
    {
      name: "owner",
      label: de ? "Repository-Owner" : "Repository owner",
      required: true,
      placeholder: "eds-labs",
    },
    {
      name: "repo",
      label: de ? "Repository" : "Repository",
      required: true,
    },
    {
      name: "baseBranch",
      label: de ? "Basis-Branch" : "Base branch",
      required: true,
      value: "main",
    },
    {
      name: "postsPath",
      label: de ? "Pfad der Posts" : "Posts path",
      required: true,
      value: "content/blog/posts",
    },
    {
      name: "siteUrl",
      label: de ? "Website-URL" : "Site URL",
      type: "url",
      required: true,
      placeholder: "https://uliquid.vip",
    },
    ...githubCredentialFields(de),
  ];
}

export function githubCredentialFields(de: boolean): FormField[] {
  return [
    {
      name: "credential",
      label: de ? "Fine-grained Token" : "Fine-grained token",
      type: "password",
      required: true,
      hint: de
        ? "Nur dieses Repository, Contents und Pull requests lesen & schreiben."
        : "This repository only, Contents and Pull requests read & write.",
    },
    {
      name: "tokenExpiresAt",
      label: de ? "Token gültig bis" : "Token expires on",
      type: "date",
      required: true,
    },
  ];
}

/** Input of the connector action for `provider: "github"`. */
export function githubConnectorPayload(v: FormValues) {
  return {
    provider: "github" as const,
    owner: str(v, "owner"),
    repo: str(v, "repo"),
    baseBranch: str(v, "baseBranch"),
    postsPath: str(v, "postsPath"),
    siteUrl: str(v, "siteUrl"),
    blogPathPrefix: "/blog/",
    profile: GITHUB_BLOG_PROFILE,
    ...githubCredentialPayload(v),
  };
}

/** Input of `POST /connectors/:id/github-credential`. */
export function githubCredentialPayload(v: FormValues) {
  return {
    credential: str(v, "credential"),
    tokenExpiresAt: str(v, "tokenExpiresAt"),
  };
}

export type GithubVerification = { status: string; problems: string[] };

// [en, de] per verification status (R81).
const verifyStatus: Record<string, [string, string]> = {
  write_verified: ["Read and write verified", "Lesen und Schreiben geprüft"],
  read_verified: [
    "Read verified, write refused",
    "Lesen geprüft, Schreiben verweigert",
  ],
  configured: ["Not verified", "Nicht geprüft"],
};

export function GithubVerifyResult({
  result,
  de,
}: {
  result: GithubVerification;
  de: boolean;
}) {
  return (
    <div className="connector-details" role="status">
      <p>
        <Badge
          tone={result.status === "write_verified" ? "success" : "warning"}
        >
          {
            (verifyStatus[result.status] ?? [result.status, result.status])[
              de ? 1 : 0
            ]
          }
        </Badge>
      </p>
      {result.problems.length > 0 && (
        <ul aria-label={de ? "Probleme" : "Problems"}>
          {result.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Repository, branch, path, site and token expiry of a saved connector; never the token. */
export function GithubConnectorDetails({ connector }: { connector: Entity }) {
  const { locale } = useWorkspace();
  const de = locale === "de";
  const d = connector.data;
  return (
    <div className="connector-details">
      <p>
        <strong>Repository:</strong> {String(d.owner)}/{String(d.repo)} ·{" "}
        {String(d.baseBranch ?? "main")}
      </p>
      <p>
        <strong>Posts:</strong> {String(d.postsPath ?? "")} ·{" "}
        {String(d.siteUrl ?? "")}
      </p>
      <p>
        <strong>{de ? "Token gültig bis:" : "Token expires on:"}</strong>{" "}
        {String(d.tokenExpiresAt ?? "—")}
      </p>
      {Array.isArray(d.verificationProblems) &&
        d.verificationProblems.length > 0 && (
          <p>{d.verificationProblems.map(String).join(" · ")}</p>
        )}
    </div>
  );
}

/** Owner actions of a saved GitHub connector: "Verbindung prüfen" and "Token erneuern". */
export function GithubConnectorActions({ connector }: { connector: Entity }) {
  const { project, locale, isOwner, refresh } = useWorkspace();
  const de = locale === "de";
  const [renew, setRenew] = useState(false);
  const [result, setResult] = useState<GithubVerification | null>(null);
  const mutation = useMutation(refresh);
  if (!isOwner) return null;
  const path = (name: string) =>
    collectionPath(project.id, `connectors/${connector.id}/${name}`);
  return (
    <>
      <Button
        variant="outline"
        disabled={mutation.pending}
        onClick={() =>
          mutation
            .run(() => post<GithubVerification>(path("verify-github"), {}))
            .then((answer) => {
              if (answer) setResult(answer);
            })
        }
      >
        <RefreshCw data-icon="inline-start" />
        {de ? "Verbindung prüfen" : "Verify connection"}
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          mutation.clear();
          setRenew(true);
        }}
      >
        {de ? "Token erneuern" : "Renew token"}
      </Button>
      {result && <GithubVerifyResult result={result} de={de} />}
      {!renew && mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {renew && (
        <Modal
          title={de ? "GitHub-Token erneuern" : "Renew GitHub token"}
          description={
            de
              ? "Der neue Token wird verschlüsselt gespeichert und nie wieder angezeigt. Danach die Verbindung erneut prüfen."
              : "The new token is stored encrypted and never shown again. Verify the connection afterwards."
          }
          onClose={() => setRenew(false)}
        >
          <DataForm
            fields={githubCredentialFields(de)}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={de ? "Token speichern" : "Save token"}
            onCancel={() => setRenew(false)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  post(path("github-credential"), githubCredentialPayload(v)),
                )
                .then((saved) => {
                  if (saved) {
                    setResult(null);
                    setRenew(false);
                  }
                })
            }
          />
        </Modal>
      )}
    </>
  );
}
