# Design

The design documents are **binding**. A coding agent implements what they say. When the code and a
design disagree, the design wins until an [ADR](../adr/index.md) changes it (see `AGENTS.md`). When two
pages disagree with each other, [Precedence](#precedence) below decides which one wins. Each
document cites requirement IDs from the [PRD](../prd.md) and rows from the
[edge-case register](../edge-cases.md), and ends with a **Tests** section that maps them to named tests.

The public contracts live in the reference section and are not repeated here:
[REST API](../../reference/api.md), [Errors](../../reference/errors.md),
[Webhook events](../../reference/events.md), [Configuration](../../reference/configuration.md) and
[Limits](../../reference/limits.md). The storage schema is in [Data model](data-model.md).

## Precedence

When two pages disagree, one rule decides which wins:

| Kind of behaviour | Examples | Wins | Must match it |
|---|---|---|---|
| **Wire behaviour**: what a client sends and receives | Paths and methods, status codes, error codes, request and response fields, enums, defaults and bounds, required permissions and key levels | [`openapi.yaml`](../../reference/openapi.yaml) | The design pages and the other reference pages ([REST API](../../reference/api.md), [Errors](../../reference/errors.md), [MCP](../../reference/mcp.md), the guides) |
| **Internal behaviour**: what happens inside the service | Storage, state machines, algorithms, retry schedules, Durable Object requests, queue messages, logs and metrics | The design page that owns the area | The other design pages, the guides and the reference prose |

Agents follow it as a rule: **for wire behaviour, `openapi.yaml` wins and the design must match; for
internal behaviour, the design page wins.** A disagreement is a documentation bug, never a choice for the
implementer: fix the losing page in the same pull request, and write an ADR only when the winning page is
itself wrong ([Decision records](../adr/index.md#when-to-write-one)).

## Index

| Document | What it decides |
|---|---|
| [Rust workspace and platform](rust-workspace.md) | The Cargo workspace, crate boundaries and allowed dependencies, exact dependency pins, the release profile, wasm32 constraints, the `platform` trait set (clock, randomness, D1, Durable Objects, R2, Queues, Workers AI, Vectorize, email, rate limits, DNS-over-HTTPS, HTTP), the `wasm-bindgen` externs that fill `workers-rs` gaps, the generated `wrangler.toml`, the `xtask` commands, the CI pipeline and the Rust SDK (FR-SDK-1). |
| [Data model](data-model.md) | Every D1 table, every Durable Object SQLite table, R2 keys and the Vectorize index. It is the source of truth for migrations. The other designs refer to its tables and columns by name. |
| [Inbound pipeline](inbound.md) | The `email()` handler (normalisation, directory lookup, reject codes, the R2 write before acknowledgement), the `pm-inbound` consumer (MIME parsing under caps, sanitising, text derivation, quote and signature stripping, hidden-text removal, reference extraction, automation classification, the authentication verdict, spam score, quarantine), the `IdentityMailbox.ingest` transaction, attachment safety and text extraction, DSN routing, re-parsing and test-mode loopback. |
| [Outbound and safe retries](outbound.md) | The send path from request to transport: the idempotency fingerprint and reservation, the ordered policy pipeline with its error codes, message composition (From, Reply-To with thread token, threading headers, signature and disclosure, marketing headers, attachments), the thread lock, the `MailTransport` trait and its implementations, the classification of every transport outcome, delivery events and status roll-up, suppressions, abuse auto-pause, uncertain-send reconciliation, cancel and resolve, SES specifics and the outbound Message-ID strategy. |
| [Threading](threading.md) | The thread token's exact byte layout and verification, key rotation, the thread resolution order, Message-ID normalisation, subject normalisation, forwarded messages, participants, and which address a reply is sent from (including fallback-pinned threads). |
| [Identities, addresses and domains](identity-domains.md) | The identity and address state machines (promote, retire, rollback, retirement, tombstones), username validation with reserved and confusable detection, domain kinds and their onboarding against the Cloudflare and SES APIs, the `DomainMonitor` health state machine, fallback, domain removal, and the Cloudflare API token permissions. |
| [Domains on any DNS host](domain-connections.md) | The six connection methods and the `kind`, `inbound` and `transport` each one fixes; SES in both directions for domains at any DNS host (deployment set-up, the SNS push plus SQS backstop with the `ses_ingest` ledger, retired and unknown recipients); `send_only` forwarding; `smtp_relay` with its alignment probe; zone creation for dedicated domains; delegated subdomains; health checks per method, cost, and spikes S10–S12. |
| [Agent signing keys and signed requests](agent-keys.md) | Per-identity Ed25519 keys (generation, sealing, rotation with overlap, revocation, tombstones), agent assertions (JWT) and the per-identity JWKS, signed HTTP requests (Web Bot Auth, RFC 9421) with the deployment key and its signed key directory, the kill switch on pause and suspension, and spike S13. |
| [Search](search.md) | The query language and its typed parse tree, keyword search (FTS5, references, trigram fallback), semantic search (chunking, embeddings, Vectorize), hybrid fusion and reranking, agentic search with deterministic citation verification, facets, cursors, tenant fan-out and the index lifecycle. |
| [Triage](triage.md) | Deterministic rules, the model call with fenced untrusted content, output schema validation, categories and risk flags, the thread roll-up and re-runs. |
| [Webhooks and events](webhooks.md) | The transactional outbox and its dispatch alarm, the event envelope and payload builders, endpoint resolution, Standard Webhooks signing and secret storage, the SSRF-guarded HTTP client, the retry schedule, delivery logs, dead letters, auto-disable and replay. |
| [MCP server](mcp.md) | The Streamable HTTP endpoint at `/mcp`, authentication, tool definitions and their mapping to REST, permission filtering and the `mail_search_strategy` prompt. |
| [CLI and setup](cli.md) | The `pmail` command tree, `setup` and `deploy` (resource creation, bundle verification, `wrangler.toml` rendering), `doctor`, profiles and output formats. |
| [Security](security.md) | The threat model, key handling (the four key levels, partner keys included), tenant and partner isolation, secrets and their single purposes, SSRF and content-safety rules, and the attack test suite. |
| [Privacy and erasure](privacy.md) | Jurisdiction, retention sweeps, erasure jobs per scope with receipts and probes, legal holds and subject-access export. |
| [Console and workspaces](console.md) | The server-rendered console at `/console`: passwordless sign-in, sessions and CSRF, workspaces, members, roles and invitations, and the console's pages. |
| [Cloud sign-up, sign-in and first run](cloud-signup.md) | Hostnames for Pylota Mail Cloud, `PM_SIGNUP` and the waitlist, Google and GitHub sign-in, TOTP two-step verification and recovery codes, where people land after sign-in, the Overview and its first-run checklist, the Checkout return, and Cloud abuse controls. |
| [Workspace policy](workspace-policy.md) | Who may write a tenant's policy and how: the four writers, the field classes with platform and partner ceilings, the guard fields and the decisions reserved for people, the compare-and-set write with its audit row and `tenant.policy_updated` event, `GET` and `PATCH /v1/tenants/{tenant_id}/policy`, and the console's policy page (FR-TEN-4). |
| [Service sign-up ledger](service-accounts.md) | The per-identity ledger of third-party accounts: requests, approval as a decision reserved for people, close and delete, the match rule that ties a verification email to an approved entry, quarantine rule 4a and the `wait` check, events, retention and erasure, and the console's accounts page (FR-IDN-10). |
| [Plans, metering and billing](billing.md) | The plan catalog, allowances and atomic holds in `TenantQuota`, `402 billing_limit`, the usage API, and Stripe checkout, portal and webhooks. |
| [Notifications and usage alerts](notifications.md) | Email to the people behind the agents: usage alerts, new-mail notifications, the daily "needs a person" email and account emails; per-person preferences, the per-tenant `Notifier` Durable Object (coalescing, schedules, caps), one-click unsubscribe, and bounces. |
| [Observability and SLOs](observability.md) | Structured logs without content, metrics, alerts, SLOs, dead-letter handling through the platform API, and the runbooks. |
| [Testing](testing.md) | The test layers (`core::`, `conf::`, `it::`, `live::`), the conformance corpus, the workerd harness, fakes, fuzzing, quality gates and the cross-tenant attack suite. |

## Shared conventions

These rules apply to every design. A design may add to them but never contradict them.

### 1. Layering

```text
crates/api-types   types only (serde, utoipa). No I/O.                 depends on: serde, utoipa
crates/core        pure logic. No I/O, no clock, no randomness.         depends on: api-types + pure crates
crates/platform    traits + Cloudflare implementations + fakes.        the ONLY crate that imports `worker`
crates/worker      handlers, Durable Objects, consumers, transports.   depends on: core, api-types, platform
```

- **`core`** functions take everything they need as arguments: the current time as `now_ms: i64`,
  random bytes as `[u8; N]`, lookups as traits implemented by the caller (for example
  `ThreadLookup` in [Threading](threading.md#31-order-fr-thr-1)). They return decisions and data, never
  perform effects. `core` builds for the host and for `wasm32-unknown-unknown`.
- **`platform`** wraps every Cloudflare API behind a trait. Native tests use the in-memory fakes in
  `platform::fakes`. No other crate names a `worker::` type, enforced by `cargo xtask check-layering`.
- **`worker`** orchestrates: it reads, calls `core` to decide, writes, and schedules follow-up work.
  Business rules that can be expressed without I/O live in `core`, so they are unit-tested natively.

### 2. Errors and the error envelope

Every failure that reaches a client is an `ApiError`, serialised as the
[error envelope](../../reference/errors.md):

```rust
// crates/api-types/src/errors.rs
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode { Unauthenticated, KeyExpired, KeyRevoked, PermissionDenied, ScopeDenied, /* …one
    variant per code in errors.md… */ InternalError, UpstreamError, Unavailable, SearchDegraded, Timeout }

impl ErrorCode {
    pub const fn http_status(self) -> u16;     // from the errors.md tables
    pub const fn retryable(self) -> bool;      // from the errors.md tables, never decided at call sites
    pub const fn default_fix(self) -> &'static str;
}

pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,                       // human text; never contains message content or addresses
    pub fix: Option<String>,                   // overrides default_fix when more specific
    pub details: Option<serde_json::Value>,
}
```

- `core` returns domain errors (`AddressError`, `PolicyError`, `QueryError`, …). Each has one
  `impl From<…> for ApiError` next to the error type in `core`, so a rule and its error code are defined
  together. The impls live in `core` because `core` depends on `api-types` and `api-types` depends on
  nothing of ours: `api-types` cannot name a `core` type.
- `platform` returns `PlatformError { kind, binding, detail }`. `detail` is a short machine string and
  never contains content or clear-text addresses. The worker maps it:

  | `PlatformErrorKind` | `ErrorCode` |
  |---|---|
  | `Unavailable` (D1 or a Durable Object overloaded, a binding refusing) | `unavailable` (503, retryable) |
  | `Timeout` (an internal deadline) | `timeout` (504, retryable) |
  | `Upstream` (a Cloudflare or SES REST API returned an unexpected status during a synchronous call) | `upstream_error` (502, retryable) |
  | `NotFound` for an object the caller named | the resource's own `*_not_found` code |
  | `NotFound` for an internal object, `Corrupt`, `Internal` | `internal_error` (500, retryable), logged with `request_id` |

- Errors after a send was accepted are never HTTP errors. They become message statuses and `reason`
  codes ([Errors › Send failures after 202](../../reference/errors.md#send-failures-after-202)).
- A `404` returned by the service always carries one of its own codes. Resources outside the key's scope
  return the same `*_not_found` as missing ones (NFR-SEC-1).

### 3. Time, randomness and IDs

- **Clock.** All time comes from `platform::Clock::now_ms()` (Unix milliseconds, `i64`), implemented
  with `Date.now()`. In Workers, `Date.now()` advances only across I/O, so two reads in one
  synchronous block return the same value; designs rely on that only for "same transaction, same
  timestamp". `std::time::SystemTime::now()` is never called in wasm code.
- **Randomness.** All randomness comes from `platform::Rng` (`crypto.getRandomValues`). `core` takes
  random bytes as arguments.
- **IDs** are `{prefix}_{ULID}` ([Data model › Conventions](data-model.md#conventions)), generated only
  by `platform::Ids::new_id(prefix)`. The generator is monotonic within an isolate: if the clock has not
  advanced past the last ID's millisecond, it reuses that millisecond and increments the 80-bit random
  part by one (moving to the next millisecond on overflow). The `req_` request ID is generated at the
  start of every `fetch`, `email`, `queue`, `scheduled` and `alarm` invocation and carried through
  internal calls and logs.

### 4. Durable Object transactions

`workers-rs` 0.8.7 exposes `SqlStorage::exec` but not `transactionSync` (read 2026-10-09 from the
v0.8.7 source). Cloudflare documents `ctx.storage.transactionSync(callback)`, which rolls back if the
callback throws, and forbids `BEGIN`/`SAVEPOINT` inside `sql.exec()`
([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), read
2026-10-09). `platform` therefore provides `Sql::transaction_sync`, a `wasm-bindgen` call to
`ctx.storage.transactionSync` (see [Rust workspace](rust-workspace.md#7-wasm-bindgen-externs)). The rules:

1. **One write transaction per state change.** Every write path in a Durable Object runs inside one
   `transaction_sync` closure. The closure is synchronous: no `.await`, no subrequests.
2. **Decide before, re-check inside.** Reads used to decide may happen before the transaction (for
   example, while waiting on `TenantQuota`), but every precondition is re-checked inside it, because
   other requests can interleave at any `.await`.
3. **Effects after commit.** R2 writes, queue sends, D1 writes and calls to other Durable Objects never
   run inside a transaction. Those that must happen before the state change (an R2 object the row will
   point to) run before it; the rest run after commit and are either idempotent or repaired by an alarm.
4. **Outbox in the same transaction.** Every transaction that changes externally visible state appends
   its events to the object's `outbox` table inside the transaction (section 6).
5. **One alarm, many purposes.** An object has a single alarm. Each object keeps its pending wake-ups in
   `meta` under `alarm:{purpose}` (for example `alarm:outbox`, `alarm:check`, `alarm:claim`,
   `alarm:dispatch`, `alarm:maintenance`; [Data model](data-model.md) lists each object's keys). After each transaction it sets
   the alarm to the earliest pending wake-up if that is earlier than the current alarm. Every mailbox has
   a daily `alarm:maintenance` that deletes expired `idempotency` rows, `rate_windows` older than 48 hours,
   `verifications` past `expires_at` or 1 hour past `consumed_at`, `outbox` rows past the tenant's `events_days`, unpins quiet
   fallback threads ([Threading](threading.md#51-fallback-pinned-threads)), and refreshes the database size
   in `meta.size_bytes` ([Data model › Mailbox notes](data-model.md#mailbox-notes)). The alarm handler runs every due purpose, then re-arms. Handlers are
   idempotent, because Cloudflare delivers alarms at least once and retries a failed handler with
   exponential backoff from 2 seconds, up to six times
   ([Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), read 2026-10-09).
6. **Schema on wake.** Each object applies its migrations on first access in a transaction, guarded by
   `meta.schema_version` ([J9](../edge-cases.md)). Every statement of a migration is idempotent
   (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE VIRTUAL TABLE IF NOT EXISTS`, and
   `INSERT OR IGNORE` for seeded `meta` keys), so a migration that ran but whose `schema_version` write was
   lost runs again without an error.
7. **Limits.** Durable Object SQLite allows 100 bound parameters per statement, 100 KB statements and
   2 MB per row or value ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
   read 2026-10-09). Designs that store text cap it below those limits (see
   [Inbound › Storage caps](inbound.md#storage-caps)).

### 5. Internal Durable Object RPC

Durable Objects are called with a typed request enum over `fetch` to the stub. There is no other
entry point into an object.

```rust
// crates/worker/src/rpc.rs
#[derive(Serialize, Deserialize)]
pub struct RpcEnvelope<T> {
    pub v: u8,                         // 1
    pub tenant_id: Option<String>,     // None only for platform-level DomainMonitor and SesControl calls
    pub identity_id: Option<String>,   // required for IdentityMailbox
    pub request_id: String,            // req_…
    pub actor_key_id: Option<String>,  // for audit
    pub deadline_ms: i64,              // absolute; the object refuses work past it
    pub req: T,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum MailboxRequest {
    Init(InitMailbox),                       // identity created: stores the owner (from the envelope) in meta,
                                             // emits identity.created once (section 9)
    Ingest(IngestInput),                     // inbound.md
    Reparse(ReparseInput),                   // inbound.md, J3
    AttachmentTextReady(AttachmentText),     // inbound.md
    Submit(SubmitInput),                     // outbound.md
    BeginTransport(BeginTransport),          // outbound.md: claim before calling a transport
    RecordTransportOutcome(TransportOutcome),// outbound.md
    ApplyDeliveryEvent(DeliveryEvent),       // outbound.md
    Cancel(CancelInput), Resolve(ResolveInput),
    LearnMessageId(LearnMessageId),          // outbound.md: Message-ID strategy B (journal copy)
    RegisterWait(RegisterWait),              // inbound.md › The wait handler: E5 registration, every 10 s
    WaitPoll(WaitQuery),                     // inbound.md › The wait handler: one poll, every 1 s
    EmitEvent(EmitEvent),                    // identity.* events written after a D1 change
    GetEvents(GetEvents),                    // webhooks.md delivery and replay
    // Read, search, triage, label and erasure operations are added by their designs.
}
pub struct InitMailbox {
    pub created_at: i64,               // identities.created_at; written to meta.created_at
    pub created_event: EmitEvent,      // identity.created, built by the handler from the rows its D1 batch wrote
}
pub struct EmitEvent {
    pub event_id: String,              // evt_…, derived from the rpc_intents row (section 9), so a re-sent call
                                       // is absorbed by the outbox's ON CONFLICT (event_id) DO NOTHING
    pub event_type: String,            // identity.created | identity.updated | identity.paused | identity.resumed |
                                       // identity.key_created | identity.key_rotated | identity.key_revoked
    pub occurred_at: i64,              // the D1 change time, kept across retries
    pub data: serde_json::Value,       // built by webhooks/envelope.rs (the identity_* builders) from D1 rows;
                                       // thin, never message content
}
// The object appends the event to its outbox (webhooks.md › Appending) with Some(event_id), so the same
// event_id is stored once and its sequence is taken once.

// DomainRequest, JobRequest, QuotaRequest, SesControlRequest (domain-connections.md § 4.8) and
// NotifierRequest (notifications.md § 3) follow the same pattern, and each starts with an
// `Init` variant that stores the owner in the object's `meta` (QuotaRequest: outbound.md › TenantQuota).

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RpcResult<T> { Ok(T), Err(ApiErrorBody) }
```

- The caller addresses the object with `id_from_string(<stored DO id>)` (IDs are created with
  `unique_id_with_jurisdiction` and stored in D1, [ADR 0002](../adr/0002-storage.md)) and sends
  `POST https://do.internal/rpc` with the JSON envelope. A handled result, success or error, is HTTP 200
  with `RpcResult`. Any other status, or a thrown exception, is a platform failure (`unavailable`).
- **Tenant check.** The handler compares `tenant_id` and `identity_id` with the owner stored in
  `meta` (written by `Init`). A mismatch returns `internal_error`, logs the security event
  `rpc_owner_mismatch` with both IDs, and increments `rpc_owner_mismatch_total`, which alerts at 1. The
  public handler has already checked scope against D1 before calling, so a mismatch is always a bug.
- An object that has no owner yet accepts only `Init`. An object marked `erased = '1'` refuses
  everything with `identity_not_found`.
- The caller's default deadline is 10 seconds (`Ingest` and `Submit`: 30 seconds). The object checks
  `deadline_ms` before starting a transaction and returns `timeout` if it has passed.

### 6. Transactional outbox

Every object with an `outbox` table (`IdentityMailbox`, `DomainMonitor`, `JobRunner`) emits events the
same way, detailed in [Webhooks and events](webhooks.md#transactional-outbox):

1. Inside the state-change transaction: increment `meta.event_seq`, build the full envelope
   ([events](../../reference/events.md#envelope)) with `sequence = event_seq`, insert it into `outbox`
   with `dispatched_at = NULL`, and record `alarm:outbox = now`.
2. The alarm writes `event_index` rows to D1 (`INSERT OR IGNORE`), sends one `pm-webhooks` message per
   event, then sets `dispatched_at`.
3. A crash between steps repeats step 2. Consumers deduplicate on the event ID, so delivery is at least
   once and never lost.

### 7. Idempotent queue consumers

Every queue is at least once. Every consumer is written so that processing the same message twice has
the same effect as once:

| Queue | Message identity | How a repeat is absorbed |
|---|---|---|
| `pm-inbound` | `message_id` (allocated in `email()`) | `ingest` deduplicates on `raw_sha256` and returns the stored message; post-commit steps (R2 attachment writes, index jobs) are idempotent by key |
| `pm-outbound` | `message_id` | The transport claim (`BeginTransport`) admits one transport call per message; a repeat finds the message no longer `queued` and acks |
| `pm-delivery-events` | provider `eventId` | Stored in `deliveries.provider_event_ids_json`; a repeat is a no-op |
| `pm-webhooks` | `(endpoint_id, event_id, attempt)` | Unique index on `webhook_deliveries`; a repeat attempt number is skipped |
| `pm-index` | job kind + target + version | Each job checks the target's status (`chunks.status`, `attachments.text_status`, triage version) before working |

Rules for every consumer:

- Process messages one at a time within a batch, and `ack()` each one after its effect has committed.
- **Retry counting never uses `Message.attempts`.** `workers-rs` 0.8.7 does not expose it (its
  `Message` binding has only `id`, `timestamp`, `body`, `retry` and `ack`; read 2026-10-09 from the
  v0.8.7 source). A bounded retry schedule is implemented in one of two ways, named in each design:
  - **Re-enqueue:** the body carries `attempt: u32`. On a known transient failure the consumer sends a
    new message with `attempt + 1` and `delay_seconds` from the schedule (`MessageBuilder::delay_seconds`),
    then acks the current one. Used where the Worker has a producer binding for the queue.
  - **Age:** the consumer computes the age of the work from a timestamp it owns (a field in the body,
    a provider event timestamp, or a stored row) and calls `retry_with_options` with the schedule's delay
    until the age limit is reached.
- An unexpected error (a bug, a panic) is logged and the message is left to the queue's own retry
  (`retry()`), up to the queue's `max_retries`, then the dead-letter queue, whose consumer records and
  alerts ([J8](../edge-cases.md)).
- A queue handler that returns an error fails the whole batch (and `workers-rs` 0.8.7's own macros turn a
  returned `Err` into a panic). Handlers therefore ack or retry each message themselves and return
  `Ok(())`; the only deliberate error is the inbound temporary failure in
  [Inbound](inbound.md#the-email-handler), which the entry glue raises as a thrown exception
  ([Rust workspace](rust-workspace.md#2-crate-responsibilities-and-allowed-dependencies)).
- Queue bodies are JSON with `"v": 1` and a `"kind"` tag. They carry IDs and pointers only, never
  message bodies, attachment content or subjects (Queues allow 128 KB per message; designs stay under
  4 KB).
- Consumers never trust a pointer's scope blindly: they re-read the tenant and identity rows from D1
  and check status before writing.

### 8. Logging

Logs never contain message bodies, subjects, attachment content or clear-text addresses (FR-PRV-6).
Addresses that must be correlated are logged as `HMAC-SHA256(PM_HASH_KEY, address)` truncated to 16 hex
characters. See [Observability](observability.md).

### 9. Durable Object calls after a D1 change

Some Durable Object calls must follow a D1 change, and a call made after the commit can fail: the Worker
can die, or the object can be overloaded. Without a record the object would stay without an owner (a
`TenantQuota` or a mailbox whose `Init` was lost accepts nothing else), or an identity event would be lost.
Each such call is therefore written down first, in the D1 table `rpc_intents`
([Data model](data-model.md#1-d1-control-plane)), in the **same D1 batch** as the change:

| Change (handler) | Intent | Call |
|---|---|---|
| Tenant created (`handlers/tenants.rs`, M5) | `quota` · `init` | `QuotaRequest::Init { tenant_id }` |
| Identity created (`handlers/identities.rs`, M6) | `mailbox` · `init` | `MailboxRequest::Init(InitMailbox)`, carrying `identity.created` |
| Identity updated, paused or resumed (M6) | `mailbox` · `emit_event` | `MailboxRequest::EmitEvent` with `identity.updated`, `identity.paused` or `identity.resumed` |
| Tenant suspended or resumed (`handlers/tenants.rs`; M6 adds this to the M5 handler) | one `mailbox` · `emit_event` per identity paused or resumed, inserted with `INSERT … SELECT` from `identities` | `identity.paused` (`reason: tenant_suspended`) or `identity.resumed` |
| Identity key created, rotated or revoked (`handlers/identity_keys.rs`, M25) | `mailbox` · `emit_event` | `identity.key_created`, `identity.key_rotated` or `identity.key_revoked` |

1. **Write.** The intent's `id` is deterministic (`{request_id}:{target_id}:{op}`, or
   `{request_id}:{identity_id}:{event_type}`), and `body_json` holds the request. An event's ID is derived
   from it like the platform events' IDs ([Webhooks › Platform events](webhooks.md#platform-events)): a
   ULID whose time is `occurred_at` and whose random part is the first 10 bytes of
   `HMAC-SHA256(PM_HASH_KEY, "intent:" + id)`. So every attempt sends the same `event_id`.
2. **Call.** After the commit the handler makes the calls and deletes each intent whose call succeeded.
   Before its own call to an object, it sends that object's older intents still pending, oldest first,
   so a mailbox appends an identity's events in the order of their D1 changes and a later
   `identity.updated` never overtakes an earlier one.
   A failed call does not fail the request: the change is committed, and the answer is the normal one
   (`201` for a create). Until the object is initialised, a call to it is answered
   `503 unavailable` (retryable).
3. **Repair.** The every-minute cron (`crons/intents.rs`) reads up to 100 rows with `next_at ≤ now`,
   oldest `occurred_at` first, sends them one object at a time in that order, deletes each that succeeds,
   and otherwise sets `attempts + 1` and `next_at = now + min(60 s × 2^attempts, 15 min)`. An object that
   answers that it is erased (`identity_not_found` from an erased mailbox, or a tenant that is `erasing` or
   `erased`) also deletes the row. A row is never dropped otherwise, and a row older than one hour is
   logged as `rpc_intent_stuck` at each retry.
4. **Idempotence.** `Init` from the same owner is a no-op that answers `Ok` (another owner is refused, as
   section 5 says), and the mailbox emits `identity.created` once, from the first `Init` it accepts.
   `EmitEvent` appends with its `event_id`, which the outbox stores once. A repeat is therefore harmless,
   and an event is emitted exactly once into the outbox, from where delivery is at least once (section 6).

The `Notifier` is not in this table: it is minted by the every-minute cron for any tenant still at
`notify_do_id = ''` ([Notifications](notifications.md#8-notifier-object)). Tests:
`it::intents::j21_init_retried` and `it::intents::j21_identity_event_retried`
([Identities and domains › Tests](identity-domains.md#tests), [J21](../edge-cases.md)).

## Spikes

The spikes run in milestone M1 of the [build plan](../build-plan.md#m1--spikes-each-one-gates-design-choices)
against a scratch Cloudflare account. Each result is recorded in the design it affects, under a
"Spike result" note with the date. A failed spike takes the listed fallback, and the design is
updated before the build continues.

| Spike | Must prove | Pass criteria | Fallback | Affects |
|---|---|---|---|---|
| **S1** Bindings smoke | From Rust with `worker` 0.8.7, through the `platform::export_worker!` entry glue (which replaces `#[event]` and `#[durable_object]`, see [Rust workspace](rust-workspace.md#2-crate-responsibilities-and-allowed-dependencies)): receive an email event and read `from`, `to`, headers and the raw stream; send with the `send_email` binding's structured `send()` including `replyTo`, `headers` (`In-Reply-To`, `References`, `Auto-Submitted`, `X-*`) and attachments (`attachment` and `inline` with `contentId`); produce and consume Queues with `delay_seconds` and `retry_with_options`, and confirm that `Message::timestamp()` is unchanged across retries; DO SQLite with the `transactionSync` extern (a thrown error rolls back) and alarms; D1 `batch`; a multi-statement request to the D1 query API (`POST /accounts/{a}/d1/database/{id}/query`); and the response of the local `wrangler dev` email endpoint to a `setReject` ([Testing §6.4](testing.md#64-injecting-inbound-mail)); and one live send to two recipients, one of which a test domain refuses with `550` at `RCPT`, to see whether `send()` answers `E_DELIVERY_FAILED` and whether the other recipient still receives the message ([Outbound › Transport outcome classification](outbound.md#transport-outcome-classification)) | Every call works from Rust. The returned `messageId` is captured. The `E_DELIVERY_FAILED` behaviour for several recipients is recorded in the outbound design; until it is, such an answer makes the send `uncertain` (`provider_outcome_unknown`), never `rejected`. A rolled-back transaction leaves no rows. A multi-statement D1 query-API request is atomic: when its last statement fails, none of the earlier statements' rows remain | Raw MIME send (`EmailMessage`) built with `mail-builder` for any missing structured field. If the entry glue cannot replace the macros: an ADR allowing exactly one file, `crates/worker/src/entry.rs`, to use them ([Rust workspace §2](rust-workspace.md#2-crate-responsibilities-and-allowed-dependencies)). If the D1 query API is not atomic: every migration file is made re-runnable and a CI lint enforces it ([CLI and setup §8.5](cli.md#85-d1-migrations)). **`transactionSync` has no fallback; this is an accepted risk.** The planned path is a `wasm-bindgen` call to `ctx.storage.transactionSync`, which Cloudflare documents with no restriction on the calling method beyond a SQLite-backed object ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), read 2026-10-09), so any JS method of the class, including the glue's, may call it. If S1 shows otherwise, the build stops and an ADR is written before M4 continues. The owner accepted this risk on 2026-10-09 | [Rust workspace](rust-workspace.md), [Outbound](outbound.md), [CLI and setup](cli.md#85-d1-migrations) |
| **S2** Inbound failure semantics | What the sending MTA sees when `email()` throws, versus `setReject` (documented as a permanent error); which `Authentication-Results` headers reach the handler | Throwing yields a 4xx temporary failure and the sender retries. The exact SMTP reply text for both cases is recorded. Record which `Authentication-Results` authserv-id Cloudflare stamps on delivered mail (setup later writes it to `PM_TRUSTED_AUTHSERV_ID`, [Inbound › Authentication verdict](inbound.md#authentication-verdict)) | **Throw only.** The handler keeps its in-handler R2 retries (three attempts) and then throws, as designed, whatever the sender is shown; the spike result records the observed reply in [Inbound](inbound.md#interface). There is no `forward()` to a backup address: setup registers no Email Routing destination address ([Identities and domains › Cloudflare API token](identity-domains.md#cloudflare-api-token-permissions)), so none exists to forward to | [Inbound](inbound.md#the-email-handler) |
| **S3** FTS5 in DO SQLite | `content='', contentless_delete=1`, the `trigram` tokenizer, `bm25()` with six column weights, `DELETE FROM fts WHERE rowid = ?`, and renaming an FTS5 table (for the index swap in [Search](search.md)) | All work on the deployed runtime, not only on local workerd | External-content table `fts_docs` ([Data model](data-model.md)); disable trigram and rely on reference normalisation plus semantic fallback; without rename, the swap rebuilds `fts` in place | [Data model](data-model.md), [Search](search.md) |
| **S4** Wasm budget | Bundle size, cold start, CPU time and peak memory when parsing and verifying a 25 MiB message and a 40 MB message from the SES source ([N5](../edge-cases.md)), and `mail-auth` verdict parity on the corpus | Compressed bundle ≤ 10 MiB (NFR-SEC-2), cold start under 1 s, both messages parsed under 128 MB peak and inside the CPU limit, DKIM and DMARC verdicts equal the reference implementation on every corpus message | Write attachments to R2 before parsing bodies; move heavy features behind cargo features; switch the release profile to `opt-level = "z"` | [Rust workspace](rust-workspace.md#4-release-profile), [Inbound](inbound.md) |
| **S5** MCP over rmcp | Streamable HTTP served from `fetch` using `rmcp` 3.4.1 protocol types, without a tokio runtime. Note: `rmcp` 3.4.1 (like 3.5.1) declares `tokio` (features `sync`, `macros`, `rt`, `time`) as a non-optional dependency (crates.io metadata, read 2026-10-10) | MCP Inspector and Claude Code connect, list tools and call one; the wasm build never starts a tokio runtime or timer, and the bundle stays inside the S4 budget | Implement the JSON-RPC types locally in `worker`; keep `rmcp` as a native dev-dependency for client tests. **Taken in advance** ([ADR 0009](../adr/0009-local-mcp-protocol-types.md)): M1 still runs S5 against the local types to record the Inspector and Claude Code result | [MCP server](mcp.md#27-protocol-types-rmcp-and-spike-s5) |
| **S6** Externs and jurisdiction | Vectorize `upsert`, `query` (namespace and metadata filter), `deleteByIds`, `getByIds` and `describe()` (the vector count); `AI.run` with the `gateway` option, including the `bge-m3` output shape, the reranker's score form and the agent model's chat-completions schema ([Search](search.md)); `AI.toMarkdown` (including whether PDF output marks page boundaries) — all through `wasm-bindgen` externs; DO IDs from `unique_id_with_jurisdiction("eu")` stored as strings and re-addressed with `id_from_string` | Every call works and each recorded shape matches the design, or the design is updated with the observed one. An EU object reports the EU jurisdiction (`ctx.id.jurisdiction`) | REST fallbacks (`/vectorize/v2/…`, `/ai/run`, `/ai/tomarkdown`) using `PM_CF_API_TOKEN`, which then becomes required ([Rust workspace §7](rust-workspace.md#7-wasm-bindgen-externs)); one page per document when `toMarkdown` does not mark pages. If an EU object does not report the EU jurisdiction, the build stops for an owner decision, because FR-PRV-1 depends on it | [Rust workspace](rust-workspace.md#7-wasm-bindgen-externs), [Inbound](inbound.md#attachment-text-extraction), [Search](search.md) |
| **S7** Outbound Message-ID | The relationship between the `messageId` that `send()` returns and the `Message-ID` header recipients see | Either a deterministic mapping (strategy A), or the header learned from a journal copy (strategy B) | Strategy B: a hidden journal BCC to `journal+{message ulid}.{identity ulid}@{PM_PLATFORM_DOMAIN}`; the email handler records the header and drops the copy ([Outbound](outbound.md#message-id-of-outbound-mail-spike-s7)). If a journal copy never arrives, that message matches replies by thread token and provider ID only | [Outbound](outbound.md#message-id-of-outbound-mail-spike-s7), [Threading](threading.md) |
| **S8** SES in wasm | SigV4 signing for SES v2 `SendEmail` with raw content, and SNS message signature verification (`SignatureVersion` 2; version 1 is refused), from Rust in wasm | A real send through SES in `eu-west-2`; a real SNS notification verified, and a tampered one rejected | SES leaves v1.0: an ADR moves `send_only`, `dns_records`, `smtp_relay` with `inbound: ses` and the SES failover to v1.1 | [Outbound](outbound.md#amazon-ses), [Identities and domains](identity-domains.md) |
| **S9** Event subscriptions and onboarding APIs | Create an Email Sending event subscription to `pm-delivery-events` through the API for one domain (source type `email.sending` with `zone_id` and `domain`; this source shape appears in Wrangler's source, not yet in the API reference), receive all six event types, delete it. Onboard a zone **apex** and a subdomain through `POST /zones/{zone_id}/email/sending/subdomains`, and enable routing on a subdomain through `POST /zones/{zone_id}/email/routing/dns` with `name`. A literal routing rule whose `worker` action value is the script name `pylota-mail` delivers to the Worker. A subdomain's routing is enabled without touching the apex's MX records, and removed on its own (unlock with `PATCH …/email/routing/dns` and `name`, delete its records by ID) while the zone's other mail domains keep receiving; the zone-wide `DELETE …/email/routing/dns` is recorded, never used for one name. The error codes for a zone gone from the account, a 31st mail domain and an existing zone are recorded | Payload fields match [Outbound › Delivery events](outbound.md#delivery-events); subscriptions can be created per domain at runtime with `PM_CF_API_TOKEN`; apex and subdomain onboarding both work through the API; a subdomain's routing can be removed on its own | For `cloudflare_zone` and `nameservers`, the API creates the domain without a subscription, marks it `delivery_events: "manual"`, sends from the platform address meanwhile, and returns its records with `details.action = "run pmail domains subscribe <domain>"`; delivery events start once that command has run. A subdomain whose routing cannot be removed on its own is left with no rules and listed by `pmail doctor` (`routing.leftover_subdomains`) ([Identities and domains › Kind `zone`](identity-domains.md#kind-zone), tests `it::domains::s9_manual_delivery_events` and, for `nameservers`, `it::domains::s9_manual_delivery_events_nameservers`). Any onboarding step the API cannot do is listed by `pmail domains add` as a dashboard step and checked by `pmail doctor` | [Identities and domains](identity-domains.md), [Outbound](outbound.md), [CLI and setup](cli.md#184-domains-subscribe) |
| **S10** Child zones | On an Enterprise account, a subdomain-setup child zone accepts Email Routing catch-all to the Worker and Email Sending onboarding, and both work end to end. Optional: skipped when no Enterprise account is available ([Build plan › Human prerequisites](../build-plan.md#human-prerequisites)) | Mail to any address at the child apex reaches `email()`; a send is DKIM-aligned | `delegated_subdomain` stays off; `dns_records` covers the case | [Domains on any DNS host](domain-connections.md#33-delegated_subdomain) |
| **S11** SES receiving | Rule set, S3 action and topic as specified; the notification shape, including the `objectKey` form; S3 `GetObject` with SigV4 from a Worker; a 39 MB message ([N5](../edge-cases.md)); `user+tag@` routing; the retired-address bounce; the backstop picks up a message whose push failed | All pass in `eu-west-2` | `dns_records` and `smtp_relay` with `inbound: ses` do not ship in v1.0; `send_only` still does | [Domains on any DNS host](domain-connections.md#45-inbound-through-ses) |
| **S12** SMTP from a Worker | Ports 465 and 587 with `StartTls` against two real providers; the certificate host name is checked (a wrong-name certificate is refused); timeouts and the uncertain window behave as designed | All pass | `smtp_relay` does not ship in v1.0 | [Domains on any DNS host](domain-connections.md#52-the-client) |
| **S13** Web Bot Auth format | A request signed by `core::httpsig` with the deployment key (`Signature-Agent` as a quoted structured-field string; `Signature-Input` covering `@authority`, `signature-agent` and `from`, with `tag="web-bot-auth"`, `keyid` = the JWK thumbprint, `created`, `expires` and a 64-byte nonce), sent to `https://crawltest.com/cdn-cgi/web-bot-auth`, which answers `401` for a well-formed message with an unknown key, `200` for a known key that verifies and `400` otherwise ([Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/), read 2026-10-09). Needs no Cloudflare account | `401` before the key directory is registered (well-formed, unknown key), never `400` | Signed HTTP requests stay off in v1.0: `PM_WEB_BOT_AUTH` cannot be turned on. Agent assertions are unaffected | [Agent signing keys](agent-keys.md#5-signed-http-requests-web-bot-auth) |
