export const googleSearchReport =
  "SearchEngineKeywordsPerformance.getKeywordsGoogleWeb";

const reportNames: Record<string, [en: string, de: string]> = {
  "VisitsSummary.get": ["Website visits", "Website-Besuche"],
  "Actions.get": ["Website actions", "Website-Aktionen"],
  "Referrers.getCampaigns": ["Campaign visits", "Kampagnenbesuche"],
  "Actions.getPageUrls": ["Individual pages", "Einzelne Seiten"],
  "Goals.get": ["Website goals", "Website-Ziele"],
  [googleSearchReport]: [
    "Google Web Search (Search Console)",
    "Google-Websuche (Search Console)",
  ],
};

export const matomoReports = Object.keys(reportNames);

export function matomoReportLabel(method: string, de: boolean) {
  return reportNames[method]?.[de ? 1 : 0] ?? method;
}
