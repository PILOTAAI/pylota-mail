# Architecture

This page is the map. The [design documents](design/index.md) hold the detail for each part, and the
[REST API reference](../reference/api.md) holds the public contract.

## 1. Shape of the system

Pylota Mail is **one Cloudflare Worker written in Rust** (compiled to WebAssembly with `workers-rs`).
It has five entry points and six Durable Object classes. It stores data in D1, Durable Object SQLite,
R2 and Vectorize, and moves work through Queues.

```text
                    ┌──────────────────────── Cloudflare account ─────────────────────────┐
 External sender    │                                                                      │
   ── SMTP ──▶ Email Routing (catch-all / literal rules)       domains with inbound = routing
                    │        │                                                             │
                    │        ▼                                                             │
                    │   email() handler ── raw .eml ──▶ R2  (BLOBS, jurisdiction)          │
                    │        │                                                             │
                    │        └── pointer ──▶ pm-inbound ──▶ queue() ── parse, verdict ──┐  │
                    │                            ▲         (SES: S3 object → R2 first)  │  │
 External sender    │                            │                                      │  │
   ── SMTP ──▶ Amazon SES receiving ── S3 object, SNS     domains with inbound = ses    │  │
                    │   SNS push ─▶ fetch() POST /hooks/ses/inbound ──┐                 │  │
                    │   SQS copy ─▶ scheduled(), every minute ────────┴─▶ ses_ingest ledger
                    │                                                                   ▼  │
 Integrator / agent │   fetch() ── /v1 REST, /mcp ──────────────────────────▶ IdentityMailbox DO
   ── HTTPS ───────▶│        │                         (one per identity, SQLite: threads,  │
 Person, browser    │        │                          messages, FTS5, refs, outbox, sends) │
   ── HTTPS ───────▶│   fetch() ── /console on PM_CONSOLE_HOST ── same internal services   │
                    │        ├──▶ D1 (DB): tenants, identities, address directory,         │
                    │        │    domains, keys, webhooks, suppressions, jobs, audit        │
                    │        │                                                             │
                    │        └──▶ pm-outbound ──▶ queue() ──▶ MailTransport                │
                    │                                   ├─ cloudflare: Email Sending (EMAIL)
                    │                                   ├─ ses: Amazon SES (optional)      │
                    │                                   ├─ smtp: the customer's relay      │
                    │                                   └─ Simulator (test tenants)        │
                    │                                                                      │
 Email Sending ──── event subscription ──▶ pm-delivery-events ──▶ queue() ──▶ mailbox DO   │
 SES events ─────── SNS ──▶ fetch() POST /hooks/ses ──▶ pm-outbound (transport events)     │
                    │                                                                      │
 mailbox DO outbox ─▶ pm-webhooks ──▶ queue() ── signed POST ──▶ integrator endpoints      │
                    │                 └─ new mail ─▶ Notifier DO (tenant) ◀─ TenantQuota   │
                    │                    alarm ─▶ system identity send ─▶ pm-outbound      │
 mailbox DO commit ─▶ pm-index ────▶ queue() ── chunk, embed (AI) ──▶ Vectorize            │
                    │                         └─ triage (AI), attachment text (toMarkdown) │
                    │                                                                      │
 scheduled() ───────▶ DomainMonitor DOs (DNS health), JobRunner DOs (erasure, retention,   │
                    │  re-embed, export, backup), address retirement, state alerts,        │
                    │  the SES backstop and account check                                  │
                    └──────────────────────────────────────────────────────────────────────┘
```

SES, S3, SNS and SQS are in the deployer's AWS account, outside Cloudflare, and are used only when SES is
configured. The `ses_ingest` ledger in D1 passes each SES pointer to `pm-inbound` once.

### Entry points

| Handler | Triggered by | Does |
|---|---|---|
| `fetch` | HTTPS to the API host, and to the console host when `PM_CONSOLE_HOST` differs | On the API host: REST API `/v1/*`, MCP `/mcp`, `/openapi.json`, `/health`, `/.well-known/*` (the security contact, identity JWKS and the Web Bot Auth key directory), signed links `/v1/links/*`, the SNS endpoints `/hooks/ses` (SES delivery events) and `/hooks/ses/inbound` (SES inbound notifications), and the Stripe webhook `/billing/stripe/webhook`. On the console host: `/console/*` |
| `email` | Email Routing, for domains with `inbound = routing` | Looks up the recipient, writes raw mail to R2, queues a pointer, and rejects unknown or retired addresses |
| `queue` | Ten Cloudflare queues: five work queues and their five dead-letter queues | Inbound processing, outbound transport, delivery events, webhook delivery, indexing, triage, dead-letter recording. The SES backstop is an SQS queue in AWS, polled by `scheduled`, not one of these |
| `scheduled` | Cron (every minute and every 15 minutes) | Every minute: address retirement, the platform-event outbox sweep, restarting queued jobs, the state-alert evaluator (with alert email and the automatic containment rules), the master-key re-seal sweep, draining the SES backstop queue. Every 15 minutes: domain health scheduling, retention, usage roll-up, the SES account check, the capacity checks, the nightly backup job. While `PM_FREEZE = "on"` they do nothing ([Observability › Restore from PITR](design/observability.md#restore-from-pitr)) |
| Durable Object `alarm` | Alarms set by each object | State machines: domain health, jobs, outbox dispatch, in each mailbox the transport-claim, dispatch-retry, lock and reconciliation work for its own sends, and in each tenant's `Notifier` the notification windows and the daily 09:00 run |

### Inbound sources and outbound transports

Each domain has an inbound source and an outbound transport, fixed by the connection method chosen when it
is added ([Domains on any DNS host](design/domain-connections.md)):

| Inbound source | How mail arrives | Used by |
|---|---|---|
| `routing` | Email Routing calls the `email()` handler | The platform domain; `cloudflare_zone`, `nameservers`, `delegated_subdomain` |
| `ses` | An SES receipt rule stores the message in S3 and notifies an SNS topic. The topic pushes to `POST /hooks/ses/inbound`; an SQS subscription keeps a copy for 14 days, drained every minute as a backstop. Both paths go through the `ses_ingest` ledger, so each object and recipient is ingested once. The consumer copies the object to R2 and runs the same pipeline | `dns_records`; `smtp_relay` with `inbound: ses` |
| `forward` | The customer's own mailbox forwards to the identity's platform address, which arrives through `routing` | `send_only`; `smtp_relay` with `inbound: forward` |

| Transport | How mail leaves | Used by |
|---|---|---|
| `cloudflare` | Email Sending through the `EMAIL` binding | Domains on Cloudflare DNS, and every fallback send |
| `ses` | The SES v2 API, signed with SigV4; delivery events come back through SNS to `POST /hooks/ses` | `dns_records`, `send_only`; failover for zone domains |
| `smtp` | The customer's relay over a Worker TCP socket (ports 465 or 587, TLS before AUTH), allowed only while a daily alignment probe passes | `smtp_relay` |

Test tenants always use the simulator.

### Console and billing

The same Worker serves the **console** at `/console`: server-rendered HTML from Rust (no JavaScript), session
cookies, CSRF tokens, and role checks per handler. A console action calls the same internal services as the
REST API, with a session principal whose permissions come from the member's role instead of an API key.

The console is served on `PM_CONSOLE_HOST`, which defaults to `PM_API_HOST`. When the two differ, console
paths answer only on the console host and API paths (REST `/v1/*` with signed links `/v1/links/*`, MCP `/mcp`,
`/openapi.json`, `/health`, `/.well-known/*`, `/hooks/*` and `/billing/stripe/webhook`) only on the API host; anything else gets `404`, and no cookie is set or read on the API host. People sign in with
an email link or code, or with Google or GitHub where enabled, plus optional two-step verification
([Cloud sign-up](design/cloud-signup.md)).

With `PM_BILLING=stripe`, plan allowances are enforced by the workspace's `TenantQuota` object (atomic holds,
settled when an outcome is known). Stripe is called only to create a workspace's Customer, to create and
retrieve Checkout Sessions, to create Customer Portal sessions, to read subscriptions with their latest
invoice and a disputed charge, and to cancel subscriptions (a deleted workspace, a duplicate, a lost
dispute) ([Billing › Stripe integration](design/billing.md#stripe-integration)); its signed webhooks at
`/billing/stripe/webhook` are the only writer of subscription state. No metered request waits on Stripe. See [Console design](design/console.md) and [Billing design](design/billing.md).

### Durable Object classes

| Class | One per | Holds |
|---|---|---|
| `IdentityMailbox` | identity | The mailbox: threads, messages, recipients, attachment metadata, labels, FTS5 index, references, contacts, triage, send ledger, idempotency records, event outbox, thread locks, chunk map |
| `DomainMonitor` | domain | The domain verification and health state machine, check history, reminder schedule |
| `JobRunner` | long-running job | The erasure, retention, export, re-embed, re-parse, re-index, domain-removal or backup state machine, with a step journal |
| `TenantQuota` | tenant | Plan allowances and open holds (inboxes, sends, triage, custom domains, storage, seats), exact daily counters (agentic searches, AI usage), abuse-rate windows and the usage-alert markers that make each 80% and 100% alert go out once |
| `SesControl` | deployment (only when SES is configured) | The token bucket that keeps Amazon SES control-plane calls at one per second ([Domains on any DNS host §4.8](design/domain-connections.md#48-ses-api-rate-one-request-per-second)) |
| `Notifier` | tenant | Notification email for the workspace's people: pending items, coalescing windows, the daily 09:00 schedule and the daily caps. It holds person and identity IDs and counts, never mail content ([Notifications](design/notifications.md#8-notifier-object)) |

Every Durable Object ID is created with `unique_id_with_jurisdiction(<jurisdiction>)` (or `unique_id()`
when the jurisdiction is `default`) and stored in D1. Objects are addressed with `id_from_string`. Names
are never hashed into IDs, because `workers-rs` only applies a jurisdiction to unique IDs. See
[ADR 0002](adr/0002-storage.md).

## 2. Storage

| Store | Binding | Holds | Why there |
|---|---|---|---|
| D1 | `DB` | The control plane: tenants, identities, addresses (the directory), domains, API keys (hashed), webhook endpoints and delivery log, suppressions, allow and block lists, jobs, erasure requests, audit log, non-mail idempotency records, the sealed thread, link, cursor and Web Bot Auth signing keys, the agents' identity keys (sealed) and key tombstones, dead-letter items, the `ses_ingest` ledger, and the console's people, members, sessions, notification preferences and billing accounts | Small, relational, and queried across tenants for routing and administration |
| Durable Object SQLite | `MAILBOX`, `DOMAINS`, `JOBS`, `QUOTA`, `SES_CONTROL`, `NOTIFY` | Everything per mailbox, in one transaction; each other object's own state | Strong consistency per mailbox, no cross-tenant write contention, 10 GB per object, one-call deletion |
| R2 | `BLOBS` (and the optional `BACKUP`) | Raw `.eml`, attachments, extracted attachment text, exports | Large objects, free egress, erasure by prefix |
| Vectorize | `VECTORS` (index `pm-mail-chunks`) | Chunk vectors and filter metadata only, never text | Semantic retrieval |
| Queues | `Q_INBOUND`, `Q_OUTBOUND`, `Q_DELIVERY`, `Q_WEBHOOKS`, `Q_INDEX` | Pointers only (≤ 128 KB) | At-least-once async work with dead-letter queues |

R2 keys are tenant-prefixed so that erasure can list them:

```text
t/{tenant_id}/i/{identity_id}/m/{message_id}/raw.eml
t/{tenant_id}/i/{identity_id}/m/{message_id}/a/{attachment_id}
t/{tenant_id}/i/{identity_id}/m/{message_id}/a/{attachment_id}.md      extracted text
t/{tenant_id}/i/{identity_id}/out/{message_id}.eml                     composed outbound MIME
t/{tenant_id}/i/{identity_id}/out/{message_id}/a/{attachment_id}       outbound attachment
t/{tenant_id}/exports/{export_id}.zip
inbound-staging/{yyyy}/{mm}/{dd}/{ulid}.eml                            before routing resolves (≤ 15 days)
inbound-staging/ses/{key}                                              SES object copied from S3 (≤ 15 days)
```

R2 has no versioning, point-in-time recovery or replication (R2 S3 API compatibility page, last updated
2026-07-31, read 2026-10-09). Its durability protects blobs against infrastructure loss, not against a
bug that deletes them. For that, an optional nightly job copies new `t/` objects to a second bucket
(`PM_BACKUP_BUCKET`, off by default, on for Pylota Mail Cloud); retention and erasure delete from both
([Privacy › R2 backup copy](design/privacy.md#54-optional-r2-backup-copy)).

The full schema is in [Data model](design/data-model.md).

## 3. Tenancy and isolation

```text
Platform (deployment) ── platform keys, platform domain, platform webhooks
  ├─ Partner (ptn_)  partner keys and partner webhooks; reaches only the tenants its keys created
  └─ Tenant (ten_)  live | test, policy, quotas, address suffix, partner_id (optional)
       ├─ Domain (dom_)      kind: zone | delegated | external; method, inbound, transport
       │                     (the platform domain is shared)
       └─ Identity (idn_)    one IdentityMailbox DO
            └─ Address (adr_)  role: primary | alias, status: pending | active | retiring | retired
```

- An API key resolves to `(level, partner_id?, tenant_id?, identity_id?, permissions)`. Every handler takes scope from
  the resolved key and checks the target resource's tenant against it **before** touching a Durable
  Object; for a partner key, the tenant's `partner_id` must be the key's
  ([Security › Partner keys](design/security.md#partner-keys)). A Durable Object also checks the tenant ID passed in the internal request against its own
  stored owner, so a routing bug cannot cross tenants.
- Every D1 query on tenant data includes `tenant_id` in its `WHERE` clause. The data-access layer
  makes it a required parameter.
- Cross-tenant attack tests run in CI (see [Testing](design/testing.md)).

## 4. Main flows

### 4.1 Inbound

1. `email()` normalises the envelope recipient and strips the `+tag`. It looks the address up in the
   directory (D1, with a 60-second in-isolate cache for hits and 5 seconds for misses).
   - Unknown or erased: `set_reject("550 5.1.1 ...")`.
   - Retired: `550 5.1.6`.
   - Suspended tenant: temporary failure.
2. It streams the raw message into R2 (`.../raw.eml`). Only after that write succeeds does it queue
   a pointer to `pm-inbound` and return. If the write fails it retries twice, then throws so the sender
   sees a temporary failure. It never calls `set_reject` for a storage failure.
3. The `pm-inbound` consumer fetches the raw message and parses it with the Rust core:
   - MIME parsing (`mail-parser`);
   - sanitising (`ammonia`);
   - quote stripping;
   - reference extraction;
   - loop and automation classification;
   - the authentication verdict (Cloudflare's `Authentication-Results` plus our own `mail-auth` DKIM,
     ARC and DMARC check over DNS-over-HTTPS).

   It then calls `IdentityMailbox.ingest`.
4. `IdentityMailbox.ingest` does all of the following in **one SQLite transaction**:
   - deduplicates on message hash;
   - resolves the thread;
   - inserts the message, recipients and attachment metadata;
   - writes the FTS5 row and references;
   - updates contacts;
   - appends `message.received` (or `message.quarantined`) to the outbox.

   It sets an alarm to drain the outbox.
5. After commit, attachments are written to R2. `pm-index` jobs are queued for attachment-text
   extraction, chunking and embedding, and triage. Each completion appends its own event, for example
   `message.triaged`.

Mail for an `inbound = ses` domain skips steps 1 and 2. SES has already accepted it and stored it in S3;
the SNS handler (or the every-minute backstop) verifies the notification, records each recipient in the
`ses_ingest` ledger and queues one pointer per new recipient. The consumer copies the object into R2 and
continues from step 3, then deletes the S3 object once every recipient is done. Unknown recipients are
dropped without a bounce; retired ones are bounced by SES receipt rules
([Domains on any DNS host §4.5](design/domain-connections.md#45-inbound-through-ses)).

See [Inbound pipeline](design/inbound.md).

### 4.2 Outbound and safe retries

1. `POST /v1/identities/{id}/messages` passes the key permission `messages:send` and validation. It then
   calls `IdentityMailbox.submit` with the `Idempotency-Key` and a request fingerprint.
2. The mailbox, in one transaction:
   - looks up the key: a replay returns the stored response, and a fingerprint mismatch returns `409`;
   - runs policy: status, accountable human, caps through `TenantQuota`, suppressions, lists,
     size, recipients, automated-mail rule;
   - takes the thread lock;
   - stores the message as `queued`;
   - records the idempotency entry.

   It returns `202`.
3. The outbound message is composed (MIME stored to R2) and a pointer is queued on `pm-outbound`. The
   consumer calls the transport. Its outcome is classified as:
   - **accepted**: stores the provider message ID, status `submitted`;
   - **definitely rejected**, such as validation errors, a suppressed recipient or a quota limit: status
     `rejected`, `failed` or `queued` with a backoff retry, depending on the error class;
   - **unknown**, such as a timeout or dropped connection: status `uncertain`, never resent.
4. Provider delivery events arrive on `pm-delivery-events`. They are routed by sender address to the
   mailbox, matched by provider message ID, and update each recipient's status.

See [Outbound and safe retries](design/outbound.md).

### 4.3 Search

`POST /v1/identities/{id}/search` parses the query string into a typed tree in the core (never raw
FTS5). It then runs:

- **keyword**: FTS5 BM25 plus exact references inside the mailbox Durable Object;
- **semantic**: embed the query (Workers AI `@cf/baai/bge-m3`), query Vectorize in the tenant namespace
  with metadata filters, and read the text back from the mailbox;
- **hybrid**: run both, fuse by reciprocal rank, rerank the top 50 with `@cf/baai/bge-reranker-base`;
- **agentic**: a bounded loop of plan, search, judge, refine and answer, using a function-calling model
  with read-only tools. A deterministic citation check runs at the end.

Tenant scope fans out to each identity's mailbox in parallel and merges the results. See [Search](design/search.md).

### 4.4 Events and webhooks

Every state change appends an event to the owning Durable Object's **outbox**, in the same transaction
as the change. An alarm drains the outbox to `pm-webhooks`. The consumer:

- resolves matching endpoints (platform, partner and tenant), from D1 with a short cache;
- signs each delivery per endpoint (Standard Webhooks);
- POSTs it with SSRF guards;
- records a delivery row;
- schedules retries with queue delays for up to 72 hours.

Exhausted deliveries go to a dead-letter state and can be replayed for 30 days from the event's
`occurred_at` (or the tenant's `retention.events_days`, if shorter). The same consumer hands new-mail
events to the tenant's `Notifier` (section 4.7). See [Webhooks and events](design/webhooks.md).

### 4.5 Domains

`DomainMonitor` runs a state machine per domain, driven by alarms:

```text
pending → verifying → verified/healthy ⇄ degraded → failing → suspended
                                            ▲           │
                                            └ recovered ┘
```

Checks query two independent DNS-over-HTTPS resolvers. A state change needs two consecutive agreeing
results. On `failing`, sending switches to the identity's platform address (`sent_via_fallback`). The
checks depend on the domain's method: DNS records for Cloudflare and SES domains, the SES identity status
for SES domains, and the daily alignment probe for `smtp_relay` domains. See
[Identities, addresses and domains](design/identity-domains.md) and
[Domains on any DNS host](design/domain-connections.md#6-health-checks-per-method).

### 4.6 Agent signing

An agent proves who it is outside email with keys that never leave the Worker:

- **Agent assertion.** `POST /v1/identities/{id}/assertions` (permission `identities:sign`, rate limit
  `RL_SIGN` per identity) reads the identity from D1 (a paused or suspended identity gets `409`), loads
  its `active` row from `identity_keys` (creating the key on first use), unseals the Ed25519 seed with
  `PM_MASTER_KEY`, and has `core::jwt` sign a short-lived JWT naming the identity, its address and its
  workspace. The token is returned and never stored; `usage_daily` counts it.
- **Verification.** Any service checks the token against the identity's JWKS,
  `GET /.well-known/jwks/{identity_id}.json` on the API host, with no API key. Pausing an identity, or
  suspending its tenant, stops signing and withdraws the JWKS.
- **Signed HTTP request (Web Bot Auth).** `POST /v1/identities/{id}/http-signatures` has `core::httpsig`
  build an RFC 9421 signature with the deployment's `web_bot_auth` key from `signing_keys`, and returns
  the `Signature-Agent`, `From`, `Signature-Input` and `Signature` headers for the agent's own HTTP client:
  the Worker never makes the request. Sites verify against the key directory,
  `GET /.well-known/http-message-signatures-directory` on the API host, which is signed once per key.
  It is off until spike S13 passes (`PM_WEB_BOT_AUTH`).

See [Agent signing keys](design/agent-keys.md).

### 4.7 Notifications

1. **Sources.** The `pm-webhooks` consumer hands `message.received`, `message.released` and
   `message.triaged` to the tenant's `Notifier` object as `NotifierRequest::Event`, after its delivery
   work and only when someone in the workspace follows new mail. `TenantQuota` sends
   `NotifierRequest::UsageThreshold` when a hold first crosses 80% or 100% of an allowance. Console
   handlers send `NotifierRequest::Account` after their D1 batch (two-step verification turned off, a
   sign-in method linked, ownership transferred), and the billing webhook does for a failed payment.
2. **Coalescing.** The Notifier keeps pending counts per person and inbox, applies each person's
   preferences from D1 `notification_prefs`, the daily caps and the time zone, and arms its alarm for the
   next window or the daily 09:00 run.
3. **Sending.** At the alarm it submits an ordinary `transactional` send from the system identity
   (`PM_SYSTEM_FROM`) with an `Idempotency-Key` per person, kind, inbox and window, through the normal
   outbound pipeline. The email holds counts and links, never content from mail, and carries a one-click
   `List-Unsubscribe` link to the console.

See [Notifications](design/notifications.md).

## 5. Consistency and delivery guarantees

| Guarantee | How |
|---|---|
| No acknowledged message is lost | R2 write before ack; the queue pointer is retried; a daily reconciliation lists R2 staging against mailbox records. SES source: the S3 object stays until every recipient is ingested, and the SQS backstop keeps each notification for 14 days |
| Each inbound message is stored once | Mailbox dedupe on `sha256(raw)` plus `(identity, rfc_message_id)` rules ([B3](edge-cases.md)); for SES, the `ses_ingest` ledger admits each object and recipient once, whichever path delivers it |
| A message is searchable as soon as it is visible | The FTS row is in the same transaction as the message |
| Events are emitted exactly when state changes | Transactional outbox in the same Durable Object transaction; consumers deduplicate on `event_id` |
| Webhooks are delivered at least once | Queue retries; endpoint consumers deduplicate on `webhook-id` |
| One outbound email per idempotency key | Reservation in the mailbox transaction; an uncertain send is never retried automatically |
| Ordering | Per mailbox only. Webhooks carry `occurred_at` and a per-identity `sequence` for consumers that need order |

## 6. Code layout

```text
crates/core         no I/O; builds native + wasm32. MIME parse/build, auth verdicts, sanitise,
                    quote stripping, references, threading rules, loop classification, query parser,
                    fusion/rerank glue, citation verifier, triage rules, policy evaluation, JWK
                    thumbprints, JWT and HTTP message signatures, notification rendering
crates/platform     the ONLY crate importing `worker`: traits + Cloudflare impls for D1, DO, R2,
                    Queues, AI, Vectorize (extern), Email (send), rate limits, clock, randomness
crates/api-types    serde request/response types, error codes, utoipa → OpenAPI 3.1
crates/worker       handlers, router, auth, console, Durable Object classes, state machines, MCP
                    endpoint, agentic loop, inbound sources (routing, ses), transports (cloudflare,
                    ses, smtp, simulator)
crates/sdk          Rust client (reqwest), used by the CLI
crates/cli          `pmail` (clap): setup, deploy, doctor, admin, mail
crates/conformance  MIME corpus + RFC conformance runner (native and against workerd)
xtask               build-worker, size budget, itest, fuzz, release bundling
```

See [Rust workspace and platform](design/rust-workspace.md).

## 7. Deployment topology

- **Self-hosted (default):** one Worker named `pylota-mail` and one assets-only Worker for the site and
  docs (optional). The API is served on a custom domain, for example `mail.example.com`, and so is the
  console unless `PM_CONSOLE_HOST` names a second host (Pylota Mail Cloud uses separate console and API
  hosts). Mail is
  received on a platform domain that **must be a zone apex**, because catch-all routing only works on an
  apex. Examples: `agents.example` or `examplemail.com`.
- **Environments:** `local` (`wrangler dev` with workerd), `staging` and `production`. Each has its own
  zone or platform domain and its own D1, R2, Vectorize and queues. Nothing is shared.
- **Release:** CI gate → staging deploy → live end-to-end suite → gradual production rollout (Workers
  gradual deployments, 10% → 50% → 100%). D1 and Durable Object schema changes are always expand then
  contract. Durable Object migrations are versioned and idempotent on wake.

## 8. External dependencies

| Dependency | Used for | Failure behaviour |
|---|---|---|
| Cloudflare Email Routing | Inbound | Outside our control; senders retry on temporary failure |
| Cloudflare Email Sending | Outbound (default) | Queue backoff. The runbook switches the transport to SES |
| Workers AI | Embeddings, rerank, triage, agentic planner, attachment text | Search degrades to keyword or hybrid without rerank; triage is marked `failed` and retried; agentic search degrades to hybrid |
| Vectorize | Semantic search | Hybrid search falls back to keyword, with `semantic_coverage` and `degraded` set |
| DNS-over-HTTPS resolvers (Cloudflare, Google) | DKIM, DMARC and domain checks | A single-resolver failure never flips a domain state |
| Amazon SES, S3, SNS, SQS (optional) | Inbound and outbound for domains on any DNS host (`dns_records`, `send_only`, `smtp_relay` with `inbound: ses`), failover | Outbound errors are classified like Cloudflare's. Inbound: SNS retries the push; the SQS backstop keeps each notification for 14 days; S3 keeps the object until it is ingested. Paused SES sending moves SES domains to fallback |
| Customer SMTP relays (optional) | Outbound for `smtp_relay` domains | Replies are classified per SMTP code; nothing is resent after the final `.`; a failing alignment probe moves the domain to fallback |
| Google and GitHub (optional) | Console sign-in | Email link and code sign-in still work |

## 9. What is deliberately not here

- No Workflows (`workers-rs` has no binding). State machines live in Durable Objects with alarms ([ADR 0005](adr/0005-state-machines.md)).
- No KV for correctness-critical state (it is eventually consistent).
- No server-side fetching of remote content in mail (tracking and SSRF).
- No handwritten JavaScript. The `worker-build` shim is generated ([ADR 0001](adr/0001-rust-on-workers.md)).
