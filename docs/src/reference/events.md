# Webhook events

Pylota Mail delivers events to your HTTPS endpoints using
[Standard Webhooks](https://www.standardwebhooks.com/). Configure endpoints through the
[API](api.md#webhooks) or `pmail webhooks create`.

## Delivery

```http
POST /webhooks/mail HTTP/1.1
Content-Type: application/json
User-Agent: PylotaMail/1.0 (+https://github.com/PILOTAAI/pylota-mail)
webhook-id: evt_01J9Z5…
webhook-timestamp: 1791540000
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4= v1,Hq3…(second during rotation)
```

### Verify every request

1. Build the signed content: `{webhook-id}.{webhook-timestamp}.{raw body}`. Use the raw request body
   bytes, not re-serialised JSON.
2. Compute `base64(HMAC-SHA256(secret_bytes, content))`. `secret_bytes` is the base64-decoded part of
   `whsec_…` after the prefix.
3. Compare it, in constant time, with each `v1,` signature in `webhook-signature`. Accept on any match.
4. Reject the request if `webhook-timestamp` is more than 5 minutes from your clock.
5. Deduplicate on `webhook-id`: delivery is **at least once**.

Standard Webhooks libraries exist for most languages. `pmail webhooks verify` checks a captured
request locally.

### Responses and retries

- Any `2xx` within 15 seconds counts as delivered. Response bodies are ignored and read only up to 4 KB.
- Anything else, including a timeout, TLS error, DNS error, redirect or `3xx`, is a failure. Failures
  retry at about **30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, 8 h, 12 h, 12 h, 12 h, 19 h**, which
  adds up to about 72 hours. Each delay has ±10% jitter.
- After the last attempt, the delivery is marked `dead`. The event can be replayed with
  `POST /v1/webhooks/{id}/replay` for 30 days from its `occurred_at` (or `retention.events_days`, if
  shorter), counted from when the event happened, not from when the delivery went `dead`.
- After 100 consecutive failures spread over at least 24 hours, the endpoint is disabled
  (`disabled_reason: failing`) and a `webhook.disabled` event goes to the platform's endpoints and, for
  an endpoint of a partner (a partner endpoint, or an endpoint of one of the partner's tenants), to that
  partner's other endpoints; never to tenant endpoints. `webhook.test` is delivered once and is never
  replayed.
- `410 Gone` from an endpoint disables it immediately.

### Ordering

Events are not guaranteed to arrive in order. Each payload carries `occurred_at`, and a `sequence` that
increases strictly per owner: per identity for mailbox events (`message.*`, `identity.*`,
`verification.received`, `suppression.created`, `quota.warning`), per domain for `domain.*` events, and
per job for `erasure.*` and `export.*` events, and for `identity.deleted`, which the erasure job emits
after the mailbox is gone (it still carries `identity_id`, so identity-filtered endpoints receive it). Use it to discard stale updates, for example a
`message.deferred` arriving after `message.delivered`. Platform events (`webhook.disabled`,
`webhook.test`, `member.*`, `billing.*`, `tenant.policy_updated` and `account.*`) have `sequence: null`.

## Envelope

```json
{
  "id": "evt_01J9Z5…",
  "type": "message.received",
  "api_version": "2026-10-01",
  "occurred_at": "2026-10-09T10:12:03.412Z",
  "tenant_id": "ten_01J9…",
  "identity_id": "idn_01J9…",
  "sequence": 1842,
  "data": { }
}
```

`identity_id` is `null` for events that do not belong to one identity (domain, job and platform
events); `identity.deleted` is the one job event that sets it. `tenant_id` is `null` only for deployment-level platform events.

Payloads are **thin**. They carry IDs, a summary, verdicts and up to `policy.webhook_text_bytes` of
`extracted_text` (default 16 KB, maximum 64 KB). Fetch anything else through the API.

## Event types

### Messages

| Type | When | `data` |
|---|---|---|
| `message.received` | An inbound message is stored and visible | `message` (summary, see below), `thread_id`, `trust`, `extracted_text`, `extracted_text_truncated`, `attachments[]` (id, filename, content type, size) |
| `message.quarantined` | An inbound message is stored but quarantined | as `message.received`, plus `quarantine_reason`. No `extracted_text` |
| `message.released` | A quarantined message was released | `message`, `released_by_key_id` (API release) or `released_by_user_id` (console release; the other is `null`), `reason` |
| `message.triaged` | Triage finished (or failed) | `message_id`, `thread_id`, `triage` |
| `message.sent` | The transport accepted an outbound message, or a person resolved an uncertain send as `sent` | `message`, `provider`, `provider_message_id` (`null` after a resolve), `sent_via_fallback` |
| `message.delivered` | A recipient's server accepted it | `message_id`, `recipient`, `smtp_code` |
| `message.deferred` | A temporary failure; the provider is retrying | `message_id`, `recipient`, `smtp_code`, `smtp_response` |
| `message.bounced` | A permanent failure, or retries exhausted | `message_id`, `recipient`, `bounce_type` (`hard` or `soft`), `smtp_code`, `smtp_response`, `suppressed` |
| `message.complained` | A recipient reported spam | `message_id`, `recipient`, `suppressed: true` |
| `message.rejected` | The transport refused it, at submission or, for some recipients, when the recipient's server rejected it after submission | `message_id`, `reason`, `detail` |
| `message.failed` | It could not be sent | `message_id`, `reason` |
| `message.uncertain` | The outcome is unknown; never resent automatically | `message_id`, `reason`, `fix` |
| `message.reconciled` | An uncertain send was matched to a provider event | `message_id`, `status` |
| `message.suppressed` | Every recipient is suppressed | `message_id`, `recipients[]` |
| `message.canceled` | Cancelled while queued | `message_id` |
| `verification.received` | A verification code or link was found in authenticated mail | `message_id`, `sender_domain`, `kind` (`code` or `link`), `account_id` (the approved service-ledger entry that matched, or `null` when the tenant does not require approval). The value itself is only available through `wait` |

The **message summary** used in `data.message` is:

```json
{
  "id": "msg_01J9…", "thread_id": "thr_01J9…", "direction": "inbound", "status": "received",
  "from": { "address": "jo@example.net", "name": "Jo Rivera" },
  "to": [ { "address": "bookings.acme@agents.example", "name": "" } ],
  "cc": [], "delivered_to": "bookings.acme@agents.example", "is_primary_recipient": true,
  "subject": "Change of dates for BK-2291", "sent_at": "…", "received_at": "…",
  "kind": "normal", "labels": [], "in_reply_to": "…", "flags": []
}
```

### Identities and addresses

| Type | `data` |
|---|---|
| `identity.created` | `identity` |
| `identity.updated` | `identity`, `changed` (list of field names) |
| `identity.paused` | `identity_id`, `reason` (`manual`, `abuse_threshold` or `tenant_suspended`), `metrics` (for abuse) |
| `identity.resumed` | `identity_id` |
| `identity.deleted` | `identity_id`, `erasure_request_id`. Emitted once, when the identity-scope erasure that deletes the identity completes and its status becomes `deleted` (after any legal holds end). It comes from the erasure job, so its `sequence` is the job's, and `identity_id` is set |
| `identity.address_added` | `address` |
| `identity.address_activated` | `address` (pending → active once its domain is `healthy` or `degraded`) |
| `identity.address_promoted` | `address`, `previous_primary` (with `retire_at`) |
| `identity.address_retired` | `address` |
| `identity.key_created` | `identity_id`, `kid`. A signing key was created for an identity that had no active key, lazily by a signing request or by `POST …/keys` ([Identity keys](api.md#identity-keys-and-signatures)). A rotation's new key emits `identity.key_rotated` instead |
| `identity.key_rotated` | `identity_id`, `kid` (the new active key), `previous_kid` (the key now `retiring`, or `null` when the rotation created the first key) |
| `identity.key_revoked` | `identity_id`, `kid`. The key is `retired` and has left the identity's JWK Set. Not sent when the key was already `retired` |

### Domains

| Type | `data` |
|---|---|
| `domain.created` | `domain` |
| `domain.verified` | `domain` (verification passed: `verifying` → `healthy`, also after a re-proved suspension. A domain that reaches `degraded` first gets `domain.degraded`, then `domain.recovered` when it becomes `healthy`) |
| `domain.degraded` | `domain_id`, `issues[]` (`code`, `record`, `fix`) |
| `domain.failing` | `domain_id`, `issues[]`, `fallback_active` |
| `domain.suspended` | `domain_id`, `reason` (`failing_14_days`, `nameservers_changed`, `ownership_record_missing` or `registration_changed`) |
| `domain.recovered` | `domain_id`, `from_state` |
| `domain.reminder` | `domain_id`, `state`, `hours_in_state` (sent at 24 h, 72 h and 7 days; a domain never verified also gets one at 12 days, 288 h, two days before its unverified expiry; a `nameservers` domain still `pending` also gets a final one at 21 days, 504 h, before Cloudflare deletes the zone at 28 days) |
| `domain.removed` | `domain_id`, `reason`: `requested` (removed through `DELETE /v1/domains/{id}`), `zone_expired` (a `nameservers` zone was never activated and Cloudflare deleted it; the domain can be added again), `evicted` (the domain was never verified, and another tenant proved control of its DNS with a claim record) or `unverified_expired` (the domain was never verified within 14 days of being added, or of its zone's activation) |

### Privacy, platform and webhooks

| Type | `data` |
|---|---|
| `erasure.completed` | `erasure_request` (with receipt) |
| `erasure.failed` | `erasure_request_id`, `step`, `error`. Retried by the job runner before this is sent |
| `export.completed` | `export_id`, `expires_at` (fetch the download link from the API) |
| `suppression.created` | `address_hint`, `reason`, `source_message_id` |
| `quota.warning` | `metric` (`sends` in v1), `used`, `limit`, `scope` (tenant or identity). Sent at 80% and at 100% of a daily send cap |
| `webhook.disabled` | `webhook_id`, `reason` (platform endpoints, and the other endpoints of the disabled endpoint's partner: its own, or its tenant's) |
| `webhook.test` | `message: "hello"` |

### Workspaces, members and billing

| Type | `data` |
|---|---|
| `member.invited` | `invitation_id`, `email_hint` (masked), `role` |
| `member.joined` | `user_id`, `role` |
| `member.role_changed` | `user_id`, `from`, `to` |
| `member.removed` | `user_id` |
| `billing.plan_changed` | `from_plan`, `to_plan`, `reason` (`checkout`, `portal`, `payment_failed_grace_ended`, `payment_recovered` (the plan was restored after a late payment, or when a dispute closed in the workspace's favour), `canceled`, `operator`, `dispute` (a payment was disputed: the default plan applies and sends stop until the dispute closes)) |
| `billing.payment_failed` | `grace_until` |
| `billing.limit_reached` | `feature`, `granted`, `resets_at` (sent once per feature per period, when the first `402` is returned) |
| `tenant.policy_updated` | `fields` (the dotted paths written), `by` (`platform`, `partner`, `tenant` or `console`), `actor_key_id`, `actor_user_id` (one of them `null`), `policy_version`. Sent for every policy write except a tenant's creation, to the tenant's, its partner's and platform endpoints ([Workspace policy](../project/design/workspace-policy.md#7-audit-and-events)) |

### Service accounts

Platform events with `tenant_id` and `identity_id` set, so an endpoint's identity filter applies
([Service sign-up ledger](../project/design/service-accounts.md#6-events)). `account` is the
[service account](api.md#service-accounts) as the API returns it.

| Type | When | `data` |
|---|---|---|
| `account.requested` | An agent recorded that it wants an account at a service | `account` |
| `account.approved` | An operator approved the entry | `account` |
| `account.rejected` | An operator rejected it, or it stayed undecided for 7 days | `account`, `reason` (`operator` or `expired`) |
| `account.closed` | The entry was closed, or deleted while it was pending or approved | `account` |

## Versioning

`api_version` is the payload schema date. Additive changes, such as new fields or new event types, keep
the version. v1 has one version, `2026-10-01`, so there is nothing to pin and endpoints have no
version field. A breaking change would get a new `api_version`, and the old one would stay available for
12 months; the endpoint field that selects a version is added with that change, through an ADR.
