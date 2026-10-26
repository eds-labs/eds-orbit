# Contract `issues.report.v1`: inbound issue reports

Status: implemented locally on `claude/issue-center-phase-3` (ADR 0018, WP3.5); not merged or deployed. Reports arrive only while `ORBIT_ISSUES` and `ORBIT_PUBLIC_INGRESS` are on and the project's owner has enabled the Issues module.

Any system that can sign an HTTP request, n8n included, may send product problem reports to a project's issue center. Orbit stores each report **redacted** (e-mail addresses, phone numbers, IBANs, card numbers, IP addresses, tokens and credential URLs, wallet addresses and transaction hashes are removed) and never keeps the raw payload after processing.

## Source and secret

A project owner creates a source in Settings → Issues → Sources (`POST /api/projects/:projectId/issues/sources` with `{ "name": "…", "kind": "webhook" | "n8n" }`). The answer contains the source's `path` and its signing `secret`. The secret is shown **once**; store it in the sending system's credential store. Disabling a source drops its secret, and later deliveries are refused.

## Request

```
POST https://<orbit-host>/api/hooks/issues/<workspaceId>/<projectId>/<sourceId>
Content-Type: application/json
X-Orbit-Timestamp: <unix seconds>
X-Orbit-Signature: v1=<hex HMAC-SHA256(secret, X-Orbit-Timestamp + "." + rawBody)>
```

- The signature covers the exact body bytes; the timestamp may differ from Orbit's clock by at most 300 seconds.
- Bodies are limited to 256 KB; each source accepts at most 120 deliveries per minute.

## Body

```json
{
  "contract": "issues.report.v1",
  "id": "alert-2026-10-26-0001",
  "occurredAt": "2026-10-26T08:00:00Z",
  "title": "Checkout API returns 500",
  "symptoms": "Since 07:55 every checkout fails with HTTP 500.",
  "type": "bug",
  "severity": "s2_major",
  "components": ["checkout"],
  "fingerprint": "checkout-api-500",
  "externalRef": { "system": "uptime", "id": "monitor-17", "url": "https://status.example.com/17" },
  "environment": "production",
  "release": "2026.10.3",
  "diagnostics": { "status": 500, "route": "/api/checkout" }
}
```

| Field | Required | Rules |
|---|---|---|
| `contract` | yes | Exactly `issues.report.v1`. |
| `id` | yes | The delivery id, `[A-Za-z0-9._:-]{1,200}`; it is signed with the body. A repeated id is refused with 409 and not processed again. |
| `title` | yes | 1–200 characters. |
| `symptoms` | no | Up to 4,000 characters. Treated as untrusted data, never as instructions. |
| `occurredAt` | no | ISO 8601 with offset; later than now counts as now. |
| `type` | no | `bug`, `feature_request`, `improvement`, `technical_problem` (a hint). |
| `severity` | no | `s1_critical`, `s2_major`, `s3_minor`, `s4_trivial` (a hint; triage decides). |
| `components` | no | Up to 20 component keys; keys the project has not configured are ignored. |
| `fingerprint` | no | A stable error signature (≤ 200). A report with the fingerprint of an open or recently closed issue joins that issue. |
| `externalRef` | no | `{system, id, url?}`; `url` must be `https`. A report with a known reference joins its issue; Orbit never fetches the URL. |
| `environment`, `release` | no | Short identifiers. |
| `diagnostics` | no | Up to 30 flat keys (`[a-z][a-zA-Z0-9_.]{0,40}`) with short strings, numbers or booleans; strings are redacted; at most 4 KB. Only members with `issues.diagnostics.read` see them; MCP never returns them. |

Unknown fields are dropped and never stored.

## Answers

| Status | Meaning |
|---|---|
| 200 `{ "ok": true }` | Stored and queued; the report is processed in the background. |
| 401 | Signature, timestamp or source invalid (audited as `webhook.rejected`). |
| 404 | Public ingress, the module or the source is not available. |
| 409 | The delivery id was received before. |
| 413 / 415 | Body too large / not JSON. |
| 429 | Rate limited. |

A delivery that does not fit the contract, or that exceeds the project's daily report cap (Settings → Issues, default 500), is accepted at the door but recorded as rejected (`issues.intake.rejected`, `issues.intake.dropped`) and creates no report.

## What happens next

The report is redacted, matched (external reference, then fingerprint) and attached to an existing issue or turned into a new issue in `new`. A new issue gets lexical duplicate candidates for a person to confirm or reject; Orbit never merges two issues by itself.
