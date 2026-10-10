# Build plan

This is the order of work for building Pylota Mail from an empty repository to v1.0, written for a
coding agent (or a team) working through it in one pass. Each milestone lists:

- the files it creates;
- the requirements it implements;
- the tests that prove it;
- the gate that must be green before the next milestone starts.

Design documents are binding. When a milestone shows a design is wrong, stop, write an ADR, update the
design, then continue. Never let code and docs drift. When two pages disagree, `openapi.yaml` wins for
wire behaviour and the design page wins for internal behaviour
([Design › Precedence](design/index.md#precedence)).

## How to work through it

1. **Test first.** For each item, write the test named in the [edge-case register](edge-cases.md) or the
   milestone's acceptance list, watch it fail, then implement.
2. **Gate after every milestone:**

   ```bash
   cargo fmt --all --check
   cargo clippy --workspace --all-targets -- -D warnings
   cargo test --workspace
   cargo xtask build-worker   # wasm build + size budget
   cargo xtask itest          # from M5 onwards
   mdbook build docs
   ```

3. **One pull request per milestone** (or per track once tracks run in parallel). The PR description
   lists the FR IDs and edge rows covered. `main` is protected. Nothing merges red.
4. **Contracts are frozen** once written: API paths and shapes, error codes, event types, MCP tool names,
   CLI commands. Additive changes need a docs update in the same PR. Breaking changes need an ADR.
5. **Record spike outcomes** in the design document they affect, under a "Spike result" note with the date.

## Timeline

| Phase | What | Elapsed time with AI coding agents |
|---|---|---|
| A. Foundation and spikes | M0–M1 | 0.5–1 day. Spikes need a real Cloudflare account and DNS |
| B. Build | M2–M19, M21–M26, run as parallel tracks after M5 | 3–5 days of agent time, depending on parallelism and review speed |
| C. Live proof | M20: staging deploy, live end-to-end suite, deliverability checks | 2–5 days. DNS propagation, Email Sending onboarding and real-mailbox tests are wall-clock bound |
| D. Hardening before production traffic | DMARC ramp (`p=none` → `quarantine` → `reject`), Postmaster Tools enrolment, external review | 4–6 weeks of calendar time, mostly waiting, run in parallel with early use |

Writing the code is the fast part. The time that cannot be compressed is the live proof:

- real inbound from Gmail and Outlook;
- bounces and complaints;
- a domain change;
- a domain on an external DNS host;
- a domain failure with fallback;
- erasure with probes.

None of this is optional. Each check guards against a failure mode that has already happened in
production with the previous provider.

## Dependency graph

An arrow means "must be done before".

```text
M0 skeleton ─▶ M1 spikes ─▶ M2 core ─▶ M3 api-types ─▶ M4 platform ─▶ M5 worker base
                                                                        │
            ┌─────────────────────────────┬──────────────┬──────────────┼───────────────┐
            ▼                             ▼              ▼              ▼               │
     M6 identities                  M16 SDK/CLI    M17 observability  M19 site/release  │
     and outbox                                                                         │
            ├──────────────┐                                                            │
            │              ▼                                                            │
            │        M8 webhooks                                                        │
            │              │                                                            │
            ▼              │                                                            │
     M7 inbound ◀──────────┘                                                            │
     and wait                                                                           │
            │                                                                           │
     ┌──────┴───────┬───────────────┐                                                   │
     ▼              ▼               ▼                                                   │
 M9 outbound   M10 search      M12 triage                                               │
     │              │               │                                                   │
     ▼              ▼               │                                                   │
 M13 domains   M11 agentic          │                                                   │
     │              │               │                                                   │
     └──────┬───────┴───────┬───────┘                                                   │
            ▼               ▼                                                           │
     M14 privacy      M15 MCP ◀─────────────────────────────────────────────────────────┘
            │               │      (M15 also waits for M22 and M25, second graph)
            └───────┬───────┘
                    ▼
            M18 quality gates ─▶ M20 staging + live proof ─▶ v1.0
```

The console, billing, domain-method, agent-key and notification milestones, and the two halves of M17,
join the graph like this. Each also feeds M20:

```text
M7, M8, M9, M10, M11, M12, M13, M14 ─▶ M21 console ─▶ M22 billing ─▶ M24 cloud sign-up and sign-in
   (the console's pages show what these build)        (M22 also needs M9 and M12)
M9 outbound ─▶ M13 domains ─▶ M23 domains on any DNS host   (S10, S11, S12 gate its methods)
M5, M6 ─▶ M25 agent signing keys, assertions and signed requests ─▶ M15 MCP (two signing tools)
                                                                  ─▶ M21 console (keys on the identity page)
   (S13 gates signed HTTP requests only)
M22 billing ─▶ M15 MCP (mail_get_usage calls M22's GET /v1/usage)
M9, M10, M21, M22, M24 (and M6's system identity) ─▶ M26 notifications and usage alerts
M5 ─▶ M17 Foundation (metrics writer, alert evaluator, alert table, re-seal sweep) ─▶ M7, M8, M9
   (M17 Completion, the checks that measure later milestones, is accepted at M20)
```

After M5, these tracks can run in parallel, each in its own branch and worktree:

- **Track 1:** M6 → M7 → M9 → M13 (domains need the send path for fallback sends and `transport/ses.rs`);
  M7 also waits for M8, whose `webhooks/payloads.rs` builds the `message.*` events that inbound mail emits;
- **Track 2:** M8, once M6 lands (M8 imports M6's `webhooks/envelope.rs`: the event envelope, the
  `WebhookJob` queue message and the identity payload builders that M6's outbox already needs);
- **Track 3:** M17 Foundation first (it must merge before M7, M8 and M9), then M16 and M17 Completion;
- **Track 4:** M19;
- **Track 5:** M25, once M6 lands (it needs only M5 and M6).

Once M7 lands, M10 and M12 also run in parallel with M9. M23 follows M13 on the domains track. M21
starts only after M7–M14 and M25, because its screens (inboxes, search, quarantine, triage, domains,
webhooks, erasure, identity keys) call their services; M22 starts after M9, M12 and M21, M24 after M21 and
M22, and M26 after M9, M10, M21, M22 and M24 (it sends through M6's system identity, is fed by M8's
webhook dispatcher and M12's triage, which come before M21, and adds hooks to M24's sign-in files).
M15 also waits for M22, whose `GET /v1/usage` its `mail_get_usage` tool calls, and for M25, whose two
signing tools it registers. M17 is accepted in two halves, without renumbering: **M17 Foundation** (the
metrics writer, the alert evaluator, the alert table and the master-key re-seal sweep) is Track 3's first
pull request and merges before M7, M8 and M9, because M7 and M8 emit their SLI metrics through its writer
and M9's G3 (`it::ops::provider_quota_80`) and M23's N26 (`ses_identities_90pct`) fire through its
evaluator; **M17 Completion** (J3, every metric emitted, the SLOs) is accepted at M20, because it
measures what later milestones build. No milestone depends on one that comes later in this graph.
Tracks never edit the same files. Shared files (`router.rs`, `wrangler.toml` template, `0001_init.sql`)
are changed only by the track that owns them, as listed per milestone.

**Shared files.** These files are changed by milestones that can run at the same time, so they have a
rule of their own:

- `quota/mod.rs`, the `TenantQuota` object. M5 creates it with every `QuotaRequest` variant already
  answered by a stub (below), and declares the billing types the stub needs to compile (`Feature`,
  `BillingMode`, `Allowances`, the `Hold` and `SetPlan` payloads and the `Held` and `Denied` answers), so
  later milestones replace the behaviour of the variants they own and never change a signature: M9
  (`Reserve`, `Release`, `RecordOutcome`), M11 (`CountAgentic`), M22 (the allowance variants, through
  `billing/quota.rs`), M24 (`OutcomeRates`) and M26 (the `NotifierRequest::UsageThreshold` hook).
- `consumers/index.rs`, the `pm-index` consumer. M7 creates it for attachment text, M10 adds chunking,
  embedding and reconciliation, and M12 the triage job. M7 writes the whole `IndexJob` enum
  ([Search § 6](design/search.md#6-indexing-pipeline-pm-index)), so each later milestone fills in only the
  arm of its own job kind.
- `billing/webhook.rs`, the Stripe webhook handler. M22 creates it; M24 adds the `ramp_lifted_at` update
  when a workspace moves to a paid plan, and M26 the `Account { event: payment_failed }` hook.
- `jobs/erasure.rs`, tenant and person erasure. M14 creates it with every step and the named stubs of its
  table (below); M21 (console rows), M22 (`cancel_billing` and the billing rows), M23 (the
  `pm-retired-{n}` entries), M24 (person deletion) and M26 (the Notifier rows) each fill in their own stub.
- `jobs/retention.rs`, the global retention job. M14 creates it with the job framework and the steps whose
  tables have writers by then; M21 (`console`), M22 (`billing_events`), M23 (`ses_ingest`), M24
  (`signup`) and M25 (`identity_keys`) each add their own step and its test. If M23 or M25 lands before
  M14, M14 writes that step, and the milestone's test runs once M14 has landed.
- `crates/core/src/sealed.rs`, the registry of columns sealed under `PM_MASTER_KEY`. M17 Foundation
  creates it with the columns written by then (`signing_keys.ciphertext`); each milestone that writes a
  sealed column adds its entry and its case in `it::secrets::master_key_rotation`: M8 (webhook secrets),
  M23 (SMTP credentials), M24 (second factors and PKCE verifiers) and M25 (identity keys). M25 is the only
  one that can land before M17 Foundation; if it does, M17 Foundation adds its entry.

Each change to one of these files has one owner, the milestone that needs it. When two tracks change the
same file at once, the one that merges second rebases onto the other and re-runs the gate; neither edits
the other's arm.

---

## M0 · Repository skeleton and CI

**Files:** `Cargo.toml` (workspace, `[workspace.dependencies]` pinned per
[Rust workspace](design/rust-workspace.md)), `rust-toolchain.toml`, `crates/{core,platform,api-types,worker,sdk,cli,conformance}/`,
`xtask/`, `.github/workflows/ci.yml`, `deny.toml`, `.cargo/config.toml`, `migrations/d1/`,
`deploy/wrangler.toml.tmpl`.

**Implements:** the workspace and dependency rules in `AGENTS.md`, and the size check of NFR-SEC-2.

### Human prerequisites

A coding agent cannot create these. A person provides each one before the milestone or spike that
needs it, and stores the credential under the name in the last column. Local values go in the shell or in
`spikes/.env` (git-ignored); CI values are GitHub Actions secrets on `PILOTAAI/pylota-mail`, in the
environment named in brackets. Nothing in this table is ever committed.

| Item | Who provides it | Needed by | Secret or config name |
|---|---|---|---|
| A Cloudflare account on the Workers Paid plan | Owner (TREFT LTD) | M1 (every spike except S10 and S13), M18 nightly evaluations, M20 | `CLOUDFLARE_ACCOUNT_ID` (local); `PM_CF_ACCOUNT_ID` (written by `pmail setup`); Actions: `PM_EVAL_CF_ACCOUNT_ID`, `STAGING_CLOUDFLARE_ACCOUNT_ID` [`staging`] |
| The `pylotamail.com` zone in that account (bought 2026-10-09, [Cloud sign-up §2](design/cloud-signup.md#2-hostnames)), plus a separate staging zone apex | Owner | M1 (S2, S7, S9 use a scratch zone or the staging zone), M20 | `PM_PLATFORM_DOMAIN`, `PM_API_HOST`, `PM_CONSOLE_HOST` in `deploy/wrangler.toml` |
| The setup API token, with the permissions in [Deploy › step 2](../self-hosting.md#2-create-a-cloudflare-api-token) | Owner | M1, M20 | `CLOUDFLARE_API_TOKEN` (local, used by `pmail` and Wrangler); `PM_CF_API_TOKEN` (Worker secret, a separate token with the "Worker token" permissions of that table, stored by the operator with `wrangler secret put`, [Deploy › Domains on Cloudflare](../self-hosting.md)); Actions: `STAGING_CLOUDFLARE_API_TOKEN` [`staging`] |
| A Workers AI API token for the nightly evaluations | Owner | M18 | Actions: `PM_EVAL_CF_API_TOKEN` (repository secret, Workers AI read only) |
| A Cloudflare Enterprise account (optional) | Owner, through Cloudflare sales | S10 only | `S10_CLOUDFLARE_ACCOUNT_ID`, `S10_CLOUDFLARE_API_TOKEN` in `spikes/.env`. **S10 may be skipped:** without it `delegated_subdomain` stays off (`PM_CF_SUBDOMAIN_SETUP=off`) and the spike result says "skipped, no Enterprise account" |
| An AWS account with SES production access in `eu-west-2` (London, decided 2026-10-09), on the à la carte plan | Owner; production access is requested in the AWS console and approved by AWS, which can take a day | S8, S11, then M23 and M20 step 5 | `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE` (local); `PM_SES_ACCESS_KEY_ID` and `PM_SES_SECRET_ACCESS_KEY` (Worker secrets, written by `pmail setup ses`); Actions: `STAGING_AWS_ACCESS_KEY_ID`, `STAGING_AWS_SECRET_ACCESS_KEY` [`staging`] |
| Two real SMTP submission providers (for example a Google Workspace mailbox and a Microsoft 365 mailbox), each with a sending account on a test domain | Owner | S12 | `S12_SMTP_A_HOST`, `S12_SMTP_A_USERNAME`, `S12_SMTP_A_PASSWORD`, and the same for `S12_SMTP_B_*`, in `spikes/.env` |
| Gmail (Google Workspace) and Microsoft 365 test mailboxes holding only synthetic mail, with API access for the harness | Owner | M20 (the live suite) | Actions: `STAGING_GMAIL_CLIENT_ID`, `STAGING_GMAIL_CLIENT_SECRET`, `STAGING_GMAIL_REFRESH_TOKEN`, `STAGING_M365_TENANT_ID`, `STAGING_M365_CLIENT_ID`, `STAGING_M365_CLIENT_SECRET` [`staging`] |
| A domain at an external DNS provider (not Cloudflare) and that provider's API token | Owner | M20 step 5 (`live::domains::dns_records_external_host`) | Actions: `STAGING_EXTERNAL_DNS_TOKEN`, `STAGING_EXTERNAL_DOMAIN` [`staging`] |
| A staging platform key (90-day expiry) | Created by the agent with `pmail keys create` on staging; stored by a person | M20 | Actions: `STAGING_PLATFORM_KEY` [`staging`] |
| A Stripe account in test mode | Owner | M22 (recorded fixtures), M20 step 11 | `PM_STRIPE_SECRET_KEY` (a restricted key, `rk_test_…`) and `PM_STRIPE_WEBHOOK_SECRET` (Worker secrets on staging); Actions: `STAGING_STRIPE_SECRET_KEY`, `STAGING_STRIPE_WEBHOOK_SECRET` [`staging`] |
| A Google OAuth client and a GitHub OAuth app, with redirect URLs on the staging and production console hosts | Owner | M24 (its gate re-reads both providers' documentation), M20 step 10 | `PM_OAUTH_GOOGLE_CLIENT_ID`, `PM_OAUTH_GITHUB_CLIENT_ID` (variables); `PM_OAUTH_GOOGLE_CLIENT_SECRET`, `PM_OAUTH_GITHUB_CLIENT_SECRET` (Worker secrets) |
| The minisign release key pair, generated offline by a person (`minisign -G`) | Owner | M19 | Secret key: Actions `MINISIGN_SECRET_KEY` and `MINISIGN_PASSWORD` [`release`]. Public key: compiled into `pmail` as the `current` key ([CLI and setup §8.2](design/cli.md#82-signature-and-checksums)); a second key pair becomes `next` before the first rotation |
| Optional: registration of the production deployment's Web Bot Auth key directory (`https://{PM_API_HOST}/.well-known/http-message-signatures-directory`) with Cloudflare's verified-bot programme (dashboard, "Bot Submission Form", verification method "Request Signature"; [Deploy › Signed HTTP requests](../self-hosting.md#signed-http-requests-web-bot-auth)) | Owner, after M25 ships with S13 passed and `PM_WEB_BOT_AUTH=on` | No milestone or test: signatures verify for any Web Bot Auth verifier without it, and S13 expects the unregistered `401` | None (a dashboard form; nothing to store) |
| The GitHub repository `PILOTAAI/pylota-mail` (created 2026-10-09), with Actions enabled, the environments `staging` (one required reviewer, `main` and `v*` tags only) and `release` (`v*` tags only), and branch protection on `main` | Owner | M0 | Actions: `CARGO_REGISTRY_TOKEN` [`release`], for `cargo publish`; every other secret above |

A milestone whose prerequisite is missing stops and reports which row is missing. It never substitutes a
fake for a spike's real provider.

**Acceptance:**

- `cargo test --workspace` passes on an empty test per crate.
- `cargo xtask build-worker` builds a "hello" Worker to wasm. The `worker` attribute macros are never
  used in `crates/worker` ([Rust workspace §2](design/rust-workspace.md#2-crate-responsibilities-and-allowed-dependencies)),
  so M0 writes a minimal `platform::export_worker!` that exports only a `fetch` answering `200`; spike S1
  validates its glue against the real runtime, and M4 extends it to the other handlers and the Durable
  Object classes. The size check runs and passes, and from here on enforces NFR-SEC-2 on every pull
  request: the compressed bundle stays ≤ 10 MiB (`xtask::size_budget`).
- CI runs these jobs: fmt, clippy, native tests, wasm build, `cargo deny check`, `mdbook build docs`.
- A CI check fails if any crate other than `platform` depends on `worker`
  (`cargo xtask check-layering`).

---

## M1 · Spikes (each one gates design choices)

Run against a scratch Cloudflare account and zone. Each spike is a small program under `spikes/` (not
shipped), plus a written result.

| Spike | Prove | Pass criteria | If it fails |
|---|---|---|---|
| S1 Bindings smoke | From Rust with `worker` 0.8.7, through the `platform::export_worker!` entry glue (which replaces `#[event]` and `#[durable_object]`, see [Rust workspace](design/rust-workspace.md#2-crate-responsibilities-and-allowed-dependencies)): receive an email event and read `from`, `to`, headers and the raw stream; send with the `send_email` binding's structured `send()` including `replyTo`, `headers` (`In-Reply-To`, `References`, `Auto-Submitted`, `X-*`) and attachments (`attachment` and `inline` with `contentId`); produce and consume Queues with `delay_seconds` and `retry_with_options`, and confirm that `Message::timestamp()` is unchanged across retries; DO SQLite with the `transactionSync` extern (a thrown error rolls back) and alarms; D1 `batch`; a multi-statement request to the D1 query API (`POST /accounts/{a}/d1/database/{id}/query`); and the response of the local `wrangler dev` email endpoint to a `setReject` ([Testing §6.4](design/testing.md#64-injecting-inbound-mail)) | Every call works from Rust. The returned `messageId` is captured. A rolled-back transaction leaves no rows. A multi-statement D1 query-API request is atomic: when its last statement fails, none of the earlier statements' rows remain | Raw MIME send (`EmailMessage`) built with `mail-builder` for any missing structured field. If the entry glue cannot replace the macros: an ADR allowing exactly one file, `crates/worker/src/entry.rs`, to use them ([Rust workspace §2](design/rust-workspace.md#2-crate-responsibilities-and-allowed-dependencies)). If the D1 query API is not atomic: every migration file is made re-runnable and a CI lint enforces it ([CLI and setup §8.5](design/cli.md#85-d1-migrations)). **`transactionSync` has no fallback; this is an accepted risk.** The planned path is a `wasm-bindgen` call to `ctx.storage.transactionSync`, which Cloudflare documents with no restriction on the calling method beyond a SQLite-backed object ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), read 2026-10-09), so any JS method of the class, including the glue's, may call it. If S1 shows otherwise, the build stops and an ADR is written before M4 continues. The owner accepted this risk on 2026-10-09 |
| S2 Inbound failure semantics | What the sending MTA sees when `email()` throws, versus `setReject` (documented as a permanent error); which `Authentication-Results` headers reach the handler | Throwing yields a 4xx temporary failure and the sender retries. The exact SMTP reply text for both cases is recorded. Record which `Authentication-Results` authserv-id Cloudflare stamps on delivered mail (setup later writes it to `PM_TRUSTED_AUTHSERV_ID`, [Inbound › Authentication verdict](design/inbound.md#authentication-verdict)) | **Throw only.** The handler keeps its in-handler R2 retries (three attempts) and then throws, as designed, whatever the sender is shown; the spike result records the observed reply in [Inbound](design/inbound.md#interface). There is no `forward()` to a backup address: setup registers no Email Routing destination address ([Identities and domains › Cloudflare API token](design/identity-domains.md#cloudflare-api-token-permissions)), so none exists to forward to |
| S3 FTS5 in DO SQLite | `content='', contentless_delete=1`, the `trigram` tokenizer, `bm25()` with six column weights, `DELETE FROM fts WHERE rowid = ?`, and renaming an FTS5 table (for the index swap in [Search](design/search.md)) | All work on the deployed runtime, not only on local workerd | External-content table `fts_docs` ([Data model](design/data-model.md)); disable trigram and rely on reference normalisation plus semantic fallback; without rename, the swap rebuilds `fts` in place |
| S4 Wasm budget | Bundle size, cold start, CPU time and peak memory when parsing and verifying a 25 MiB message and a 40 MB message from the SES source ([N5](edge-cases.md)), and `mail-auth` verdict parity on the corpus | Compressed bundle ≤ 10 MiB (NFR-SEC-2), cold start under 1 s, both messages parsed under 128 MB peak and inside the CPU limit, DKIM and DMARC verdicts equal the reference implementation on every corpus message | Write attachments to R2 before parsing bodies; move heavy features behind cargo features; switch the release profile to `opt-level = "z"` |
| S5 MCP over rmcp | Streamable HTTP served from `fetch` using `rmcp` 3.4.1 protocol types, without a tokio runtime. Note: `rmcp` 3.4.1 (like 3.5.1) declares `tokio` (features `sync`, `macros`, `rt`, `time`) as a non-optional dependency (crates.io metadata, read 2026-10-10) | MCP Inspector and Claude Code connect, list tools and call one; the wasm build never starts a tokio runtime or timer, and the bundle stays inside the S4 budget | Implement the JSON-RPC types locally in `worker`; keep `rmcp` as a native dev-dependency for client tests. **Taken in advance** ([ADR 0009](adr/0009-local-mcp-protocol-types.md)): M1 still runs S5 against the local types to record the Inspector and Claude Code result |
| S6 Externs and jurisdiction | Vectorize `upsert`, `query` (namespace and metadata filter), `deleteByIds`, `getByIds` and `describe()` (the vector count); `AI.run` with the `gateway` option, including the `bge-m3` output shape, the reranker's score form and the agent model's chat-completions schema ([Search](design/search.md)); `AI.toMarkdown` (including whether PDF output marks page boundaries) — all through `wasm-bindgen` externs; DO IDs from `unique_id_with_jurisdiction("eu")` stored as strings and re-addressed with `id_from_string` | Every call works and each recorded shape matches the design, or the design is updated with the observed one. An EU object reports the EU jurisdiction (`ctx.id.jurisdiction`) | REST fallbacks (`/vectorize/v2/…`, `/ai/run`, `/ai/tomarkdown`) using `PM_CF_API_TOKEN`, which then becomes required ([Rust workspace §7](design/rust-workspace.md#7-wasm-bindgen-externs)); one page per document when `toMarkdown` does not mark pages. If an EU object does not report the EU jurisdiction, the build stops for an owner decision, because FR-PRV-1 depends on it |
| S7 Outbound Message-ID | The relationship between the `messageId` that `send()` returns and the `Message-ID` header recipients see | Either a deterministic mapping (strategy A), or the header learned from a journal copy (strategy B) | Strategy B: a hidden journal BCC to `journal+{message ulid}.{identity ulid}@{PM_PLATFORM_DOMAIN}`; the email handler records the header and drops the copy ([Outbound](design/outbound.md#message-id-of-outbound-mail-spike-s7)). If a journal copy never arrives, that message matches replies by thread token and provider ID only |
| S8 SES in wasm | SigV4 signing for SES v2 `SendEmail` with raw content, and SNS message signature verification (`SignatureVersion` 2; version 1 is refused), from Rust in wasm | A real send through SES in `eu-west-2`; a real SNS notification verified, and a tampered one rejected | SES leaves v1.0: an ADR moves `send_only`, `dns_records`, `smtp_relay` with `inbound: ses` and the SES failover to v1.1 |
| S9 Event subscriptions and onboarding APIs | Create an Email Sending event subscription to `pm-delivery-events` through the API for one domain (source type `email.sending` with `zone_id` and `domain`; this source shape appears in Wrangler's source, not yet in the API reference), receive all six event types, delete it. Onboard a zone **apex** and a subdomain through `POST /zones/{zone_id}/email/sending/subdomains`, and enable routing on a subdomain through `POST /zones/{zone_id}/email/routing/dns` with `name`. A literal routing rule whose `worker` action value is the script name `pylota-mail` delivers to the Worker | Payload fields match [Outbound › Delivery events](design/outbound.md#delivery-events); subscriptions can be created per domain at runtime with `PM_CF_API_TOKEN`; apex and subdomain onboarding both work through the API | For `cloudflare_zone` and `nameservers`, the API creates the domain without a subscription, marks it `delivery_events: "manual"`, and returns its records with `details.action = "run pmail domains subscribe <domain>"`; delivery events start once that command has run ([Identities and domains › Kind `zone`](design/identity-domains.md#kind-zone), tests `it::domains::s9_manual_delivery_events` and, for `nameservers`, `it::domains::s9_manual_delivery_events_nameservers`). Any onboarding step the API cannot do is listed by `pmail domains add` as a dashboard step and checked by `pmail doctor` |
| S10 Child zones | On an Enterprise account, a subdomain-setup child zone accepts Email Routing catch-all to the Worker and Email Sending onboarding, and both work end to end. Optional: skipped when no Enterprise account is available ([Build plan › Human prerequisites](#human-prerequisites)) | Mail to any address at the child apex reaches `email()`; a send is DKIM-aligned | `delegated_subdomain` stays off; `dns_records` covers the case |
| S11 SES receiving | Rule set, S3 action and topic as specified; the notification shape, including the `objectKey` form; S3 `GetObject` with SigV4 from a Worker; a 39 MB message ([N5](edge-cases.md)); `user+tag@` routing; the retired-address bounce; the backstop picks up a message whose push failed | All pass in `eu-west-2` | `dns_records` and `smtp_relay` with `inbound: ses` do not ship in v1.0; `send_only` still does |
| S12 SMTP from a Worker | Ports 465 and 587 with `StartTls` against two real providers; the certificate host name is checked (a wrong-name certificate is refused); timeouts and the uncertain window behave as designed | All pass | `smtp_relay` does not ship in v1.0 |
| S13 Web Bot Auth format | A request signed by `core::httpsig` with the deployment key (`Signature-Agent` as a quoted structured-field string; `Signature-Input` covering `@authority`, `signature-agent` and `from`, with `tag="web-bot-auth"`, `keyid` = the JWK thumbprint, `created`, `expires` and a 64-byte nonce), sent to `https://crawltest.com/cdn-cgi/web-bot-auth`, which answers `401` for a well-formed message with an unknown key, `200` for a known key that verifies and `400` otherwise ([Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/), read 2026-10-09). Needs no Cloudflare account | `401` before the key directory is registered (well-formed, unknown key), never `400` | Signed HTTP requests stay off in v1.0: `PM_WEB_BOT_AUTH` cannot be turned on ([Agent signing keys](design/agent-keys.md#5-signed-http-requests-web-bot-auth)). Agent assertions are unaffected |

**Gate:** every spike has a written result. Design documents are updated where a fallback was taken.

---

## M2 · Core logic (`crates/core`, no I/O)

**Files:** `crates/core/src/{ids.rs, address.rs, thread_token.rs, thread.rs, reply.rs, mime/, sanitize.rs, text.rs, quote.rs, refs/, classify.rs, auth.rs, trust.rs, attach.rs, query/, fusion.rs, citations.rs, triage_rules.rs, policy.rs, dns.rs, domain_fsm.rs, injection.rs}`,
`crates/conformance/corpus/`, `fuzz/`.

**Implements:** the parsing and decision logic behind FR-ADR-6/7, FR-IN-3, 6, 7 and 9, FR-THR-1,
FR-SRCH-3/4/8 (verifier), FR-TRI-2, FR-DOM-4/5 (the pure state machine).

**Acceptance:**

- Unit tests for every `core::` row in sections A–H of the edge-case register (section N's are in M23):
  A1–A4, A12, B2, B4–B11, B13, C1, C2,
  C8, D1–D3, D6, D8, D9, E1, F1, F5, F9, F11, H2, H3, H7. (D10's test is `it::inbound::d10_token_bruteforce`,
  which needs the mailbox's `rate_windows`, so it belongs to M7.)
- A property test for the query parser: every input parses or returns `invalid_query`, and every
  compiled FTS expression contains only quoted terms.
- A property test for thread tokens: round-trip works, and any bit flip fails verification.
- A conformance corpus of at least 300 messages, covering Gmail, Outlook, Apple Mail, Thunderbird,
  mailing lists, DSNs (RFC 3464), MDNs, calendar, TNEF, S/MIME, PGP, charsets and malformed input.
  Each message has an expected JSON output.
- Fuzz targets `mime_parse`, `query_parse`, `address_parse`, `sanitize` and `dsn_parse` each run for
  60 seconds in CI without a crash.
- `crates/core` builds for `wasm32-unknown-unknown`.

---

## M3 · API types and OpenAPI

**Files:** `crates/api-types/src/{lib.rs, errors.rs, objects/*.rs, requests/*.rs, events/*.rs, openapi.rs}`.

**Implements:** FR-API-1/2, plus the types for every object in [REST API](../reference/api.md) and
[events](../reference/events.md).

**Acceptance:**

- `cargo test -p pylota-mail-api-types` generates `openapi.json` with `utoipa`, and a test compares it
  semantically (paths, methods, schemas, enums, required fields) with `docs/src/reference/openapi.yaml`.
  Any difference fails.
- Every error code in [Errors](../reference/errors.md) exists in the `ErrorCode` enum with its HTTP
  status and `retryable` flag, checked by a table test.
- Serde round-trip tests for every object, using the examples in `openapi.yaml`. The examples in `api.md`
  are not used: they elide fields (`"…"`), so they are not complete objects.

---

## M4 · Platform crate

**Files:** `crates/platform/src/{lib.rs, clock.rs, rng.rs, d1.rs, durable.rs, r2.rs, queues.rs, ai.rs, vectorize.rs (extern), email.rs, ratelimit.rs, dns.rs (DoH), http.rs, fakes/}`.

**Implements:** the trait set in [Rust workspace and platform](design/rust-workspace.md), with
Cloudflare implementations and in-memory fakes for native tests.

**Acceptance:**

- Each trait has a fake used by native tests in `worker` logic modules.
- The DoH resolver parses the JSON answers from both configured resolvers. A test uses canned
  responses for TXT, MX, NS and CNAME, including NXDOMAIN and SERVFAIL.
- Only this crate depends on `worker`, enforced by `check-layering`.

---

## M5 · Worker base: routing, auth, tenants, keys

**Files:** `crates/worker/src/{lib.rs, router.rs, auth.rs, errors.rs, ratelimit.rs, request_id.rs, keyring.rs, handlers/{meta.rs, tenants.rs, partners.rs, keys.rs, audit.rs}, db/{mod.rs, tenants.rs, partners.rs, keys.rs, audit.rs, idempotency.rs, signing_keys.rs}, quota/mod.rs}`,
`crates/core/src/{keys.rs, crypto.rs}` (key format and the sealing envelope, pure)
(`TenantQuota` as a stub class that answers every `QuotaRequest` variant, see below),
`migrations/d1/0001_init.sql` (every D1 table and index in [Data model](design/data-model.md), including those that
later milestones use: the console, billing, sign-up and domain-method tables and columns),
`crates/worker/tests/` harness (`cargo xtask itest`).

**Implements:** FR-TEN-1/2/3, FR-KEY-1/2/3/4, NFR-SEC-1 (the cross-tenant suite), the error envelope, rate limits, request IDs,
idempotency for non-mail POSTs, and the thread and link keyring (`signing_keys`, created on first use;
[Security](design/security.md#62-rotation-procedures)).

**Partners and partner keys** (FR-KEY-4) land here with the other key levels: the `partners` table and
the `partner_id` columns of `tenants`, `api_keys` and `webhook_endpoints`, `tenants.suspended_by` and
`policy_ceilings_json`, `partners.max_tenants` and `ramp_exempt`, `zone_claims` and
`event_index.partner_id` (all in `0001_init.sql`); the five `/v1/partners` routes, with the soft delete;
`level: "partner"` in `POST /v1/keys`; the partner checks of authentication (`403 partner_suspended` for
the partner's keys and for its tenants' keys) and of the owner check, which compares only a partner key's
own `partner_id` with a tenant's, so a `NULL` never matches
([Security › Partner keys](design/security.md#partner-keys)); `POST /v1/tenants` with a partner key (its
`partner_id`, `default_billing_mode`, `max_tenants` and `RL_PARTNER`, `RlBucket::Partner`); the
per-field policy classes and platform ceilings of
[Configuration › Who may change a field](../reference/configuration.md#who-may-change-a-field);
`suspended_by`; the frozen `erasing` and `erased` tenant for non-platform writes; idempotency records
keyed by the calling key, with one-time secrets stripped; and the `foreign_partner` class of the
cross-tenant suite. Partner endpoints (`POST /v1/webhooks` with a partner key, and their scoped delivery)
land with the webhook routes in M8, and `quarantine.key_release` with the release route in M7.

**The cross-tenant matrix grows with each route family.** J10's matrix (`it::security::cross_tenant_matrix`
with its `foreign_partner` class, and `it::partners::j10_foreign_partner_not_found`) starts here with the
tenant, partner and key routes. Each milestone that adds a route family extends both in the same pull
request: M6 the identity and address routes, M7 the message, thread and quarantine routes, M8 the webhook
endpoint routes, and M13 the domain routes, with M13 also adding the `foreign_zone` case
([H8](edge-cases.md)).

**Tenants without owner or billing behaviour.** `POST /v1/tenants` accepts `owner` and `billing` as
[REST API](../reference/api.md) specifies, validates them, and stores them: the owner's `users` and
`members` rows and the `billing_accounts` row. Nothing acts on them yet. The owner's sign-in link is sent
once M21 lands, and plan checks run once M22 lands; until then holds always succeed, as in billing mode
`disabled`. Each tenant gets its `TenantQuota` object (`quota_do_id`, then `QuotaRequest::Init`).
`notify_do_id` is written as `''` until M26 mints a `Notifier` with the tenant row; from M26 the
every-minute cron also mints one for each row still at `''`
([Data model](design/data-model.md#1-d1-control-plane)).

**The `TenantQuota` stub.** `quota/mod.rs` declares the whole `QuotaRequest` enum of
[Outbound › TenantQuota](design/outbound.md#tenantquota) and
[Plans, metering and billing](design/billing.md#tenantquota-allowances-and-holds) now, and the stub
answers every variant, so a milestone that calls `TenantQuota` before the one that owns a variant gets a
well-formed answer. Later milestones replace behaviour, never a signature:

| Variants | Stub behaviour from M5 | Replaced by |
|---|---|---|
| `Init` | Stores the owner in `meta`; every other request checks it | final |
| `Reserve`, `Release` | `Reserve` takes its `sends` hold as `Hold` does and counts the day's `sends:{identity_id}` counter, and the tenant `sends` counter unless `tenant_cap` is `None` (the system identity), without enforcing a cap; `Release` decrements the same counters (`sends` only when `tenant_counted`) | M9: daily caps (`CapReached`) and `quota.warning` thresholds |
| `RecordOutcome` | Records the outcome in `outcomes` and the tenant's per-day outcome counters; never pauses an identity | M9: abuse auto-pause (FR-DLV-3) |
| `OutcomeRates` | Zero counts (`{ outcomes: 0, bounced: 0, complained: 0 }`) | M24: sums the tenant's outcome counters for the send ramp |
| `CountAgentic` | Counts `agentic` for the day and `usage:agentic`; always `Ok { used }` | M11: the tenant daily cap (`CapReached`) |
| `RecordUsage` | Adds to `usage:{metric}` for the current UTC day | final |
| `ForgetIdentity` | Deletes the identity's `outcomes` rows and `sends:{identity_id}` counters | final |
| `Hold` | Always grants (`Held`), as in billing mode `disabled` | M22: allowances and holds |
| `Settle`, `Extend`, `Adjust`, `SetPlan`, `SetMeasured`, `Reconcile` | No-ops that answer `Ok` | M22 |
| `GetUsage` | The usage counters, with no allowances (`billing: disabled`) | M22 |

**Acceptance:**

- `it::auth::*`: unknown, expired and revoked keys; missing permission; key scope exceeded.
- A cross-tenant suite skeleton: for every registered route, a key from another tenant gets an
  indistinguishable `404`. The suite enumerates the router table, so a new route without a test fails.
- `it::keys::j6_revoke_rotate`, with `GET /v1/audit-events?actor_key_id=`.
- The keyring creates one key per purpose under concurrency and opens it with `PM_MASTER_KEY`
  (`core::keys::format_round_trip`, `core::crypto::envelope_round_trip`).
- Idempotent `POST /v1/tenants` replays and conflicts; `owner` and `billing` are stored but send no mail
  and change no limit; the tenant's `TenantQuota` answers `Init`, refuses a mismatched owner, and answers
  every other variant as the stub table says (a worker-logic test sends each one).
- `/health`, `/v1/me`, `/openapi.json` and `/.well-known/security.txt` are served (the last as
  [Security](design/security.md) specifies, from `PM_SECURITY_CONTACT`).
- J6 (`it::keys::j6_revoke_rotate`, above).
- Partners (FR-KEY-4): `it::partners::routes_and_audit`; `it::partners::policy_caps_lower_only` (its
  `send_policy.daily_cap` cases are added in M6 with the identity routes); J10
  (`it::partners::j10_foreign_partner_not_found`, and the `foreign_partner` class of
  `it::security::cross_tenant_matrix`, for this milestone's routes); J11
  (`it::keys::j11_partner_key_limits`); J18 (`it::partners::j18_partner_limits`: `max_tenants` and
  `RL_PARTNER`); a partner key's requests counted in `RL_API` by key ID (`it::auth::rate_limited`). The
  authentication part of J13 runs here (`it::partners::j13_suspended_partner`: partner and tenant keys
  refused with `403 partner_suspended`); J13 is accepted in M9, once inbound storage (M7), held deliveries
  (M8) and the send path (M9) exist. The `suspended_by` and ceiling parts of J17 run here too; J17 is
  accepted in M9 with its abuse-pause part. The key part of J19 (`POST /v1/keys` and key rotation) runs
  here; J19 is accepted in M8 with the webhook secrets. `DELETE /v1/partners/{partner_id}` ships here with
  its `409 partner_has_tenants` and soft delete; J12 is accepted in M14, because its test erases the
  partner's tenant first.
- NFR-SEC-1: the cross-tenant suite (`it::security::cross_tenant_matrix`), with its `foreign_partner`
  class, finds 0 cross-tenant reads or writes. Every later milestone extends it with its routes, and it
  must stay at 0.

**One migration until v1.0.** `0001_init.sql` holds every table until v1.0 is released. No later
milestone adds a D1 migration: M6–M26 change code only. A milestone that finds a missing column or table
fixes `0001_init.sql` itself (no deployed database exists before M20) and updates
[Data model](design/data-model.md) in the same pull request. Migrations `0002_…` onwards start after v1.0,
under the expand-then-contract rule ([CLI and setup §8.5](design/cli.md#85-d1-migrations)).

**Owner of shared files from here:** Track 1 owns `router.rs` and `0001_init.sql`. Other tracks add routes
through `handlers/<area>.rs` plus one registration line, reviewed by Track 1.

---

## M6 · Identities, addresses, platform domain (Track 1)

**Files:** `handlers/{identities.rs, addresses.rs (list and get; the platform address is created with
the identity), domains.rs (platform domain read only)}`, `db/{identities.rs, addresses.rs, domains.rs}`,
`mailbox/mod.rs` (IdentityMailbox shell with schema-on-wake), `mailbox/outbox.rs` (the transactional
outbox, its dispatch alarm, the `event_index` writes and the `pm-webhooks` producer;
[Webhooks and events](design/webhooks.md#transactional-outbox)), `webhooks/envelope.rs` (the event
envelope builder, the `WebhookJob` queue message and the `identity_*` and `address_*` payload builders,
which the outbox needs before M8 exists; M8 imports it), `jobs/mod.rs` as a `JobRunner` stub (below), and
the system identity's mailbox minting in the every-minute cron.

**Implements:** FR-IDN-1–4, FR-ADR-5–7, FR-DOM-1 (platform), the outbox and event index, and the system
identity ([Identities and domains](design/identity-domains.md#the-system-identity)). FR-ADR-1–4 (several
addresses, promotion, retirement and rollback) need a tenant domain and land in M13.

**Identity deletion before M14.** `DELETE /v1/identities/{identity_id}` runs its whole D1 batch
([Identities and domains › Delete](design/identity-domains.md#delete-fr-idn-4-a13)): tombstones, address
removal, `status = 'deleting'`, and the `jobs` and `erasure_requests` rows. Until M14 the `JobRunner` is a
stub that accepts `JobRequest::Start` and runs no step, so the job stays `queued` and the identity
`deleting`. M14 replaces the stub with the real `JobRunner`, whose every-minute restart of jobs left
`queued` picks these up.

**Acceptance:** A5, A12, J9, the identity and address routes added to J10's matrix
(`it::security::cross_tenant_matrix`, `it::partners::j10_foreign_partner_not_found`), the
`send_policy.daily_cap` cases of `it::partners::policy_caps_lower_only`, plus `identity.created`, `identity.updated`,
`identity.paused` and `identity.resumed` events that reach the outbox, `event_index` and a `pm-webhooks`
message (consumed once M8 lands); a crash between commit and dispatch repeats the dispatch, never loses
it. The system identity is never listed and refuses tenant keys. The pause itself
(`PATCH /v1/identities/{identity_id}` with `status: "paused"` or `"active"`) ships here. Rows that need a
later milestone are accepted there: A7 in M9 (its only test, `it::send::a7_paused_refuses_send`, needs
the send path), A13 in M7 (it needs `email()`), A8 in M9 (`it::send::a8_owner_required`), and A11, A14
and the promote, retire and rollback flows in M13 (they need a tenant domain).

---

## M7 · Inbound (Track 1)

**Files:** `email.rs` (handler), `consumers/inbound.rs`, `mailbox/{ingest.rs, threads.rs, messages.rs, attachments.rs, schema/v1.sql}`,
`handlers/{threads.rs, messages.rs, quarantine.rs, wait.rs}`, `consumers/index.rs` (attachment text only at
this stage), `crates/api-types/src/internal/index_job.rs` (the whole `IndexJob` enum, so M10 and M12 only
fill in their arms).

**Implements:** FR-IN-1–9, FR-THR-1/2, NFR-REL-1/2, read APIs, quarantine and release (with the
`quarantine.key_release` override of FR-CON-6 for API keys), and `wait`
([Inbound › The `wait` handler](design/inbound.md#the-wait-handler-e4)), which is P0 because quarantine
rule 5 (E5) depends on its registrations.

**Acceptance:** A2, A6 (`it::inbound::a6_reject_codes`; its SES part in M23), A9, A10 (inbound part), A13, B1 (documented), B3, B12, B14, C1, D4, D5, D9, D10,
E4 (`it::wait::e4_*`), E5, J1, J2, J7, J14 (`it::quarantine::j14_key_release_policy`), J16
(`it::quarantine::j16_key_release_override`), the message, thread and quarantine routes added to J10's
matrix, and every `conf::` corpus case ingested end to end through workerd.
Rows whose inbound side needs a later milestone are accepted there: C7 (it matches replies to outbound
mail), D7 (suppressions and lists) and loopback L3 in M9, and C3 (a retiring address) and A4's role-mail
routing (it sends a new message and needs a tenant domain) in M13.
NFR-REL-1 is checked with a canary, because the only emitter of `inbound_lost_total` is the global
retention `staging` step, which comes with M14: under the J1, J2 and J7 fault injections, every message
that `email()` accepted is found exactly once through the read API after the queues drain, and
`inbound_raw_missing_total` stays 0 (`it::inbound::nfr_rel1_no_loss_canary`). NFR-REL-2: the inbound SLI
counters of [Observability §4](design/observability.md#4-service-level-objectives) are emitted for accepted, staged and
temporarily failed mail.

---

## M8 · Webhooks (Track 2, after M6)

**Files:** `handlers/webhooks.rs`, `consumers/webhooks.rs`, `webhooks/{sign.rs, client.rs, replay.rs, payloads.rs}`
(it imports the envelope, `WebhookJob` and the identity payload builders from M6's `webhooks/envelope.rs`),
`crons/outbox_sweep.rs`, the SSRF guard `crates/core/src/ssrf.rs` (pure) and `crates/worker/src/net.rs` (guarded HTTP)
([Webhooks](design/webhooks.md), [Security § 9](design/security.md#9-ssrf-controls)).

**Implements:** FR-WH-1–5, NFR-REL-4, and the partner endpoints of FR-KEY-4 (`scope: "partner"`).

**Acceptance:**

- Signature vectors from the Standard Webhooks spec verify.
- Rotation sends two signatures.
- The SSRF table refuses loopback, RFC 1918, link-local, CGNAT, `::1`, `fc00::/7` and
  `169.254.169.254`, and does not follow redirects (`core::ssrf::refuses_private_ranges`).
- J4: a time-controlled harness checks the retry schedule.
- Replay.
- Auto-disable on `410` and on 100 consecutive failures.
- J15: partner endpoints receive only their partner's tenants' events, by fan-out and by replay, and
  `webhook.disabled` for a partner endpoint reaches that partner's other endpoints and platform endpoints
  (`it::webhooks::j15_partner_scope_filter`), with replay selecting on `event_index.partner_id` and never
  replaying `webhook.test` (`it::webhooks::replay_by_ids_and_window`). M8 also adds the endpoint routes to
  J10's matrix (another partner's endpoint by ID, in `it::partners::j10_foreign_partner_not_found` and
  `it::security::cross_tenant_matrix`).
- J19 (`it::idempotency::j19_per_key_no_secret`): replays are per key, and a replay of key creation and
  rotation, webhook creation and webhook secret rotation returns no secret (`"secret_replayed": false`).
- The delivery hold of J13 (`it::webhooks::j13_held_while_partner_suspended`): deliveries to a suspended
  partner's endpoints and its tenants' endpoints are held and resume on reactivation.
- NFR-REL-4: the retry schedule reaches 24 hours within its 13 attempts, and `webhook_delivery_latency_ms`
  and `webhook_dead_total` are emitted for the SLI.
- `webhook_endpoints.secret_enc` and `prev_secret_enc` are registered in `crates/core/src/sealed.rs`
  (M17 Foundation's registry), with their case in `it::secrets::master_key_rotation`.

---

## M9 · Outbound and delivery (Track 1, after M7)

**Files:** `handlers/send.rs`, `mailbox/{submit.rs, compose.rs, locks.rs, deliveries.rs, idempotency.rs}`,
`crates/core/src/compose.rs` (MIME composition, pure),
`transport/{mod.rs, cloudflare.rs, simulator.rs, loopback.rs}`, `consumers/{outbound.rs, delivery.rs}`,
`quota/mod.rs` (replaces the M5 stub's `Reserve`, `Release` and `RecordOutcome` behaviour with the daily
caps, quota warnings and abuse windows; `RecordUsage` has recorded since M5),
`handlers/{suppressions.rs, lists.rs, links.rs}` (allow and block lists,
`/v1/tenants/{tenant_id}/lists/{direction}/{kind}[/{entry}]`; signed links, `GET /v1/links/{token}`, with
kid verification), `db/{suppressions.rs, lists.rs}`, `mailbox/alarms.rs` (the claim and dispatch purposes
of [Data model §2](design/data-model.md#2-identitymailbox-durable-object-sqlite): thread locks expire
lazily and reconciliation is event-driven, so neither has an alarm; no cron is involved).

**Implements:** FR-OUT-1–12, FR-DLV-1–5, NFR-PERF-1/2.

**Acceptance:** A7, A8, A10, C2, C4, C6, C7, D6 (exchange cap), D7, E2, E3, E8, G1–G6, G8–G11 (G5 with
signed links; G9's re-check of the marketing transport at `BeginTransport`), K3, L1–L4. J13
(`it::partners::j13_suspended_partner`, whose authentication part runs from M5): no send is accepted for
a suspended partner's tenants, their inbound mail is stored, and with M8's held deliveries the row is
accepted here. J17 (`it::partners::j17_operator_enforcement`): with the abuse auto-pause, resuming an
identity paused for `abuse_threshold` on a partner's tenant needs a platform key. G3's `it::ops::provider_quota_80` fires through M17 Foundation's evaluator,
which merges first. G7 needs domain states and is accepted in M13. Also: the allow and block lists
(`it::lists::entries_crud`) and their effect on sends and on inbound mail (`it::send::list_filters`,
`it::inbound::receive_allow_skips_spam`; D7 covers receive-block), the custom-header rules checked at the
API (`it::send::header_rules`), the simulator matrix drives every status, an uncertain send is reconciled by a
later provider event, `?dry_run=true` returns the recipient plan without storing anything, and cancel
works only while a message is `queued` and unclaimed (`it::send::cancel_queued`, FR-OUT-11).
NFR-PERF-1 (`it::bench::send_api_p95`) and NFR-PERF-2 (`it::bench::queue_to_transport_p95`) report their
figures; CI warns above the targets.

---

## M10 · Search (after M7)

**Files:** `search/{mod.rs, keyword.rs, semantic.rs, hybrid.rs, rerank.rs, facets.rs, cursor.rs, tenant.rs, contacts.rs, related.rs}`,
`mailbox/search.rs`, `consumers/index.rs` (chunk, embed, upsert), `handlers/{search.rs, contacts.rs}`, `crons/index_reconcile.rs`.

**Implements:** FR-SRCH-1–7, 10 and 11 (index side), plus contacts and related; NFR-PERF-3/4/5.

**Acceptance:** F2 (`it::auth::f2_permission`, now that search exists), F3–F5, F7, F8, F14, F15 (F6 needs
erasure and is accepted in M14). The nightly reconciliation records its run in D1 `index_reconcile` and
raises the drift alert only after two nights over 1% ([Search § 6.6](design/search.md#66-nightly-reconciliation)).
NFR-PERF-3: keyword p95 ≤ 200 ms on a 50,000-message synthetic mailbox in workerd (`it::bench::keyword_p95`,
which reports the figure, with a warning threshold). NFR-PERF-4 (`it::bench::hybrid_p95`) and NFR-PERF-5
(`it::bench::tenant_fanout_p95`) report theirs the same way. The benchmarks fill their mailboxes through
the `itest-hooks` bulk-seed hook and run in the nightly workflow, not as a required check on every pull
request ([Testing § 6.9](design/testing.md#69-benchmarks)).

---

## M11 · Agentic search (after M10)

**Files:** `search/agentic/{mod.rs, planner.rs, tools.rs, judge.rs, answer.rs, sse.rs, prompts.rs}`,
`quota/mod.rs` (`QuotaRequest::CountAgentic`: the tenant daily cap replaces the M5 stub's plain count).

**Implements:** FR-SRCH-8/9, NFR-PERF-6.

**Acceptance:**

- E1 (fenced), F10–F13.
- Deterministic tests with a scripted fake model: plan, two searches, refine, answer, then a
  verifier removal.
- An SSE stream test.
- Budget enforcement by steps and by time, and the tenant daily cap through `QuotaRequest::CountAgentic`.
- NFR-PERF-6: `it::bench::agentic_p95` reports p95 and first-evidence time against 8 s and 1.5 s.

---

## M12 · Triage (after M7)

**Files:** `triage/{mod.rs, rules.rs, model.rs, schema.rs, prompts.rs}`, `consumers/index.rs` (triage job).

**Implements:** FR-TRI-1–4.

The `triage` hold of consumer step 2 ([Triage § 1.1](design/triage.md#11-consumer-steps)) goes to the M5
`TenantQuota` stub, which grants every hold, so triage runs on every message until M22 adds allowances.

**Acceptance:**

- D8 and rule evaluation order; E1 for triage input (`it::triage::e1_fenced`).
- Invalid model output ends `failed` and is never guessed.
- `message.triaged` events.
- The thread roll-up.

---

## M13 · Domains (after M7 and M9; SES depends on S8)

**Files:** `domains/{mod.rs, cloudflare_api.rs, ses_api.rs, ses_control.rs (SesControl DO, the SES
token bucket), records.rs, monitor.rs (DomainMonitor DO), fallback.rs}`,
`handlers/domains.rs` (full for `cloudflare_zone`, including `PATCH /v1/domains/{domain_id}` for the
transport), `handlers/addresses.rs` (aliases on tenant domains, promote, retire and rollback),
`crons/retire.rs`, `transport/ses.rs`, `consumers/ses_events.rs` (the `POST /hooks/ses` SNS endpoint), and
CLI `pmail domains subscribe`. The other connection methods, `nameservers` included, are M23's.

**Implements:** FR-DOM-2–6 for `cloudflare_zone`, FR-ADR-1–4.

**Acceptance:**

- H1, H2 (`core::dns::h2_spf_lookup_count`; its MAIL FROM part, `it::ses::h2_mail_from_spf_preflight`,
  is for `dns_records` and `send_only` domains and is accepted in M23), H3–H7, H8
  (`it::domains::h8_zone_permission` for `cloudflare_zone`, `replace_mx` and the listed zones of
  `domains.cloudflare_zones`; the `zone_claims` written by `nameservers` and `delegated_subdomain`, and the
  refusal of those methods under a claimed or deployment zone, are added in M23), the domain routes added
  to J10's matrix with the `foreign_zone` case of `it::security::cross_tenant_matrix`, G7, C3, A11, A14, A4's
  role-mail routing (`it::inbound::a4_role_mail_routing`), the promote,
  retire and rollback flows
  (`it::addresses::promote_retire_rollback`, `it::addresses::retirement_cron`), and the API part of J5
  (`it::domains::transport_patch`, including the SES identity that `cloudflare_zone` onboarding creates
  for the failover when SES is configured). J5's live part, `live::transport::j5_ses_failover`, runs in
  M20.
- The spike S9 fallback path for `cloudflare_zone`, whatever S9's result
  (`it::domains::s9_manual_delivery_events`, `cli::domains::subscribe_manual`), and the SES control-plane
  budget (`it::ses::control_plane_rate`).
- With a DNS fake that can remove a record, add a conflicting record, or move the NS, and the
  `cloudflare_zone` method only: `it::domains::{h1_failing_fallback, h4_ownership_change, h5_existing_mx,
  h6_rule_failure, onboarding_idempotent, records_from_api, cron_mints_missing_monitor,
  cf_token_required_by_method}` and `it::send::g7_domain_states`. The `nameservers` and
  `delegated_subdomain` parts of the onboarding, token and S9 fallback tests are separate tests, accepted
  in M23.
- The fallback send carries `sent_via_fallback` and keeps the thread token.
- Recovery leaves fallback threads pinned.
- The `domain_remove` job's steps for `cloudflare_zone`
  ([Identities and domains › Domain removal](design/identity-domains.md#domain-removal)), including
  `delete_ses_identity`, which deletes the failover SES identity that onboarding created and its three
  DKIM CNAMEs. `DELETE /v1/domains/{domain_id}` queues the job behind M6's `JobRunner` stub; M14 runs it,
  inline in tenant erasure's `remove_domains` too, and accepts `it::domains::remove_deletes_ses_identity`.

---

## M23 · Domains on any DNS host (after M13 and M9; S11, S12 and S10 gate methods)

**Files:** `crates/core/src/{connect.rs, smtp.rs, sns.rs}` (and SES receipt parsing in `ses.rs`),
`handlers/domains.rs` (methods, `PATCH` with `smtp`, `probe`), `handlers/addresses.rs`
(`test-forwarding`), `handlers/hooks_ses.rs` (`POST /hooks/ses/inbound`), `transport/smtp.rs`,
`inbound/sources/{routing.rs, ses.rs}`, `consumers/inbound.rs` (the SES source), `crons/ses_backstop.rs`,
`domains/monitor.rs` (method health rows, retired-address rules, probe and forwarding tokens); no
migration (the `domains` method columns, `ses_ingest`, `addresses.ses_bounce_rule` and
`addresses.forwarding` are already in `0001_init.sql`); CLI `pmail setup ses`, `pmail domains add --method`, `pmail domains update
--smtp-…`, `pmail domains probe` and `pmail addresses test-forwarding`.

**Implements:** FR-DOM-7–12, [Domains on any DNS host](design/domain-connections.md).

**Acceptance:**

- N1–N30, with the tests named in the register (`core::sns::verify_v2_vectors`,
  `core::smtp::state_machine`, `core::dns::doubled_name_detected`,
  `it::ses::*`, `it::smtp::*`, `it::forwarding::*`, `cli::setup::ses_region_check` and
  `it::domains::{existing_mx_external, nameservers_dedicated_check, zone_expired, mx_wrong_region,
  zone_create_rate_limited, zone_hold, delegation_removed, ses_identity_limit}`).
- `core::connect::method_matrix`, which no register row names: every `method` maps to the documented
  `kind`, `inbound` and `transport`, and invalid combinations are refused.
- The `nameservers` and `delegated_subdomain` parts of M13's domain tests:
  `it::domains::onboarding_idempotent_created_zones`, `it::domains::s9_manual_delivery_events_nameservers`
  and `it::domains::cf_token_required_other_methods`, and the claimed-zone part of H8
  (`it::domains::h8_zone_permission`: `zone_claims` written with the domain row, deleted by `delete_zone`
  and on `zone_expired`, and the refusal of a name under a deployment or another tenant's zone).
- `pmail setup ses` is idempotent: it runs twice against a recorded AWS API fake with no duplicate
  resources, never deactivates an existing active rule set, and prints the IAM policy before applying it.
- Every new error code and `transport_unavailable` reason in the design is returned by at least one test.
- The SES parts of rows that M7 and M13 accept: A6's suspended-tenant hold (`it::ses::suspended_tenant_held`)
  and H2's MAIL FROM preflight (`it::ses::h2_mail_from_spf_preflight`).
- The SES operator alerts, which fire through M17 Foundation's evaluator: `it::ops::ses_alerts`
  (`ses_identities_90pct` for N26, `ses_sending_paused` and `ses_rule_missing` for N10).
- The cross-tenant suite covers `/hooks/ses/inbound` (no key) and the new routes.
- Erasure extension, once M14 has landed (if M14 lands later, it writes this substep instead of a stub):
  tenant erasure's `remove_domains` removes each SES domain's addresses from the `pm-retired-{n}`
  receipt rules (the `prune_retired_rules` step of domain removal;
  [Privacy §6.6](design/privacy.md#66-tenant-scope)). The SES identity itself is deleted by M13's
  `delete_ses_identity` step. `it::erasure::tenant_ses_rows` lands here.
- The global retention job's `ses_ingest` step (`it::retention::global_ses_ingest`).
- `domains.smtp_sealed` and `domains.smtp_pending_sealed` are registered in `crates/core/src/sealed.rs`,
  with their case in `it::secrets::master_key_rotation`.

**Gate:** each method ships only when its spike passed: S11 for `dns_records`, S12 for `smtp_relay`, S10
for `delegated_subdomain` (which also stays behind `PM_CF_SUBDOMAIN_SETUP`). `smtp_relay` with `inbound: ses`
also needs S11; without it, `smtp_relay` ships with `inbound: forward` only. `cloudflare_zone`,
`nameservers` and `send_only` do not wait for them. A method whose spike failed moves to v1.1 by ADR
(PRD section 5).

---

## M14 · Privacy (after M9, M10)

**Files:** `jobs/{mod.rs (JobRunner DO), erasure.rs, retention.rs, export.rs, reembed.rs, reparse.rs, reindex.rs, backup.rs}`,
`handlers/{erasure.rs, exports.rs, holds.rs}`, `crons/retention.rs`.

**Implements:** FR-PRV-1–6, FR-IDN-4, NFR-PRV-1, and partner deletion after its tenants' erasure (FR-KEY-4).

**Acceptance:** F6, I1–I7, the `reparse` job that J3 starts (J3 itself is accepted with M17 Completion,
which adds its start through `POST /v1/platform/jobs`), plus every erasure scope with receipt counts and
empty probes (identity and tenant scope also delete `identity_keys` and write `key_tombstones`; with M25
this is O7), J12 (a partner whose tenants are all erased can be deleted, softly, and not before:
`it::partners::j12_delete_with_tenants`), I8 (writes to an `erasing` or `erased` tenant refused for
non-platform keys, reads kept for its partner key, a second tenant-scope erasure answered `200` or
`409 tenant_erased`, and the tenant's idempotency records deleted by `tenant_id`:
`it::erasure::i8_erasing_tenant_frozen`), the optional backup copy (`it::retention::backup_copy`), and
`it::logs::i5_no_content_in_logs`, which greps captured Worker logs for any test-message body string and
any test address. NFR-PRV-1: in a time-controlled harness every erasure scope completes within 24 hours,
and a step that keeps failing still produces a receipt (`it::erasure::step_retry_and_fail`). Tenant scope
runs its steps in order, `cancel_billing` second (`it::erasure::tenant_scope_order`). `remove_domains`
runs M13's `domain_remove` steps inline, including `delete_ses_identity` (the failover SES identity and
its three DKIM CNAMEs), and a domain removal that M13 queued behind the stub now runs
(`it::domains::remove_deletes_ses_identity`). The global retention job ([Privacy
§5.3](design/privacy.md#53-global-retention-job)) lands with its framework and the steps whose tables
have writers by now: `idempotency`, `platform_events`, `jobs`, `usage`, `dlq`, `signing_keys`, `staging`
and `audit` (`it::retention::global_job_steps`). Its other steps are added by the milestones that write
their tables, each with its own test: `console` in M21, `billing_events` in M22, `ses_ingest` in M23,
`signup` in M24 and `identity_keys` in M25.

**Stubs completed by later milestones.** Tenant erasure ([Privacy §6.6](design/privacy.md#66-tenant-scope))
reaches tables and services that later milestones build. M14 writes every step, and leaves these substeps
as named stub functions in `jobs/erasure.rs` that do nothing until their milestone fills them in, with the
test it names:

| Substep | Completed by | Test |
|---|---|---|
| Console rows: `members`, `invitations` and `sessions` in `delete_d1_rows` | M21 | `it::erasure::tenant_console_rows` (lands in M21) |
| Billing: the `cancel_billing` step (step 2), and `billing_events` and `billing_accounts` in `delete_d1_rows` | M22 | `it::erasure::tenant_cancels_billing`; billing assertions in `it::erasure::tenant_console_rows` |
| SES: the domain's addresses in the `pm-retired-{n}` receipt rules (`prune_retired_rules`, run by `remove_domains`) | M23 | `it::erasure::tenant_ses_rows` (lands in M23) |
| Person rows: deleting every person left with no workspace ([Privacy §6.9](design/privacy.md#69-people-console-accounts)) | M24 | `it::erasure::person_scope`; assertions on people left with no workspace in `it::erasure::tenant_console_rows` |
| Notifier: `notification_prefs` in `delete_d1_rows`, and `Notifier` `delete_all` | M26 | Notifier assertions in `it::erasure::tenant_console_rows` and `it::erasure::person_scope` |

---

## M15 · MCP server (after M9, M10, M11, M22, M25)

**Files:** `mcp/{mod.rs, transport.rs, tools.rs, schemas.rs, prompts.rs}`.

**Implements:** FR-MCP-1 and the tool list in [MCP reference](../reference/mcp.md), including the two
signing tools of M25 (`mail_sign_assertion`, `mail_sign_http_request`).

**Acceptance:**

- `tools/list` is filtered by permission.
- Each tool's call maps to its REST equivalent, checked by a table test.
- Error mapping.
- Revision 2026-07-28 has no sessions: the server never mints `Mcp-Session-Id`, and `GET` and `DELETE`
  on `/mcp` answer `405`.
- A recorded MCP Inspector session replays green.

---

## M16 · Rust SDK and CLI (Track 3, from M5; commands land as their APIs land)

**Files:** `crates/sdk/src/*`, `crates/cli/src/{main.rs, config.rs, output.rs, cloudflare/, commands/*}`.

**Implements:** FR-SDK-1, FR-CLI-1, FR-OPS-1–3. The SDK's `verify_assertion` and the CLI commands
`identity-keys`, `assertions` and `http-sign` land with M25's endpoints.

**Acceptance:**

- SDK integration tests run against the workerd harness for every endpoint, and
  `sdk::coverage::every_operation` proves the SDK has one method per `openapi.yaml` operation (FR-SDK-1,
  [Rust workspace §11](design/rust-workspace.md#11-the-rust-sdk-fr-sdk-1)).
- `pmail setup` is idempotent: it runs twice against a recorded Cloudflare API fake with no
  duplicate resources.
- `pmail deploy` verifies checksums and refuses a tampered bundle.
- `pmail doctor` reports every check with a fix.
- The landing-page CLI examples run as tests.

---

## M17 · Observability and operations (Track 3)

**Files:** `crates/worker/src/{log.rs, metrics.rs}`, `ops/alerts.rs`, `consumers/dlq.rs`, `crates/core/src/slo.rs`
(alert rules, pure), `handlers/platform.rs`
(the platform API: `GET /v1/platform/dlq`, `POST /v1/platform/dlq/{dlq_id}/redrive`,
`POST /v1/platform/jobs`, `GET /v1/platform/jobs/{job_id}`, `POST /v1/platform/keys/{purpose}/rotate`, all
`platform:ops`), `crates/core/src/sealed.rs` (the registry of sealed columns, pure), `ops/reseal.rs` (the
re-seal sweep that the `*/15` cron runs), CLI `dlq list|redrive` and `secrets rotate-master`. There is no
internal-only handler: the CLI uses the public platform API.

**Implements:** FR-OPS-4, NFR-OPS-2, NFR-COST-1 and [Observability](design/observability.md).

M17 is accepted in two halves, without renumbering ([Dependency graph](#dependency-graph)).

**Acceptance, M17 Foundation** (Track 3's first pull request; it merges before M7, M8 and M9):

- The log and metrics writer (`log.rs`, `metrics.rs`): `event = "metric"` lines with the catalogued
  labels, and log scrubbing (part of I5).
- The alert table (the [alert list](design/observability.md#53-alert-list) as data in `ops/alerts.rs`:
  each alert's key, class, severity and runbook) and the state alert evaluator
  ([Observability §5.4](design/observability.md#54-the-state-alert-evaluator)): `core::slo::alert_state_machine`
  and `it::ops::alert_evaluator_transitions`. M9's G3 (`it::ops::provider_quota_80`) and M23's N26
  (`ses_identities_90pct`, checked by `it::ops::ses_alerts`) fire through them and are accepted there.
- The master-key rotation ([Security §6.2](design/security.md#62-rotation-procedures)):
  `PM_MASTER_KEY_NEXT`, the re-seal sweep over the registry in `crates/core/src/sealed.rs`, and
  `pmail secrets rotate-master`, whose count query is built from the same registry:
  `it::secrets::master_key_rotation` and `cli::secrets::rotate_master` for the columns registered so far.
  Each milestone that writes a sealed column registers it and extends the test
  ([Shared files](#dependency-graph)).

**Acceptance, M17 Completion** (accepted at M20, once what it measures has landed):

- J8, J3 (job start through `POST /v1/platform/jobs`; it needs M14's `reparse` job),
  `it::secrets::signing_key_rotation`.
- Every metric in the design is emitted by at least one test path (`it::ops::metrics_emitted`).
- Every SLO of [Observability §4](design/observability.md#4-service-level-objectives) is computed from emitted metrics
  (`it::ops::slo_from_metrics`): NFR-REL-1–4, NFR-PERF-1–6 and NFR-PRV-1, including those that need
  later milestones (NFR-PRV-1 needs M14's erasure, NFR-PERF-6 M11's agentic search).
- NFR-OPS-2: `it::ops::restore_rebuilds_ledger`, and the restore runbook that `live::ops::restore_drill`
  runs in M20.
- NFR-COST-1: the generated `wrangler.toml` declares no always-on compute (no Containers, no binding
  that bills while idle beyond storage), checked by `xtask::template_no_idle_compute`; the idle-cost
  review runs in M20.

---

## M18 · Quality gates (after M10–M12)

**Files:** `crates/conformance/golden/` (a generator for about 5,000 synthetic messages plus labelled
queries), `xtask eval-search`, `xtask eval-agentic`, `xtask eval-triage`.

**Implements:** NFR-QUAL-1–3.

**Acceptance:** recall@10 ≥ 0.90 (hybrid), citation precision ≥ 0.98, and triage accuracy ≥ 0.85.
These figures are measured on the golden set using real Workers AI models in a nightly CI job with an
API token, and recorded in `docs/src/project/quality.md` (created by this milestone). CI fails on a
regression of more than 1 point.

---

## M19 · Site, docs and release pipeline (Track 4)

**Files:** `site/` (exists), `.github/workflows/release.yml`, `xtask release`.

**Acceptance:**

- `mdbook build docs` writes into `site/public/docs`, and the site Worker serves both. The landing
  page's links to docs anchors resolve (link check in CI).
- A tagged release produces `pylota-mail-worker-<v>.tar.gz`, CLI binaries for macOS (arm64, x64),
  Linux (x64, arm64) and Windows (x64), and signed `SHA256SUMS`.
- `pmail deploy --version <v>` deploys that bundle.

---

## M21 · Console and workspaces (after M7–M14 and M25, whose services its pages use)

**Files:** `crates/worker/src/console/{mod.rs, router.rs, session.rs, signin.rs, csrf.rs, layout.rs (maud), pages/*.rs}`,
`crates/worker/src/members/{mod.rs, invitations.rs, roles.rs}`, `handlers/members.rs`. No migration:
`users`, `members`, `invitations`, `login_tokens` and `sessions` are in `0001_init.sql`.

**Implements:** FR-CON-1–7, NFR-CON-1, the console screens in [Console design](design/console.md),
including identity-key management on the identity page ([Agent signing keys §6](design/agent-keys.md#6-permissions-limits-and-plans)).

**Acceptance:**

- Edge rows W9, W10, W15–W18.
- Every console route works with JavaScript disabled, checked by the browser suite
  (`browser::console::no_js`, Playwright with `javaScriptEnabled: false`), which `cargo xtask itest` runs
  from this milestone on ([Testing §2](design/testing.md#2-test-layers)).
- An axe accessibility scan finds no violation of impact `serious` or `critical` on any page
  (`browser::console::axe_scan`).
- NFR-CON-1: `it::console::render_budget` keeps server render time p95 ≤ 300 ms on every page.
- Sign-in and invitation emails are sent through the system identity that setup creates
  ([Identities and domains › The system identity](design/identity-domains.md#the-system-identity)), using the
  simulator in tests; invitations also work with `PM_CONSOLE=off`. The system identity is exempt from the
  tenant daily cap and from abuse auto-pause (`it::send::system_identity_exemptions`).
- Erasure extension: the console-rows stub of tenant erasure (`members`, `invitations` and `sessions` in
  `delete_d1_rows`, [Privacy §6.6](design/privacy.md#66-tenant-scope)) is filled in, and
  `it::erasure::tenant_console_rows` lands here, asserting those rows; M22, M24 and M26 add their
  assertions to it (M23's SES rows have their own test, `it::erasure::tenant_ses_rows`).
- The global retention job's `console` step (`login_tokens`, `sessions`, and invitations expired or
  revoked more than 30 days ago) is added here: `it::retention::global_console_rows`.

---

## M22 · Plans, metering and billing (after M9, M12, M21)

**Files:** `crates/worker/src/billing/{mod.rs, catalog.rs, quota.rs (TenantQuota allowances and holds), stripe.rs, webhook.rs, usage.rs}`,
`handlers/{usage.rs, plans.rs, billing.rs}` (`GET /v1/usage` and `GET /v1/usage/daily`),
console pages `plan.rs`. No migration: `billing_accounts` and `billing_events` are in `0001_init.sql`.

**Implements:** FR-BILL-1–12, NFR-BILL-1/2, the metering points in [Billing design](design/billing.md).

**Acceptance:**

- Edge rows W1–W8, W11–W14, W19.
- Every metered action is wired to a hold and a settlement, checked by a table test that lists each metering
  point. A new metered action without a row fails.
- A Stripe test-mode run (CLI `stripe trigger` fixtures recorded as JSON) covers checkout completed,
  subscription updated, payment failed, and canceled.
- `GET /v1/usage` matches the catalog and the `TenantQuota` state in property tests.
- NFR-BILL-1: `it::billing::w1_last_unit_race` and the hold property tests allow 0 actions beyond a
  granted allowance. NFR-BILL-2: `it::billing::w2_stripe_down_sends_ok` fails no metered action while
  Stripe is unreachable.
- Erasure extension: the billing stub of tenant erasure, that is the `cancel_billing` step (step 2, right
  after routing stops: the plan and every top-up subscription cancelled at once, no proration, no refund) and `billing_events` and
  `billing_accounts` in `delete_d1_rows` ([Privacy §6.6](design/privacy.md#66-tenant-scope)), with
  `it::erasure::tenant_cancels_billing`; webhooks for an erased tenant are answered `200` and recorded
  `ignored_erased`, except that a live subscription created after the deletion is cancelled
  (`it::billing::late_subscription_after_erasure`). `it::erasure::tenant_console_rows` gains the billing assertions.
- The global retention job's `billing_events` step: `it::retention::global_billing_events`.

**Gate:** every request pins `Stripe-Version: 2025-03-31.basil`, and each Stripe call matches the
`Verified` line of [Billing](design/billing.md#tests) (read 2026-10-10; re-read and update it if it is more
than 30 days old when the code is written).

---

## M24 · Cloud sign-up and sign-in (after M21, M22)

**Files:** `crates/worker/src/console/{signup.rs, oauth.rs, totp.rs, landing.rs, onboarding.rs, pages/overview.rs}`,
`crates/core/src/totp.rs` (RFC 6238 codes, pure; the console module only stores and checks them),
`handlers/platform.rs` (`POST /v1/platform/waitlist/invite`), no migration (the `users` sign-in
columns, `oauth_identities`, `oauth_states`, `waitlist` and `tenants.{require_two_factor,
onboarding_dismissed_at, ramp_lifted_at}` and the `login_tokens` sign-up columns are in `0001_init.sql`),
the host split for `PM_CONSOLE_HOST` in `router.rs`, CLI `pmail waitlist invite`, the new-workspace send
ramp (`crons/signup_ramp.rs`, run once a day by the `*/15` cron; the ramp check in outbound policy
step 18; the `ramp_lifted_at` update in `billing/webhook.rs`; `QuotaRequest::OutcomeRates`), and person
deletion (`console/pages/settings.rs` and the person step of `jobs/erasure.rs`).

**Implements:** FR-CON-8–13, [Cloud sign-up, sign-in and first run](design/cloud-signup.md).

**Acceptance:**

- Edge rows W20–W34, with the tests named in the register (`it::oauth::*`, `it::signup::*`, `it::totp::*`,
  `it::landing::routing_table`, `it::checkout::*`, `it::abuse::free_ramp`, `it::abuse::ramp_evaluator`,
  `it::abuse::partner_ramp` (W30's partner part: a partner's tenants are ramped unless `ramp_exempt`),
  `it::console::delete_account_owner_required`).
- Erasure extension: person deletion ([Privacy §6.9](design/privacy.md#69-people-console-accounts)) is
  owned here. That covers account deletion at `/console/settings`, the person-rows stub of tenant
  erasure (every person left with no workspace), the scrub of accepted invitations, and the
  system-mail counterparty erasure restricted by the internal `identity_ids` param
  ([Privacy §6.4](design/privacy.md#64-counterparty-scope-i1)). Tests: `it::erasure::person_scope`,
  `it::privacy::system_mail_retention_and_person_delete` and `it::erasure::tenant_console_rows`'s
  assertions on people left with no workspace.
- `core::totp::rfc6238_vectors`, `it::signup::email_creates_account_only_on_use`,
  `it::onboarding::derived_steps` and `it::hosts::console_api_split`.
- The new pages pass the M21 checks: they join `browser::console::no_js` and `browser::console::axe_scan`
  (no JavaScript needed, no axe violation of impact `serious` or `critical`).
- `users.totp_sealed`, `users.recovery_codes_sealed` and `oauth_states.pkce_sealed` are registered in
  `crates/core/src/sealed.rs`, so M17 Foundation's re-seal sweep covers them, with their cases in
  `it::secrets::master_key_rotation`.
- The global retention job's `signup` step (`oauth_states`, `waitlist`): `it::retention::global_signup_rows`.

**Gate:** Google's and GitHub's endpoints and claim names are re-read from their current documentation
and recorded in the design before the OAuth code is written ([Cloud sign-up §4](design/cloud-signup.md#4-google-and-github)).

---

## M25 · Agent signing keys, assertions and signed requests (after M5 and M6; S13 gates signed requests)

**Files:** `crates/core/src/{jwk.rs, jwt.rs, httpsig.rs}` (RFC 7638 and RFC 8037 thumbprints and JWS,
RFC 9421 signature bases, pure), `handlers/{identity_keys.rs, assertions.rs, http_signatures.rs,
well_known.rs}`, `db/identity_keys.rs`, `keyring.rs` (the `web_bot_auth` purpose: a 43-character
thumbprint kid, `public_jwk`, the 7-day directory overlap), the `RL_SIGN` binding in the `wrangler.toml`
template, `crates/sdk/src/assertions.rs` (`verify_assertion`), CLI `pmail identity-keys
list|create|rotate|revoke`, `pmail assertions create|verify` and `pmail http-sign`; no migration
(`identity_keys`, `key_tombstones` and the `signing_keys` columns are in `0001_init.sql`). Route
registrations go through Track 1 as usual.

**Implements:** FR-IDN-6–9 and edge rows O1–O13 ([Agent signing keys and signed requests](design/agent-keys.md)),
and the cross-tenant suite's new routes (NFR-SEC-1).

**Tasks:**

1. Write the RFC vector tests first (`core::jwk`, `core::jwt`, `core::httpsig`), then the pure code.
2. Identity keys: lazy creation on first sign, `POST …/keys`, rotation with the
   `PM_IDENTITY_KEY_OVERLAP_DAYS` overlap, revocation, the `key_tombstones` check at generation, and the
   three `identity.key_*` events through the identity's mailbox (`MailboxRequest::EmitEvent`).
3. The JWKS endpoint, with the pause and suspension kill switch.
4. Assertions (`identities:sign`, `RL_SIGN`), never stored or logged; `Idempotency-Key` ignored. Each
   signature is counted through `QuotaRequest::RecordUsage` (`usage:assertions`, `usage:http_signatures`,
   flushed to `usage_daily`; the M5 stub has recorded `RecordUsage` since M5, so the calls work whatever lands first).
5. Signed HTTP requests and the signed directory behind `PM_WEB_BOT_AUTH` and tenant policy
   `web_bot_auth.allowed`; the `web_bot_auth` purpose of `POST /v1/platform/keys/{purpose}/rotate`.
6. The SDK verifier and the CLI commands; the two MCP tools are added to M15's table.

**Acceptance:**

- Edge rows O1–O13, with the tests named in the register: `core::httpsig::signature_base_rfc9421` (O10),
  `it::identity_keys::{lazy_create_and_rotate, revoke_removes_from_jwks, paused_withdraws_jwks}` (O2, O3,
  O1), `it::assertions::claims_and_limits` (O4–O6), `it::secrets::rotate_master_reseals_identity_keys`
  (O8: M25 registers `identity_keys.private_enc` in `crates/core/src/sealed.rs`, so M17 Foundation's
  re-seal sweep covers it alongside `signing_keys.ciphertext`, and adds its case to
  `it::secrets::master_key_rotation`; if M25 lands before M17 Foundation, M17 Foundation does both and
  this test runs once it has landed),
  `it::http_signatures::{disabled_and_policy, expiry_bounds}` (O9, O13, O11) and
  `it::well_known::directory_signed_per_key` (O12). O7 (`it::assertions::erasure_tombstones_kid`) runs
  once M14 has landed too: M14's identity- and tenant-scope erasure deletes the keys and writes
  `key_tombstones`.
- The global retention job's `identity_keys` step, which retires `retiring` keys past `verify_until`:
  `it::retention::global_identity_keys` (it runs once M14 has landed; if M14 lands later, M14 writes the
  step).
- `core::jwk::thumbprint_rfc8037_vector`, `core::jwt::eddsa_rfc8037_vector` and
  `it::assertions::sdk_verifies` (the SDK verifier accepts a fresh token and rejects a wrong audience, an
  expired token, an unknown kid and `alg: none`).
- The cross-tenant suite covers the six new `/v1` routes; another tenant's key gets the same `404` as a
  missing identity, and the identity JWKS route (`/.well-known/jwks/{identity_id}.json`) gives the same
  `404 identity_not_found` for unknown, paused and deleted identities. The key directory is deployment-wide;
  its only `404` is `key_not_found`, while `PM_WEB_BOT_AUTH` is `off`.
- No response, log line, event or idempotency record contains a private key, a seed, an assertion or a
  signature (`it::logs::i5_no_content_in_logs` is extended with them).

**Gate:** signed HTTP requests ship only when spike S13 passed. Otherwise `PM_WEB_BOT_AUTH` cannot be
turned on (`422 web_bot_auth_disabled`, the directory `404`), FR-IDN-8 moves to v1.1 by ADR, and the
assertion half of the milestone ships unchanged.

---

## M26 · Notifications and usage alerts (after M9, M10, M21, M22 and M24; the system identity from M6)

**Files:** `crates/worker/src/notify/{mod.rs, notifier.rs (the Notifier Durable Object), compose.rs,
prefs.rs, unsubscribe.rs}`, `crates/core/src/notify.rs` (windows, caps, schedules across time zones, and
rendering that takes no mail content, pure), `crates/worker/src/console/pages/notifications.rs`
(`/console/settings/notifications` and the unsubscribe pair), the `NOTIFY` binding and the `Notifier`
class in the `wrangler.toml` template and `export_worker!`, and `tenants.notify_do_id` minted with the
tenant row, plus a `Notifier` minted by the every-minute cron for each tenant still at
`notify_do_id = ''` (those created before M26, setup's default tenant included;
[Configuration › Bindings](../reference/configuration.md#bindings)); no migration (`notification_prefs` and the
column are in `0001_init.sql`). Hooks in other milestones' files, each reviewed by that file's owner:

| File | Hook |
|---|---|
| `consumers/webhooks.rs` (M8's dispatcher) | `NotifierRequest::Event` for `message.received`, `message.released` and `message.triaged` |
| `consumers/delivery.rs` (M9's delivery-event consumer, which SES events also reach) | After a hard bounce or complaint on a system-identity message carrying `metadata.notify_user_id`, set `paused_reason` on every `notification_prefs` row of that person ([O17](edge-cases.md); [Outbound › Applying an event](design/outbound.md#applying-an-event-to-a-message)) |
| `quota/mod.rs` (M22's `TenantQuota`) | `NotifierRequest::UsageThreshold` |
| `members/mod.rs` and `handlers/members.rs` (M21) | `NotifierRequest::MemberRemoved` on removal and leaving; `Account { event: ownership_transferred }` on a transfer |
| `console/totp.rs` (M24) | `Account { event: two_factor_disabled }` |
| `console/oauth.rs` (M24) | `Account { event: sign_in_method_linked }` |
| `billing/webhook.rs` (M22) | `Account { event: payment_failed }` when the status becomes `past_due` |
| `jobs/erasure.rs` (M14) | The Notifier stub of tenant erasure (`notification_prefs`, `Notifier` `delete_all`), and the `notification_prefs` rows of person deletion |

**Implements:** FR-CON-14, FR-CON-15, FR-BILL-13 and edge rows O14–O26
([Notifications and usage alerts](design/notifications.md)).

**Tasks:**

1. `core::notify` first: coalescing windows, caps, the 09:00 schedule per time zone, and the
   content-free renderer, each unit-tested.
2. The `Notifier` object (`Init`, `pending`, `held`, `windows`, `sent`, `meta`, one alarm) and its inputs:
   the dispatcher hook for `new_mail` (with `held` for the `needs_reply` filter), `UsageThreshold` from
   `TenantQuota` (with the `alerted:{feature}:{threshold}:{period}` keys), `Account` from the code that
   changes security or billing state, and `MemberRemoved`; the daily `digest` of capped items.
3. Sending through the system identity with the `notify:` idempotency key; bounces and complaints set
   `paused_reason`; the hourly retry loop for a failing platform domain and for a refused system-identity
   submit, with the `system_mail_blocked` alert.
4. The console settings page, the bounce banner and its confirmation, and the unsubscribe pair (no
   session, CSRF-exempt, served with `PM_CONSOLE=off`).
5. Member removal and person and tenant erasure delete preferences and pending items: the erasure
   extension fills the Notifier stub of tenant erasure ([Privacy §6.6](design/privacy.md#66-tenant-scope))
   and adds the `notification_prefs` rows to person deletion (§6.9).

**Acceptance:**

- Edge rows O14–O26, with the tests named in the register (`it::notify::*`).
- `core::notify::no_content_in_body`: a rendered notification contains no subject, sender, snippet or
  attachment name from the source message.
- Notification emails go out through the system identity with the simulator in tests, as
  `transactional` sends carrying `List-Unsubscribe` and `List-Unsubscribe-Post`; a retried alarm never
  sends twice (the `notify:` idempotency key).
- The new pages pass the M21 checks: they join `browser::console::no_js` and `browser::console::axe_scan`
  (no JavaScript needed, no axe violation of impact `serious` or `critical`). The unsubscribe pair works
  without a session and with `PM_CONSOLE=off`.
- The cross-tenant suite covers the unsubscribe route: a token never changes another person's or
  workspace's preferences (O18).
- `it::notify::system_mail_blocked_retries`, and `it::console::account_emails` for all four `account`
  events.
- Erasure extension: `it::erasure::tenant_console_rows` and `it::erasure::person_scope` gain their
  `notification_prefs` and `Notifier` assertions, and `it::notify::member_removed_drops_pending` covers
  `held` rows.

---

## M20 · Staging deploy and live proof

**Implements:** NFR-OPS-1 (the timed rehearsal, step 12) and the live measurements of NFR-REL-3,
NFR-PERF-4, NFR-OPS-2 and NFR-COST-1 (step 13). M17 Completion is accepted here too: its checks run in the
gate once every milestone it measures has landed.

Deploy to staging with `pmail setup` and `pmail deploy` from the docs alone, as if you were a new
self-hoster. Then run `live::*`. Each step names its tests in [Testing §10](design/testing.md#10-live-end-to-end-suite-live);
the ones marked manual there need a person in a browser and run with `cargo xtask live --manual`:

1. Inbound from Gmail and Outlook test mailboxes. The verdicts are correct, and HTML-only mail
   produces text.
2. Outbound to both. Each reply threads correctly in the recipient's client, and replies come back
   into the same thread.
3. Bounce: a non-existent mailbox at a domain you control. Complaint: through the provider's simulator
   if available, otherwise a manual test.
4. A domain change: platform address, then zone subdomain, then zone apex, then rollback.
5. A domain on an external DNS host with `dns_records`: publish the records at a DNS provider other than
   Cloudflare, wait for `healthy`, receive from Gmail through SES, and send with aligned DKIM and SPF.
6. A domain failure: delete the DKIM record. After two checks the domain is `failing`, sends fall back,
   the operator is told. Restore the record and the domain recovers.
7. Erasure of a counterparty with a held thread. The receipt is correct and the probes are empty.
8. An MCP client (Claude Code) connects, searches and sends with an idempotency key.
9. Console: sign in with a magic link, invite a second member, release a quarantined message, and see it
   in the audit log (`live::console::magic_link_invite_release`).
10. Cloud sign-up with Google (`PM_SIGNUP=open`): a new account and workspace, the Overview with its
    first-run checklist, and Checkout from `?plan=developer` (`live::signup::google_to_checkout`, manual).
11. Billing in Stripe test mode: upgrade Free to Developer through Checkout, spend the send allowance to a
    `402`, buy a top-up, and retry the same send successfully (`live::billing::upgrade_spend_topup_retry`,
    manual for the two Checkout pages). Staging runs with a `PM_PLAN_CATALOG` whose plans keep their
    names and use Stripe test-mode prices but have small allowances (Free 10 sends, Developer 20 sends, a
    sends top-up of 5), so the allowance is spent in a few sends; the production catalog is never used
    for this.
12. NFR-OPS-1, a fresh-account rehearsal (`live::ops::fresh_deploy_rehearsal`): a person who did not
    build it deploys from `self-hosting.md` in under 15 minutes of hands-on time, timed and recorded.
13. Measured on staging: NFR-REL-3 (`live::slo::inbound_to_webhook`), NFR-PERF-4 with the real models
    (the hybrid figure of `it::bench::hybrid_p95` repeated against staging), NFR-OPS-2
    (`live::ops::restore_drill`) and NFR-COST-1 (`live::ops::idle_cost_review` after a week of idling).
    NFR-REL-2 and NFR-REL-4 are read from the SLO dashboard over the live run.
14. Agent keys: an assertion minted on staging verifies with `pmail assertions verify` against staging's
    JWKS, and stops verifying within 5 minutes of pausing the identity (`live::assertions::verify_then_pause`).
    With S13 passed and `PM_WEB_BOT_AUTH=on`, a signed request to
    `https://crawltest.com/cdn-cgi/web-bot-auth` returns `401` (the directory is not registered on
    staging; `live::http_signatures::crawltest_unregistered_401`).
15. Notifications: in Stripe test mode, with the staging catalog of step 11, sends cross 80% and an alert
    arrives once (`live::notify::usage_alert_once`); a `new_mail` notification reaches the Gmail test
    mailbox with no content from the mail (`live::notify::new_mail_no_content`); Gmail's one-click
    unsubscribe turns that kind off (`live::notify::gmail_one_click_unsubscribe`, manual).

**v1.0 release criteria:** [PRD §9](prd.md#9-release-criteria-v10).
