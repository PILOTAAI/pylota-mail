# Outbound and safe retries

Binding for implementation. This page takes a send request to a transport call, and provider events
back to per-recipient status, without ever producing a second email for one `Idempotency-Key`.

| | |
|---|---|
| Requirements | FR-OUT-1 … FR-OUT-12, FR-DLV-1 … FR-DLV-5, FR-IDN-2, FR-IDN-3, FR-DOM-5, FR-DOM-6, FR-DOM-8, FR-DOM-11, FR-TEN-2, FR-TEN-3, FR-BILL-4, FR-BILL-5, FR-CON-14 (notification sends), NFR-PERF-1, NFR-PERF-2 |
| Edge cases | [A7](../edge-cases.md), [A8](../edge-cases.md), [A10](../edge-cases.md), [C2](../edge-cases.md), [C4](../edge-cases.md), [C6](../edge-cases.md), [C7](../edge-cases.md), [D3](../edge-cases.md), [D6](../edge-cases.md), [E2](../edge-cases.md), [E3](../edge-cases.md), [E8](../edge-cases.md), [G1–G11](../edge-cases.md), [J5](../edge-cases.md), [K3](../edge-cases.md), [L1](../edge-cases.md), [L2](../edge-cases.md), [N11](../edge-cases.md), [N14–N16](../edge-cases.md), [N18](../edge-cases.md), [N19](../edge-cases.md), [O17](../edge-cases.md) |
| Code | `crates/worker/src/handlers/send.rs`, `mailbox/{submit.rs, compose.rs, locks.rs, deliveries.rs, idempotency.rs}`, `transport/{mod.rs, cloudflare.rs, ses.rs, smtp.rs, simulator.rs, loopback.rs}`, `consumers/{outbound.rs, delivery.rs, ses_events.rs}`, `quota/mod.rs`, `billing/quota.rs`; `crates/core/src/{policy.rs, compose.rs, ses.rs, sns.rs, smtp.rs}` |
| ADR | [0004 Required idempotency](../adr/0004-idempotency.md) |

```text
POST …/messages ─▶ handler: auth, rate limit, Idempotency-Key, schema, fingerprint, D1 context
                     │  MailboxRequest::Submit
                     ▼
             IdentityMailbox.submit: idempotency lookup → in-flight check → policy pipeline →
             compose (MIME → R2 out/{msg}.eml) → TenantQuota: sends hold + daily reserve → thread lock →
             TRANSACTION { message queued, deliveries, idempotency row, lock } → 202
                     │ after commit: pointer
                     ▼
             pm-outbound consumer: re-read scope → BeginTransport (claim) → MailTransport.send
                     │                                   ├─ cloudflare (send_email binding)
                     │                                   ├─ ses (SendEmail v2, raw, SigV4)
                     │                                   ├─ smtp (the customer's relay, TCP socket, TLS)
                     │                                   └─ test: simulator / loopback
                     ▼
             RecordTransportOutcome: submitted | rejected | failed | queued+backoff | uncertain
                     │                → settle the sends hold (or extend it for a back-off)
                     ▼
pm-delivery-events ─▶ delivery consumer ─▶ ApplyDeliveryEvent ─▶ per-recipient status, roll-up,
(SES via SNS, simulator, loopback → pm-outbound TransportEvent;    suppressions, abuse windows, events
 relay DSNs arrive as inbound mail → Inbound › DSN routing)
```

## The submit path

### Handler

`POST /v1/identities/{id}/messages` (operation `send`), `…/messages/{mid}/reply` (`reply`),
`…/reply-all` (`reply_all`), `…/forward` (`forward`):

1. **Authenticate** and require `messages:send`. Resolve the identity from D1 and check it is inside the
   key's scope (`identity_not_found` otherwise, indistinguishable from missing).
2. **Rate limit** `RL_SEND` keyed by identity ID (120 per minute) → `429 rate_limited` with `Retry-After`.
3. **`Idempotency-Key`**: missing → `400 idempotency_key_required`; a value that does not match
   `^[\x20-\x7E]{1,255}$` (empty, longer than 255 bytes, or containing a byte outside printable ASCII
   0x20–0x7E) → `400 invalid_idempotency_key`. The pattern is the one in `openapi.yaml`, and the MCP
   tools' `idempotency_key` argument uses it too ([MCP](mcp.md)).
4. **Body**: over 7 MiB → `413 payload_too_large`; JSON or schema errors → `400 invalid_request` with
   `details.errors[]`.
5. **Fingerprint** (section below).
6. **D1 context** in one `batch` (5-second deadline; `503 unavailable` on failure): the identity row
   (`status`, `pause_reason`, `owner_*`, `display_name`, `signature_*`, `send_policy_json`, `is_system`),
   the tenant (`status`, `mode`, `policy_json`, `timezone`, `created_at`, `ramp_lifted_at`,
   `partner_id`) with its `billing_accounts` `mode` and `plan_id` and its partner's `ramp_exempt` (for the
   send ramp of step 18), all of the identity's addresses
   with their domains (`state`, `kind`, `transport`, `reply_token`, `sending`), the platform domain, suppressions for every
   requested recipient (`address_hash IN (…)`), send-list entries for each recipient address and
   `@domain`, and, for a test tenant, the directory rows of the recipients (policy step 8).
7. **Call `MailboxRequest::Submit`** (30-second deadline). The handler does **not** apply policy
   itself: a replay must return the original response even if policy would now refuse it, so the
   mailbox checks idempotency first.
8. **Respond** `202` with the Message object plus `"deduplicated": false`, or the stored response with
   `"deduplicated": true` and the header `Idempotent-Replayed: true`.

### Idempotency fingerprint

```rust
// crates/core/src/policy.rs
/// hex(sha256(canonical_json({"body": body, "operation": op, "target": target})))
pub fn send_fingerprint(operation: SendOp, target: &str, body: &serde_json::Value) -> String;
// target: identity_id for send; "{identity_id}/{message_id}" for reply, reply_all and forward
```

Canonical JSON: object keys sorted by their UTF-8 bytes at every level, no insignificant whitespace,
strings with the minimal escapes `serde_json` produces, numbers in `serde_json`'s shortest form, arrays
in their original order. The body is hashed as received (after parsing); there is no semantic
normalisation, so a client must resend the same body (key order and whitespace do not matter).

### Reservation inside the mailbox (FR-OUT-1, [G1](../edge-cases.md))

The mailbox keeps an in-memory set `in_flight: HashSet<String>` of keys being processed. A Durable Object
has exactly one live instance, and its in-memory state is lost only when the instance is, together with
every request it was running, so the set cannot hold a stale key.

1. Synchronous lookup:

   ```sql
   SELECT fingerprint, message_id, response_json FROM idempotency
   WHERE key_hash = ?1 AND expires_at > ?2;     -- ?1 = hex(sha256(Idempotency-Key))
   ```

   The ledger stores only the key's SHA-256, so the same value can be kept in the R2 metadata of the
   sent copy and used to rebuild the ledger after a restore ([Composition](#composition)).

   - Same fingerprint → return the stored `response_json` with `deduplicated: true`. No other work.
   - Different fingerprint → `409 idempotency_conflict` with `details.original_message_id`.
2. Key in `in_flight` → `409 request_in_progress` (retryable).
3. Insert the key into `in_flight`; a guard removes it on every exit path.
4. Run the policy pipeline, composition, quota reservation (the `sends` hold and the daily caps) and
   lock (below). These include `.await`s, during which other requests may run.
5. One transaction ([Storage](#storage-of-an-accepted-send)): re-check that no `idempotency` row exists
   for the key, insert the message, deliveries and the `idempotency` row (`expires_at = now + 30 days`,
   `response_json` = the Message object returned), take the lock.
6. After commit: queue the pointer and return.

Only accepted sends (`202`) are recorded. A request that fails with an error records nothing, so a retry
with the same key re-evaluates it: no email was produced, and stateful errors (`identity_paused`,
`daily_cap_reached`, `thread_busy`) may have cleared. Expired rows are deleted by the daily maintenance
alarm; an expired key behaves as new.

## Policy pipeline

`core::policy::evaluate_send(&SendContext) -> Result<SendPlan, PolicyError>` runs in this order inside
`submit` (FR-OUT-3). The first failure returns its error and nothing is stored:

| # | Check | Error |
|---|---|---|
| 1 | Identity `deleting`/`deleted` | `404 identity_not_found` |
| 2 | Tenant `suspended` (FR-TEN-3). Checked before the identity's pause: a suspension pauses every identity with `pause_reason = 'tenant_suspended'`, so with the opposite order this error could never be returned | `403 tenant_suspended` |
| 3 | Identity `paused` ([A7](../edge-cases.md), FR-IDN-3) | `409 identity_paused`, `details.reason` = `pause_reason` |
| 4 | No accountable human: `owner_name` or `owner_email` is null ([A8](../edge-cases.md), FR-IDN-2) | `409 identity_owner_required` |
| 5 | Target: for reply, reply-all and forward the message exists in this mailbox and is visible to the key (`hidden` and `throttled` never; `quarantined` only with `quarantine:review`); for `send` with `thread_id`, the thread exists | `404 message_not_found` / `404 thread_not_found` |
| 6 | Recipients ([Recipients](#recipients)): each is a valid RFC 5321 address with an ASCII local part; duplicates removed case-insensitively; at least one | `400 address_invalid`; `400 address_unsupported` for a non-ASCII (SMTPUTF8) local part ([A3](../edge-cases.md)); `400 invalid_request` when there is no recipient |
| 7 | Count across `to`, `cc`, `bcc` ≤ `policy.max_recipients` (default 10, at most 49: Cloudflare's limit is 50 and strategy B's journal copy takes one, so the limit is 49 on every transport) ([E3](../edge-cases.md)) | `400 too_many_recipients` |
| 8 | Test tenant: every recipient is `*@simulator.invalid` or an `active`/`retiring` address on this deployment (FR-OUT-12, [L1](../edge-cases.md)) | `403 test_mode_recipient` |
| 9 | `kind: marketing` has `unsubscribe.url` (HTTPS) and `consent` ([G9](../edge-cases.md), FR-OUT-8). Its transport is checked at step 15, once step 13 has resolved the sending address | `400 marketing_requirements_missing` |
| 10 | `kind: auto_reply` only for reply or reply-all, to a message whose `kind` is `normal` or `calendar`, with `policy.auto_reply.allowed`, identity `send_policy.auto_reply` not `"denied"` (the default is `"allowed"`), and under the exchange cap ([D6](../edge-cases.md), FR-OUT-7) | `409 auto_reply_not_allowed` |
| 11 | Custom headers ([Headers](#headers)) | `400 header_not_allowed` / `400 invalid_request` |
| 12 | Content: `text` or `html` present; subject ≤ 998 characters; ≤ 32 attachments, valid base64, `content_id` on inline parts; labels and metadata within limits | `400 invalid_request` |
| 13 | From address ([From](#from-address-and-fallback)): an `active` address of the identity, or `retiring` on a thread that already uses it ([G7](../edge-cases.md)) | `400 invalid_request` (`details.errors[0].path = "from_address"`) |
| 14 | Sending domain: `pending` or `verifying` (or the address is `pending`) | `409 domain_not_ready` (retryable) |
| 15 | Transport: `ses` configured (the SES secrets and region); and for `kind: marketing`, the domain of the From address resolved at step 13 has `transport` `ses` or `smtp`, because Cloudflare Email Service is for transactional mail only ([Cloudflare Email Service FAQ](https://developers.cloudflare.com/email-service/reference/faq/), read 2026-10-10). The platform domain and every `cloudflare`-transport domain fail this. `BeginTransport` checks it again with the transport actually chosen ([The outbound consumer](#the-outbound-consumer)) | `422 transport_unavailable`, `details.reason = "ses_not_configured"` or `"marketing_needs_ses"` |
| 16 | Per recipient: suppression, send-block, `send_allowlist_only`, `require_known_recipient` ([Recipient filters](#recipient-filters)) | not an error: the recipient's delivery is `suppressed` (FR-OUT-4, [G4](../edge-cases.md), [E2](../edge-cases.md)) |
| 17 | Size after composition ([Attachments and size](#attachments-and-size)) | `413 message_too_large`, unless `large_attachments: "link"` |
| 18 | Plan allowance and daily caps, in one `TenantQuota` request and one transaction ([TenantQuota](#tenantquota)). First the **`sends` hold** (FR-BILL-4, FR-BILL-5): `units` = recipients left after step 16, `ref` = the new `msg_` ID, gate `storage_gb` when the message has attachments; a send whose recipients are all suppressed takes no hold. Then the **daily-cap reserve** (identity cap: `send_policy.daily_cap`, else `policy.identity_daily_send_cap`; tenant cap: `policy.tenant_daily_send_cap`), counted per accepted message in the tenant's time zone ([E3](../edge-cases.md)). The tenant cap is min(`policy.tenant_daily_send_cap`, 50) while the **new-workspace send ramp** applies: `tenants.ramp_lifted_at IS NULL` and either the tenant has a partner whose `ramp_exempt` is `0` (whatever `PM_BILLING` and its billing mode), or it has no partner, `PM_BILLING=stripe` and the workspace is `metered` on the catalog's `default_plan` ([Cloud sign-up › New-workspace send ramp](cloud-signup.md#101-new-workspace-send-ramp), [W30](../edge-cases.md)). The **system identity** (`is_system = 1`) is exempt from the tenant cap: its reserve passes `tenant_cap: None`, so the tenant `sends` counter is neither checked nor incremented, and only its own `send_policy.daily_cap` (50,000) applies ([Identities and domains › The system identity](identity-domains.md#the-system-identity)). If either check fails, neither is kept | `402 billing_limit` (`details.feature` = `sends` or `storage_gb`); `429 daily_cap_reached`, `details.resets_at` |
| 19 | Thread lock ([C4](../edge-cases.md), FR-OUT-9) | `409 thread_busy`, `details.retry_after` |

The allowance is checked before the daily caps, so a request that would fail both gets the `402`, which
needs a person, rather than a `429` ([Plans, metering and billing › Ordering relative to idempotency](billing.md#ordering-relative-to-idempotency)).

A domain in `failing` or `suspended` is not an error at submit: the send is accepted and fallback (or
`domain_failing_no_fallback`) is decided at transport time, when the state is current. If the lock fails
at step 19, both reservations from step 18 are released: the `sends` hold (`Settle` with `consume: 0`)
and the daily count (`Release`).

**Dry run.** `?dry_run=true` on send, reply, reply-all or forward runs steps 1–17 (step 17 composes in
memory and writes nothing to R2) without storing anything, reserving quota or locking, and returns `200`
with `{ "would_send": true, "recipients": [{ "address", "field", "status", "reason" }] }` (`reason` only
for `suppressed` recipients: the suppression reason or the list rule), or the first policy error, or
`422 all_recipients_suppressed` / `422 recipient_blocked` ([Errors](../../reference/errors.md#policy-and-limits)).
The `Idempotency-Key` header is optional on a dry run and is never looked up or recorded.

### Recipients

| Operation | `to` | `cc` | `bcc` |
|---|---|---|---|
| `send` | From the body | From the body | From the body |
| `reply` to an inbound message M | The reply target of M (below) | – | – |
| `reply` to an outbound message M | M's `to` | M's `cc` | – |
| `reply_all` to M | The reply target, then M's `to` | M's `cc` | – |
| `forward` | From the body | From the body | From the body |

- **Reply target ([D3](../edge-cases.md)).** If M has a `Reply-To` and either the sender is
  `known_sender`, or the `Reply-To` address shares the organisational domain of `From`, or the
  `Reply-To` address is in `contacts` with `outbound_count > 0`, the target is the first `Reply-To`
  address; otherwise it is M's `From`. `core::reply::reply_target` implements this.
- **Reply-all ([A10](../edge-cases.md)).** Every address of this identity (any status) is removed, so
  are duplicates, and M's `bcc` is never used. A BCC copy's `delivered_to` is the identity's own address,
  so it is removed too, and nothing in the reply reveals the BCC.
- `reply` and `reply_all` take only `text`, `html`, `attachments`, `kind`, `labels`, `headers` and
  `metadata` from the body.

### Recipient filters

Each recipient that matches one of these becomes a delivery row with status `suppressed`, and its
`smtp_response` records the rule (`policy: suppression (hard_bounce)`, `policy: send_block`,
`policy: not_on_allowlist`, `policy: unknown_recipient`):

- an unexpired row in `suppressions` for `HMAC-SHA256(PM_HASH_KEY, address)` (FR-OUT-4);
- a send-block entry for the address or `@domain`;
- `policy.send_allowlist_only` and no send-allow entry for the address or `@domain`;
- identity `send_policy.require_known_recipient` and no `contacts` row for the address with
  `inbound_count > 0` or `outbound_count > 0` ([E2](../edge-cases.md)).

If every recipient is filtered, the send is still accepted (`202`), stored with status `suppressed`, and
`message.suppressed` is emitted with the recipients; nothing reaches a transport
([Errors](../../reference/errors.md#policy-and-limits)).

### Automatic-exchange cap ([D6](../edge-cases.md))

```sql
SELECT COUNT(*) FROM messages
WHERE thread_seq = ?1 AND direction = 'outbound' AND kind = 'auto_reply'
  AND status NOT IN ('canceled', 'rejected', 'failed', 'suppressed')
  AND rowid > COALESCE((SELECT MAX(rowid) FROM messages
                        WHERE thread_seq = ?1 AND direction = 'outbound' AND kind <> 'auto_reply'), 0);
```

A count ≥ `policy.auto_reply.max_automatic_exchanges` (default 2) refuses the auto-reply.

## Composition

`core::compose::compose(&ComposeInput) -> ComposedMessage` is pure; the mailbox supplies the identity,
thread and policy data. The result is serialised to MIME with `mail-builder` (with an explicit
`Message-ID`, `Date` and multipart boundaries, because `mail-builder` reads the system clock otherwise;
see [Rust workspace](rust-workspace.md#3-workspace-dependencies)) and written to
`t/{ten}/i/{idn}/out/{msg}.eml` **before** the transaction, so the row never points to a missing object.
The stored copy has no `Bcc` header; BCC recipients are in `bcc_json` and `deliveries`. Its custom metadata
holds `tenant`, `identity`, `message`, `idem_key_sha256` (the ledger's `key_hash`), `fingerprint` and
`operation`, so a point-in-time restore of the mailbox can rebuild the idempotency ledger for sends made
after the restore point ([Observability › Restore from PITR](observability.md#restore-from-pitr)).

### From address and fallback

1. **Choose the address** (FR-OUT-5, [C3](../edge-cases.md)):
   - `send` without `thread_id`: `from_address` if given (must be `active`), else the primary.
   - `send` with `thread_id`, reply, reply-all, forward: `select_reply_from` in
     [Threading](threading.md#5-which-address-a-reply-is-sent-from-c3-fr-out-5), unless `from_address`
     is given.
2. **Display name** = `identities.display_name` (≤ 78 characters, no CR/LF).
3. **Domain state** of the chosen address, re-read at transport time
   ([Identities, addresses and domains](identity-domains.md#fallback-behaviour), FR-DOM-5, FR-DOM-6,
   [G7](../edge-cases.md)):

   | State | Behaviour |
   |---|---|
   | `healthy`, `degraded` | Send as composed |
   | `pending`, `verifying` (the domain changed after submit, for example a reprove moved it from `suspended` to `verifying`) | **Hold and retry:** nothing is sent and the message stays `queued`. `BeginTransport` takes no claim and answers `DomainNotReady`; the consumer re-enqueues the message with the `Paused` back-off (as `Quota`), until 24 h after submit, then the queued deliveries are `failed` (`quota_exhausted`), as for every back-off ([Back-off bookkeeping](#transport-outcome-classification)) |
   | `failing`, `suspended`, or `transport = ses` while the platform check reports `ses_sending_paused`, with `policy.domain_fallback = true` | **Fallback:** From becomes the identity's platform-domain address with the same display name, Reply-To becomes that address with the thread token, the message gets flag `sent_via_fallback`, the transport is Cloudflare (the platform domain is always a Cloudflare zone), and the thread gets `fallback_pinned = 1`. A `kind: marketing` message never falls back (Cloudflare Email Service is transactional only): it takes the next row instead |
   | The same, with `policy.domain_fallback = false` | Status `failed`, reason `domain_failing_no_fallback`; nothing is sent |
   | `removing`, `removed` | Status `rejected`, reason `sender_domain_unavailable` |

   Fallback is the same whatever the failing domain's connection method (`cloudflare_zone`,
   `nameservers`, `dns_records`, `send_only`, `smtp_relay`, `delegated_subdomain`) and transport: the
   fallback send always leaves through Cloudflare from the platform domain
   ([Domains on any DNS host § 2](domain-connections.md#2-inbound-source-and-outbound-transport-are-separate-choices)).
   The platform domain itself has no fallback: if it is failing, sends from it fail with
   `domain_failing_no_fallback`.

### Reply-To and the thread token

When the sending domain has `reply_token = 'subaddress'` (FR-OUT-6):

```text
Reply-To: "Acme Car Hire" <bookings.acme+t03k.9f2mq7xa@agents.example>
```

The local part and domain are those of the From address actually used (after fallback), and the token
is minted from the thread's `seq` and the identity ID ([Threading](threading.md#2-thread-token)). It is
passed in the transport's `replyTo` field (Cloudflare requires `Reply-To` through the API field, not a
custom header). Domains with `reply_token = 'none'` (those with `inbound = forward`: `send_only`, and
`smtp_relay` with `inbound: forward`, whose own mail system may not preserve sub-addresses) get no
`Reply-To`. External domains with `inbound = ses` use `subaddress` and get one.

### Threading headers and subject

`In-Reply-To`, `References` and the subject follow [Threading › Outbound threading](threading.md#4-outbound-threading)
([C2](../edge-cases.md), [C6](../edge-cases.md)). Cloudflare allows `In-Reply-To` and `References` as
custom headers with values up to 2,048 bytes; if `References` would exceed 2,048 bytes, further entries
after the first are dropped (oldest first) until it fits.

### Body: signature, disclosure, unsubscribe

In this order:

1. The request's `text` and `html`. When `text` is missing it is derived from `html`
   ([Inbound › Text derivation](inbound.md#text-derivation-b4)). When `html` is missing none is sent.
2. **Signature**, unless `operation = forward` adds it after the transfer note: text gets
   `"\n\n-- \n" + signature_text`; HTML gets `<br><br>-- <br>` + `signature_html` (sanitised when it
   was saved).
3. **AI disclosure ([E8](../edge-cases.md)):** `ai_disclosure.mode = "footer"` appends
   `"\n\n" + text` to the text body and `<p>{escaped text}</p>` to the HTML body; `"header"` adds
   `X-AI-Generated: true`; `"none"` adds nothing.
4. **Marketing ([G9](../edge-cases.md), FR-OUT-8):** headers
   `List-Unsubscribe: <{url}>, <mailto:{mailto}>` (mailto only when given) and
   `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058 requires one HTTPS URI); and, unless
   the body already contains the URL, a visible footer `Unsubscribe: {url}` (text) and
   `<p><a href="{url}">Unsubscribe</a></p>` (HTML).

   **Notification emails** are the one exception to "marketing only": a send from the system identity
   made by the `Notifier` is `kind: transactional`, and its internal submit input carries
   `list_unsubscribe: { url }`, the console's one-click URL for that person, workspace and kind. The
   service then writes `List-Unsubscribe: <{url}>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
   and adds no visible footer: the email's text is the Notifier's own
   ([Notifications §5](notifications.md#5-the-emails)). The field exists only on the internal submit
   input: the REST and MCP schemas have no such field, and the mailbox refuses it (`internal_error`,
   logged) on any identity other than the system identity. `account` notifications carry no
   `list_unsubscribe`.
5. **Forward ([C6](../edge-cases.md)):** after the user's text, a transfer note:

   ```text
   ---------- Forwarded message ---------
   From: Brightwell Leeds <accounts@brightwell.example>
   Date: Mon, 14 Sep 2026 08:12:00 +0000
   Subject: Invoice 88213 – AB12 CDE
   To: maintenance.acme@agents.example

   {original text}
   ```

   and in HTML the same block followed by the original sanitised HTML inside `<blockquote>`. With
   `include_attachments` (default `true`) the original's attachments that have no `risk` are attached
   again from R2.

### Headers

| Header | Set by | Condition |
|---|---|---|
| `In-Reply-To`, `References` | Service | Replies, threaded sends, forwards (References only) |
| `Auto-Submitted: auto-replied` | Service | `kind: auto_reply` (FR-OUT-7) |
| `X-Pylota-Mail-Hop: n` | Service | Always: `n` = 1 for a new send, else 1 + the hop of the message replied to or forwarded (stored as `automated_json.hop` on inbound messages, 0 when absent) |
| `X-AI-Generated: true` | Service | `ai_disclosure.mode = "header"` |
| `List-Unsubscribe`, `List-Unsubscribe-Post` | Service | `kind: marketing`; or a `kind: transactional` notification from the system identity whose internal submit input carries `list_unsubscribe` ([Body](#body-signature-disclosure-unsubscribe)). A caller can never set either name: it falls under "anything else" |
| `X-*` | Caller | A name matching `^X-[A-Za-z0-9_-]+$` (the `X-` prefix in either case), except the reserved `X-Pylota-*` and `X-AI-Generated`, which are refused in any case |
| `Importance` | Caller | Value `high`, `normal` or `low` |
| `Priority` | Caller | Value `normal`, `non-urgent` or `urgent` |
| `Sensitivity` | Caller | Value `personal`, `private` or `company-confidential` |
| `Keywords`, `Comments`, `Organization` | Caller | Any value within the limits below |
| Anything else | – | `400 header_not_allowed` |

Validation follows Cloudflare's rules (Email headers reference, read 2026-10-10) and runs at policy step 11,
when the request arrives, so a header Cloudflare would refuse is a `400` at the API, never a later
`rejected` with `provider_validation`. Names are matched case-insensitively, as Cloudflare matches them
(validation rule 3 of that page): an `X-` name must match `^X-[A-Za-z0-9_-]+$` with the prefix in either
case, be at most 100 bytes, and is sent as given; the six other names may be written in any case and are
sent in the casing shown above (`importance` is sent as `Importance`); any other name, an `X-` name with
another character, or a reserved name in any case is `400 header_not_allowed`. Two names that differ only
in case are `400 invalid_request`. Values: non-empty, no CR or LF, at most 2,048 bytes, and
for `Importance`, `Priority` and `Sensitivity` one of the values in the table; a value that breaks a rule
is `400 invalid_request` (`details.errors[0].path = "headers.{name}"`). At most 20 non-`X-` custom headers
in total (service-set ones included); all custom headers together at most 16 KB. `From`, `To`,
`Cc`, `Bcc`, `Subject` and `Reply-To` are never custom headers; `Date`, `Message-ID`, `MIME-Version`,
`Content-*`, `DKIM-Signature`, `Return-Path`, `Received` and the other platform-controlled headers are
set by the transport.

### Attachments and size

- Each attachment: `content_base64` decoded (invalid → `400 invalid_request`), filename sanitised (no
  path, no control characters, ≤ 255 bytes), `content_type` a valid `type/subtype`, `disposition`
  `attachment` or `inline`; inline parts need `content_id`.
- The composed MIME (base64 attachments included) must be at most **5,242,880 − 8,192 bytes**, keeping
  8 KiB for headers the transport adds (Cloudflare's limit is 5 MiB, [limits](../../reference/limits.md#mail)).
  Base64 with 76-character lines turns 57 bytes into 78, so this is about 3.6 MiB (3,825,000 bytes) of
  attachment bytes, less the body. Over it → `413 message_too_large` ([G5](../edge-cases.md), FR-OUT-10).
- **Signed links (P1, `large_attachments: "link"`).** Attachments are replaced by links, largest first,
  until the message fits. Each replaced attachment is stored at
  `t/{ten}/i/{idn}/out/{msg}/a/{att}` and replaced in the body by
  `{filename} ({size}): {url} (available until {expiry, RFC 3339})`, and in HTML by a link. The URL is
  `https://{PM_API_HOST}/v1/links/{token}` in the signed-link format of
  [Security › Signed links](security.md#73-signed-links):
  `token = base64url(payload || HMAC-SHA256(link key {kid}, payload)[0..16])` with
  `payload = "l1:{kid}:att:{tenant_id}:{identity_id}:{message_id}:{attachment_id}:{expires_unix_s}"`,
  signed by the current `link` key; `expires` = now + `link_ttl_hours`. `GET /v1/links/{token}`
  ([REST API](../../reference/api.md#get-v1linkstoken)) verifies the kid, the MAC in constant time and the
  expiry, and serves the bytes with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- Outbound attachments are recorded in `attachments` (`text_status = 'skipped'`) with `r2_key` pointing
  at the stored object (for linked attachments) or at a copy written to the same key layout, so
  `GET …/attachments/{id}` works for outbound messages too.

## Thread lock (C4)

A reply, reply-all, forward or threaded send takes the thread's lock in the submit transaction
(FR-OUT-9). A new thread needs no lock.

```sql
UPDATE threads SET lock_owner = ?1, lock_until = ?2
WHERE seq = ?3 AND (lock_owner IS NULL OR lock_until < ?4 OR lock_owner = ?1);
-- ?1 the new message ID, ?2 now + 120 000 (lease), ?4 now; acquired when changes = 1
```

- **Waiting.** If the lock is held, the transaction is abandoned (nothing written), the request waits
  250 ms (`worker::Delay`, re-checking `deadline_ms`), and tries again, for at most 10 seconds from the
  first attempt. Then `409 thread_busy` with
  `details.retry_after = clamp(ceil((lock_until − now) / 1000), 1, 60)`. The client retries with the
  same key.
- **Holding.** The lock is held while the first message is `queued`, so that the second message's
  `References` can include the first's Message-ID once known. `BeginTransport` refreshes the lease to
  now + 60 s.
- **Release** (in the same transaction as the state change): when the message leaves `queued`
  (`submitted`, `rejected`, `failed`, `uncertain`, `suppressed`, `canceled`), and when it enters a quota
  back-off (it is then definitely unsent and may wait for hours).
- A crashed holder's lock expires with its lease; acquisition ignores locks whose `lock_until` has
  passed, so no sweep is needed.

## Storage of an accepted send

One transaction:

```sql
INSERT INTO messages (id, thread_seq, direction, status, provider, raw_r2_key, raw_size,
  from_address, from_name, sender_domain, reply_to_json, to_json, cc_json, bcc_json, subject, text,
  html_sanitized, extracted_text, snippet, sent_at, received_at, kind, flags_json,
  operation, in_reply_to, references_json, metadata_json)
VALUES (?1, ?2, 'outbound', 'queued', NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?13,
  ?15, ?16, ?16, ?17, '[]', ?18, ?19, ?20, ?21)
RETURNING rowid;
-- status is 'suppressed' instead of 'queued' when every recipient was filtered
-- extracted_text = text for outbound; sent_at = received_at = submit time
-- ?14 html_sanitized: the sent HTML passed through the inbound sanitiser (the exact sent HTML is in the .eml)
-- the Idempotency-Key is not a messages column: it lives in the idempotency row below and, for a restore,
-- in the .eml's R2 metadata (idem_key_sha256)

INSERT INTO deliveries (message_rowid, address, field, status, smtp_response, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6);        -- one per recipient: 'queued', or 'suppressed' with the rule

INSERT INTO labels (message_rowid, label) VALUES (?1, ?2);      -- per requested label
INSERT INTO fts (rowid, subject, participants, body_new, body_full, attachments, refs) VALUES (…);
INSERT INTO idempotency (key_hash, fingerprint, operation, message_id, response_json, created_at, expires_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6 + 2592000000);
```

Then: the thread row update ([Threading](threading.md#42-the-outbound-message-row)), contacts upsert for
each recipient (`outbound_count + 1`), the lock, `meta` `dispatch:{msg} = now`, and for a fully
suppressed send the `message.suppressed` event. Quota warnings returned by `TenantQuota` at 80% and 100%
are emitted here as `quota.warning` (once per scope, metric and day).

After commit the mailbox sends `OutboundJob::Send` to `pm-outbound`. If that fails, the message stays
`queued` and the **dispatch alarm** re-sends it: every queued message whose `dispatch:{msg}` time is more
than 5 minutes old and that has no transport claim is re-queued, and `dispatch:{msg}` is updated. A
duplicate queue message is harmless (the claim admits one transport call).

## Transports

```rust
// crates/worker/src/transport/mod.rs
pub enum Provider { Cloudflare, Ses, Smtp, Simulator, Loopback }

pub struct OutgoingMessage {
    pub message_id: String,
    pub from: (String, String),                   // address, display name
    pub reply_to: Option<String>,
    pub to: Vec<String>, pub cc: Vec<String>, pub bcc: Vec<String>,   // only 'queued' deliveries
    pub subject: String, pub text: Option<String>, pub html: Option<String>,
    pub headers: Vec<(String, String)>,
    pub attachments: Vec<OutAttachment>,
    pub mime: Vec<u8>,                            // the composed MIME, for raw transports
    pub journal_bcc: Option<String>,              // Message-ID strategy B only
}

pub enum TransportResult {
    Accepted { provider_message_id: String, rfc_message_id: Option<String>,
               refused: Vec<RecipientRefusal>,
               deferred: Vec<String> },                          // SMTP only: recipients answered 4xx to
                                                                 // RCPT TO; they stay queued for a retry
    Rejected { reason: RejectReason, code: String, detail: String },  // definitely not sent
    RecipientSuppressed { code: String },                             // definitely not sent (G4)
    RetryLater { class: RetryClass, code: String,                    // definitely not sent
                 refused: Vec<RecipientRefusal> },
    Unknown { reason: UncertainReason, detail: String },             // may have been sent
}
// SMTP only: recipients the relay refused with a 5xx reply to RCPT TO; empty for other transports
pub struct RecipientRefusal { pub address: String, pub code: String, pub detail: String }
pub enum RejectReason { ProviderValidation, SenderDomainUnavailable }
pub enum RetryClass { RateLimit, Quota, Paused, Relay }
pub enum UncertainReason { Timeout, ConnectionLost }

pub trait MailTransport {
    fn provider(&self) -> Provider;
    async fn send(&self, msg: &OutgoingMessage, deadline_ms: u32) -> TransportResult;
}
```

| Implementation | Used for | How |
|---|---|---|
| `CloudflareTransport` | Live tenants, domains with `transport = cloudflare` (the platform domain and the methods `cloudflare_zone`, `nameservers`, `delegated_subdomain`), all fallback sends | `MailSender::send` (structured: `from`, `to`, `cc`, `bcc`, `replyTo`, `subject`, `text`, `html`, `headers`, `attachments`) through the `EMAIL` binding; returns `{ messageId }`. If S1 shows a structured field missing, that message uses `send_raw` with the composed MIME |
| `SesTransport` | Live tenants, domains with `transport = ses` (methods `dns_records` and `send_only`), and `zone` domains switched to `ses` by the failover runbook ([J5](../edge-cases.md)) | SES v2 `SendEmail` with raw content ([Amazon SES](#amazon-ses)) |
| `SmtpTransport` | Live tenants, domains with `transport = smtp` (method `smtp_relay`) | SMTP submission to the customer's own relay over a TCP socket, with TLS ([SMTP relay](#smtp-relay)) |
| `SimulatorTransport` | Test tenants, recipients at `simulator.invalid` | Scripted outcomes ([Simulator](#simulator-l2)) |
| `LoopbackTransport` | Test tenants, recipients on this deployment | Inbound injection ([Loopback](#loopback-l3-g11)) |

A test tenant's message may mix simulator and loopback recipients; both run under one provider ID
`test-{message ulid, lower case}`, and `provider` is `simulator` if any simulator recipient exists, else
`loopback`. Test tenants never reach Cloudflare, SES or a relay (FR-TEN-2).

## The outbound consumer

`pm-outbound` (batch 10, `max_retries` 100) carries:

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutboundJob {
    Send { v: u8, tenant_id: String, identity_id: String, message_id: String, request_id: String },
    TransportEvent { v: u8, tenant_id: String, identity_id: String, event: DeliveryEvent },
}
```

For `Send`:

1. **Re-read** identity, tenant and the sending domain from D1. If the identity is now `paused` or
   `deleting`, or the tenant `suspended`, call `Cancel` with actor `system` (status `canceled`,
   `message.canceled`, audit entry `message.cancel` with the reason) and ack. If `Cancel` answers
   `NotCancelable`: with an active transport claim, ack (the claimed attempt settles the message); with
   deliveries already `submitted` (an SMTP relay that deferred only some recipients), re-enqueue with the
   `Paused` back-off, so the remaining recipients go out if the identity and tenant are active again
   within 24 hours of submit and otherwise end `failed` (`quota_exhausted`), as every back-off does. While
   the deployment is frozen, or the `read_only` switch is on, or the `free_sending` switch is off for a
   Free or ramped workspace, the consumer re-enqueues the message with a delay instead (300 s, or the
   `Paused` back-off for `free_sending`) and cancels nothing ([Observability § 5.6](observability.md#56-automatic-containment)).
2. **`BeginTransport { message_id, domain_state, fallback }`** in the mailbox:
   - status not `queued` → `NotQueued` → ack (a duplicate, or already handled);
   - sending domain `pending` or `verifying` → `DomainNotReady` → no claim; re-enqueue with the `Paused`
     back-off ([From address and fallback](#from-address-and-fallback));
   - a claim `meta` `claim:{msg}` younger than 5 minutes → `AlreadyClaimed` → ack;
   - a claim older than 5 minutes → the previous attempt died after claiming, so its outcome is unknown:
     record `uncertain` with `transport_connection_lost` and ack;
   - otherwise write `claim:{msg} = {token, claimed_at}`, refresh the lock lease, set `alarm:claim` at
     `claimed_at + 5 min`, apply the From decision (fallback or `domain_failing_no_fallback`), and return
     the `OutgoingMessage` inputs (the `.eml` key, `queued` recipients, From, Reply-To, transport);
   - after the From decision, a `kind: marketing` message whose transport is now `cloudflare` (the
     domain's transport changed after submit, or fallback chose the platform domain) is not sent: in the
     same transaction its `queued` deliveries and the message become `rejected` with reason
     `marketing_needs_ses`, the lock is released and no claim is written; after the commit the `sends`
     hold is settled with nothing consumed, `message.rejected` is emitted, and the consumer acks.
3. **Build** the `OutgoingMessage` (structured fields parsed back from the stored `.eml` with the core
   parser, overridden by the fallback decision; attachments read from R2).
4. **Send** through the chosen transport with a 30-second deadline (SMTP: the step timeouts and the
   4-minute overall deadline of [SMTP relay](#smtp-relay)).
5. **`RecordTransportOutcome { message_id, claim_token, result }`**: in one transaction, clear the claim,
   update the message and deliveries per the classification below, release the lock where required,
   append events. It returns the back-off delay for `RetryLater`, and for an `Accepted` result with a
   non-empty `deferred` list. **The message stays `queued` while any delivery is still `queued`**: an
   SMTP `Accepted` with `deferred` recipients sets the accepted deliveries to `submitted`, the refused ones
   to `rejected`, keeps the deferred ones `queued`, and leaves the message `queued` (with
   `provider_message_id` set from this attempt). After the commit the mailbox settles the `sends` hold
   for the part that is decided: `Settle { consume, keep }` consumes one unit per delivery that reached
   `submitted` in this attempt, keeps `keep` = the number of deferred deliveries held for their retry
   (`expires_at` = the retry time + 10 minutes), and releases the rest; for `rejected`, `failed` and
   `uncertain` it consumes nothing
   ([Plans, metering and billing › What the Worker meters](billing.md#what-the-worker-meters)).
6. **Ack**, or for `RetryLater` (and for `Accepted` with `deferred` recipients) call `Extend` on the
   `sends` hold (`until` = the retry time + 10 minutes; for a partial acceptance the `keep` above already
   did it), then **re-enqueue**: send a new `OutboundJob::Send` for the message to `Q_OUTBOUND` with
   `delay_seconds = delay` and ack the current one. The retry sends only to deliveries still `queued`,
   with the same `Message-ID`, so no recipient gets the message twice. Because each back-off is a new
   queue message, its delivery count starts again at zero: the queue's `max_retries` (100) counts only
   unexpected errors (`retry()`), never back-offs, and the 24-hour limit below ends every back-off.

The claim alarm runs the same stale-claim rule for claims older than 5 minutes, so a consumer that dies
after claiming is resolved to `uncertain` even if its queue message is never redelivered.

### Transport outcome classification

Cloudflare codes and meanings are from the Workers API page of Email Service (read 2026-10-09). SES
codes are from the SES v2 `SendEmail` reference (read 2026-10-09). SMTP rows follow the client table of
[Domains on any DNS host § 5.2](domain-connections.md#52-the-client).

| Transport result | Message status | Deliveries (`queued` ones) | Retry | Event (`data.reason`) |
|---|---|---|---|---|
| Accepted (Cloudflare `{messageId}`, SES `200 {MessageId}`, SMTP `250` to the final `.`, simulator, loopback) | `submitted`, `provider_message_id` set; SMTP with `deferred` recipients: stays `queued` until they are sent | `submitted` (SMTP: those in `refused` are `rejected`, those in `deferred` stay `queued`) | SMTP `deferred` only: `Relay` back-off for those deliveries, then `failed` (`quota_exhausted`) after 24 h | `message.sent` once the message leaves `queued` |
| Cloudflare `E_VALIDATION_ERROR`, `E_FIELD_MISSING`, `E_TOO_MANY_RECIPIENTS`, `E_TOO_MANY_ATTACHMENTS`, `E_CONTENT_TOO_LARGE`, `E_HEADER_NOT_ALLOWED`, `E_HEADER_USE_API_FIELD`, `E_HEADER_VALUE_INVALID`, `E_HEADER_VALUE_TOO_LONG`, `E_HEADER_NAME_INVALID`, `E_HEADERS_TOO_LARGE`, `E_HEADERS_TOO_MANY` ([G10](../edge-cases.md)) | `rejected` | `rejected` | never | `message.rejected` (`provider_validation`) |
| Cloudflare `E_DELIVERY_FAILED` ("SMTP delivery failure, recipient server rejection"; definitive) | `rejected` | `rejected` | never | `message.rejected` (`provider_validation`, detail from the error) |
| Cloudflare `E_RECIPIENT_NOT_ALLOWED` (binding restriction; never configured by us) | `rejected` | `rejected` | never | `message.rejected` (`provider_validation`); alert |
| Cloudflare `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_SENDER_NOT_VERIFIED`; SES `MailFromDomainNotVerifiedException`, `NotFoundException` | `rejected` | `rejected` | never | `message.rejected` (`sender_domain_unavailable`); the domain gets an immediate health check |
| Cloudflare `E_RECIPIENT_SUPPRESSED` | see [Provider suppressions](#provider-suppressions-and-resending-g4) | | | |
| Cloudflare `E_RATE_LIMIT_EXCEEDED`; SES `TooManyRequestsException` | `queued` | `queued` | `RateLimit`: 10 s × n (n = back-offs so far, max 60 s), ±10% jitter, until 24 h after submit, then `failed` | none while retrying; `message.failed` (`quota_exhausted`) at the end, as for `Quota` |
| Cloudflare `E_DAILY_LIMIT_EXCEEDED`; SES `LimitExceededException` ([G3](../edge-cases.md)) | `queued` | `queued` | `Quota`: 60 s × 2^(n−1), max 3,600 s, ±10% jitter, until 24 h after submit, then `failed` | none while retrying; `message.failed` (`quota_exhausted`) at the end; the first one fires the `provider_quota` alert ([Observability](observability.md#53-alert-list)) |
| SES `AccountSuspendedException`, `SendingPausedException` | `queued` | `queued` | `Paused`: as `Quota` | as `Quota`; alert |
| SES `MessageRejected`, `BadRequestException`, any other 4xx with an error type | `rejected` | `rejected` | never | `message.rejected` (`provider_validation`) |
| SMTP `535` (or another `5xx`) to `AUTH` ([N14](../edge-cases.md)) | `rejected` | `rejected` | never | `message.rejected` (`sender_domain_unavailable`); domain issue `smtp_auth_failed` (fail) and an immediate health check |
| SMTP port 587 without `STARTTLS` advertised; credentials never sent ([N16](../edge-cases.md)) | `rejected` | `rejected` | never | `message.rejected` (`sender_domain_unavailable`); domain issue `smtp_tls_required` (fail) and an immediate health check |
| SMTP `5xx` to `MAIL FROM` or to the final `.`; every `RCPT TO` refused with `5xx` | `rejected` | `rejected` | never | `message.rejected` (`provider_validation`, detail = the SMTP reply) |
| SMTP `5xx` to one `RCPT TO` | the rest of the exchange decides | that delivery `rejected`, with the reply in `smtp_response` | never for that recipient | none of its own; the message's event covers it |
| SMTP before the final `.` is written: no `220` within 10 s, a refused connection or failed TLS handshake, a non-`250` reply to `EHLO`, `4xx` to `AUTH` or `MAIL FROM`, `4xx` to every `RCPT TO` (no `DATA` is sent), or the connection lost; also `4xx` to the final `.`. A `4xx` to only some `RCPT TO` is not this row: `DATA` goes to the others, and the result is `Accepted` with those recipients in `deferred` ([SMTP relay](#smtp-relay)) | `queued` | `queued` (any `5xx` refusals: `rejected`) | `Relay`: as `Quota`, then `failed` | none while retrying; `message.failed` (`quota_exhausted`) at the end |
| Cloudflare `E_INTERNAL_SERVER_ERROR` ("temporarily unavailable"), any unrecognised Cloudflare code, a thrown error without a code; SES 5xx; a connection error; SMTP connection lost after the final `.` was written and before its reply ([N15](../edge-cases.md)) | `uncertain` | `uncertain` | **never** | `message.uncertain` (`transport_connection_lost`) |
| No answer within the 30-second deadline ([G2](../edge-cases.md)); SMTP: no reply to the final `.` within 60 s, or the overall deadline reached after the final `.` | `uncertain` | `uncertain` | **never** | `message.uncertain` (`transport_timeout`) |
| Domain failing with fallback disabled | `failed` | `failed` | never | `message.failed` (`domain_failing_no_fallback`) |
| `kind: marketing` on the `cloudflare` transport at `BeginTransport` (decided before any transport call) | `rejected` | `rejected` | never | `message.rejected` (`marketing_needs_ses`) |

An error response from the provider that the table does not classify as definitive is treated as
unknown: the design prefers an `uncertain` that a human or a later event resolves over a retry that could
send twice (FR-OUT-2). The public summary of this mapping is in
[Errors › How provider errors map to reasons](../../reference/errors.md#how-provider-errors-map-to-reasons). `message.uncertain` carries `fix`: "Check the recipient's mailbox or wait for a
delivery event; then call resolve with sent or not_sent."

**Back-off bookkeeping.** `workers-rs` 0.8.7 does not expose the queue attempt count, so `n` is kept in the
mailbox as `meta` `backoff:{msg} = {n, first_at}`, incremented by `RecordTransportOutcome`, and cleared
when the message leaves `queued`. "24 h after submit" uses `messages.received_at`. Every back-off class
(`RateLimit`, `Quota`, `Paused`, `Relay`) has the same end: a `RetryLater` whose next retry would fall more
than 24 hours after submit makes the queued deliveries `failed` (`quota_exhausted`) instead, and the
message rolls up as usual. Each back-off releases
the thread lock, extends the `sends` hold to the retry time plus 10 minutes (`Extend`), and sets
`dispatch:{msg}` to the retry time, so the dispatch alarm re-queues the message if the queue retry is
lost.

### Provider suppressions and resending (G4)

Cloudflare's per-domain "drop suppressed recipients" setting is off by default, and the design keeps it
off (onboarding sets `drop_suppressed_recipients: false`), so a send that includes a recipient on
Cloudflare's suppression list fails as a whole with `E_RECIPIENT_SUPPRESSED`, which is definitive
(read 2026-10-09). Then:

1. **Identify** the suppressed recipients. With one queued recipient, it is that one. Otherwise, for each
   queued recipient call `GET /accounts/{PM_CF_ACCOUNT_ID}/email/sending/suppressions?email={address}`
   with `PM_CF_API_TOKEN`; an item whose scope is the account or this sending domain counts.
2. **Sync**: each suppressed recipient's delivery becomes `suppressed` with `smtp_response =
   "provider: suppressed ({reason})"`, and a row is added to our `suppressions` with reason `provider`
   (`INSERT OR IGNORE`, `source_message_id` = this message), with its `suppression.created` event.
3. **Resend** to the remaining queued recipients immediately, under the same claim. This is safe because
   the rejection was definitive. At most three rounds.
4. If no recipient remains, the message ends `suppressed` (`message.suppressed`). If the recipients cannot
   be identified (no API token, the lookup fails, or it finds none), the message ends `rejected` with
   reason `recipient_suppressed_by_provider`.

## Message-ID of outbound mail (spike S7)

Cloudflare sets the `Message-ID` header (generated with a Cloudflare domain) and refuses attempts to set
it with `E_HEADER_NOT_ALLOWED`; the documentation does not say whether the returned `messageId` equals
the header value, and its examples show bare IDs without `<…@…>`
([headers reference](https://developers.cloudflare.com/email-service/reference/headers/), read
2026-10-09). SES also overrides any `Message-ID` it is given
([SES header fields](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html), read 2026-10-09).
Replies match our mail by thread token first ([C7](../edge-cases.md)); the header ID is needed for
replies that drop the `Reply-To` token, matched through `In-Reply-To`.

**Strategy A (derived).** If S7 finds a deterministic mapping, `core::compose::derive_cf_message_id(provider_id)`
implements it, and `RecordTransportOutcome` stores `rfc_message_id` with `provider_message_id`.

**Strategy B (journal copy).** Otherwise every Cloudflare send adds a hidden BCC
`journal+{message ulid}.{identity ulid}@{PM_PLATFORM_DOMAIN}` (both ULIDs lower case, without prefixes;
61-character local part). It is not a delivery row, does not count against `max_recipients`, but uses one
of Cloudflare's 50 recipients (so the hard maximum becomes 49). When it arrives:

1. `email()` recognises `journal` with a detail on the platform domain
   ([Inbound](inbound.md#the-email-handler)), reads `Message-ID`, `From` and `Subject` from the headers,
   loads the identity's `mailbox_do_id` (`SELECT tenant_id, mailbox_do_id FROM identities WHERE id = ?1`),
   and sends `MailboxRequest::LearnMessageId { message_id, rfc_message_id, from, subject }`.
2. The mailbox accepts it only if: the message is outbound, its status is past `queued`, its
   `rfc_message_id` is null, `from_address` equals the header `From` address, `subject` equals the header
   subject, it was submitted less than 15 minutes ago, and the header ID matches the pattern recorded by
   S7 (the Cloudflare domain). Then it sets `rfc_message_id`.
3. Nothing is stored, nothing is evented, and the handler returns `Ok` whatever the outcome (a lost
   journal copy only loses the header-ID match). Delivery events for the journal recipient are ignored.

**SES.** The SES `Send` event carries `mail.commonHeaders.messageId`, the ID SES assigned; the event
handler stores it as `rfc_message_id`. Loopback mail keeps the `Message-ID` we compose
(`<{message ulid, lower case}@{from domain}>`), so it is known immediately.

## Delivery events

### Cloudflare Email Sending

Each sending domain has an event subscription that feeds `pm-delivery-events`
([Identities and domains](identity-domains.md)). The payload, per the Email Service event-subscriptions
page (read 2026-10-09):

```rust
// crates/worker/src/consumers/delivery.rs
#[derive(Deserialize)]
pub struct CfEvent {
    #[serde(rename = "type")] pub event_type: String,   // cf.email.sending.message.delivered | deferred |
                                                          // bounced | failed | rejected | complained
    pub source: CfSource,                                 // { type: "email.sending", zoneId, domain }
    pub payload: CfPayload,
    pub metadata: CfMetadata,                             // { accountId, eventSubscriptionId,
}                                                         //   eventSchemaVersion, eventTimestamp }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CfPayload {
    pub event_id: String, pub message_id: String, pub sender: String, pub recipient: String,
    pub subject: Option<String>,                          // absent on complaints
    pub terminal: bool,
    pub delivery: Option<CfDelivery>,                     // { status, provider, deliveryTimeMs,
                                                          //   smtpStatusCode, smtpEnhancedStatusCode, smtpResponse }
    pub bounce: Option<CfBounce>,                         // { type: hard|soft, classification, reason }
    pub failure: Option<CfReason>, pub rejection: Option<CfRejection>, pub complaint: Option<CfComplaint>,
}
```

Every source is normalised to one type:

```rust
pub struct DeliveryEvent {
    pub source: EventSource,                 // Cloudflare | Ses | Simulator | Loopback | Dsn
    pub event_id: String,                    // provider eventId, "ses:{sns id}:{rcpt}", "sim:…", "dsn:…"
    pub provider_message_id: Option<String>,
    pub sender: String, pub recipient: String, pub subject: Option<String>,
    pub kind: DeliveryKind,                  // Delivered | Deferred | Bounced { hard: bool } | Failed | Rejected | Complained
    pub smtp_code: Option<String>, pub enhanced_code: Option<String>,
    pub smtp_response: Option<String>,       // trimmed to 512 characters
    pub occurred_at: i64,                    // metadata.eventTimestamp, or the provider's timestamp
}
```

### The delivery consumer

For each event (from `pm-delivery-events`, or a `TransportEvent` on `pm-outbound`):

1. **Parse.** An unknown `type` is acked and counted (`delivery_unknown_type_total`).
2. **Route by sender** (FR-DLV-1): normalise `sender`, then
   `SELECT a.identity_id, a.tenant_id, i.mailbox_do_id FROM addresses a JOIN identities i ON i.id = a.identity_id WHERE a.address = ?1`
   with **no status filter**, so retiring and retired addresses still route late events. Journal
   recipients are acked and ignored. No match → ack, `delivery_unroutable_total`.
3. **`ApplyDeliveryEvent`** in the mailbox ([below](#applying-an-event-to-a-message)), which returns
   `Applied { outcome, suppress }`, `Duplicate { suppress }`, `Reconciled { … }` or `NotFound`.
4. **`NotFound` ([G8](../edge-cases.md))**: the event may have arrived before `RecordTransportOutcome`
   stored the provider ID. With age = now − `occurred_at`: below 330 seconds (ten 30-second retries plus
   margin) → `retry(Some(30))`; otherwise ack as orphaned, `delivery_orphaned_total` incremented and the
   hashed IDs logged. (Age, not attempt count, bounds the retries; see
   [Design › Idempotent queue consumers](index.md#7-idempotent-queue-consumers).)
5. **Suppressions** for `suppress` (hard bounce → reason `hard_bounce`, complaint → `complaint`; both
   permanent, `expires_at = NULL`), see [Suppressions](#suppressions).
6. **Abuse windows** for `outcome` ([Abuse auto-pause](#abuse-auto-pause-fr-dlv-3)).
7. Ack.

### Applying an event to a message

In one mailbox transaction:

1. **Find the message:** `SELECT rowid, id, status FROM messages WHERE direction = 'outbound' AND provider_message_id = ?1`.
   None → try [reconciliation](#uncertain-sends-and-reconciliation-fr-dlv-4); still none → `NotFound`.
2. **Find the delivery:** `SELECT status, provider_event_ids_json FROM deliveries WHERE message_rowid = ?1 AND address = ?2`
   (recipient normalised). No row (an address we did not send to) → `Duplicate`.
3. **Deduplicate:** `event_id` already in `provider_event_ids_json` → `Duplicate` (with the `suppress`
   list recomputed). Otherwise append it (the list keeps the last 20).
4. **Transition** the delivery ([G6](../edge-cases.md)):

   | Current \ event | delivered | deferred | bounced | failed | rejected | complained |
   |---|---|---|---|---|---|---|
   | `queued`, `submitted`, `uncertain` | delivered | deferred | bounced | failed | rejected | complained |
   | `deferred` | delivered | deferred (details updated) | bounced | failed | rejected | complained |
   | `delivered` | – | ignored (stale) | bounced (late bounce) | ignored | ignored | complained |
   | `bounced` | ignored | ignored | details updated | ignored | ignored | complained |
   | `complained`, `failed`, `rejected`, `suppressed` | ignored | ignored | ignored | ignored | ignored | ignored |

   An applied transition writes `status`, `smtp_code`, `enhanced_code`, `smtp_response`, `bounce_type`
   and `updated_at`.
5. **Roll up** the message status over deliveries that are not `suppressed`:

   ```text
   none left                                  → suppressed
   any complained                             → complained
   any queued                                 → queued (an SMTP relay deferred some recipients)
   any submitted / deferred / uncertain:
       message is 'uncertain' and every non-terminal delivery is still 'uncertain' → uncertain
       any deferred                           → deferred
       otherwise                              → submitted
   all terminal:
       any bounced                            → bounced
       any failed                             → failed
       any rejected                           → rejected
       otherwise                              → delivered
   ```

   A terminal message status changes only from `delivered` to `bounced` (late bounce) or to `complained`,
   and from `bounced` to `complained`.
6. **Events** (with `sequence`): `message.delivered`, `message.deferred`, `message.bounced` (with
   `bounce_type`, `suppressed`) and `message.complained` (with `suppressed: true`) per recipient for every
   applied transition; `message.rejected` (reason `provider_validation`, `detail` from the provider) when
   the roll-up becomes `rejected`, and `message.failed` (`message_id`, `reason`; it has no `detail`) when
   it becomes `failed`. Stale or ignored events emit
   nothing.
7. **Return** `outcome` for the abuse windows (delivered → `delivered`, hard bounce → `bounced`,
   complaint → `complained`, soft bounce, failed and rejected → `other`; deferred → none) and `suppress`
   for hard bounces and complaints.

**Notification sends ([O17](../edge-cases.md)).** On the system identity's mailbox, a hard bounce or a
complaint on a notification email (a message whose `metadata.notify_user_id` the Notifier set) is handled
as above (the address is suppressed on the default tenant
like any recipient) and, after commit, also pauses that person's notification preferences: the consumer
sets `paused_reason` (`bounce` or `complaint`) on every `notification_prefs` row of the person, in every
workspace, as [Notifications §5](notifications.md#5-the-emails) defines. A notification that ends
`failed` or `rejected` is counted in `notifications_failed_total`
([Observability](observability.md#32-catalogue)); it pauses nothing.

### SES events

SES events arrive by SNS at the Worker ([Amazon SES](#amazon-ses)), are normalised to `DeliveryEvent`
and sent to `pm-outbound` as `TransportEvent`, then handled by the same consumer steps:

| SES `eventType` | Delivery event |
|---|---|
| `Send` | No status change; stores `mail.commonHeaders.messageId` as `rfc_message_id` |
| `Delivery` | `delivered` for each of `delivery.recipients` |
| `Bounce`, `bounceType = Permanent` | `bounced` (hard) per `bouncedRecipients`; subtypes `Suppressed`, `OnAccountSuppressionList` also add our suppression with reason `provider` |
| `Bounce`, `Transient` or `Undetermined` | `bounced` (soft); SES publishes soft bounces only once it stops retrying |
| `Complaint` | `complained` per `complainedRecipients` |
| `DeliveryDelay` | `deferred` per `delayedRecipients` |
| `Reject`, `Rendering Failure` | `rejected` for every recipient |

`event_id` = `ses:{SNS MessageId}:{recipient}`, `provider_message_id` = `mail.messageId`,
`sender` = the first address of `mail.commonHeaders.from`, `occurred_at` = the event's timestamp.

## Suppressions

- Our list is `suppressions` in D1, keyed by `HMAC-SHA256(PM_HASH_KEY, address)` with a masked
  `address_hint` (`j***@example.com`). It is checked per recipient at submit.
- Created by: a hard bounce (`hard_bounce`), a complaint (`complaint`), provider sync (`provider`), and
  the API (`manual`, `unsubscribe`) (FR-DLV-2). Soft bounces never suppress. A suppression survives
  counterparty erasure ([I7](../edge-cases.md)).
- Writes are `INSERT OR IGNORE INTO suppressions (tenant_id, address_hash, address_hint, reason, source_message_id, created_at, expires_at) VALUES (…)`.
- **`suppression.created`** is emitted by the mailbox that owns `source_message_id`, through
  `MailboxRequest::EmitEvent` with a **deterministic event ID**: a ULID whose time is the suppression's
  `created_at` and whose random part is the first 10 bytes of
  `HMAC-SHA256(PM_HASH_KEY, "suppression:" + tenant_id + address_hash + created_at)`. The outbox insert
  is `INSERT OR IGNORE`, so a consumer retry never emits it twice. It is emitted only when the D1 row's
  `source_message_id` is this message (a pre-existing suppression from elsewhere emits nothing).

## Abuse auto-pause (FR-DLV-3)

`TenantQuota.outcomes` keeps the last 1,000 outcomes per identity. For each `outcome`, the consumer calls
`QuotaRequest::RecordOutcome { identity_id, domain_id, outcome, at }`, which in one transaction inserts it
with the next `seq`, deletes rows beyond 1,000 for that identity, increments the tenant's per-day counters
and the per-domain hourly counters (below), and evaluates:

```text
complaints = complained outcomes among the identity's last 1,000 rows
bounces    = bounced outcomes among the identity's last 200 rows
pause if complaints / 1000 > policy.abuse.complaint_rate_pause   (default 0.003 → more than 3)
      or bounces / 200     > policy.abuse.bounce_rate_pause      (default 0.05  → more than 10)
```

The denominators are the window sizes, not the number of rows present, so a young identity is judged
against a full window and is not paused by its first complaint. When `pause` is returned, the consumer
runs:

```sql
UPDATE identities SET status = 'paused', pause_reason = 'abuse_threshold', updated_at = ?2
WHERE id = ?1 AND status = 'active';
```

and only when it changed a row: `EmitEvent identity.paused` with `reason: "abuse_threshold"` and
`metrics: { complaints, complaint_window: 1000, bounces, bounce_window: 200 }`, and an `audit_log` row
(`identity.auto_pause`). Resuming needs a platform, partner or tenant key; on a tenant a partner's key
created it needs a platform key, so a partner cannot reverse the platform's abuse control on its own
tenants ([J17](../edge-cases.md), [API](../../reference/api.md#patch-v1identitiesidentity_id--identitieswrite)).

**Tenant outcome counters.** `RecordOutcome` also increments `counters` rows of the tenant for the UTC
day of `at`: `outcomes` for every outcome, and `bounced` or `complained` when the outcome is one of those.
They are not per identity and `ForgetIdentity` leaves them, so they count every outcome since the
workspace was created, which the per-identity `outcomes` rows cannot (they keep 1,000 per identity and are
deleted with the identity). `OutcomeRates { since }` sums them over the UTC days from the day of `since`
for the new-workspace send ramp ([Cloud sign-up › New-workspace send ramp](cloud-signup.md#101-new-workspace-send-ramp)).
They are never pruned (three rows a day at most); tenant erasure's `delete_all` removes them.

**Per-domain outcome counters.** `RecordOutcome` also increments `dom:{domain_id}:outcomes`, and
`dom:{domain_id}:bounced` or `dom:{domain_id}:complained`, in the window of the UTC hour of `at`
(`domain_id` is the sending domain the delivery used: the platform domain for a fallback send), and
deletes that domain's windows older than 25 hours. It then sums the last hour's and the last 24 hours'
windows of that domain and answers `domain_alert` when bounced/outcomes > 2% with ≥ 50 outcomes in the
hour, or complained/outcomes > 0.1% with ≥ 200 outcomes in 24 hours, and `suspend` at twice either
threshold (4% with ≥ 100, or 0.2% with ≥ 500). The delivery-event consumer reports `domain_alert` as the
state alert `bounce_rate:{tenant_id}:{domain_id}` or `complaint_rate:{tenant_id}:{domain_id}`, and on
`suspend` runs `UPDATE tenants SET status = 'suspended', suspended_by = 'platform', suspended_at = ?2
WHERE id = ?1 AND status = 'active'`, which pauses the tenant's identities as any suspension does, then
writes `tenant.auto_suspend` and reports `containment:tenant_suspended`
([Observability § 5.3 and § 5.6](observability.md#56-automatic-containment)).

**The system identity is exempt.** For the identity with `is_system = 1` the consumer still records each
outcome but never runs the pause: pausing it would stop every sign-in, invitation and notification email
of the deployment. Its bounces and complaints are handled per person instead (a notification bounce pauses
that person's notification preferences, [O17](../edge-cases.md)), and suppressions apply to it as to any
identity.

## Uncertain sends and reconciliation (FR-DLV-4)

An `uncertain` message is **never resent automatically** (FR-OUT-2). Its deliveries are `uncertain`
with `updated_at` = the time it became uncertain. Its `sends` hold is released; a reconciliation below,
or `resolve` with `sent`, then consumes one unit per recipient with a `Settle` that finds no hold
([W5](../edge-cases.md), [Plans, metering and billing › Settle, extend and expiry](billing.md#settle-extend-and-expiry)).

**Reconciliation from events.** When an event's provider ID matches no message, `ApplyDeliveryEvent`
looks for exactly one candidate:

```sql
SELECT m.rowid, m.id FROM messages m
JOIN deliveries d ON d.message_rowid = m.rowid
WHERE m.direction = 'outbound' AND m.status = 'uncertain' AND m.provider_message_id IS NULL
  AND m.from_address = ?1                  -- event sender (normalised)
  AND d.address = ?2 AND d.status = 'uncertain'
  AND m.subject = ?3                       -- event subject, exact
  AND d.updated_at BETWEEN ?4 AND ?5;      -- occurred_at − 30 min … occurred_at + 5 min
```

- **One row** → set `provider_message_id` to the event's message ID, add the flag `reconciled`, apply the
  event (step 2 onwards), emit `message.reconciled { message_id, status }` with the rolled-up status, then
  the per-recipient event. Later events for other recipients match by provider ID.
- **Several rows** → ambiguous: nothing changes, `reconcile_ambiguous_total` is incremented, and the
  event is treated as `NotFound`.
- **No subject in the event** (Cloudflare omits it on complaints) → no reconciliation.

After 30 minutes without a match the message stays `uncertain` until a human resolves it.

**Resolve.** `POST …/messages/{id}/resolve` with `messages:write` (`Idempotency-Key` optional, stored in
D1 `idempotency_records`) calls `MailboxRequest::Resolve { outcome }`:

| Current status | `outcome` | Result |
|---|---|---|
| not `uncertain` | any | `409 not_uncertain` |
| `uncertain` | `sent` | status `submitted`, uncertain deliveries `submitted`; `message.sent` with `provider_message_id: null` |
| `uncertain` | `not_sent` | status `failed`, uncertain deliveries `failed`; `message.failed` with reason `resolved_not_sent` |

The handler writes an `audit_log` row (`message.resolve`, outcome in `details_json`). After `not_sent` the
caller may send again with a **new** `Idempotency-Key`; the old key keeps replaying the original response.

## Cancel

`POST …/messages/{id}/cancel` (`messages:send`) calls `MailboxRequest::Cancel`: allowed only while the
status is `queued` and no transport claim is active. It sets status `canceled` (deliveries are left
`queued`; the message status is authoritative), clears `backoff:` and `dispatch:` metadata, releases the
thread lock, the day's quota reservation and the `sends` hold, and emits `message.canceled`
(FR-OUT-11). Otherwise `409 not_cancelable`, including for a `queued` message that already has
`submitted` deliveries (an SMTP relay deferred only some recipients, so part of it was sent). A queue
message that arrives later finds the message not `queued` and acks.

## Amazon SES

SES is optional (`PM_SES_REGION` plus `PM_SES_ACCESS_KEY_ID` and `PM_SES_SECRET_ACCESS_KEY`). It is the
transport of domains with `transport = ses` (the methods `dns_records` and `send_only` of
[Domains on any DNS host](domain-connections.md)) and the failover transport ([J5](../edge-cases.md)).
**Spike S8** must pass for it to ship in v1.0.

**Identities.** Each such domain is an SES identity, created at onboarding with `CreateEmailIdentity` and
`ConfigurationSetName` ([§ 4.3](domain-connections.md#43-dns_records)). When SES is configured, a
`cloudflare_zone`, `nameservers` or `delegated_subdomain` domain also gets an SES identity at onboarding,
with its DKIM CNAMEs published through the Cloudflare DNS API, so that the [J5](../edge-cases.md) failover
needs no DNS change ([Identities and domains › Kind `zone`](identity-domains.md#kind-zone)). It has no
custom MAIL FROM, so during a failover SPF does not align and DMARC passes on DKIM.

- **DKIM.** Easy DKIM signs with `d=` the domain, so DKIM aligns even under `adkim=s`. The three CNAME
  targets are built from the returned `SigningHostedZone`, which differs by region
  ([creating identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html), read
  2026-10-09).
- **Custom MAIL FROM.** `PutEmailIdentityMailFromAttributes` sets `MailFromDomain = pm-bounce.{domain}`
  and `BehaviorOnMxFailure = USE_DEFAULT_VALUE`
  ([MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html), read 2026-10-09). The return
  path is then under the customer's domain, so SPF aligns under relaxed `aspf`
  ([SES DMARC](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html), read
  2026-10-09). If the MAIL FROM MX disappears, SES falls back to its own MAIL FROM domain: SPF stops
  aligning, DKIM still aligns, and the domain is `degraded` (`mail_from_failed`, [N11](../edge-cases.md)),
  not `failing`.
- **Identity limit.** SES allows 10,000 verified identities per AWS Region
  ([quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09). The count is the
  `domains` rows with `ses_region` set that are not `removed`, plus the platform identity. At 9,000 the
  operator alert `ses_identities_90pct` fires and `pmail doctor` warns. At 10,000, creating a domain that
  needs an SES identity (`dns_records`, `send_only`, or `smtp_relay` with `inbound: ses`) fails with
  `422 transport_unavailable` and `details.reason = "ses_identity_limit"`.

**Send.** `POST https://email.{region}.amazonaws.com/v2/email/outbound-emails`:

```json
{ "FromEmailAddress": "bookings@acme.example.com",
  "Destination": { "ToAddresses": ["jo@example.net"], "CcAddresses": [], "BccAddresses": [] },
  "Content": { "Raw": { "Data": "<base64 of the composed MIME>" } },
  "ConfigurationSetName": "pylota-mail" }
```

The MIME is the stored `.eml` (no `Bcc` header; the `Reply-To` header carries the token when the domain
supports it). SES replaces `Message-ID` and `Date`. Response `200 { "MessageId": "…" }`. SES accepts
50 recipients and 40 MB per message after base64 (read 2026-10-09); our 5 MiB composed limit applies to
every transport.

**SigV4** (`core::ses::sigv4`, pure: inputs are the request, the credentials and `now`):

```text
CanonicalRequest = Method \n CanonicalURI \n CanonicalQueryString \n CanonicalHeaders \n SignedHeaders \n hex(SHA256(body))
  headers signed: content-type, host, x-amz-date (lower-case names, sorted, values trimmed)
StringToSign     = "AWS4-HMAC-SHA256" \n {YYYYMMDD'T'HHMMSS'Z'} \n {YYYYMMDD}/{region}/ses/aws4_request \n hex(SHA256(CanonicalRequest))
kDate    = HMAC-SHA256("AWS4" + secret, YYYYMMDD)
kRegion  = HMAC-SHA256(kDate, region)
kService = HMAC-SHA256(kRegion, "ses")
kSigning = HMAC-SHA256(kService, "aws4_request")
Authorization: AWS4-HMAC-SHA256 Credential={key_id}/{YYYYMMDD}/{region}/ses/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature={hex(HMAC-SHA256(kSigning, StringToSign))}
```

The signing name is `ses` and the host `email.{region}.amazonaws.com` (AWS SigV4 guide and the SES v2
service model, read 2026-10-09). Errors are classified by the error type in the `x-amzn-ErrorType`
response header (or the body's error type), as in the outcome table (verify the exact location at build
time, S8). `core::ses::sigv4` is tested against AWS's published SigV4 test vectors.

**Events.** Setup creates the configuration set `pylota-mail` with an SNS event destination for
`SEND`, `DELIVERY`, `BOUNCE`, `COMPLAINT`, `REJECT`, `DELIVERY_DELAY` and `RENDERING_FAILURE`, sets
`SignatureVersion=2` on that topic (the default is 1,
[SetTopicAttributes](https://docs.aws.amazon.com/sns/latest/api/API_SetTopicAttributes.html), read
2026-10-09), and subscribes the topic over HTTPS to `https://{PM_API_HOST}/hooks/ses`. This endpoint
carries SES **delivery events** only. Inbound SES notifications use a separate topic and endpoint,
`POST /hooks/ses/inbound` ([Domains on any DNS host § 4.5](domain-connections.md#45-inbound-through-ses));
both endpoints share the verification in `core::sns`. `POST /hooks/ses` (in `consumers/ses_events.rs`):

1. Reads `x-amz-sns-message-type` and the JSON body (SNS sends `text/plain`).
2. **Verifies the signature:** `SignatureVersion` must be `2`; version 1 (SHA-1) is refused.
   `SigningCertURL` must be `https` on host `sns.{PM_SES_REGION}.amazonaws.com`; `TopicArn` must equal
   `PM_SES_SNS_TOPIC_ARN`; `Timestamp` must be within one hour. The certificate is fetched (cached per URL
   for 24 hours in the isolate), parsed as X.509, and its RSA key verifies the base64 `Signature` over the
   string to sign: for `Notification` the fields `Message`, `MessageId`, `Subject` (if present),
   `Timestamp`, `TopicArn`, `Type`; for `SubscriptionConfirmation` and `UnsubscribeConfirmation` the
   fields `Message`, `MessageId`, `SubscribeURL`, `Timestamp`, `Token`, `TopicArn`, `Type`; each as
   `Key\nValue\n` in that order. Version 2 is RSA PKCS#1 v1.5 with SHA-256 (SNS developer guide, read
   2026-10-09). Failure → `403 invalid_signature`, counted in `ses_sns_rejected_total`.
3. `SubscriptionConfirmation` → `GET SubscribeURL` (same host rule) and `200`. The token is valid for two
   days.
4. `Notification` → parse `Message` as the SES event, normalise one `DeliveryEvent` per recipient, send
   them to `pm-outbound` as `TransportEvent`, respond `200`. Any internal failure responds `500`, because
   SNS retries only `5xx` and `429`.
5. `UnsubscribeConfirmation` → log and `200`.

## SMTP relay

The transport of `smtp_relay` domains (FR-DOM-11): the agent's mail leaves through the customer's own
provider, under their reputation and authentication.
[Domains on any DNS host § 5](domain-connections.md#5-smtp_relay-the-customers-own-sending-provider)
specifies the configuration, the client and the probe; this section is what the send path relies on.
**Spike S12** must pass for it to ship in v1.0.

**Client.** `core::smtp` is a pure state machine, and `transport/smtp.rs` drives it over the `platform`
crate's TCP socket (which wraps the workers-rs `Socket`) with the credentials opened from `domains.smtp_sealed`. Every connection applies the
[SSRF rules](security.md#9-ssrf-controls) to the relay's host. Port 465 uses TLS from the start; port 587
is opened with `StartTls` and upgraded once, after the server advertises `STARTTLS`. Credentials are never
sent without TLS. There is one connection per message and no pipelining: `EHLO`, (`STARTTLS`, `EHLO`),
`AUTH PLAIN` (or `AUTH LOGIN`), `MAIL FROM` (with `SIZE=` when advertised), one `RCPT TO` per `queued`
delivery, `DATA`, the dot-stuffed stored `.eml`, the final `.`, `QUIT`.

**Outcomes** (also rows of [Transport outcome classification](#transport-outcome-classification)):

| Point in the exchange | Result |
|---|---|
| Any failure before the final `.` is written: connect, greeting, `EHLO`, TLS, `4xx` to `AUTH` or `MAIL FROM`, a dropped connection | `RetryLater` (`Relay`). Nothing was sent |
| Port 587 and no `STARTTLS` advertised | `Rejected` (`sender_domain_unavailable`), domain issue `smtp_tls_required` ([N16](../edge-cases.md)) |
| `535` (or another `5xx`) to `AUTH` | `Rejected` (`sender_domain_unavailable`), domain issue `smtp_auth_failed` ([N14](../edge-cases.md)) |
| `5xx` to `MAIL FROM` | `Rejected` (`provider_validation`) |
| `5xx` to a `RCPT TO` | That delivery is `rejected` with the reply (`refused`); the others continue ([N20](../edge-cases.md)). Every recipient `5xx`: `Rejected` |
| `4xx` to a `RCPT TO` | That delivery stays `queued`; the others continue to `DATA` ([N20](../edge-cases.md)). After the `250` to the final `.`, the result is `Accepted` with that recipient in `deferred`: the message stays `queued`, goes back to `pm-outbound` with the `Relay` back-off, and the next attempt sends, with the same `Message-ID`, only to deliveries still `queued`, so no recipient gets it twice. The `sends` hold is settled for the recipients sent and kept for the deferred ones. Every recipient `4xx`: no `DATA`, `RSET`, `QUIT`, `RetryLater` (`Relay`) |
| `250` to the final `.` | `Accepted`: `provider_message_id = "smtp:{host}:{Message-ID}"`, `rfc_message_id` = the composed `Message-ID` |
| `4xx` / `5xx` to the final `.` | `RetryLater` (`Relay`) / `Rejected` (`provider_validation`) |
| After the final `.` is written: the connection drops, or no reply within 60 s | `Unknown`, so the message is `uncertain` and **never resent** ([N15](../edge-cases.md)) |

**Timeouts.** 10 seconds to connect, 30 seconds per command, 60 seconds for the reply to the final `.`.
The whole exchange also has a 4-minute deadline, so it ends inside the 5-minute transport claim
([The outbound consumer](#the-outbound-consumer)). Reaching it before the final `.` is written is
`RetryLater`; after it, `Unknown` (`transport_timeout`).

**Parallelism.** A Worker invocation can have at most six connections waiting for response headers at
once, and an outbound socket counts while it connects
([limits](https://developers.cloudflare.com/workers/platform/limits/), read 2026-10-09). The
`pm-outbound` consumer therefore runs at most four SMTP sends in parallel per invocation; the other
messages of the batch wait for a free slot.

**Status after `250`.** A relay does not report deliveries back. The message and the deliveries the relay
accepted are `submitted`, and stay `submitted` unless a bounce arrives. The return path is the `From` address, so a
remote server's RFC 3464 DSN comes back to the identity through forwarding or SES.
[Inbound › DSN routing](inbound.md#dsn-routing-and-backscatter) matches it to the message by the DSN's
original `Message-ID` against `rfc_message_id`, and applies a `bounced` event (`hard` for `5.x.x`, with a
suppression; `soft` for `4.x.x`) ([N19](../edge-cases.md)). No complaints arrive from a relay, so abuse
auto-pause sees only DSN bounces for these domains. A relay that rewrites `Message-ID` loses the DSN match
and the header-ID threading match of [C7](../edge-cases.md); whether a provider keeps it is checked per
provider at build time.

**Probe gate** (FR-DOM-11, [N18](../edge-cases.md)). No mail goes through a relay before the domain's
first passing alignment probe
([§ 5.3](domain-connections.md#53-proving-alignment-the-probe)). Until then the domain is `verifying`, so
submit answers `409 domain_not_ready` (policy step 14). The probe repeats every day. Failing probes move
the domain to `failing` through the normal state machine, and sends then fall back to the platform
address ([From address and fallback](#from-address-and-fallback), FR-DOM-6), so the domain never sends
mail that fails DMARC. New credentials set with `PATCH /v1/domains/{domain_id}` (`smtp`) stay pending, and
sends keep the stored ones, until a probe with the new values passes. The probe goes through the same
client but is not a send: no message row, no `sends` hold and no daily-cap count.

## Simulator (L2)

Test tenants only (FR-OUT-12, [L2](../edge-cases.md)). The local part of a `@simulator.invalid`
recipient picks the script:

| Local part | Transport result | Events (sent to `pm-outbound` with a delay) |
|---|---|---|
| `delivered` | Accepted | `delivered` after 1 s |
| `bounce` | Accepted | `bounced` (hard, `550 5.1.1`) after 1 s; creates a suppression |
| `softbounce` | Accepted | `deferred` (`451 4.2.0`) after 1 s, then `bounced` (soft) after 3 s |
| `complaint` | Accepted | `delivered` after 1 s, then `complained` after 3 s |
| `deferred` | Accepted | `deferred` (`451 4.2.0`) after 1 s, nothing more |
| `reject` | Rejected (`provider_validation`, code `E_SIMULATED_REJECT`) | – |
| `timeout` | Unknown (`transport_timeout`) → `uncertain` ([G2](../edge-cases.md)) | none, ever (so `resolve` can be tested) |
| anything else | as `delivered` | as `delivered` |

With several simulator recipients: any `reject` → the whole message is rejected; else any `timeout` →
uncertain; else accepted with each recipient's events. Event IDs are `sim:{message_id}:{recipient}:{n}`.

## Loopback (L3, G11)

For a test tenant, each recipient that resolves (`active` or `retiring`) to an identity on this
deployment is delivered by injection ([L3](../edge-cases.md)):

1. Allocate an inbound `msg_` ID for the recipient's mailbox and copy the composed MIME (with its own
   `Message-ID`) to that mailbox's raw key.
2. Send an `InboundPointer` with `loopback = { tenant_id, identity_id, message_id }` of the sender
   ([Inbound › Test-mode loopback](inbound.md#test-mode-loopback-l3)).
3. Queue a `delivered` `TransportEvent` for the recipient.

The sender's `rfc_message_id` is the composed one. Live tenants never use loopback: mail to an address
on the same deployment leaves through the transport and returns through Email Routing like any other
mail ([G11](../edge-cases.md)).

## TenantQuota

```rust
pub enum QuotaRequest {
    Init { tenant_id: String },                      // tenant created (POST /v1/tenants, setup's default
                                                     // tenant): stores the owner in meta; the only request
                                                     // an object without an owner accepts
    Reserve { identity_id: String, day: String, identity_cap: u32, tenant_cap: Option<u32>,
              hold: Option<SendsHold> },             // policy step 18: the sends hold, checked first;
                                                     // tenant_cap None = the system identity (is_system = 1):
                                                     // the tenant `sends` counter is neither checked nor
                                                     // incremented
    Release { identity_id: String, day: String, tenant_counted: bool },
                                                     // undoes a Reserve; tenant_counted is false exactly when
                                                     // that Reserve had tenant_cap None
    RecordOutcome { identity_id: String, domain_id: String, outcome: Outcome, at: i64 },
                                                     // the identity's abuse windows (outcomes rows), the
                                                     // tenant's per-day outcome counters and the per-domain
                                                     // hourly counters → { pause, domain_alert, suspend }
    OutcomeRates { since: i64 },                     // the daily ramp evaluation (Cloud sign-up § 10.1): sums
                                                     // the tenant's outcome counters over the UTC days from
                                                     // since's day → { outcomes, bounced, complained }
    CountAgentic { day: String, cap: u32 },          // Search § 2 step 3: increments `agentic` for `day`
                                                     // (tenant time zone) and `usage:agentic`
                                                     // → Ok { used } | CapReached { resets_at }
                                                     //   → 429 agentic_budget_exhausted
    RecordUsage { metric: UsageMetric, n: u64 },     // adds n to usage:{metric} for the current UTC day
    ForgetIdentity { identity_id: String },          // identity erasure (Privacy § 6.4): deletes the
                                                     // identity's outcomes and sends:{identity_id} counters
    // Allowances (declared with their payload types here by M5; behaviour in billing/quota.rs, M22;
    // Plans, metering and billing):
    Hold   { feature: Feature, units: u32, r#ref: String, gates: Vec<Feature> },
    Settle { feature: Feature, r#ref: String, consume: u32, keep: u32 },
           // consume + keep ≤ held units; keep stays held for a deferred retry (SMTP 4xx recipients);
           // the rest is released
    Extend { feature: Feature, r#ref: String, until: i64 },     // a send waiting in transport back-off
    // … and Adjust, SetPlan, SetMeasured, Reconcile, GetUsage, used by billing only
}
pub enum UsageMetric { Inbound, Outbound, Search, AiNeurons, Assertions, HttpSignatures }
pub struct SendsHold { pub units: u32, pub r#ref: String, pub gates: Vec<Feature> }  // ref = msg_ ID
// Reserve → Ok { identity_used, tenant_used, warnings: Vec<QuotaWarning>, held: Option<Held> }
//         | Denied { feature, granted, used, resets_at, first_in_period }   → 402 billing_limit
//         | CapReached { scope: "identity" | "tenant", resets_at: i64 }      → 429 daily_cap_reached
```

`Reserve` runs in one transaction. With `hold`, it first takes the `sends` hold exactly as `Hold` does
([Plans, metering and billing › Hold](billing.md#hold)); a denial returns `Denied` and writes nothing
(the caller emits `billing.limit_reached` when `first_in_period`). It then increments `counters` rows
`sends:{identity_id}` and `sends` for `day` (YYYY-MM-DD in the tenant's time zone) when both stay within
their caps; otherwise it returns `CapReached` and keeps no hold either. With `tenant_cap: None`, which the
mailbox passes only for the system identity (`is_system = 1`), the tenant `sends` row is neither checked
nor incremented: only `sends:{identity_id}` is counted against `identity_cap`, the answer's `tenant_used`
is the row's unchanged value, and no tenant warning is returned. The matching `Release` carries
`tenant_counted: false` and decrements only `sends:{identity_id}`, so the system identity's mail never
moves the tenant's count. `resets_at` is the next local
midnight in UTC. A warning is returned the first time a counter reaches 80% and 100% of its cap that day
(tracked with `counters` rows `warned:{metric}:{80|100}`), and the mailbox emits `quota.warning`. The
`sends` hold is settled at the transport outcome, extended for each back-off, released on cancel and when
the thread lock fails ([The outbound consumer](#the-outbound-consumer)); the full rules are in
[Plans, metering and billing › What the Worker meters](billing.md#what-the-worker-meters).

**Day boundaries.** Two different days are counted, and both are stated here once:

| Counter | Day | Why |
|---|---|---|
| Daily caps: `sends`, `sends:{identity_id}` (and their `warned:` rows), `agentic` (no warnings) | The tenant's time zone (`tenants.timezone`, IANA, default `UTC`); `resets_at` is the next local midnight | A cap is a promise to the tenant about its own day |
| Usage: `usage:{metric}`, flushed to D1 `usage_daily` | UTC (`usage_daily.day` is a UTC date) | One day boundary for every tenant, so deployment-wide sums (`provider_quota_80`) add up |

**Usage counters.** `TenantQuota` counts usage per UTC day in `counters` rows `usage:{metric}`, and the
hourly usage roll-up ([Plans, metering and billing › Storage](billing.md#storage)) writes today's and
yesterday's values to `usage_daily` (`INSERT … ON CONFLICT (tenant_id, day, metric) DO UPDATE SET value =
excluded.value`), then deletes `usage:*` rows older than two days. Writers:

| Metric | Written by | When |
|---|---|---|
| `inbound` | `RecordUsage { Inbound, 1 }` from the `pm-inbound` consumer ([Inbound](inbound.md)) | A message is committed (once per message and identity) |
| `outbound` | `RecordUsage { Outbound, 1 }` from `RecordTransportOutcome` | A transport accepted the message (once per message) |
| `sends` | The object itself, inside `Settle` | `Settle { feature: Sends }` consumes units: recipients accepted by a transport |
| `triage` | The object itself, inside `Settle` | `Settle { feature: Triage }` consumes a unit: an analysis was stored |
| `search` | `RecordUsage { Search, 1 }` from the search handler ([Search § 2](search.md#2-request-handling), step 10) | A keyword, semantic or hybrid search returned |
| `agentic` | `CountAgentic` | An agentic search was admitted |
| `ai_neurons` | `RecordUsage { AiNeurons, n }` from the triage job and the agentic planner | After each model call that reports neurons ([Triage](triage.md)) |
| `assertions` | `RecordUsage { Assertions, 1 }` from the assertion service behind `POST /v1/identities/{identity_id}/assertions` and `mail_sign_assertion` ([Agent signing keys](agent-keys.md)) | A token was signed and returned (once per token) |
| `http_signatures` | `RecordUsage { HttpSignatures, 1 }` from the signing service behind `POST /v1/identities/{identity_id}/http-signatures` and `mail_sign_http_request` | A request was signed and returned (once per signature) |
| `storage_bytes` | `SetMeasured`, by the roll-up itself | Hourly |

The provider's own daily quota is per Cloudflare account and is not visible to the Worker
([G3](../edge-cases.md)). The deployer can copy it into `PM_DAILY_SEND_QUOTA`: the state-alert evaluator
then fires `provider_quota_80` when today's (UTC) accepted recipients across live tenants reach 80% of it
([Observability › Alert list](observability.md#53-alert-list)). Without the variable there is no 80%
signal, and the first `E_DAILY_LIMIT_EXCEEDED` fires the `provider_quota` alert instead. Neither is a
tenant event: the quota belongs to the deployment.

## Sequence: a timeout, then reconciliation

```text
Agent        API handler      IdentityMailbox     pm-outbound consumer   Cloudflare EMAIL     pm-delivery-events
  │ POST …/messages (Idempotency-Key: bk-2291-confirm)
  │─────────────▶│ Submit ───────────▶│ policy, compose, R2 out/{msg}.eml, quota, lock
  │              │                    │ TXN: message queued, deliveries, idempotency
  │◀── 202 queued ◀───────────────────│ ── pointer ──▶│
  │              │                    │◀ BeginTransport│ claim:{msg}
  │              │                    │               │ send() ─────────────▶│
  │              │                    │               │   … 30 s, no answer …│ (accepted, delivering)
  │              │                    │◀ RecordTransportOutcome(Unknown: timeout)
  │              │                    │ TXN: uncertain, lock released, message.uncertain
  │ retry POST (same key, same body)  │               │                      │
  │─────────────▶│ Submit ───────────▶│ idempotency hit → stored 202, deduplicated: true
  │◀── 202 (deduplicated) ◀───────────│   (no second send)                   │
  │              │                    │               │                      │ delivered event
  │              │                    │◀──────────────── ApplyDeliveryEvent ◀─────────────────────│
  │              │                    │ no provider-ID match → one uncertain candidate:
  │              │                    │ same sender, recipient, subject, within 30 min
  │              │                    │ TXN: provider_message_id set, flag reconciled,
  │              │                    │      delivery delivered, roll-up delivered,
  │              │                    │      message.reconciled + message.delivered
  │◀════════════ webhooks: message.uncertain, message.reconciled {status: delivered}, message.delivered
```

## Tests

| Test | Covers |
|---|---|
| `it::send::g1_same_key_same_body` / `g1_same_key_different_body` / `g1_in_flight` | Replay with `deduplicated: true` and `Idempotent-Replayed`; `409 idempotency_conflict`; `409 request_in_progress` ([G1](../edge-cases.md), FR-OUT-1) |
| `core::policy::fingerprint_canonical` | Key order and whitespace do not change the fingerprint; any value change does |
| `it::send::cancel_queued` | Cancel while `queued` and unclaimed → `canceled`, `message.canceled`, the `sends` hold and the day's reservation released, and the later queue message acks without sending; with an active claim, after transport, or with any delivery already `submitted` → `409 not_cancelable` (FR-OUT-11) |
| `it::send::a7_paused_refuses_send` | `identity_paused` ([A7](../edge-cases.md)) |
| `it::send::suspended_tenant_refuses_send` | After `PATCH /v1/tenants/{id}` with `status: suspended`, a send from any of its identities (all now paused with `tenant_suspended`) gets `403 tenant_suspended`, not `409 identity_paused` (FR-TEN-3, FR-OUT-3: the policy order) |
| `it::send::a8_owner_required` | `identity_owner_required` ([A8](../edge-cases.md)) |
| `it::send::a10_reply_all_excludes_bcc` | Reply-all never includes BCC recipients or own addresses ([A10](../edge-cases.md)) |
| `core::reply::d3_reply_target` | Reply-To used only for known senders, same organisational domain or known contacts ([D3](../edge-cases.md)) |
| `it::send::d6_exchange_cap` | The third consecutive auto-reply in a thread is refused ([D6](../edge-cases.md), FR-OUT-7) |
| `it::send::e2_require_known_recipient` | Unknown recipients become `suppressed` deliveries ([E2](../edge-cases.md)) |
| `it::lists::entries_crud` | `PUT`, `GET`, list and `DELETE` on `/v1/tenants/{tenant_id}/lists/{direction}/{kind}/{entry}` for both directions and kinds, an address and an `@domain` entry; entries are stored lower case with an A-label domain; `PUT` again updates only `note`; a key without `suppressions:manage` (every identity key, which can never hold it) gets `403 permission_denied`; another tenant's key gets `404 tenant_not_found` (build plan M9) |
| `it::send::list_filters` | A send-block entry, and `policy.send_allowlist_only` without a send-allow entry, make that recipient's delivery `suppressed` with `policy: send_block` or `policy: not_on_allowlist`; a send-allow entry for the address or its `@domain` lets it through; a dry run reports the rule (build plan M9, FR-OUT-4) |
| `it::send::e3_caps` | `max_recipients`, identity and tenant daily caps ([E3](../edge-cases.md)) |
| `it::send::e8_disclosure_footer` | Footer and header modes ([E8](../edge-cases.md)) |
| `it::send::c4_thread_lock` | Concurrent replies: the second waits, then `thread_busy` after 10 s ([C4](../edge-cases.md), FR-OUT-9) |
| `it::send::c6_forward_keeps_refs` | Forward with transfer note and `References` ([C6](../edge-cases.md)) |
| `it::thread::c7_reply_to_cloudflare_message_id` | Learned header ID (strategy A or B) matches a reply ([C7](../edge-cases.md)) |
| `it::send::g2_timeout_uncertain` | Simulator `timeout@` → `uncertain`, never resent; resolve both ways ([G2](../edge-cases.md), FR-OUT-2) |
| `it::send::g3_quota_backoff` | `E_DAILY_LIMIT_EXCEEDED` and `E_RATE_LIMIT_EXCEEDED` each back off by re-enqueuing (never `retry()`, so `max_retries` is never reached) and end `failed: quota_exhausted` after 24 h of test time ([G3](../edge-cases.md)) |
| `it::send::g4_partial_suppression` | Our suppression filtered; provider suppression synced and the rest resent ([G4](../edge-cases.md), FR-OUT-4) |
| `it::send::g5_large_attachment` | `413 message_too_large`; signed links with `large_attachments: link` ([G5](../edge-cases.md), FR-OUT-10) |
| `it::delivery::g6_hard_soft_complaint_late` | Hard bounce suppresses; soft bounce does not; complaint suppresses permanently; late bounce after delivered ([G6](../edge-cases.md), FR-DLV-1, FR-DLV-2) |
| `it::send::g7_domain_states` | Retiring only on threads using it; pending `domain_not_ready`; failing falls back or fails ([G7](../edge-cases.md), FR-DOM-6) |
| `it::delivery::g8_race` | An event before the provider ID is stored is retried every 30 s, then orphaned ([G8](../edge-cases.md)) |
| `it::send::g9_marketing_requirements` | Marketing needs `unsubscribe` and `consent`; headers and visible link added; from a `cloudflare`-transport domain (the platform domain included) it is refused with `422 transport_unavailable` (`marketing_needs_ses`) by step 15, with the address resolved at step 13; a marketing message accepted on an `ses` domain whose transport is changed to `cloudflare` before transport, or whose domain fails so that fallback would use the platform domain, ends `rejected` with `marketing_needs_ses` at `BeginTransport` and is never sent ([G9](../edge-cases.md), FR-OUT-8) |
| `it::send::notification_list_unsubscribe` | A `usage`, `new_mail`, `needs_person` or `digest` notification from the system identity is `transactional` and carries `List-Unsubscribe` and `List-Unsubscribe-Post` (the `digest` token names the kind `digest`, and its one-click `POST` sets `usage`, `new_mail` and `needs_person` to `off`); an `account` notification carries neither; a REST send naming either header gets `400 header_not_allowed`; `list_unsubscribe` on any other identity is refused |
| `it::send::header_rules` | `X-Booking-Ref`, `x-booking-ref` and the six allowed names pass in any case (`importance: high` is sent as `Importance: high`); `X-Bad Name`, `X-`, `Importance ` and the reserved `x-pylota-trace` and `x-ai-generated` get `400 header_not_allowed`; `Importance: urgent`, `priority: high` and `Sensitivity: secret` get `400 invalid_request` with the header's path, and so do `Importance` and `importance` in one request; nothing is stored, so no send ends `rejected` for a header |
| `it::send::idempotency_key_pattern` | An empty key, a 256-byte key and a key with a byte outside 0x20–0x7E get `400 invalid_idempotency_key`; a 255-byte key with spaces is accepted |
| `it::notify::bounce_pauses_prefs` ([Notifications §10](notifications.md#10-tests)) | A hard bounce on a notification suppresses the address on the default tenant and pauses every preference of the person ([O17](../edge-cases.md)) |
| `it::send::g10_provider_validation` | Every validation code in the table → `rejected: provider_validation`, never retried ([G10](../edge-cases.md)) |
| `it::send::g11_loopback` | Live tenant to a local address goes through the transport; test tenant through loopback ([G11](../edge-cases.md)) |
| `it::delivery::uncertain_reconciled` | A later event reconciles an uncertain send and emits `message.reconciled` (FR-DLV-4) |
| `it::delivery::abuse_auto_pause` | Four complaints in a 1,000 window or eleven bounces in a 200 window pause the identity once (FR-DLV-3) |
| `it::send::system_identity_exemptions` | With the default tenant's `tenant_daily_send_cap` set to 2 and the system identity's `send_policy.daily_cap` to 4 (platform key), the system identity's third and fourth sends are accepted and the fifth gets `429 daily_cap_reached`; the system identity's sends neither are checked against nor increment the tenant `sends` counter (its `Reserve` passes `tenant_cap: None`, and a cancelled send's `Release` leaves the tenant count unchanged), so another identity of the default tenant is still held to the tenant cap of 2 after them; eleven bounces in the system identity's 200 window are recorded but never pause it |
| `it::send::k3_failure_reason` | `message.failed` / `message.rejected` carry the reason and detail ([K3](../edge-cases.md)) |
| `it::testmode::l1_refuse_external` | `test_mode_recipient` ([L1](../edge-cases.md), FR-TEN-2) |
| `it::testmode::l2_simulator_matrix` | Every simulator script ([L2](../edge-cases.md)) |
| `core::ses::sigv4_vectors`, `core::sns::verify_v2_vectors`, `it::ses::sns_tampered_rejected` | S8: SigV4 and SNS verification; `SignatureVersion` 1, a wrong host or topic and a stale timestamp are refused on `/hooks/ses` |
| `it::send::sends_hold_with_daily_cap` | Step 18 takes the `sends` hold and the daily reserve together; a `402` keeps neither; a lock failure releases both; a back-off extends the hold; the transport outcome settles it (FR-BILL-4, FR-BILL-5) |
| `core::smtp::state_machine` | Every row of the SMTP outcome table: no `STARTTLS` → refused before `AUTH`, `535` → `sender_domain_unavailable`, `5xx` on one `RCPT` → that delivery `rejected`, `4xx` on some `RCPT`s → `DATA` still sent to the others and `Accepted` with those recipients in `deferred` (the message stays `queued`), `4xx` on every `RCPT` → no `DATA` and a retry ([N14](../edge-cases.md), [N16](../edge-cases.md), [N20](../edge-cases.md)) |
| `it::smtp::paused_partial_send_backoff` | An SMTP send with one recipient deferred and one `submitted`, whose identity is then paused: the consumer's `Cancel` answers `NotCancelable`, the message is re-enqueued with the `Paused` back-off (not canceled), the deferred recipient is sent once the identity is resumed within 24 hours, and ends `failed` (`quota_exhausted`) otherwise |
| `it::smtp::uncertain_after_final_dot` | Connection dropped after the final `.` → `uncertain`, never resent ([N15](../edge-cases.md)) |
| `it::smtp::probe_unaligned_falls_back` | Failing probes → `failing` → the next send uses the platform address; no relay send before the first passing probe ([N18](../edge-cases.md), FR-DOM-6) |
| `it::smtp::parallel_cap` | A batch of 10 SMTP sends never has more than four sockets open at once |
| `live::transport::j5_ses_failover` | Switching a pre-verified domain's transport to SES ([J5](../edge-cases.md)) |
