"use client";
// Search index generations (WP2.3b) and their live evaluation. Orbit writes
// the test questions; the owner reviews them and starts the evaluation.
import { useEffect, useMemo, useState } from "react";
import { action, collectionPath, useMutation, useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import {
  Alert,
  Badge,
  Button,
  Loading,
  Modal,
} from "@/components/ui/primitives";
import { DataForm, options, str } from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";

type CaseKind = "positive" | "public_leak" | "language";
export type EvaluationRun = {
  id: string;
  origin: "generated" | "supplied";
  status: string;
  errorCode?: string | null;
  costMicros?: number | null;
  batchesDone?: number | null;
  cases: number;
  evaluation?: {
    passed: boolean;
    answered: number;
    recallAt10: number;
    forbiddenHits: number;
    /** Answered questions that found their passage. */
    found: number;
  } | null;
  items?: {
    id: string;
    query: string;
    kind: CaseKind;
    title: string | null;
    heading: string | null;
    snippet: string | null;
  }[];
};
export type IndexGeneration = {
  id: string;
  generation: number;
  profile: string;
  state: string;
  manifest: unknown[];
  evaluation?: Record<string, unknown> | null;
  createdAt: string;
  activatedAt?: string | null;
  /** Embedded corpus chunks and where the generation stands (`building` covers several phases). */
  chunks?: number;
  embeddedChunks?: number;
  phase?: string;
  evaluationRun?: EvaluationRun | null;
  evaluationSetEstimateMicros?: number | null;
  managedRefresh?: boolean;
  /** Only on the active generation: whether its live check still allows releases. */
  liveEvaluation?: { valid: boolean; reasons: string[] } | null;
};

type IndexRefresh = {
  autoEnabled: boolean;
  run: {
    indexId: string;
    status: string;
    stage: string;
    errorCode: string | null;
  } | null;
};

const TEXT = {
  en: {
    refresh: "Refresh index now",
    refreshTerms:
      "Orbit sends eligible passages and generated questions to the configured AI providers using this project's AI budget. It activates the new index after the check passes.",
    autoEnable: "Enable automatic refresh",
    autoDisable: "Disable automatic refresh",
    autoInfo:
      "Automatically refresh when Orbit needs a new live check. Disabling this setting leaves an already started refresh running.",
    autoOn: "Automatic refresh is on.",
    autoOff: "Automatic refresh is off.",
    refreshCurrent: "The active index has a valid live check.",
    refreshProgress: {
      embedding: "Embedding passages…",
      questions: "Writing test questions…",
      evaluation: "Running the live check…",
    } as Record<string, string>,
    refreshDone: "The check passed and the new index is active.",
    refreshFailed: "Index refresh stopped.",
    advanced: "Manual index controls",
    title: "Search index",
    intro:
      "Orbit finds knowledge through an index of text passages. A new index generation is built and checked with test questions before it replaces the current one.",
    prepare: "Prepare new generation",
    generation: "Generation",
    embedded: (done: number, total: number) =>
      `${done} of ${total} text passages embedded`,
    passages: (total: number) => `${total} text passages`,
    phase: {
      embedding: "Embedding",
      ready_for_evaluation: "Ready for the check",
      evaluation_failed: "Check not passed",
      evaluated: "Check passed",
      active: "Active",
      retired: "Retired",
      corpus_changed: "Outdated",
    } as Record<string, string>,
    hint: {
      embedding: "Some passages are not embedded yet. Embed the next batch.",
      ready_for_evaluation:
        "All passages are embedded. Check next whether the search finds the right passages.",
      evaluation_failed:
        "The last check did not pass. You can check again with new questions.",
      evaluated: "The check passed. Activate the generation to use it.",
      corpus_changed:
        "The knowledge changed after this generation was prepared. Prepare a new generation.",
    } as Record<string, string>,
    activeInvalid: "Active · check not valid",
    liveInvalid: {
      INDEX_EVALUATION_CORPUS_CHANGED:
        "No valid check: the knowledge changed after this generation was checked.",
      LIVE_INDEX_EVALUATION_REQUIRED:
        "No valid check: this generation has no live check, or it is older than 30 days.",
      INDEX_EVALUATION_RECEIPTS_UNAVAILABLE:
        "No valid check: the cost receipts of its check are incomplete.",
    } as Record<string, string>,
    liveInvalidAction:
      "Refresh the index to restore the live check for post releases.",
    build: "Embed next batch",
    check: "Check",
    review: "Review questions",
    activate: "Activate",
    rollback: "Roll back",
    run: {
      generating: (done: number) =>
        `Orbit is writing test questions (${done} batches done) …`,
      review: (n: number) => `${n} test questions are ready for your review.`,
      queued: "The check is running …",
      running: "The check is running …",
      passed: (found: number, total: number, recall: number) =>
        `Passed: ${found} of ${total} questions found the right passage (${recall} %), no forbidden hits.`,
      notPassed: (
        found: number,
        total: number,
        recall: number,
        forbidden: number,
      ) =>
        `Not passed: ${found} of ${total} questions found the right passage (${recall} %, 90 % needed)${forbidden ? `, ${forbidden} forbidden hits` : ""}.`,
      failed: (why: string) => `Stopped: ${why}`,
    },
    details: "Evaluation record",
    prepareTitle: "Prepare a new index generation",
    prepareInfo:
      "Takes a snapshot of the current knowledge. Free; the embedding follows as a separate step.",
    profile: "Embedding model",
    prepareSubmit: "Prepare",
    buildTitle: "Embed passages",
    buildInfo:
      "Sends the next passages to OpenAI to compute their embeddings. This costs a little and runs within the project's AI budget.",
    buildConfirm: "I allow this paid embedding batch",
    buildSubmit: "Embed",
    checkTitle: "Check the search",
    checkInfo:
      "Orbit writes a test question for each text passage and then checks whether the search finds that passage among the first ten results. Control questions check that internal knowledge is never found by public questions. You review the questions before the check runs.",
    estimate: (amount: string) =>
      `Estimated cost of writing the questions: at most ${amount}.`,
    estimateUnknown:
      "The cost depends on the model chosen for “Knowledge test questions” in the AI settings.",
    checkConfirm:
      "I allow Orbit to send the text passages to the AI provider to write test questions (paid)",
    checkSubmit: "Write test questions",
    reviewTitle: "Review the test questions",
    reviewInfo:
      "Untick questions that do not fit. The check needs at least 48 test questions, 12 control questions and 60 questions in total.",
    questions: "Test questions",
    controls: "Control questions",
    controlPublic: "Must not find this internal passage when asked publicly",
    controlLanguage: "Asked in another language: must not find this passage",
    selected: (q: number, c: number) =>
      `${q} test questions and ${c} control questions selected.`,
    tooFew: "Too few questions selected for the check.",
    reviewConfirm:
      "I allow sending the questions to OpenAI for the check (paid, less than 1 cent)",
    reviewSubmit: "Start the check",
    activateTitle: "Activate generation",
    activateInfo:
      "From now on the search uses this generation. Content that depends on the old one is checked again.",
    rollbackTitle: "Roll back to this generation",
    confirm: "I confirm this change",
    apply: "Apply",
    errors: {
      INDEX_REFRESH_CHECK_NOT_PASSED:
        "The new index did not pass the live check. The previous index is still active.",
      INDEX_REFRESH_TIMEOUT: "The refresh timed out. Start it again.",
      INDEX_NOT_READY_FOR_EVALUATION:
        "This generation is not ready for a check.",
      EVALUATION_IN_PROGRESS: "A check of this generation is already running.",
      EVALUATION_SET_TOO_SMALL:
        "There is too little knowledge for a meaningful check (at least 48 questions are needed).",
      EVALUATION_SET_NOT_IN_REVIEW: "These questions can no longer be started.",
      EVALUATION_CASE_COVERAGE_REQUIRED:
        "Too few questions selected for the check.",
      INDEX_CORPUS_CHANGED:
        "The knowledge changed in the meantime. Prepare a new generation.",
      AGENT_OUTPUT_INVALID: "The AI's answer could not be used. Try again.",
      AGENT_OUTPUT_LIMIT:
        "The AI's answer was cut off at its output limit. Raise “Knowledge test questions” in the AI settings.",
      MODEL_CAPABILITY_NOT_VERIFIED:
        "No model is set up for “Knowledge test questions” in the AI settings.",
      EMBEDDING_KEY_REQUIRED: "The project has no OpenAI key for embeddings.",
      PROJECT_PAUSED: "The project is paused.",
    } as Record<string, string>,
    budget: "The project's AI budget or spending approval does not allow it.",
  },
  de: {
    refresh: "Index jetzt aktualisieren",
    refreshTerms:
      "Orbit sendet freigegebene Wissensabschnitte und erzeugte Testfragen an die konfigurierten KI-Anbieter. Der Lauf nutzt das KI-Budget des Projekts. Nach bestandener Prüfung aktiviert Orbit den neuen Index.",
    autoEnable: "Automatische Aktualisierung einschalten",
    autoDisable: "Automatische Aktualisierung ausschalten",
    autoInfo:
      "Orbit startet automatisch, wenn eine neue Live-Prüfung nötig ist. Das Ausschalten lässt einen bereits gestarteten Lauf zu Ende laufen.",
    autoOn: "Automatische Aktualisierung ist an.",
    autoOff: "Automatische Aktualisierung ist aus.",
    refreshCurrent: "Der aktive Index hat eine gültige Live-Prüfung.",
    refreshProgress: {
      embedding: "Wissensabschnitte werden eingebettet …",
      questions: "Testfragen werden geschrieben …",
      evaluation: "Die Live-Prüfung läuft …",
    } as Record<string, string>,
    refreshDone: "Die Prüfung ist bestanden und der neue Index ist aktiv.",
    refreshFailed: "Die Indexaktualisierung wurde gestoppt.",
    advanced: "Index manuell verwalten",
    title: "Suchindex",
    intro:
      "Orbit findet Wissen über einen Index aus Textabschnitten. Eine neue Index-Generation wird aufgebaut und mit Testfragen geprüft, bevor sie die aktuelle ersetzt.",
    prepare: "Neue Generation vorbereiten",
    generation: "Generation",
    embedded: (done: number, total: number) =>
      `${done} von ${total} Textabschnitten eingebettet`,
    passages: (total: number) => `${total} Textabschnitte`,
    phase: {
      embedding: "Wird eingebettet",
      ready_for_evaluation: "Bereit zur Prüfung",
      evaluation_failed: "Prüfung nicht bestanden",
      evaluated: "Prüfung bestanden",
      active: "Aktiv",
      retired: "Abgelöst",
      corpus_changed: "Veraltet",
    } as Record<string, string>,
    hint: {
      embedding:
        "Noch sind nicht alle Abschnitte eingebettet. Bette das nächste Paket ein.",
      ready_for_evaluation:
        "Alle Abschnitte sind eingebettet. Prüfe als Nächstes, ob die Suche die richtigen Abschnitte findet.",
      evaluation_failed:
        "Die letzte Prüfung wurde nicht bestanden. Du kannst mit neuen Fragen erneut prüfen.",
      evaluated:
        "Die Prüfung ist bestanden. Aktiviere die Generation, um sie zu nutzen.",
      corpus_changed:
        "Das Wissen hat sich geändert, seit diese Generation vorbereitet wurde. Bereite eine neue Generation vor.",
    } as Record<string, string>,
    activeInvalid: "Aktiv · Prüfung ungültig",
    liveInvalid: {
      INDEX_EVALUATION_CORPUS_CHANGED:
        "Das Wissen hat sich seit der Prüfung dieser Generation geändert.",
      LIVE_INDEX_EVALUATION_REQUIRED:
        "Für diese Generation fehlt eine gültige Live-Prüfung oder sie ist älter als 30 Tage.",
      INDEX_EVALUATION_RECEIPTS_UNAVAILABLE:
        "Die Kostenbelege ihrer Prüfung sind unvollständig.",
    } as Record<string, string>,
    liveInvalidAction:
      "Beiträge können erst wieder freigegeben werden, wenn eine neu geprüfte Generation aktiv ist.",
    build: "Nächstes Paket einbetten",
    check: "Prüfen",
    review: "Fragen durchsehen",
    activate: "Aktivieren",
    rollback: "Zurückrollen",
    run: {
      generating: (done: number) =>
        `Orbit schreibt Testfragen (${done} Pakete fertig) …`,
      review: (n: number) => `${n} Testfragen warten auf deine Durchsicht.`,
      queued: "Die Prüfung läuft …",
      running: "Die Prüfung läuft …",
      passed: (found: number, total: number, recall: number) =>
        `Bestanden: ${found} von ${total} Fragen fanden den richtigen Abschnitt (${recall} %), keine unzulässigen Treffer.`,
      notPassed: (
        found: number,
        total: number,
        recall: number,
        forbidden: number,
      ) =>
        `Nicht bestanden: ${found} von ${total} Fragen fanden den richtigen Abschnitt (${recall} %, nötig sind 90 %)${forbidden ? `, ${forbidden} unzulässige Treffer` : ""}.`,
      failed: (why: string) => `Abgebrochen: ${why}`,
    },
    details: "Prüfprotokoll",
    prepareTitle: "Neue Index-Generation vorbereiten",
    prepareInfo:
      "Hält den aktuellen Wissensstand fest. Kostenlos; das Einbetten folgt als eigener Schritt.",
    profile: "Embedding-Modell",
    prepareSubmit: "Vorbereiten",
    buildTitle: "Abschnitte einbetten",
    buildInfo:
      "Sendet die nächsten Abschnitte an OpenAI, um ihre Embeddings zu berechnen. Das kostet wenig und läuft über das KI-Budget des Projekts.",
    buildConfirm: "Ich erlaube dieses kostenpflichtige Einbetten",
    buildSubmit: "Einbetten",
    checkTitle: "Suche prüfen",
    checkInfo:
      "Orbit schreibt zu jedem Textabschnitt eine Testfrage und prüft dann, ob die Suche genau diesen Abschnitt unter den ersten zehn Treffern findet. Kontrollfragen prüfen, dass internes Wissen bei öffentlichen Fragen nie gefunden wird. Du siehst die Fragen durch, bevor die Prüfung startet.",
    estimate: (amount: string) =>
      `Geschätzte Kosten für das Schreiben der Fragen: höchstens ${amount}.`,
    estimateUnknown:
      "Die Kosten hängen vom Modell ab, das in den KI-Einstellungen für „Wissensprüfung: Testfragen“ gewählt ist.",
    checkConfirm:
      "Ich erlaube, dass Orbit die Textabschnitte an den KI-Anbieter sendet, um Testfragen zu schreiben (kostenpflichtig)",
    checkSubmit: "Testfragen schreiben",
    reviewTitle: "Testfragen durchsehen",
    reviewInfo:
      "Entferne das Häkchen bei Fragen, die nicht passen. Für die Prüfung braucht es mindestens 48 Testfragen, 12 Kontrollfragen und insgesamt 60 Fragen.",
    questions: "Testfragen",
    controls: "Kontrollfragen",
    controlPublic:
      "Darf diesen internen Abschnitt bei einer öffentlichen Frage nicht finden",
    controlLanguage:
      "In einer anderen Sprache gestellt: darf diesen Abschnitt nicht finden",
    selected: (q: number, c: number) =>
      `${q} Testfragen und ${c} Kontrollfragen ausgewählt.`,
    tooFew: "Für die Prüfung sind zu wenige Fragen ausgewählt.",
    reviewConfirm:
      "Ich erlaube, die Fragen für die Prüfung an OpenAI zu senden (kostenpflichtig, unter 1 Cent)",
    reviewSubmit: "Prüfung starten",
    activateTitle: "Generation aktivieren",
    activateInfo:
      "Die Suche nutzt ab sofort diese Generation. Inhalte, die von der alten abhängen, werden erneut geprüft.",
    rollbackTitle: "Auf diese Generation zurückrollen",
    confirm: "Ich bestätige diese Änderung",
    apply: "Übernehmen",
    errors: {
      INDEX_REFRESH_CHECK_NOT_PASSED:
        "Der neue Index hat die Live-Prüfung nicht bestanden. Der bisherige Index bleibt aktiv.",
      INDEX_REFRESH_TIMEOUT:
        "Die Aktualisierung hat zu lange gedauert. Starte sie erneut.",
      INDEX_NOT_READY_FOR_EVALUATION:
        "Diese Generation ist nicht bereit für eine Prüfung.",
      EVALUATION_IN_PROGRESS:
        "Für diese Generation läuft bereits eine Prüfung.",
      EVALUATION_SET_TOO_SMALL:
        "Für eine aussagekräftige Prüfung ist zu wenig Wissen vorhanden (nötig sind mindestens 48 Fragen).",
      EVALUATION_SET_NOT_IN_REVIEW:
        "Diese Fragen können nicht mehr gestartet werden.",
      EVALUATION_CASE_COVERAGE_REQUIRED:
        "Für die Prüfung sind zu wenige Fragen ausgewählt.",
      INDEX_CORPUS_CHANGED:
        "Das Wissen hat sich inzwischen geändert. Bereite eine neue Generation vor.",
      AGENT_OUTPUT_INVALID:
        "Die Antwort der KI war nicht verwendbar. Versuche es erneut.",
      AGENT_OUTPUT_LIMIT:
        "Die Antwort der KI wurde an ihrem Ausgabelimit abgeschnitten. Erhöhe „Wissensprüfung: Testfragen“ in den KI-Einstellungen.",
      MODEL_CAPABILITY_NOT_VERIFIED:
        "In den KI-Einstellungen ist kein Modell für „Wissensprüfung: Testfragen“ eingerichtet.",
      EMBEDDING_KEY_REQUIRED:
        "Das Projekt hat keinen OpenAI-Schlüssel für Embeddings.",
      PROJECT_PAUSED: "Das Projekt ist pausiert.",
    } as Record<string, string>,
    budget:
      "Das KI-Budget oder die Ausgabenfreigabe des Projekts lässt das nicht zu.",
  },
};
type Text = (typeof TEXT)["en"];

/** A readable reason for a server code. */
export function reason(text: Text, code: string | null | undefined) {
  if (!code) return "";
  const known = text.errors[code.split(":")[0]!];
  if (known) return known;
  if (/BUDGET|MANDATE|POLICY|CEILING/.test(code)) return text.budget;
  return code;
}
const usd = (micros: number, locale: Locale) =>
  new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.max(micros, 10_000) / 1_000_000);

function RunSummary({ run, text }: { run: EvaluationRun; text: Text }) {
  if (run.status === "generating")
    return <p>{text.run.generating(run.batchesDone ?? 0)}</p>;
  if (run.status === "review") return <p>{text.run.review(run.cases)}</p>;
  if (run.status === "queued" || run.status === "running")
    return <p>{text.run[run.status]}</p>;
  if (run.status === "failed")
    return <p>{text.run.failed(reason(text, run.errorCode))}</p>;
  const e = run.evaluation;
  if (run.status !== "completed" || !e) return null;
  const found = e.found;
  const recall = Math.round(e.recallAt10 * 100);
  return (
    <p>
      {e.passed
        ? text.run.passed(found, e.answered, recall)
        : text.run.notPassed(found, e.answered, recall, e.forbiddenHits)}
    </p>
  );
}

const BUSY = ["generating", "queued", "running"];
type Mode = "begin" | "build" | "check" | "review" | "activate" | "rollback";

/** The step a generation offers its owner, by phase and evaluation record. */
function steps(i: IndexGeneration, text: Text) {
  const run = i.evaluationRun;
  const phase = i.phase ?? i.state;
  if (run?.status === "review")
    return [{ key: "review" as Mode, label: text.review }];
  if (BUSY.includes(run?.status ?? "")) return [];
  if (phase === "embedding")
    return [{ key: "build" as Mode, label: text.build }];
  if (phase === "ready_for_evaluation" || phase === "evaluation_failed")
    return [{ key: "check" as Mode, label: text.check }];
  if (phase === "evaluated")
    return [{ key: "activate" as Mode, label: text.activate }];
  if (phase === "retired")
    return [{ key: "rollback" as Mode, label: text.rollback }];
  return [];
}

export function IndexManagement() {
  const { project, revision, isOwner, refresh, locale, t } = useWorkspace();
  const text = TEXT[locale];
  const indexes = useResource<{
    items: IndexGeneration[];
    refresh?: IndexRefresh;
  }>(collectionPath(project.id, `indexes?revision=${revision}`));
  const [mode, setMode] = useState<Mode | null>(null);
  const [enablingAuto, setEnablingAuto] = useState(false);
  const [selected, setSelected] = useState<IndexGeneration | null>(null);
  const mutation = useMutation(() => {
    refresh();
    indexes.refresh();
  });
  const indexRefresh = indexes.data?.refresh;
  const refreshRun = indexRefresh?.run;
  const refreshing = refreshRun?.status === "running";
  const current =
    indexes.data?.items?.find((i) => i.state === "active")?.liveEvaluation
      ?.valid === true;
  const busy =
    refreshing ||
    indexRefresh?.autoEnabled ||
    (indexes.data?.items ?? []).some((i) =>
      BUSY.includes(i.evaluationRun?.status ?? ""),
    );
  const reload = indexes.refresh;
  const polling =
    refreshing || (indexRefresh?.autoEnabled && !current) ? 5000 : 30000;
  // Questions and the check run in the background: look again while they do.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => reload(), polling);
    return () => clearInterval(timer);
  }, [busy, reload, polling]);
  const open = (m: Mode, generation: IndexGeneration | null) => {
    setSelected(generation);
    setMode(m);
    mutation.clear();
  };
  const close = () => setMode(null);
  const done = (result: unknown) => {
    if (result) close();
  };
  const error = mutation.error ? reason(text, mutation.error) : null;
  return (
    <section className="panel administration-panel knowledge-index-panel">
      <div className="panel-head">
        <div>
          <h2>{text.title}</h2>
          <p>{text.intro}</p>
        </div>
      </div>
      <ResourceError error={indexes.error} retry={indexes.refresh} />
      {isOwner && indexRefresh && (
        <div className="knowledge-index-refresh">
          <div className="knowledge-index-description">
            <p>{text.refreshTerms}</p>
            <p role="status">
              {refreshing
                ? text.refreshProgress[refreshRun.stage]
                : refreshRun?.status === "failed" && !current
                  ? `${text.refreshFailed} ${reason(text, refreshRun.errorCode)}`
                  : current
                    ? refreshRun?.status === "completed"
                      ? text.refreshDone
                      : text.refreshCurrent
                    : null}
            </p>
            <p>{indexRefresh.autoEnabled ? text.autoOn : text.autoOff}</p>
            {error && !mode && !enablingAuto && (
              <Alert kind="error">{error}</Alert>
            )}
          </div>
          <div className="knowledge-index-actions">
            <Button
              disabled={current || refreshing || mutation.pending}
              onClick={() =>
                mutation.run(() =>
                  action(project.id, "refresh-knowledge-index", {
                    confirmPaidProviderUse: true,
                  }),
                )
              }
            >
              {text.refresh}
            </Button>
            <Button
              variant="outline"
              disabled={mutation.pending}
              onClick={() => {
                mutation.clear();
                if (indexRefresh.autoEnabled)
                  return mutation.run(() =>
                    action(project.id, "knowledge-index-automation", {
                      enabled: false,
                    }),
                  );
                setEnablingAuto(true);
              }}
            >
              {indexRefresh.autoEnabled ? text.autoDisable : text.autoEnable}
            </Button>
          </div>
        </div>
      )}
      {isOwner && (
        <details className="knowledge-index-manual">
          <summary>{text.advanced}</summary>
          <Button variant="outline" onClick={() => open("begin", null)}>
            {text.prepare}
          </Button>
        </details>
      )}
      {enablingAuto && (
        <Modal title={text.autoEnable} onClose={() => setEnablingAuto(false)}>
          <Alert>
            {text.autoInfo} {text.refreshTerms}
          </Alert>
          {error && <Alert kind="error">{error}</Alert>}
          <div className="form-actions">
            <Button
              disabled={mutation.pending}
              onClick={() =>
                mutation
                  .run(() =>
                    action(project.id, "knowledge-index-automation", {
                      enabled: true,
                      confirmPaidProviderUse: true,
                    }),
                  )
                  .then((result) => {
                    if (result) setEnablingAuto(false);
                  })
              }
            >
              {text.autoEnable}
            </Button>
          </div>
        </Modal>
      )}
      {indexes.loading ? (
        <Loading />
      ) : (
        (indexes.data?.items || []).map((i) => {
          const run = i.evaluationRun;
          const phase = i.phase ?? i.state;
          const offered = i.managedRefresh ? [] : steps(i, text);
          // The active generation whose live check no longer allows releases.
          const invalid =
            phase === "active" && i.liveEvaluation?.valid === false;
          return (
            <div className="data-row index-generation" key={i.id}>
              <div>
                <strong>
                  {text.generation} {i.generation}
                </strong>
                <p>{i.profile}</p>
                <small>
                  {i.embeddedChunks !== undefined
                    ? text.embedded(i.embeddedChunks, i.chunks ?? 0)
                    : text.passages(
                        Array.isArray(i.manifest) ? i.manifest.length : 0,
                      )}
                </small>
                {text.hint[phase] &&
                  !BUSY.includes(run?.status ?? "") &&
                  run?.status !== "review" && <p>{text.hint[phase]}</p>}
                {invalid && (
                  <p>
                    {(i.liveEvaluation?.reasons ?? [])
                      .map((r) => text.liveInvalid[r])
                      .filter(Boolean)
                      .join(" ")}{" "}
                    {text.liveInvalidAction}
                  </p>
                )}
                {run && <RunSummary run={run} text={text} />}
              </div>
              <Badge
                tone={
                  invalid
                    ? "warning"
                    : phase === "active" || phase === "evaluated"
                      ? "success"
                      : phase === "evaluation_failed"
                        ? "danger"
                        : phase === "ready_for_evaluation"
                          ? "blue"
                          : "neutral"
                }
              >
                {invalid ? text.activeInvalid : (text.phase[phase] ?? phase)}
              </Badge>
              {isOwner && offered.length > 0 && (
                <div className="form-actions">
                  {offered.map((step) => (
                    <Button
                      key={step.key}
                      variant="outline"
                      onClick={() => open(step.key, i)}
                    >
                      {step.label}
                    </Button>
                  ))}
                </div>
              )}
              {i.evaluation && (
                <details>
                  <summary>{text.details}</summary>
                  <pre className="code-block">
                    {JSON.stringify(i.evaluation, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          );
        })
      )}
      {mode === "review" && selected?.evaluationRun?.items ? (
        <ReviewDialog
          run={selected.evaluationRun}
          text={text}
          pending={mutation.pending}
          error={error}
          onClose={close}
          onStart={(excludedCaseIds) =>
            mutation
              .run(() =>
                action(project.id, "start-evaluation-set", {
                  evaluationId: selected.evaluationRun!.id,
                  excludedCaseIds,
                  confirmQueriesMayBeSentToOpenAI: true,
                }),
              )
              .then(done)
          }
        />
      ) : mode && mode !== "review" ? (
        <Modal
          title={
            mode === "begin"
              ? text.prepareTitle
              : mode === "build"
                ? text.buildTitle
                : mode === "check"
                  ? text.checkTitle
                  : mode === "activate"
                    ? text.activateTitle
                    : text.rollbackTitle
          }
          onClose={close}
        >
          <Alert
            kind={mode === "build" || mode === "check" ? "warning" : "info"}
          >
            {mode === "begin"
              ? text.prepareInfo
              : mode === "build"
                ? text.buildInfo
                : mode === "check"
                  ? text.checkInfo
                  : text.activateInfo}
          </Alert>
          {mode === "check" && (
            <p className="field-hint">
              {typeof selected?.evaluationSetEstimateMicros === "number"
                ? text.estimate(
                    usd(selected.evaluationSetEstimateMicros, locale),
                  )
                : text.estimateUnknown}
            </p>
          )}
          <DataForm
            key={`${mode}-${selected?.id || "new"}`}
            t={t}
            fields={
              mode === "begin"
                ? [
                    {
                      name: "profile",
                      label: text.profile,
                      type: "select",
                      required: true,
                      value: "openai:text-embedding-3-small:1536:chunk-v1",
                      options: options([
                        "openai:text-embedding-3-small:1536:chunk-v1",
                        "openai:text-embedding-3-large:1536:chunk-v1",
                        "openai:text-embedding-3-large:3072:chunk-v1",
                      ]),
                    },
                  ]
                : [
                    {
                      name: "confirm",
                      label:
                        mode === "build"
                          ? text.buildConfirm
                          : mode === "check"
                            ? text.checkConfirm
                            : text.confirm,
                      type: "checkbox",
                      required: true,
                    },
                  ]
            }
            pending={mutation.pending}
            error={error}
            submitLabel={
              mode === "begin"
                ? text.prepareSubmit
                : mode === "build"
                  ? text.buildSubmit
                  : mode === "check"
                    ? text.checkSubmit
                    : text.apply
            }
            onSubmit={(v) =>
              mutation
                .run(async () => {
                  if (mode === "begin")
                    return action(project.id, "begin-index", {
                      profile: str(v, "profile"),
                    });
                  if (!selected) throw new Error("INDEX_UNAVAILABLE");
                  if (mode === "check")
                    return action(project.id, "generate-evaluation-set", {
                      indexId: selected.id,
                    });
                  return action(project.id, `${mode}-index`, {
                    indexId: selected.id,
                  });
                })
                .then(done)
            }
          />
        </Modal>
      ) : null}
    </section>
  );
}

function ReviewDialog({
  run,
  text,
  pending,
  error,
  onClose,
  onStart,
}: {
  run: EvaluationRun;
  text: Text;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onStart: (excludedCaseIds: string[]) => void;
}) {
  const items = useMemo(() => run.items ?? [], [run.items]);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [confirmed, setConfirmed] = useState(false);
  const counts = useMemo(() => {
    const kept = items.filter((item) => !excluded.has(item.id));
    const questions = kept.filter((item) => item.kind === "positive").length;
    return { questions, controls: kept.length - questions, total: kept.length };
  }, [items, excluded]);
  const enough =
    counts.questions >= 48 && counts.controls >= 12 && counts.total >= 60;
  const toggle = (id: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const list = (kinds: CaseKind[]) => (
    <ul className="evaluation-review">
      {items
        .filter((item) => kinds.includes(item.kind))
        .map((item) => (
          <li key={item.id}>
            <label>
              <input
                type="checkbox"
                checked={!excluded.has(item.id)}
                onChange={() => toggle(item.id)}
              />
              <span>
                <strong>{item.query}</strong>
                {item.kind !== "positive" && (
                  <em>
                    {item.kind === "public_leak"
                      ? text.controlPublic
                      : text.controlLanguage}
                  </em>
                )}
                <small>
                  {[item.title, item.heading].filter(Boolean).join(" · ")}
                  {item.snippet ? ` — ${item.snippet}` : ""}
                </small>
              </span>
            </label>
          </li>
        ))}
    </ul>
  );
  return (
    <Modal title={text.reviewTitle} onClose={onClose} wide>
      <Alert>{text.reviewInfo}</Alert>
      <h3 className="field-heading">{text.questions}</h3>
      {list(["positive"])}
      <h3 className="field-heading">{text.controls}</h3>
      {list(["public_leak", "language"])}
      <p className="field-hint" role="status">
        {text.selected(counts.questions, counts.controls)}
        {!enough && ` ${text.tooFew}`}
      </p>
      <label className="evaluation-review-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>{text.reviewConfirm}</span>
      </label>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="form-actions">
        <Button
          disabled={!enough || !confirmed || pending}
          onClick={() => onStart([...excluded])}
        >
          {text.reviewSubmit}
        </Button>
      </div>
    </Modal>
  );
}
