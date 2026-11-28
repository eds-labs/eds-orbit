"use client";

import { useId, useState } from "react";
import { ChartNoAxesCombined, Globe } from "lucide-react";
import {
  Alert,
  Button,
  Empty,
  Field,
  FieldLabel,
  Input,
  Loading,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useResource } from "@/lib/api";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { PageHead } from "@/platform/ui/collection";
import {
  dimensions,
  initialRange,
  maxReportRows,
  seoPath,
  validRange,
  websitePath,
  type Dimension,
  type SeoOverview,
  type SeoPerformance,
} from "./api";
import { seoError, seoText } from "./labels";
import styles from "./seo.module.css";

export function SeoRequestError({
  error,
  retry,
}: {
  error: Error;
  retry?: () => void;
}) {
  const { locale } = useWorkspace();
  const t = seoText(locale);
  return (
    <Alert kind="error">
      <p>{seoError(error, t)}</p>
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          {t.retry}
        </Button>
      )}
    </Alert>
  );
}

function PerformanceTable({ report }: { report: SeoPerformance }) {
  const { locale } = useWorkspace();
  const titleId = useId();
  const t = seoText(locale);
  const integer = new Intl.NumberFormat(locale);
  const percentage = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 2,
  });
  const position = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  const dateLabel = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? date.format(parsed) : value;
  };
  if (!report.rows.length)
    return <Empty title={t.emptyReport} icon={ChartNoAxesCombined} />;
  return (
    <div className={styles.body}>
      <p id={titleId} className="field-hint">
        {t.reportRows(
          report.rows.length,
          dateLabel(report.startDate),
          dateLabel(report.endDate),
        )}
      </p>
      <div
        role="region"
        aria-label={t.reportTable}
        tabIndex={0}
        className={`table-wrap ${styles.table}`}
      >
        <table className="table-plain-head" aria-labelledby={titleId}>
          <thead>
            <tr>
              <th scope="col">{t.dimensions[report.dimension]}</th>
              <th scope="col">{t.clicks}</th>
              <th scope="col">{t.impressions}</th>
              <th scope="col">{t.ctr}</th>
              <th scope="col">{t.position}</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={JSON.stringify(row.keys)}>
                <td>
                  {report.dimension === "date"
                    ? dateLabel(row.keys[0] ?? "")
                    : row.keys.join(" · ")}
                </td>
                <td>{integer.format(row.clicks)}</td>
                <td>{integer.format(row.impressions)}</td>
                <td>{percentage.format(row.ctr)}</td>
                <td>{position.format(row.position)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Report({ overview }: { overview: SeoOverview }) {
  const { project, locale } = useWorkspace();
  const t = seoText(locale);
  const id = useId();
  const [websiteId, setWebsiteId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [dimension, setDimension] = useState<Dimension>("date");
  const [{ startDate, endDate }, setRange] = useState(() => initialRange());
  const [requested, setRequested] = useState("");
  const [invalidRange, setInvalidRange] = useState(false);
  const website =
    overview.websites.find((item) => item.id === websiteId) ??
    overview.websites.find((item) => item.properties.length > 0) ??
    overview.websites[0];
  const binding =
    website?.properties.find((property) => property.provider === providerId) ??
    website?.properties[0];
  const reportPath = requested && website && binding ? requested : null;
  const report = useResource<SeoPerformance>(reportPath);

  if (!website) {
    return <Empty icon={Globe} title={t.noSites} description={t.noSitesBody} />;
  }
  return (
    <section className="panel" aria-labelledby={`${id}-heading`}>
      <div className="panel-head">
        <h2 id={`${id}-heading`}>{t.performance}</h2>
      </div>
      <div className={`panel-body ${styles.body}`}>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (!binding) return;
            if (!validRange(startDate, endDate)) {
              setInvalidRange(true);
              return;
            }
            const params = new URLSearchParams({
              provider: binding.provider,
              startDate,
              endDate,
              dimension,
              limit: String(maxReportRows),
            });
            const next = seoPath(
              project.id,
              `${websitePath(website.id)}/performance?${params}`,
            );
            setInvalidRange(false);
            if (next === requested) report.refresh();
            else setRequested(next);
          }}
        >
          <div className={styles.fields}>
            <Field>
              <FieldLabel htmlFor={`${id}-website`}>
                {t.selectWebsite}
              </FieldLabel>
              <select
                className="input"
                id={`${id}-website`}
                value={website.id}
                onChange={(event) => {
                  setWebsiteId(event.target.value);
                  setProviderId("");
                  setRequested("");
                }}
              >
                {overview.websites.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
            {binding && (
              <>
                <Field>
                  <FieldLabel htmlFor={`${id}-provider`}>
                    {t.selectProvider}
                  </FieldLabel>
                  <select
                    className="input"
                    id={`${id}-provider`}
                    value={binding.provider}
                    onChange={(event) => {
                      setProviderId(event.target.value);
                      setRequested("");
                    }}
                  >
                    {website.properties.map((property) => (
                      <option key={property.provider} value={property.provider}>
                        {overview.providers.find(
                          (provider) => provider.id === property.provider,
                        )?.label ?? property.provider}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-start`}>{t.startDate}</FieldLabel>
                  <Input
                    id={`${id}-start`}
                    type="date"
                    required
                    value={startDate}
                    onChange={(event) => {
                      setRange({ startDate: event.target.value, endDate });
                      setInvalidRange(false);
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-end`}>{t.endDate}</FieldLabel>
                  <Input
                    id={`${id}-end`}
                    type="date"
                    required
                    value={endDate}
                    onChange={(event) => {
                      setRange({ startDate, endDate: event.target.value });
                      setInvalidRange(false);
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-dimension`}>
                    {t.groupBy}
                  </FieldLabel>
                  <select
                    className="input"
                    id={`${id}-dimension`}
                    value={dimension}
                    onChange={(event) =>
                      setDimension(event.target.value as Dimension)
                    }
                  >
                    {dimensions.map((item) => (
                      <option key={item} value={item}>
                        {t.dimensions[item]}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>
          {binding && (
            <div className={styles.actions}>
              <Button
                type="submit"
                disabled={Boolean(reportPath && report.loading)}
              >
                {t.load}
              </Button>
              <p className="field-hint">{t.range}</p>
            </div>
          )}
          {invalidRange && <Alert kind="error">{t.rangeError}</Alert>}
        </form>
        {!binding && (
          <Empty
            icon={Globe}
            title={t.noLinkedSites}
            description={t.noLinkedSitesBody}
          />
        )}
        {reportPath && report.loading && <Loading label={t.waitingReport} />}
        {reportPath && report.errorPath === reportPath && report.error && (
          <SeoRequestError error={report.error} retry={report.refresh} />
        )}
        {reportPath && report.path === reportPath && report.data && (
          <PerformanceTable report={report.data} />
        )}
      </div>
    </section>
  );
}

export function SeoOverviewPage() {
  const { project, locale } = useWorkspace();
  const { projectCenterHref } = useShell();
  const t = seoText(locale);
  const overview = useResource<SeoOverview>(seoPath(project.id));
  return (
    <div className={styles.page}>
      <PageHead title="SEO" description={t.intro}>
        {overview.data?.canManage && (
          <Button asChild variant="outline">
            <AppLink
              href={projectCenterHref("integrations", "seo", "search-console")}
            >
              {t.manage}
            </AppLink>
          </Button>
        )}
      </PageHead>
      {overview.error && (
        <SeoRequestError error={overview.error} retry={overview.refresh} />
      )}
      {overview.loading && <Loading label={t.loading} />}
      {overview.data && <Report overview={overview.data} />}
    </div>
  );
}
