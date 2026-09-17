"use client";
import { useState } from "react";
import Link from "next/link";
import { action, useMutation, value, type Entity } from "@/lib/api";
import {
  Alert,
  Button,
  Empty,
  Loading,
  Modal,
  Status,
  Badge,
} from "./ui/primitives";
import { DataForm, str } from "./form";
import { useWorkspace } from "./workspace-context";
import { EntityRows, ResourceError, useCollection } from "./work";
export type BriefProposal = {
  title: string;
  goal: string;
  language: "en" | "de";
};
export function BriefProposalDialog({
  onUse,
  onClose,
}: {
  onUse: (p: BriefProposal) => void;
  onClose: () => void;
}) {
  const { project, locale } = useWorkspace();
  const mutation = useMutation();
  const [result, setResult] = useState<{
    method: string;
    proposal: BriefProposal;
    unknowns: string[];
    limitations: string[];
  } | null>(null);
  return (
    <Modal
      title={
        locale === "de" ? "Aus einem Briefing starten" : "Start from a brief"
      }
      onClose={onClose}
    >
      <Alert>
        {locale === "de"
          ? "Eine lokale Textvorlage, kein KI-Plan: Zahlen, Budgets und Berechtigungen werden nicht geraten."
          : "A local text template, not an AI plan. Targets, budgets and permissions are never guessed."}
      </Alert>
      <DataForm
        fields={[
          {
            name: "brief",
            label: locale === "de" ? "Dein Briefing" : "Your brief",
            type: "textarea",
            required: true,
            min: 5,
            max: 2000,
          },
        ]}
        pending={mutation.pending}
        error={mutation.error}
        submitLabel="Prepare editable proposal"
        onSubmit={(v) =>
          mutation
            .run(() =>
              action<typeof result>(project.id, "editorial-propose-brief", {
                brief: str(v, "brief"),
                language: project.language,
              }),
            )
            .then((r) => {
              if (r) setResult(r);
            })
        }
      />
      {result && (
        <div className="administration-panel">
          <h3>{result.proposal.title}</h3>
          <p className="prose">{result.proposal.goal}</p>
          <p>Complete before creation: {result.unknowns.join(", ")}</p>
          <Button onClick={() => onUse(result.proposal)}>
            Complete structured mission
          </Button>
        </div>
      )}
    </Modal>
  );
}
export function AdaptationDialog({
  parent,
  onClose,
}: {
  parent: Entity;
  onClose: () => void;
}) {
  const { project, refresh } = useWorkspace();
  const mutation = useMutation(refresh);
  const [result, setResult] = useState<Entity | null>(null);
  return (
    <Modal
      title="Create a social adaptation"
      description={`Based on ${value(parent, "title")}, version ${parent.version}.`}
      onClose={onClose}
    >
      <Alert>
        Keep complete supported claims in the text. Evidence is rechecked. A
        variant starts as a draft without inherited approval, schedule or media.
        Exact or claim-overlapping posts on the same channel are rejected.
      </Alert>
      <DataForm
        fields={[
          {
            name: "title",
            label: "Variant title",
            required: true,
            value: value(parent, "title"),
            max: 200,
          },
          { name: "channel", label: "Target channel", required: true, max: 80 },
          {
            name: "body",
            label: "Adapted body",
            type: "textarea",
            required: true,
            value: value(parent, "body"),
            max: 40000,
          },
        ]}
        pending={mutation.pending}
        error={mutation.error}
        submitLabel="Save variant draft"
        onCancel={onClose}
        onSubmit={(v) =>
          mutation
            .run(() =>
              action<Entity>(project.id, "adapt-content", {
                parentContentId: parent.id,
                version: parent.version,
                title: str(v, "title"),
                body: str(v, "body"),
                channel: str(v, "channel"),
              }),
            )
            .then((r) => {
              if (r) setResult(r);
            })
        }
      />
      {result && (
        <Alert kind="success">
          Variant saved as {value(result, "status")} with parent version{" "}
          {String(result.data.parentContentVersion)}. Open it in Content Studio
          for review.
        </Alert>
      )}
    </Modal>
  );
}
export function CommunityQuestions() {
  const { project, canEdit, refresh } = useWorkspace();
  const groups = useCollection("community_groups"),
    questions = useCollection("community_questions"),
    missions = useCollection("missions"),
    content = useCollection("content");
  const [importing, setImporting] = useState(false),
    [selected, setSelected] = useState<Entity | null>(null);
  const mutation = useMutation(refresh);
  return (
    <>
      <Alert>
        Questions are private, untrusted community observations, not verified
        product facts. Grouping uses matching words. Complaints and sensitive
        questions require review; no public replies are sent here.
      </Alert>
      {canEdit && (
        <div className="form-actions">
          <Button onClick={() => setImporting(true)}>
            Import authorized questions
          </Button>
        </div>
      )}
      <ResourceError
        error={groups.error || questions.error}
        retry={() => {
          groups.refresh();
          questions.refresh();
        }}
      />
      {groups.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          {groups.data?.items.length ? (
            <EntityRows
              items={groups.data.items}
              fields={["title", "questionCount", "status"]}
              onSelect={setSelected}
            />
          ) : (
            <Empty
              title="Turn recurring questions into useful answers"
              description="Import a labeled, authorized question list, then link a group to an internal mission or answer draft."
            />
          )}
        </section>
      )}
      {importing && (
        <Modal
          title="Import community questions"
          description="Paste one question per line from a source you are authorized to process. This is a labeled manual import, not a live community connection."
          onClose={() => setImporting(false)}
        >
          <DataForm
            fields={[
              {
                name: "label",
                label: "Stable import label",
                required: true,
                min: 3,
                max: 160,
              },
              {
                name: "questions",
                label: "Questions, one per line (maximum 100)",
                type: "textarea",
                required: true,
                min: 5,
                max: 200000,
              },
              {
                name: "sensitive",
                label: "Mark this import as sensitive and require human review",
                type: "checkbox",
              },
              {
                name: "confirm",
                label:
                  "I am authorized to import and process these questions in this project.",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Import and group"
            onCancel={() => setImporting(false)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(project.id, "community-import", {
                    label: str(v, "label"),
                    authorizationConfirmed: true,
                    questions: str(v, "questions")
                      .split(/\r?\n/)
                      .map((text) => text.trim())
                      .filter(Boolean)
                      .map((text, index) => ({
                        externalId: `line-${index + 1}`,
                        text,
                        language: project.language,
                        sensitive: v.sensitive === true,
                      })),
                  }),
                )
                .then((r) => {
                  if (r) setImporting(false);
                })
            }
          />
        </Modal>
      )}
      {selected && (
        <Modal
          title={value(selected, "title")}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="detail-summary">
            <Status value={selected.data.status} />
            <Badge>Private import</Badge>
            <Badge>No public reply permission</Badge>
          </div>
          {(questions.data?.items || [])
            .filter(
              (q) =>
                Array.isArray(selected.data.questionIds) &&
                selected.data.questionIds.includes(q.id),
            )
            .map((q) => (
              <article className="content-preview" key={q.id}>
                <p>{value(q, "text")}</p>
                <small>
                  {value(q, "label")} · {value(q, "externalId")} ·{" "}
                  {value(q, "origin")}
                </small>
              </article>
            ))}
          <p>
            Linked missions:{" "}
            {
              (Array.isArray(selected.data.missionIds)
                ? selected.data.missionIds
                : []
              ).length
            }{" "}
            · Linked drafts:{" "}
            {
              (Array.isArray(selected.data.contentIds)
                ? selected.data.contentIds
                : []
              ).length
            }
          </p>
          {canEdit && (
            <>
              {missions.data?.items.length ? (
                <DataForm
                  fields={[
                    {
                      name: "missionId",
                      label: "Internal mission",
                      type: "select",
                      required: true,
                      options: missions.data.items.map((e) => ({
                        value: e.id,
                        label: value(e, "title"),
                      })),
                    },
                  ]}
                  pending={mutation.pending}
                  error={mutation.error}
                  submitLabel="Link mission"
                  onSubmit={(v) =>
                    mutation
                      .run(() =>
                        action<Entity>(project.id, "community-link", {
                          groupId: selected.id,
                          version: selected.version,
                          missionId: str(v, "missionId"),
                        }),
                      )
                      .then((r) => {
                        if (r) setSelected(r);
                      })
                  }
                />
              ) : (
                <p>
                  <Link href="/missions">Create a mission</Link> using
                  separately approved knowledge, then link it here.
                </p>
              )}
              {content.data?.items.length ? (
                <DataForm
                  fields={[
                    {
                      name: "contentId",
                      label: "Internal answer draft",
                      type: "select",
                      required: true,
                      options: content.data.items.map((e) => ({
                        value: e.id,
                        label: value(e, "title"),
                      })),
                    },
                  ]}
                  pending={mutation.pending}
                  error={mutation.error}
                  submitLabel="Link answer draft"
                  onSubmit={(v) =>
                    mutation
                      .run(() =>
                        action<Entity>(project.id, "community-link", {
                          groupId: selected.id,
                          version: selected.version,
                          contentId: str(v, "contentId"),
                        }),
                      )
                      .then((r) => {
                        if (r) setSelected(r);
                      })
                  }
                />
              ) : (
                <p>
                  <Link href="/content">Create an internal answer draft</Link>{" "}
                  from verified sources, then link it here.
                </p>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
