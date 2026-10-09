# Build plan

This is the order of work for building Pylota Mail from an empty repository to v1.0, written for a
coding agent (or a team) working through it in one pass. Each milestone lists:

- the files it creates;
- the requirements it implements;
- the tests that prove it;
- the gate that must be green before the next milestone starts.

Design documents are binding. When a milestone shows a design is wrong, stop, write an ADR, update the
design, then continue. Never let code and docs drift.

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
| B. Build | M2–M19, M21–M24, run as parallel tracks after M5 | 3–5 days of agent time, depending on parallelism and review speed |
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

```text
M0 skeleton ─▶ M1 spikes ─▶ M2 core ─▶ M3 api-types ─▶ M4 platform ─▶ M5 worker base
                                                                         │
            ┌──────────────┬──────────────┬──────────────┬──────────────┼──────────────┐
            ▼              ▼              ▼              ▼              ▼              ▼
     M6 identities   M8 webhooks    M16 SDK/CLI    M17 observability  M19 site/release  │
            │              │                                                          │
            ▼              │                                                          │
     M7 inbound ◀──────────┘                                                          │
            │                                                                         │
     ┌──────┴───────┬───────────────┬──────────────┐                                  │
     ▼              ▼               ▼              ▼                                  │
 M9 outbound   M10 search      M12 triage     M13 domains                            │
     │              │                              │                                  │
     │              ▼                              │                                  │
     │         M11 agentic                         │                                  │
     └──────┬───────┴──────────────┬───────────────┘                                  │
            ▼                      ▼                                                  │
     M14 privacy             M15 MCP ◀────────────────────────────────────────────────┘
            │                      │
            └──────────┬───────────┘
                       ▼
               M18 quality gates ─▶ M20 staging + live proof ─▶ v1.0
```

The console, billing and domain-method milestones join the graph like this. Each also feeds M20:

```text
M6 identities ─▶ M21 console ─▶ M22 billing ─▶ M24 cloud sign-up and sign-in
                 (M22 also needs M9 and M12)
M13 domains (and M9 outbound) ─▶ M23 domains on any DNS host   (S10, S11, S12 gate its methods)
```

After M5, these tracks can run in parallel, each in its own branch and worktree:

- **Track 1:** M6 → M7 → M9;
- **Track 2:** M8;
- **Track 3:** M16 + M17;
- **Track 4:** M19.

Once M7 lands, M10, M12 and M13 also run in parallel. M23 follows M13 (and M9) on the domains track.
M21 starts after M6, M22 after M9, M12 and M21, and M24 after M21 and M22. Tracks never edit the same files. Shared files
(`router.rs`, `wrangler.toml` template, migrations) are changed only by the track that owns them, as
listed per milestone.

---

## M0 · Repository skeleton and CI

**Files:** `Cargo.toml` (workspace, `[workspace.dependencies]` pinned per
[Rust workspace](design/rust-workspace.md)), `rust-toolchain.toml`, `crates/{core,platform,api-types,worker,sdk,cli,conformance}/`,
`xtask/`, `.github/workflows/ci.yml`, `deny.toml`, `.cargo/config.toml`, `migrations/d1/`,
`deploy/wrangler.toml.tmpl`.

**Implements:** the workspace and dependency rules in `AGENTS.md`.

**Acceptance:**

- `cargo test --workspace` passes on an empty test per crate.
- `cargo xtask build-worker` builds a "hello" Worker to wasm. The size check runs and passes.
- CI runs these jobs: fmt, clippy, native tests, wasm build, `cargo deny check`, `mdbook build docs`.
- A CI check fails if any crate other than `platform` depends on `worker`
  (`cargo xtask check-layering`).

---

## M1 · Spikes (each one gates design choices)

Run against a scratch Cloudflare account and zone. Each spike is a small program under `spikes/` (not
shipped), plus a written result.

| Spike | Prove | Pass criteria | If it fails |
|---|---|---|---|
| S1 Bindings smoke | `workers-rs` 0.8.7 can: receive in `#[event(email)]`; send structured mail with `replyTo`, `headers` (In-Reply-To, References, Auto-Submitted, X-*) and attachments (attachment and inline); produce and consume Queues; use DO SQLite with transactions and alarms; query D1 | All calls work from Rust. Returned `messageId` captured | Use raw MIME send (`EmailMessage`) built with `mail-builder` for whichever field is missing |
| S2 Inbound failure semantics | What the sending MTA sees when `email()` throws, versus `set_reject` | Throwing gives a 4xx temporary failure (sender retries) | Write raw to an in-isolate retry, then fall back to `forward()` to a backup address on the same account. Document in [Inbound](design/inbound.md) |
| S3 FTS5 in DO SQLite | `contentless_delete=1`, the `trigram` tokenizer, `bm25()` with column weights | All available | Use an external-content table (`fts_docs`). Disable trigram and rely on reference normalisation plus semantic fallback |
| S4 Wasm budget | Bundle size, cold start, CPU and peak memory parsing a 25 MiB message, `mail-auth` verdicts on the corpus | Compressed bundle ≤ 10 MiB. Cold start under 1 s. A 25 MiB parse under 128 MB peak and inside the CPU limit. DKIM/DMARC verdicts match the reference on the corpus | Stream attachments to R2 before parsing bodies. Split heavy features behind cargo features |
| S5 MCP over rmcp | Serve MCP Streamable HTTP from the fetch handler using `rmcp` 3.5.1 protocol types (no tokio) | MCP Inspector and Claude Code connect, list tools and call one | Implement the JSON-RPC types locally from the spec (they are small) and keep `rmcp` for tests |
| S6 Externs and jurisdiction | Vectorize (`upsert`, `query` with metadata filter and namespace, `deleteByIds`) and `AI.toMarkdown` through `wasm-bindgen` externs. DO IDs from `unique_id_with_jurisdiction("eu")` stored and re-addressed with `id_from_string` | Every call works. An EU DO reports EU location | REST fallback for Vectorize (`/vectorize/v2/...`) and `toMarkdown` (`/ai/tomarkdown`) using `PM_CF_API_TOKEN` |
| S7 Outbound Message-ID | The relationship between the `messageId` that `send()` returns and the `Message-ID` header recipients see | Either a deterministic mapping, or the header learned from a journal copy | Strategy B: hidden journal BCC to `journal+{msg}@{platform}`. The email handler records the header and drops the copy. See [Outbound](design/outbound.md) |
| S8 SES in wasm | SigV4 signing for SES v2 `SendEmail` (raw) and SNS message signature verification (`SignatureVersion` 2 only; version 1 refused), from Rust in wasm | A real send through SES. A real SNS notification verified, a tampered one refused | SES leaves v1.0: an ADR moves `send_only`, `dns_records` and the SES failover to v1.1 |
| S9 Event subscriptions | Create an Email Sending event subscription to a queue through the API for one domain. Receive all six event types | Payload fields match the brief. Subscriptions can be created per domain at runtime | Create subscriptions at setup or domain-add time through the CLI only |
| S10 Child zones | On an Enterprise account, a subdomain-setup child zone accepts Email Routing catch-all to the Worker and Email Sending onboarding, and both work end to end ([Domains on any DNS host §12](design/domain-connections.md#12-spikes)) | Mail to any address at the child apex reaches `email()`; a send is DKIM-aligned | `delegated_subdomain` stays off; `dns_records` covers the case |
| S11 SES receiving | Rule set, S3 action and topic as specified. The notification shape (including the `objectKey` form) matches the design. S3 `GetObject` with SigV4 from a Worker. A 30 MB message. `user+tag@` routing. The retired-address bounce. The backstop picks up a message whose push failed | All pass in `eu-west-2` | `dns_records` does not ship in v1.0; `send_only` still does |
| S12 SMTP from a Worker | Ports 465 and 587 with `StartTls` against two real providers. The certificate host name is checked (a wrong-name certificate is refused). Timeouts and the uncertain window behave as designed | All pass | `smtp_relay` does not ship in v1.0 |

**Gate:** every spike has a written result. Design documents are updated where a fallback was taken.

---

## M2 · Core logic (`crates/core`, no I/O)

**Files:** `crates/core/src/{ids.rs, address.rs, thread_token.rs, mime/, sanitize.rs, text.rs, quote.rs, refs/, classify.rs, auth.rs, trust.rs, attach.rs, query/, fusion.rs, citations.rs, triage_rules.rs, policy.rs, dns.rs, domain_fsm.rs, injection.rs}`,
`crates/conformance/corpus/`, `fuzz/`.

**Implements:** the parsing and decision logic behind FR-ADR-6/7, FR-IN-3, 6, 7 and 9, FR-THR-1,
FR-SRCH-3/4/8 (verifier), FR-TRI-2, FR-DOM-4/5 (the pure state machine).

**Acceptance:**

- Unit tests for every `core::` row in sections A–H of the edge-case register (section N's are in M23):
  A1–A4, A12, B2, B4–B11, B13, C1, C2,
  C8, D1–D3, D6, D8–D10, E1, F1, F5, F9, F11, H2, H3, H7.
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
- Serde round-trip tests for every object, using the examples from `api.md`.

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

**Files:** `crates/worker/src/{lib.rs, router.rs, auth.rs, errors.rs, ratelimit.rs, request_id.rs, keyring.rs, handlers/{meta.rs, tenants.rs, keys.rs, audit.rs, usage.rs}, db/{mod.rs, tenants.rs, keys.rs, audit.rs, idempotency.rs, signing_keys.rs}}`,
`migrations/d1/0001_init.sql` (all tables from [Data model](design/data-model.md)),
`crates/worker/tests/` harness (`cargo xtask itest`).

**Implements:** FR-TEN-1/2/3, FR-KEY-1/2/3, the error envelope, rate limits, request IDs,
idempotency for non-mail POSTs, and the thread and link keyring (`signing_keys`, created on first use;
[Security](design/security.md#62-rotation-procedures)).

**Acceptance:**

- `it::auth::*`: unknown, expired and revoked keys; missing permission; key scope exceeded.
- A cross-tenant suite skeleton: for every registered route, a key from another tenant gets an
  indistinguishable `404`. The suite enumerates the router table, so a new route without a test fails.
- `it::keys::j6_revoke_rotate`, with `GET /v1/audit-events?actor_key_id=`.
- The keyring creates one key per purpose under concurrency and opens it with `PM_MASTER_KEY`.
- Idempotent `POST /v1/tenants` replays and conflicts.
- `/health`, `/v1/me` and `/openapi.json` are served.

**Owner of shared files from here:** Track 1 owns `router.rs` and migrations. Other tracks add routes
through `handlers/<area>.rs` plus one registration line, reviewed by Track 1.

---

## M6 · Identities, addresses, platform domain (Track 1)

**Files:** `handlers/{identities.rs, addresses.rs, domains.rs (platform domain read only)}`,
`db/{identities.rs, addresses.rs, domains.rs}`, `mailbox/mod.rs` (IdentityMailbox shell with
schema-on-wake), `crons/retire.rs`.

**Implements:** FR-IDN-1–4, FR-ADR-1–7, FR-DOM-1 (platform).

**Acceptance:** A5, A7 (pause part), A8, A11, A12, A13, J9, plus promote, retire and rollback flows
with `identity.address_*` events (to outbox).

---

## M7 · Inbound (Track 1)

**Files:** `email.rs` (handler), `consumers/inbound.rs`, `mailbox/{ingest.rs, threads.rs, messages.rs, attachments.rs, outbox.rs, schema/v1.sql}`,
`handlers/{threads.rs, messages.rs, quarantine.rs}`, `consumers/index.rs` (attachment text only at
this stage).

**Implements:** FR-IN-1–9, FR-THR-1/2, read APIs, quarantine and release, outbox and event index.

**Acceptance:** A2, A6, A9, A10 (inbound part), B1 (documented), B3, B12, B14, C1, C3, C7 (inbound
matching), D4, D5, D7, D9, D10, E5, J1, J2, J7, plus loopback L3, and every `conf::` corpus case
ingested end to end through workerd.

---

## M8 · Webhooks (Track 2)

**Files:** `handlers/webhooks.rs`, `consumers/webhooks.rs`, `webhooks/{sign.rs, ssrf.rs, client.rs, replay.rs}`, `crons/outbox_sweep.rs`.

**Implements:** FR-WH-1–5.

**Acceptance:**

- Signature vectors from the Standard Webhooks spec verify.
- Rotation sends two signatures.
- The SSRF table refuses loopback, RFC 1918, link-local, CGNAT, `::1`, `fc00::/7` and
  `169.254.169.254`, and does not follow redirects.
- J4: a time-controlled harness checks the retry schedule.
- Replay.
- Auto-disable on `410` and on 100 consecutive failures.

---

## M9 · Outbound and delivery (Track 1, after M7)

**Files:** `handlers/send.rs`, `mailbox/{submit.rs, compose.rs, locks.rs, deliveries.rs, idempotency.rs}`,
`transport/{mod.rs, cloudflare.rs, simulator.rs, loopback.rs}`, `consumers/{outbound.rs, delivery.rs}`,
`quota/mod.rs` (TenantQuota DO), `handlers/suppressions.rs`, `db/suppressions.rs`, `mailbox/alarms.rs`
(the claim, dispatch, lock and reconciliation purposes; no cron is involved).

**Implements:** FR-OUT-1–12, FR-DLV-1–5.

**Acceptance:** A7, A8, A10, C2, C4, C6, D6 (exchange cap), E2, E3, E8, G1–G4, G6–G11, K3,
L1, L2, L4. Also: the simulator matrix drives every status, an uncertain send is reconciled by a
later provider event, and `?dry_run=true` returns the recipient plan without storing anything.

---

## M10 · Search (after M7)

**Files:** `search/{mod.rs, keyword.rs, semantic.rs, hybrid.rs, rerank.rs, facets.rs, cursor.rs, tenant.rs, contacts.rs, related.rs}`,
`mailbox/search.rs`, `consumers/index.rs` (chunk, embed, upsert), `handlers/{search.rs, contacts.rs, wait.rs}`, `crons/index_reconcile.rs`.

**Implements:** FR-SRCH-1–7, 10 and 11 (index side), plus contacts, related and `wait`.

**Acceptance:** E4, F3–F8, F14, F15. Keyword p95 ≤ 200 ms on a 50,000-message synthetic mailbox in
workerd (a benchmark test that reports the figure, with a CI warning threshold).

---

## M11 · Agentic search (after M10)

**Files:** `search/agentic/{mod.rs, planner.rs, tools.rs, judge.rs, answer.rs, sse.rs, prompts.rs}`.

**Implements:** FR-SRCH-8/9.

**Acceptance:**

- E1 (fenced), F10–F13.
- Deterministic tests with a scripted fake model: plan, two searches, refine, answer, then a
  verifier removal.
- An SSE stream test.
- Budget enforcement by steps and by time.

---

## M12 · Triage (after M7)

**Files:** `triage/{mod.rs, rules.rs, model.rs, schema.rs, prompts.rs}`, `consumers/index.rs` (triage job).

**Implements:** FR-TRI-1–4.

**Acceptance:**

- D8 and rule evaluation order.
- Invalid model output ends `failed` and is never guessed.
- `message.triaged` events.
- The thread roll-up.

---

## M13 · Domains (after M7; SES depends on S8)

**Files:** `domains/{mod.rs, cloudflare_api.rs, ses_api.rs, records.rs, monitor.rs (DomainMonitor DO), fallback.rs}`,
`handlers/domains.rs` (full, including `PATCH /v1/domains/{domain_id}` for the transport), `transport/ses.rs`,
`consumers/ses_events.rs` (the `POST /hooks/ses` SNS endpoint).

**Implements:** FR-DOM-2–6.

**Acceptance:**

- H1–H7, G7, J5 (`it::domains::transport_patch`).
- `it::domains::*` with a DNS fake that can remove a record, add a conflicting record, or move the NS.
- The fallback send carries `sent_via_fallback` and keeps the thread token.
- Recovery leaves fallback threads pinned.

---

## M23 · Domains on any DNS host (after M13 and M9; S11, S12 and S10 gate methods)

**Files:** `crates/core/src/{connect.rs, smtp.rs, sns.rs}` (and SES receipt parsing in `ses.rs`),
`handlers/domains.rs` (methods, `PATCH` with `smtp`, `probe`), `handlers/addresses.rs`
(`test-forwarding`), `handlers/hooks_ses.rs` (`POST /hooks/ses/inbound`), `transport/smtp.rs`,
`inbound/sources/{routing.rs, ses.rs}`, `consumers/inbound.rs` (the SES source), `crons/ses_backstop.rs`,
`domains/monitor.rs` (method health rows, retired-address rules, probe and forwarding tokens), a
migration for the new `domains` columns, `ses_ingest`, `addresses.ses_bounce_rule` and
`addresses.forwarding`; CLI `pmail setup ses`, `pmail domains add --method`, `pmail domains update
--smtp-…`, `pmail domains probe` and `pmail addresses test-forwarding`.

**Implements:** FR-DOM-7–12, [Domains on any DNS host](design/domain-connections.md).

**Acceptance:**

- N1–N30, with the tests named in the register (`core::connect::method_matrix`,
  `core::sns::verify_v2_vectors`, `core::smtp::state_machine`, `core::dns::doubled_name_detected`,
  `it::ses::*`, `it::smtp::*`, `it::forwarding::*`, `cli::setup::ses_region_check` and
  `it::domains::{existing_mx_external, nameservers_dedicated_check, zone_expired, mx_wrong_region,
  zone_create_rate_limited, zone_hold, delegation_removed, ses_identity_limit}`).
- `pmail setup ses` is idempotent: it runs twice against a recorded AWS API fake with no duplicate
  resources, never deactivates an existing active rule set, and prints the IAM policy before applying it.
- Every new error code and `transport_unavailable` reason in the design is returned by at least one test.
- The cross-tenant suite covers `/hooks/ses/inbound` (no key) and the new routes.

**Gate:** each method ships only when its spike passed: S11 for `dns_records`, S12 for `smtp_relay`, S10
for `delegated_subdomain` (which also stays behind `PM_CF_SUBDOMAIN_SETUP`). `cloudflare_zone`,
`nameservers` and `send_only` do not wait for them. A method whose spike failed moves to v1.1 by ADR
(PRD section 5).

---

## M14 · Privacy (after M9, M10)

**Files:** `jobs/{mod.rs (JobRunner DO), erasure.rs, retention.rs, export.rs, reembed.rs, reparse.rs, reindex.rs, backup.rs}`,
`handlers/{erasure.rs, exports.rs, holds.rs, links.rs}`, `crons/retention.rs`.

**Implements:** FR-PRV-1–6, FR-IDN-4.

**Acceptance:** F6, I1–I7, J3, plus every erasure scope with receipt counts and empty probes, signed
links (`GET /v1/links/{token}`) with kid verification, the optional backup copy
(`it::retention::backup_copy`), and `it::logs::i5_no_content_in_logs`, which greps captured Worker logs
for any test-message body string and any test address.

---

## M15 · MCP server (after M10, M11)

**Files:** `mcp/{mod.rs, transport.rs, tools.rs, schemas.rs, prompts.rs}`.

**Implements:** FR-MCP-1 and the tool list in [MCP reference](../reference/mcp.md).

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

**Implements:** FR-SDK-1, FR-CLI-1, FR-OPS-1–3.

**Acceptance:**

- SDK integration tests run against the workerd harness for every endpoint.
- `pmail setup` is idempotent: it runs twice against a recorded Cloudflare API fake with no
  duplicate resources.
- `pmail deploy` verifies checksums and refuses a tampered bundle.
- `pmail doctor` reports every check with a fix.
- The landing-page CLI examples run as tests.

---

## M17 · Observability and operations (Track 3)

**Files:** `obs/{log.rs, metrics.rs}`, `ops/alerts.rs`, `consumers/dlq.rs`, `handlers/platform.rs`
(the platform API: `GET /v1/platform/dlq`, `POST /v1/platform/dlq/{dlq_id}/redrive`,
`POST|GET /v1/platform/jobs`, `POST /v1/platform/keys/{purpose}/rotate`, all `platform:ops`), CLI
`dlq list|redrive`. There is no internal-only handler: the CLI uses the public platform API.

**Implements:** FR-OPS-4 and [Observability](design/observability.md).

**Acceptance:**

- J8, J3 (job start through the API), `it::secrets::signing_key_rotation`, `it::ops::provider_quota_80`.
- Log scrubbing (part of I5).
- Every metric in the design is emitted by at least one test path.

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

## M21 · Console and workspaces (after M6; uses M8–M14 services)

**Files:** `crates/worker/src/console/{mod.rs, router.rs, session.rs, signin.rs, csrf.rs, layout.rs (maud), pages/*.rs}`,
`crates/worker/src/members/{mod.rs, invitations.rs, roles.rs}`, `handlers/members.rs`, migrations for
`users`, `members`, `invitations`, `login_tokens`, `sessions`.

**Implements:** FR-CON-1–7, the console screens in [Console design](design/console.md).

**Acceptance:**

- M9, M10, M15–M18.
- Every console route works with JavaScript disabled, checked by a Playwright run with `javaScriptEnabled: false`.
- An axe accessibility scan with no serious violations on every page.
- Sign-in emails are sent through the deployment's own platform identity, using the simulator in tests.

---

## M22 · Plans, metering and billing (after M9, M12, M21)

**Files:** `crates/worker/src/billing/{mod.rs, catalog.rs, quota.rs (TenantQuota allowances and holds), stripe.rs, webhook.rs, usage.rs}`,
`handlers/{usage.rs, plans.rs, billing.rs}`, console pages `plan.rs`, migration for `billing_accounts` and
`billing_events`.

**Implements:** FR-BILL-1–12, the metering points in [Billing design](design/billing.md).

**Acceptance:**

- M1–M8, M11–M14, M19.
- Every metered action is wired to a hold and a settlement, checked by a table test that lists each metering
  point. A new metered action without a row fails.
- A Stripe test-mode run (CLI `stripe trigger` fixtures recorded as JSON) covers checkout completed,
  subscription updated, payment failed, and canceled.
- `GET /v1/usage` matches the catalog and the `TenantQuota` state in property tests.

---

## M24 · Cloud sign-up and sign-in (after M21, M22)

**Files:** `crates/worker/src/console/{signup.rs, oauth.rs, totp.rs, landing.rs, onboarding.rs, pages/overview.rs}`,
`handlers/platform.rs` (`POST /v1/platform/waitlist/invite`), a migration for the new `users` columns,
`oauth_identities`, `oauth_states`, `waitlist` and `tenants.{require_two_factor, onboarding_dismissed_at}`,
the host split for `PM_CONSOLE_HOST` in `router.rs`, and CLI `pmail waitlist invite`.

**Implements:** FR-CON-8–13, [Cloud sign-up, sign-in and first run](design/cloud-signup.md).

**Acceptance:**

- M20–M34, with the tests named in the register (`it::oauth::*`, `it::signup::*`, `it::totp::*`,
  `it::landing::routing_table`, `it::checkout::*`, `it::abuse::free_ramp`,
  `it::console::delete_account_owner_required`).
- `core::totp::rfc6238_vectors`, `it::signup::email_creates_account_only_on_use`,
  `it::onboarding::derived_steps` and `it::hosts::console_api_split`.
- The new pages pass the M21 checks: they work with JavaScript disabled and have no serious axe
  violations.
- `pmail secrets rotate-master` re-seals `users.totp_sealed` and `users.recovery_codes_sealed`.

**Gate:** Google's and GitHub's endpoints and claim names are re-read from their current documentation
and recorded in the design before the OAuth code is written ([Cloud sign-up §4](design/cloud-signup.md#4-google-and-github)).

---

## M20 · Staging deploy and live proof

Deploy to staging with `pmail setup` and `pmail deploy` from the docs alone, as if you were a new
self-hoster. Then run `live::*`:

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
   in the audit log.
10. Cloud sign-up with Google (`PM_SIGNUP=open`): a new account and workspace, the Overview with its
    first-run checklist, and Checkout from `?plan=developer`.
11. Billing in Stripe test mode: upgrade Free to Developer through Checkout, spend the send allowance to a
    `402`, buy a top-up, and retry the same send successfully.
12. A fresh-account rehearsal: a person who did not build it deploys from `self-hosting.md` in under
    15 minutes (NFR-OPS-1).

**v1.0 release criteria:** [PRD §9](prd.md#9-release-criteria-v10).
