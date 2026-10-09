# Webhooks and events

Binding for implementation. This page defines how state changes become events, and how events become
signed HTTPS deliveries with retries, dead letters and replay.

| | |
|---|---|
| Requirements | FR-WH-1 … FR-WH-5, NFR-REL-3, NFR-REL-4, FR-PRV-6, FR-IDN-6 (key events), FR-CON-14 (the Notifier hand-off) |
| Edge cases | [J4](../edge-cases.md), [I5](../edge-cases.md), [K1](../edge-cases.md) (integrator side), [C5](../edge-cases.md) (sequence), [O14](../edge-cases.md), [O16](../edge-cases.md) (Notifier hand-off) |
| Code | `crates/worker/src/mailbox/outbox.rs` (and the outbox modules of `DomainMonitor` and `JobRunner`), `webhooks/envelope.rs` (build plan M6: the envelope, `WebhookJob` and the identity payload builders), `handlers/webhooks.rs`, `consumers/webhooks.rs`, `webhooks/{sign.rs, client.rs, replay.rs, payloads.rs}` (build plan M8), `crons/outbox_sweep.rs`; the SSRF guard is `crates/core/src/ssrf.rs` and `crates/worker/src/net.rs` ([Security](security.md#9-ssrf-controls)) |
| Contract | [Webhook events](../../reference/events.md) (envelope, types, signing, retry schedule), [REST API › Webhooks](../../reference/api.md#webhooks) |

```text
 state change ──▶ owner object TRANSACTION { change + outbox row (seq, evt_…) }
                        │ alarm:outbox
                        ▼
                  dispatch: event_index rows (D1) ─▶ pm-webhooks Fanout{event pointer} ─▶ dispatched_at
                        │
                        ▼
                  consumer: Fanout ─▶ matching endpoints (D1, cached) ─▶ Deliver{endpoint, attempt 1} each
                            then, for new mail: NotifierRequest::Event ─▶ the tenant's Notifier (never blocks)
                  consumer: Deliver ─▶ payload from owner (GetEvents) ─▶ SSRF check ─▶ sign ─▶ POST (15 s)
                        │ 2xx: succeeded           │ failure: delivery row, re-enqueue attempt n+1 with delay
                        ▼                          ▼ after attempt 13: dead (replayable for 30 days from occurred_at)
```

## Transactional outbox

Every object that owns state (`IdentityMailbox`, `DomainMonitor`, `JobRunner`) has an `outbox` table
([Data model](data-model.md#3-other-durable-objects)). Events are emitted exactly when state changes,
because the event row is written in the same SQLite transaction as the change
([Design › Transactional outbox](index.md#6-transactional-outbox)).

### Appending (inside the state-change transaction)

```rust
// crates/worker/src/mailbox/outbox.rs (the same module shape in domains/ and jobs/)
pub fn append(tx: &impl Sql, ids: &impl Ids, clock: &impl Clock, owner: &Owner,
              event_type: &str, data: serde_json::Value, event_id: Option<String>) -> PResult<EventRef>;
```

1. `UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'event_seq' RETURNING v` gives `seq`
   (initialised to `0` by `Init`). The counter never goes backwards, even when outbox rows are deleted.
2. `event_id` = the given deterministic ID (used for `suppression.created`,
   [Outbound](outbound.md#suppressions)) or `ids.new_id(Evt)`.
3. Build the envelope (below) with `sequence = seq` and serialise it once, with
   `webhooks/envelope.rs`; these exact bytes are what is signed and sent on every attempt.
4. `INSERT INTO outbox (seq, event_id, type, payload_json, occurred_at, dispatched_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL) ON CONFLICT (event_id) DO NOTHING`.
   When the insert is ignored (a deterministic ID seen before), `meta.event_seq` is restored in the same
   transaction.
5. Set `meta` `alarm:outbox = now`; after commit the object re-arms its alarm if needed.

### Dispatching (alarm purpose `outbox`)

1. `SELECT seq, event_id, type, payload_json, occurred_at FROM outbox WHERE dispatched_at IS NULL ORDER BY seq LIMIT 100`.
2. One D1 `batch`:

   ```sql
   INSERT OR IGNORE INTO event_index (id, tenant_id, identity_id, type, owner_kind, owner_id, payload_json, occurred_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7);   -- owner_kind mailbox | domain | job; owner_id = this object's ID
   ```

3. `send_batch` to `pm-webhooks`: one `WebhookJob::Fanout` per event (at most 100 per call). Queue
   messages carry pointers only, never the payload ([I5](../edge-cases.md)).
4. `UPDATE outbox SET dispatched_at = ?1 WHERE seq IN (…)`.
5. If 100 rows were read, set `alarm:outbox = now` to continue. If step 2 or 3 failed, set
   `alarm:outbox = now + d` with `d` = 30 s, doubling per consecutive failure, at most 5 minutes
   (`meta.outbox_backoff`).

A crash between steps 3 and 4 repeats steps 2–4 on the next alarm. The `event_index` insert is
idempotent and the consumer deduplicates, so delivery is **at least once** and never lost. Endpoint
consumers deduplicate on `webhook-id` ([K1](../edge-cases.md)).

**Retention.** The daily maintenance alarm deletes outbox rows with
`occurred_at < now − policy.retention.events_days` (default 30 days). The D1 retention job prunes
`event_index` and `webhook_deliveries` on the same schedule. Erasure deletes outbox rows that reference
erased messages ([Privacy and erasure](privacy.md)). The **replay window** is 30 days from the event's
`occurred_at` (or `retention.events_days`, if shorter, because the payloads are then gone), never counted
from when a delivery went `dead` ([Replay](#replay)).

### Platform events

`webhook.disabled` has no owner object. It is written to `event_index` with `owner_kind = 'platform'`,
`owner_id = 'platform'` and its envelope in `payload_json`, in the same D1 `batch` as the endpoint update
that causes it, and then a `Fanout` is queued. Its event ID is deterministic: a ULID whose time is the
`created_at` of the delivery row that triggered it and whose random part is the first 10 bytes of
`HMAC-SHA256(PM_HASH_KEY, "webhook.disabled:" + webhook_id + ":" + trigger_event_id + ":" + attempt)`,
so a consumer retry rewrites the same row. As a safety net, the every-minute cron
(`crons/outbox_sweep.rs`) re-queues a `Fanout` for each platform event from the last hour that was never
fanned out:

```sql
SELECT e.id FROM event_index e
WHERE e.owner_kind = 'platform' AND e.occurred_at > ?1          -- now − 1 h
  AND e.fanned_out_at IS NULL
LIMIT 100;
```

The `Fanout` consumer sets `fanned_out_at` on a platform event once its `Deliver` messages are queued
(step 3 below), also when no endpoint matched. So an event that no endpoint subscribes to is fanned out
once, not every minute for an hour.

## Event envelope and payloads

```rust
// crates/api-types/src/events/mod.rs
#[derive(Serialize, Deserialize, ToSchema)]
pub struct EventEnvelope {
    pub id: String,                       // evt_…  (also the webhook-id header)
    #[serde(rename = "type")] pub event_type: String,
    pub api_version: String,              // "2026-10-01"
    pub occurred_at: String,              // RFC 3339 UTC with milliseconds
    pub tenant_id: Option<String>,
    pub identity_id: Option<String>,      // mailbox events and identity.deleted; null for domain, other job
                                          // and platform events
    pub sequence: Option<u64>,            // the owner's outbox seq; null for platform events
    pub data: serde_json::Value,
}
```

`sequence` increases strictly per owner object: per identity for mailbox events (C5), per domain for
domain events, per job for job events. Platform events (`webhook.disabled`, `webhook.test`, and the
`member.*` and `billing.*` events of the [Console](console.md) and [Billing](billing.md) designs) have no
owner object and carry `sequence: null`.

The three identity-key events (`identity.key_created`, `identity.key_rotated` with `previous_kid`, and
`identity.key_revoked`) are identity events like the other `identity.*` events: the identity-key
handler writes them after its D1 change through `MailboxRequest::EmitEvent` on the identity's mailbox, so
they carry the identity's `identity_id` and the next value of its `sequence`
([Agent signing keys §7](agent-keys.md#7-api-mcp-and-cli)).

Payloads are built from rows already read in the transaction, and are **thin**
(FR-WH-4): IDs, a header summary, verdicts, triage and at most `policy.webhook_text_bytes` of
`extracted_text` (default 16,384, maximum 65,536), cut at a UTF-8 character boundary. The `identity_*`
and `address_*` builders live in `webhooks/envelope.rs` with the envelope builder and the `WebhookJob`
type, because M6's outbox emits identity events before M8 exists (build plan M6); every other builder is
in `webhooks/payloads.rs` (M8), which imports them.

| Builder | Event types | `data` (per [events](../../reference/events.md)) |
|---|---|---|
| `message_summary(row)` | used inside others | `id`, `thread_id`, `direction`, `status`, `from`, `to`, `cc`, `delivered_to`, `is_primary_recipient`, `subject`, `sent_at`, `received_at`, `kind`, `labels`, `in_reply_to`, `flags` |
| `message_received(row, attachments, policy)` | `message.received` | `message`, `thread_id`, `trust`, `extracted_text`, `extracted_text_truncated`, `attachments[]` (`id`, `filename`, `content_type`, `size`); plus `reprocessed: true` when re-emitted by a re-parse |
| `message_quarantined(…)` | `message.quarantined` | as above without `extracted_text`, plus `quarantine_reason` |
| `message_released(row, actor, reason)` | `message.released` | `message`, `released_by_key_id` or `released_by_user_id` (the other `null`), `reason` |
| `message_triaged(row)` | `message.triaged` | `message_id`, `thread_id`, `triage` |
| `message_sent(row)` | `message.sent` | `message`, `provider`, `provider_message_id`, `sent_via_fallback` |
| `delivery_event(row, delivery)` | `message.delivered`, `message.deferred`, `message.bounced`, `message.complained` | `message_id`, `recipient`, `smtp_code`, and per type `smtp_response`, `bounce_type`, `suppressed` |
| `send_outcome(row, reason, detail)` | `message.rejected`, `message.failed`, `message.uncertain`, `message.reconciled`, `message.suppressed`, `message.canceled` | per [events](../../reference/events.md#messages) |
| `verification(row, v)` | `verification.received` | `message_id`, `sender_domain`, `kind` (never the value) |
| `identity_*`, `address_*` | `identity.*`, including `identity.key_created`, `identity.key_rotated` and `identity.key_revoked` | per [events](../../reference/events.md#identities-and-addresses) |
| `domain_*` | `domain.*` | per [events](../../reference/events.md#domains) |
| `job_*` | `erasure.completed`, `erasure.failed`, `export.completed` | per [events](../../reference/events.md#privacy-platform-and-webhooks) |
| `quota_warning`, `suppression_created`, `webhook_disabled`, `webhook_test` | as named | per [events](../../reference/events.md#privacy-platform-and-webhooks) |

Every builder has a golden-file test against the examples in the events reference, and a test that the
serialised `data` never contains a body field other than the capped `extracted_text`.

## Endpoint resolution and filters

For a `Fanout` (FR-WH-1):

1. Load the enabled endpoints that can see the event, cached in the isolate for 30 seconds per tenant:

   ```sql
   SELECT id, tenant_id, event_types_json, identity_ids_json FROM webhook_endpoints
   WHERE enabled = 1 AND (tenant_id IS NULL OR tenant_id = ?1);
   ```

2. An endpoint matches when:
   - its `event_types_json` is `["*"]` (which includes types added later) or contains the event type;
   - its `identity_ids_json` is null, or contains the event's `identity_id` (events without an identity,
     such as `domain.*`, match only endpoints without an identity filter);
   - platform endpoints (`tenant_id IS NULL`) see every tenant's events;
   - `webhook.disabled` goes only to platform endpoints, never to the endpoint it is about;
   - `webhook.test` is never fanned out (it is delivered synchronously, below).
3. Queue one `Deliver { attempt: 1, first_attempt: 1 }` per matching endpoint (`send_batch`). For a
   platform event, then run `UPDATE event_index SET fanned_out_at = ?now WHERE id = ?1 AND fanned_out_at IS NULL`.
   Then ack. A crash between the two repeats the fan-out; the `Deliver` consumer's "Already done?"
   check, and receivers' de-duplication by `webhook-id` (the event ID), absorb the repeat.

An endpoint created after an event occurred does not receive it, except through replay.

## Handing new mail to the Notifier

The `Fanout` consumer sees every outbox event, so it also feeds new-mail notifications
([Notifications §3](notifications.md#3-how-notifications-are-produced), FR-CON-14). After step 3 above (the
`Deliver` messages are queued), and before the ack:

1. **Which events.** By the `event_type` in the `Fanout` message: `message.received`,
   `message.released` (a message released from quarantine counts when it is released), and
   `message.triaged` when a `needs_reply` filter may be waiting (step 2). No other type is handed over.
2. **Whether anyone follows new mail.**

   ```sql
   SELECT EXISTS (SELECT 1 FROM notification_prefs
                  WHERE tenant_id = ?1 AND kind = 'new_mail' AND mode <> 'off')   AS any_new_mail,
          EXISTS (SELECT 1 FROM notification_prefs
                  WHERE tenant_id = ?1 AND kind = 'new_mail' AND mode <> 'off'
                    AND filter = 'needs_reply')                                AS any_needs_reply;
   ```

   The answer is cached in the isolate for 60 seconds per tenant, so a preference turned on starts
   counting within a minute. `message.received` and `message.released` go on only with `any_new_mail`,
   and `message.triaged` only with `any_needs_reply`. A tenant where nobody follows new mail never reaches the Notifier from
   this path.
3. **The payload.** Read the event with `MailboxRequest::GetEvents` on its owner, as the `Deliver`
   consumer does (one call per owner for a queue batch). A `message.received` re-emitted by a re-parse
   (`data.reprocessed: true`, [Inbound › Re-parsing](inbound.md#re-parsing-j3)) is skipped: it is not
   new mail.
4. **Hand-off.** Send `NotifierRequest::Event { tenant_id, identity_id, message_id, flags }` to the object
   named by `tenants.notify_do_id`, with the event's tenant and identity in the RPC envelope. `flags` come
   from the payload: the message's flags for `message.received` and `message.released`, the triage verdict for
   `message.triaged`. The Notifier applies the visibility rule (only mail visible in
   the inbox counts, [O15](../edge-cases.md)), the coalescing ([O14](../edge-cases.md)), and uses a
   triage result only for a message it is holding for a `needs_reply` filter (up to 5 minutes,
   [O16](../edge-cases.md)), ignoring the rest.
5. **Never blocking delivery.** The hand-off runs after the delivery work and cannot change it: a failed
   or timed-out step 3 or 4 (the standard RPC deadline, [Design § 5](index.md#5-internal-durable-object-rpc))
   is logged as `notifier_handoff_failed` with the event and tenant IDs, and the message is still acked.
   The fan-out is never retried for a notification, so a lost hand-off leaves at most that one message
   out of a `new_mail` count; it never causes a notification about mail that is not visible.

`PM_NOTIFICATIONS=off` skips steps 2–5 (only `account` emails are sent then, and they do not come
through this path). Webhook delivery itself is unchanged: `quota.warning` and `billing.limit_reached`
still go to endpoints.

## Signing (Standard Webhooks)

Delivery follows the [Standard Webhooks](https://www.standardwebhooks.com/) specification (v1.0.0, read
2026-10-09) and the [events reference](../../reference/events.md#delivery) (FR-WH-2):

```rust
// crates/worker/src/webhooks/sign.rs (pure; no I/O)
pub fn signed_content(webhook_id: &str, timestamp_s: i64, body: &[u8]) -> Vec<u8>;   // "{id}.{ts}." + body
pub fn sign_v1(secret: &[u8], content: &[u8]) -> String;  // "v1," + base64(HMAC-SHA256(secret, content))
pub fn signature_header(current: &[u8], previous: Option<&[u8]>, content: &[u8]) -> String;
```

- `webhook-id` = the event ID. It is the same on every attempt and every replay.
- `webhook-timestamp` = Unix seconds **at the attempt**, so each attempt is signed afresh.
- Signed content = `{webhook-id}.{webhook-timestamp}.{body}`, where `body` is the exact stored envelope
  bytes.
- Signature = standard base64 (with padding) of `HMAC-SHA256(secret_bytes, content)`, prefixed `v1,`.
  `secret_bytes` is the base64-decoded part of `whsec_…` after the prefix.
- During a rotation overlap (`prev_secret_expires_at > now`) the header carries both signatures,
  separated by one space, the new secret's first: `v1,{new} v1,{old}`.
- Other headers: `Content-Type: application/json` and
  `User-Agent: PylotaMail/1.0 (+https://github.com/PILOTAAI/pylota-mail)` (the version is the deployed
  release).

### Secrets

- **Generation.** 32 bytes from `platform::Rng`; the secret is `whsec_` + standard base64 of them
  (Standard Webhooks requires 24–64 random bytes). It is returned once, on create and on rotate, and never
  again (FR-WH-2). Each endpoint has its own secret; no secret is derived from another.
- **Storage.** `secret_enc` holds the 32 secret bytes sealed with AES-256-GCM under `PM_MASTER_KEY`,
  in the encryption envelope of [Security § 7.2](security.md#72-encryption-envelope)
  (`pm1.{kid}.{nonce}.{ciphertext}`, a fresh random 96-bit nonce from `platform::Rng` for every seal, so a
  nonce is never reused with the key). The associated data binds the value to its row and column
  (`pm1|webhook_endpoints|secret_enc|{endpoint_id}`), so a ciphertext copied elsewhere fails to decrypt.
  The `kid` lets `pmail secrets rotate-master` find values still sealed under an old key. AES-GCM is the
  `aes-gcm` crate (pin at build time).
- **Use.** Decrypted per delivery and cached in the isolate for at most 60 seconds, keyed by endpoint ID
  and a hash of `secret_enc`. A decryption failure records the attempt as failed with error
  `secret_unavailable` and alerts.
- **Rotation.** `POST /v1/webhooks/{id}/rotate-secret` with `overlap_hours` (0–168): the current secret
  is unsealed and re-sealed with the associated data of `prev_secret_enc` (the column is part of the
  associated data, so the ciphertext cannot simply be copied), `prev_secret_expires_at = now + overlap`
  (both `NULL` when the overlap is 0), and `secret_enc` = a newly generated secret. Audit-logged.

## HTTP client and SSRF rules

Every delivery goes through the SSRF guard defined once in [Security § 9](security.md#9-ssrf-controls)
(`core::ssrf` decides, `worker::net::GuardedHttp` enforces). This design does not restate the rules;
in summary (FR-WH-5):

- URLs are checked when an endpoint is created or updated (`400 invalid_request`,
  `details.errors[].path = "url"`) and again before **every** attempt, because DNS can change: `https`
  only, no user information or fragment, a DNS host name (never an IP literal), none of the refused
  names (including `PM_API_HOST` and the platform domain), and every resolved `A`/`AAAA` address outside
  the blocked ranges ([Security § 9.1](security.md#91-url-rules-at-create-update-and-every-attempt)).
  A failure at delivery time is a failed attempt with error `ssrf_blocked`.
- **Request** ([Security § 9.2](security.md#92-request-rules)): `POST`, the headers above, the stored
  envelope bytes as body, `redirect: manual` (any `3xx` is a failure, never followed), a 15-second
  deadline through `AbortController`, and at most 4 KB of the response body read before the stream is
  cancelled. Any `2xx` within the deadline is success; the body is ignored.
- The DNS-rebinding race that remains because `fetch()` cannot be pinned to the checked address is
  accepted and documented in [Security § 9.2](security.md#92-request-rules).

Each attempt's outcome is `succeeded` (2xx) or an error code stored in `webhook_deliveries.error`:
`timeout`, `dns`, `tls`, `connect`, `redirect`, `status_4xx`, `status_410`, `status_5xx`,
`ssrf_blocked`, `invalid_url`, `secret_unavailable`, `event_unavailable`, `endpoint_disabled`.

## Delivering an attempt

For `Deliver { event_id, endpoint_id, attempt, first_attempt, replay }`:

1. **Already done?**

   ```sql
   SELECT status FROM webhook_deliveries WHERE endpoint_id = ?1 AND event_id = ?2 AND attempt = ?3;
   ```

   `succeeded` or `dead` → ack. `failed` → make sure attempt `n + 1` is queued (step 7) and ack, without
   a second HTTP request. Unless `replay`, also ack if any attempt for this endpoint and event succeeded.
2. **Endpoint**: re-read the row. Deleted → ack. Disabled → record the attempt as `dead` with
   `endpoint_disabled` (so it can be replayed) and ack.
3. **Payload**: `payload_json` from `event_index` for platform events; otherwise
   `MailboxRequest::GetEvents` (or the domain or job equivalent) on `owner_id`, with the event's tenant and
   identity in the RPC envelope. Messages in one queue batch for the same owner are fetched in one call.
   The outbox row is gone (retention or erasure) → record `dead` with `event_unavailable` and ack.
4. **Validate** the URL (SSRF rules), **sign**, **POST**.
5. **Record** the attempt:

   ```sql
   INSERT OR IGNORE INTO webhook_deliveries
     (id, endpoint_id, tenant_id, event_id, event_type, attempt, status, http_status, error,
      duration_ms, next_attempt_at, created_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);
   -- status: 'succeeded', 'failed', or 'dead' when this was the last attempt
   ```

   and update the endpoint: success → `consecutive_failures = 0`; failure →
   `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1, updated_at = ?2 WHERE id = ?1 RETURNING consecutive_failures`.
6. **Auto-disable** checks ([below](#dead-deliveries-and-auto-disable)).
7. **Schedule** the next attempt on failure: if `k = attempt − first_attempt + 1` is below 13, send
   `Deliver { attempt: attempt + 1, … }` with `delay_seconds` from the schedule; then ack. If that send
   fails, `retry()` the current message; step 1 then skips the HTTP request and only re-queues.

D1 or owner-RPC errors in steps 1–3 and 5 → `retry(Some(30))` (the queue's `max_retries` of 13 is a
backstop for crashes; after it the message goes to `pm-webhooks-dlq`).

### Retry schedule ([J4](../edge-cases.md), FR-WH-3)

| After attempt `k` fails | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Next attempt in | 30 s | 2 min | 10 min | 30 min | 1 h | 2 h | 4 h | 8 h | 12 h | 12 h | 12 h | 19 h |

Each delay is multiplied by a uniform random factor in [0.9, 1.1] (±10% jitter), rounded to whole
seconds, at most 86,400 (the Queues delay limit). The 13th attempt is the last: if it fails the row is
`dead`. The schedule adds up to about 72 hours. Retries use re-enqueue with an explicit `attempt`, because
`workers-rs` 0.8.7 does not expose the queue's attempt count ([Design](index.md#7-idempotent-queue-consumers)).
`next_attempt_at` on a `failed` row records the scheduled time.

## Dead deliveries and auto-disable

- A delivery whose 13th attempt fails is `dead`. It stays replayable for 30 days from its event's
  `occurred_at` (or the tenant's `policy.retention.events_days`, if shorter; platform events, which have
  no tenant, 30 days). The window is never counted from when the delivery went `dead`.
- **`410 Gone`** disables the endpoint immediately.
- **100 consecutive failures spread over at least 24 hours** disable it. When the returned
  `consecutive_failures` is ≥ 100:

  ```sql
  SELECT MIN(created_at) FROM webhook_deliveries
  WHERE endpoint_id = ?1
    AND created_at > COALESCE((SELECT MAX(created_at) FROM webhook_deliveries
                               WHERE endpoint_id = ?1 AND status = 'succeeded'), 0);
  ```

  and the endpoint is disabled when `now − MIN(created_at) ≥ 24 h`.
- Disabling, in one D1 `batch` with the platform event row:

  ```sql
  UPDATE webhook_endpoints SET enabled = 0, disabled_reason = 'failing', updated_at = ?2
  WHERE id = ?1 AND enabled = 1;
  INSERT OR IGNORE INTO event_index (id, tenant_id, identity_id, type, owner_kind, owner_id, payload_json, occurred_at)
  VALUES (?3, ?4, NULL, 'webhook.disabled', 'platform', 'platform', ?5, ?2);
  ```

  `data` is `{ "webhook_id": "whk_…", "reason": "gone" }` or `{ … "reason": "failing" }`. The event goes
  to the platform's other endpoints.
- `PATCH /v1/webhooks/{id}` with `enabled: true` re-enables it and resets `consecutive_failures` and
  `disabled_reason`. `enabled: false` disables it with `disabled_reason = 'manual'` and no event.

## Replay

`POST /v1/webhooks/{id}/replay` with `webhooks:manage` (FR-WH-3):

1. **Select events** from `event_index` whose `occurred_at` is within the last 30 days (or the tenant's
   `retention.events_days`, if shorter; 30 days for platform events, which have no tenant), scoped to
   the endpoint's tenant (all tenants for a platform endpoint), at most 1,000 per request (more → `400 invalid_request` asking for a
   narrower window):
   - by IDs: `WHERE id IN (…)` (at most 100 IDs);
   - by window: `WHERE occurred_at >= ?since AND occurred_at < ?until`, plus, when `status` is given,
     `dead`: `EXISTS (… d.status = 'dead')` and no `succeeded` attempt for this endpoint; `failed`: the
     latest attempt for this endpoint is `failed`; `succeeded`: some attempt succeeded.
2. **Filter** to events the endpoint would receive (event types and identity filter).
3. For each event: `first_attempt = 1 + COALESCE(MAX(attempt), 0)` over this endpoint's rows for the event,
   then queue `Deliver { attempt: first_attempt, first_attempt, replay: true }`. The full retry schedule
   restarts for the replay. The payload is read from the owner as for a normal delivery, so an event whose
   message was erased can no longer be replayed (`event_unavailable`).
4. Respond `202 { "queued": n }`. Audit-logged.

## Test deliveries

`POST /v1/webhooks/{id}/test` writes a `webhook.test` platform event (`data: { "message": "hello" }`) to
`event_index`, performs **one** attempt synchronously within the request (same signing, SSRF rules and
15-second deadline), records it in `webhook_deliveries`, and returns that delivery row. It is never
retried.

## The pm-webhooks message

```rust
// crates/worker/src/webhooks/envelope.rs (build plan M6) — JSON, pointers only. The outbox produces
// Fanout; consumers/webhooks.rs (M8) consumes both kinds and produces Deliver.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WebhookJob {
    Fanout {
        v: u8,                              // 1
        event_id: String, event_type: String,
        tenant_id: Option<String>, identity_id: Option<String>,
        owner_kind: OwnerKind,              // mailbox | domain | job | platform
        owner_id: String,                   // Durable Object ID, or "platform"
        occurred_at: i64,
    },
    Deliver {
        v: u8,
        event_id: String, event_type: String, endpoint_id: String,
        tenant_id: Option<String>, identity_id: Option<String>,
        owner_kind: OwnerKind, owner_id: String,
        attempt: u32,                       // the attempt number recorded in webhook_deliveries
        first_attempt: u32,                 // 1, or the first attempt of a replay
        replay: bool,
    },
}
```

The queue is configured with batch size 20 and `max_retries` 13 ([Configuration](../../reference/configuration.md#bindings)).

## Metrics

`webhook_attempts_total{result}`, `webhook_dead_total{event_class}`, `webhook_disabled_total{reason}`,
`webhook_delivery_latency_ms{event_class, first_attempt}` (from `occurred_at` to the first successful
attempt, written once per delivery; NFR-REL-3 is measured on it), `outbox_undispatched_age_ms{owner}`
(at dispatch time), `webhook_ssrf_blocked_total`. The labels are defined in
[Observability › Catalogue](observability.md#32-catalogue):

- `event_class` is `inbound` for `message.received` and `message.quarantined`, and `other` for every
  other type;
- `first_attempt` is `succeeded` when the delivery's first attempt succeeded and `failed` when an
  earlier attempt failed. The NFR-REL-3 SLI counts only `first_attempt = succeeded`, so an integrator's
  outage does not burn the service's budget. Logs record
event and endpoint IDs, status codes and durations, never payloads or URLs' query strings
([I5](../edge-cases.md), FR-PRV-6).

## Tests

| Test | Covers |
|---|---|
| `it::webhooks::outbox_at_least_once` | A crash after queue send and before `dispatched_at` delivers the event again with the same `webhook-id`; nothing is lost |
| `it::webhooks::sequence_strictly_increases` | Per-identity `sequence` strictly increases across event types ([C5](../edge-cases.md)) |
| `webhooks::sign::standard_webhooks_vectors` | The specification's test vectors verify (build plan M8, FR-WH-2) |
| `it::webhooks::rotation_two_signatures` | During an overlap both signatures are sent, new first; after it only one (FR-WH-2) |
| `core::crypto::aes_gcm_round_trip_and_aad` | Seal/unseal round trip in the Security § 7.2 envelope; a ciphertext moved to another row or column fails |
| `core::ssrf::*` (owned by [Security](security.md)) | Loopback, RFC 1918, link-local, CGNAT, `::1`, `fc00::/7`, `169.254.169.254`, IPv4-mapped and NAT64 forms, integer IPv4 literals (FR-WH-5) |
| `it::webhooks::no_redirects_and_caps` | A `3xx` is a failure and is not followed; a slow endpoint times out at 15 s; only 4 KB of the body is read (FR-WH-5) |
| `it::webhooks::j4_retry_schedule` | A time-controlled harness sees 13 attempts at the scheduled delays (±10%), then `dead` ([J4](../edge-cases.md), FR-WH-3) |
| `it::webhooks::disable_on_410` | `410 Gone` disables at once and emits `webhook.disabled` to other platform endpoints |
| `it::webhooks::disable_after_100_failures_24h` | 100 failures within 24 h do not disable; 100 spread over ≥ 24 h do |
| `it::webhooks::replay_by_ids_and_window` | Replay by IDs and by window with `status: dead`; the limit is 30 days from `occurred_at` (an event that went `dead` on day 3 cannot be replayed after day 30), or `events_days` when shorter; erased events are not replayed |
| `it::webhooks::notifier_handoff_never_blocks` | `message.received` reaches the tenant's Notifier only when a `new_mail` preference is on (after the 60-second cache), and never for a re-parse; `message.triaged` only with a `needs_reply` preference; a failing Notifier leaves every delivery queued and the event acked |
| `it::webhooks::identity_key_events` | Creating, rotating and revoking an identity key emits `identity.key_created`, `identity.key_rotated` (with `previous_kid`) and `identity.key_revoked` with the identity's `identity_id` and the next `sequence`; an existing active key returned by `POST …/keys` and a second revoke emit nothing |
| `it::webhooks::filters` | Event-type and identity filters; `*` includes new types; platform endpoints see every tenant (FR-WH-1) |
| `it::webhooks::payload_text_cap` | `extracted_text` capped at `webhook_text_bytes`, never above 64 KB; quarantined events carry none (FR-WH-4) |
| `it::logs::i5_no_content_in_logs` | Queue messages and logs carry no content ([I5](../edge-cases.md), FR-PRV-6) |
