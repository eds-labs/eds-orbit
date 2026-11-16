# Outbound webhooks

Orbit notifies a project's own systems, for example a website that revalidates or rebuilds after a publication ([ADR 0029](adr/0029-content-module.md), work package CH1.3). This is separate from inbound webhooks (`/api/hooks/...`, WP4.2).

Status: implemented on the Content Hub branch and switched off by default (`ORBIT_WEBHOOKS=false`). The Content module registers its events; the publishing core emits them from CH1.10 on. The settings center UI follows in CH1.14f.

## Endpoints

- Project owners manage endpoints under `/api/projects/:projectId/webhooks`: list, create, change, rotate the secret, send a test ping, see deliveries, replay.
- An endpoint belongs to one module and subscribes to that module's registered event types, e.g. `cms.entry.published`.
- The URL must be HTTPS without credentials, query or fragment. Delivery uses `boundedFetch`: public addresses only, pinned DNS, no redirects, 10 s timeout.
- The signing secret `whsec_…` is shown once, when the endpoint is created or the secret is rotated. Orbit stores it encrypted.
- After a rotation the previous secret also signs for 24 hours.
- Changes, rotations, replays and automatic disabling are audited. Audit entries carry the URL's host, never its path.

## Requests to the receiver

`POST` with a JSON body:

```json
{ "id": "evt_…", "type": "cms.entry.published", "occurredAt": "2026-11-16T10:00:00.000Z",
  "projectId": "…", "data": { "entry": { "id": "…", "path": "/blog/…/" }, "tags": ["orbit:entry:…"] } }
```

Headers:
- `X-Orbit-Event-Id` and `X-Orbit-Event-Type`.
- `X-Orbit-Timestamp`: Unix seconds.
- `X-Orbit-Signature`: `v1=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`. During a rotation there are two values, comma-separated.

Payloads name what changed and carry no content. Receivers fetch the content through the [API v1](API_V1.md).

## Verifying on the receiver

1. Reject timestamps more than 5 minutes off.
2. Compute the HMAC over the raw body and accept it if any `v1=` value matches. Use a constant-time comparison.
3. Deduplicate by `X-Orbit-Event-Id`. Orbit may deliver an event more than once: a retry after an unclear answer, or a replay.
4. Answer `2xx` quickly and do the work afterwards.

## Retries and disabling

| Answer | Effect |
| --- | --- |
| `2xx` | Delivered. The endpoint's failure counter resets. |
| `410` | No further attempts. The endpoint is disabled with reason `GONE`. |
| Anything else, timeout, network error | Retried with backoff (1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h, then daily, ±20 % jitter), at most 12 attempts, then `dead`. |
| 20 consecutive failures | The endpoint is disabled with reason `FAILURES`. Re-enabling it resets the counter. |

- A paused project holds its deliveries as `failed` (`PROJECT_PAUSED`); the owner can replay them.
- Without live external writes (`EXECUTION_MODE=live` and `ENABLE_EXTERNAL_WRITES=true`) a delivery is recorded as `skipped` (`TEST_MODE`) and nothing is sent.
- Deliveries are kept for 30 days.

## For modules

- Register event types in `ModuleContributions.webhookEvents` (`<module>.<event>`).
- Emit them with `emitWebhookEvent(tx, scope, type, payload)` inside the transaction that makes the change, so a change and its deliveries commit together.

## Operations

- Enable it with `ORBIT_WEBHOOKS=true`. While off, the routes answer 404, nothing is emitted, and queued deliveries are recorded as `skipped`.
- Rollback: switch the flag off. The tables `WebhookEndpoint` and `WebhookDelivery` stay.
