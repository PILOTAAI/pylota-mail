# Testing

Binding for implementation. This page defines the test layers, where each kind of test lives, the MIME
conformance corpus, property tests and fuzzing, the integration harness against a local workerd with its
fakes, fault injection and time control, the cross-tenant attack suite, the search and triage quality
gates, the live end-to-end suite against staging, coverage, how every edge-case row maps to a test, and
the CI checks. [Rust workspace](rust-workspace.md#9-xtask) defines the `xtask` commands and the base CI
pipeline; this page adds what they must contain.

| | |
|---|---|
| Requirements | PRD release criteria 1–7, NFR-QUAL-1, NFR-QUAL-2, NFR-QUAL-3, NFR-SEC-1, NFR-SEC-2, NFR-OPS-1 |
| Edge cases | Every row marked `S` or `S+I` in the [edge-case register](../edge-cases.md) |
| Code | `crates/core/src/**` (`#[cfg(test)]` modules), `crates/conformance/`, `crates/worker/tests/it/`, `crates/worker/tests/browser/`, `crates/worker/tests/live/`, `fuzz/`, `xtask/` |

## 1. Principles

1. **A change ships with a test that fails without it** (AGENTS.md definition of done).
2. **Test where the rule lives.** Pure rules are tested natively in `core`. Orchestration is tested
   natively against `platform::fakes`. Platform behaviour and wiring are tested against workerd. Only
   what needs real mail providers runs live.
3. **Deterministic by default.** Clock, randomness, DNS, models and vector search are fakes behind
   platform traits, so a failing test fails the same way every time.
4. **No real data.** Fixtures use RFC 2606 names (`example.com`, `example.net`, `example.org`,
   `*.example`, `agents.example`) and `.invalid` for the simulator; no real people, addresses or
   messages (CONTRIBUTING.md).
5. **Names are contracts.** Test names in the edge-case register exist verbatim in the code, and
   `cargo xtask trace` fails when one is missing (section 11).

## 2. Test layers

```text
                      ┌─────────────┐  live::   staging, real Gmail/Outlook/SES        nightly, release
                    ┌─┴─────────────┴─┐ eval    real Workers AI + Vectorize            nightly, release
                  ┌─┴─────────────────┴─┐ it::, browser::  local workerd, fakes        every PR
                ┌─┴─────────────────────┴─┐ worker logic on platform::fakes (native)   every PR
              ┌─┴─────────────────────────┴─┐ conf:: MIME corpus (native)              every PR
            ┌─┴─────────────────────────────┴─┐ core:: unit + property tests, fuzz smoke every PR
            └─────────────────────────────────┘
```

| Layer | Prefix | Location | Runs with | Covers |
|---|---|---|---|---|
| Unit | `core::` | `#[cfg(test)]` modules in `crates/core` | `cargo test --workspace` | Every pure rule: parsing, caps, sanitising, classification, verdicts, threading, tokens, addresses, query parser, fusion, citation verifier, triage rules, policy, DNS parsing, domain state machine, SSRF classification, fencing, crypto envelope, receipt builder, SLO rules, JWK thumbprints (`core::jwk::`), JWT signing (`core::jwt::`), HTTP message signature bases (`core::httpsig::`), notification rendering (`core::notify::`) |
| Property | `core::` | same modules, `proptest` | `cargo test --workspace` | Section 4 |
| Worker logic | `worker::`, `platform::` | `#[cfg(test)]` modules in `crates/worker` and `crates/platform` | `cargo test --workspace` | Handlers, Durable Object logic modules (`mailbox::Mailbox<P>` and the others) over `platform::fakes` with `rusqlite` standing in for Durable Object SQLite ([Rust workspace](rust-workspace.md#63-durable-object-classes)) |
| Conformance | `conf::` | `crates/conformance` | `cargo test --workspace` | The MIME corpus (section 5) |
| CLI | `cli::` | `#[cfg(test)]` modules and `tests/` in `crates/cli` | `cargo test --workspace` | Configuration, output, `setup` (including `pmail setup ses`) and `deploy` against recorded Cloudflare and AWS API fakes ([CLI and setup](cli.md)) |
| Fuzz | target name | `fuzz/` | `cargo xtask fuzz` | Section 8 |
| Integration | `it::` | `crates/worker/tests/it/` | `cargo xtask itest` | Section 6 |
| Attack suite | `it::security::` | `crates/worker/tests/it/security/` | `cargo xtask itest` | Section 7 |
| Browser | `browser::` | `crates/worker/tests/browser/`: Playwright specs in TypeScript, with `@playwright/test` and `@axe-core/playwright` at exact versions in its `package.json` and lockfile (pinned at build time) | `cargo xtask itest`, after the `it::` tests and against the same running Worker; `cargo xtask itest --suite browser` alone | Console pages with JavaScript disabled and the axe accessibility scan (FR-CON-1; build plan M21, M24, M26). Section 6.8 |
| Evaluation | – | `crates/conformance/golden/`, `xtask` | `cargo xtask eval-search`, `eval-agentic`, `eval-triage` | Section 9 |
| Live | `live::` | `crates/worker/tests/live/` | `cargo xtask live` | Section 10 |

## 3. Unit and worker-logic tests

- `core` takes time, randomness and lookups as arguments ([Design conventions](index.md#1-layering)), so
  its tests pass fixed values: `now_ms = 1_791_540_000_000`, fixed 32-byte keys, fixed random bytes.
- `core` builds for `wasm32-unknown-unknown` too (CI `wasm` job); tests run natively.
- Worker-logic tests build a `Platform` bundle from `platform::fakes`: an in-memory clock that tests
  advance, a seeded RNG, `rusqlite` for D1 and Durable Object SQLite (with FTS5), maps for R2, captured
  queue sends, scripted AI and Vectorize, a DNS zone map, a recording HTTP client and a recording mail
  sender. They exercise transactions, outbox writes, state machines and policy without workerd.
- Error-code tests compare `ErrorCode::http_status()` and `retryable()` with every row of
  [Errors](../../reference/errors.md) (`core::errors::catalogue_matches_reference`), and every
  `ErrorCode` variant with the catalogue in both directions.
- Snapshot-style assertions compare JSON structurally (`serde_json::Value`), never as strings.

## 4. Property tests

`proptest` (pin at build time), native only. Each property runs 1,024 cases in CI and 65,536 nightly
(`PROPTEST_CASES`).

| Test | Property |
|---|---|
| `core::query::f1_*` | For any input string: parsing never panics; it returns a typed tree or `invalid_query` with a position; the FTS5 expression built from any tree quotes every term, contains no bare FTS5 operator, column filter or `NEAR`, and never contains the raw input ([F1](../edge-cases.md)); `parse(print(tree)) == tree` |
| `core::address::a1_case_and_dots` (property part) | Normalisation is idempotent, case-insensitive on the local part, keeps dots, converts the domain to an A-label; random Unicode local parts are refused with `address_unsupported` or `address_reserved` ([A1](../edge-cases.md), [A3](../edge-cases.md)) |
| `core::thread_token::a2_round_trip` | Mint then verify returns `Valid` for random identities and sequence numbers; every single-bit flip returns `Invalid` or `Absent`; a token for one identity never verifies for another ([Threading](threading.md)) |
| `core::refs::f5_*` (property part) | Plate normalisation: `AB12CDE`, `ab12 cde` and `AB12  CDE` normalise equally; normalisation is idempotent ([F5](../edge-cases.md)) |
| `core::ssrf::refuses_private_ranges` | Every address inside each blocked range, including IPv4-mapped, NAT64 and 6to4 embeddings, is refused; addresses outside them pass ([Security](security.md#9-ssrf-controls)) |
| `core::injection::e1_*` (fence property) | After `core::injection::fence` escaping, no content, including content containing the nonce or runs of `<` and `>`, can terminate a `MAIL_CONTENT` fence ([Search](search.md#116-fencing-mail-content)) |
| `core::citations::f11_*` (property part) | A sentence survives verification only if every cited ID is in the evidence set and every quoted phrase occurs in the cited source after normalisation ([F11](../edge-cases.md)) |
| `core::keys::format_round_trip` | Generated keys match the key regex; parsing rejects every other shape |
| `core::mime::b2_caps` (property part) | Random nesting and part counts never exceed depth 32 or 500 parts in the parsed tree and never panic ([B2](../edge-cases.md)) |

## 5. MIME conformance corpus (`conf::`)

### 5.1 Layout

```text
crates/conformance/
  corpus/
    mime/          b2_*, b4_*, b5_*, b6_*, b7_*, b8_*, b9_*, b13_*   structure, charsets, TNEF, nesting
    auth/          d1_*, d9_*                                      DKIM, ARC, DMARC, forged Authentication-Results
    dsn/           d4_*, g6_*                                      DSNs, MDNs, auto-replies
    threading/     c1_*, c2_*, c7_*, c8_*                          headers and subjects
    sanitize/      b7_*, b11_*, e1_*                               remote content, hidden text, injection text
    attachments/   b10_*, b12_*                                    risky types, archive bombs, extraction inputs
  dns/             zone files (TOML) for the fake resolvers: DKIM keys, DMARC and SPF records
  keys/            DKIM signing keys generated for tests only (file names end in .test-only.pem)
  golden/          the evaluation set (section 9)
  src/             loader, expectation checker, generators
  THIRD_PARTY.md   origin and licence of every imported fixture
```

Each case is a pair: `<case>.eml` and `<case>.toml`.

```toml
# crates/conformance/corpus/mime/b5_shift_jis_subject.toml
id      = "b5_shift_jis_subject"
edge    = ["B5"]
source  = "authored"                 # authored | generated:<generator> | derived:<origin> | imported:<project>
licence = "FSL-1.1-ALv2"

[envelope]
from = "sender@example.net"
to   = "bookings.acme@agents.example"

[expect]
subject        = "ご予約の確認"
flags          = []
text_contains  = ["予約番号 BK-2291"]
attachments    = 0
kind           = "normal"
verdict        = "none"              # with the zone fixtures in dns/
```

### 5.2 Sources and licensing

| Source | Rule |
|---|---|
| Authored | Written for this repository, under the repository's licence (FSL-1.1-ALv2). The default |
| Generated | Produced at test time by a seeded generator in `crates/conformance/src/gen/` (large messages, deep nesting, part floods, the 25 MiB message for spike S4). Not committed when larger than 1 MiB |
| Derived | Built from published standards examples (RFC example messages), with every address rewritten to RFC 2606 names; the origin is named in `source` |
| Imported | Test fixtures from open-source projects under Apache-2.0 or MIT (for example the `mail-parser` test suite), each listed in `THIRD_PARTY.md` with its upstream path and licence |

Never: real mail dumps, archives of public mailing lists, or anything containing a real person's
address. DKIM-signed fixtures are signed with the test-only keys and verified against the zone fixtures,
so signatures are reproducible.

### 5.3 Runners

- **Native** (`cargo test -p pylota-mail-conformance`): parse each case with `core`, compare with
  `[expect]`. Test names are `conf::<dir>::<id>`, generated from the files, so the register's wildcards
  (`conf::mime::b2_*`) match every case with that prefix.
- **Through workerd** (`it::conformance::corpus_via_workerd`): inject every case through the local email
  endpoint and compare the Message object returned by the API with the native expectations. This catches
  differences between native and wasm builds and gives the verdict-parity check of spike S4.

## 6. Integration tests against workerd (`it::`)

### 6.1 What `cargo xtask itest` does

As defined in [Rust workspace](rust-workspace.md#9-xtask), plus the details below:

1. Build the Worker with `worker-build --release` and the `itest-hooks` cargo feature.
2. Render `deploy/wrangler.itest.toml`: the production bindings, local resources, `PM_ENV = "local"`,
   `PM_PLATFORM_DOMAIN = "agents.example"`, `PM_API_HOST = "localhost:8799"`,
   `PM_CONSOLE_HOST = "console.localhost:8799"` (hosts with the port, so the console's `Origin` rule and
   the host split work unchanged: [Console › CSRF](console.md#csrf)),
   `PM_SIGNUP = "open"` with the four values it requires (`PM_TERMS_URL = "https://agents.example/terms"`,
   `PM_PRIVACY_URL = "https://agents.example/privacy"`, `PM_DPA_URL = "https://agents.example/dpa"` and
   `PM_TERMS_VERSION = "itest-1"`; without them the configuration is `config_invalid`,
   [Rust workspace § 6.1](rust-workspace.md#61-errors-and-configuration)), `PM_WEB_BOT_AUTH = "on"`
   (local only: the S13 gate applies to real deployments), the SES variables (`PM_SES_REGION = "eu-west-2"`, `PM_SES_INBOUND_*`) and the
   Google, GitHub and Stripe client settings naming resources on the fake server, random test secrets
   written to `.dev.vars` in a temporary directory, `PM_ITEST_FAKES_URL = "http://127.0.0.1:8798"`, a random
   `PM_ITEST_TOKEN`, queue consumers with `max_batch_timeout = 1`, and no `AI` or `VECTORS` binding (both
   are served by fakes). Tests inject provider events through the production `Q_DELIVERY` producer
   binding, which exists for dead-letter redrive.
3. Apply D1 migrations: `npx --yes wrangler@4.139.0 d1 migrations apply pylota-mail --local
   --persist-to target/itest/state --config deploy/wrangler.itest.toml` (a fresh directory per run). The
   rendered file sets `migrations_dir = "../migrations/d1"`, because Wrangler resolves it against the
   file's own directory, `deploy/`. Until v1.0 there is one file, `0001_init.sql`.
4. Write a throwaway TLS certificate for the run: `openssl req -x509 -newkey ec -pkeyopt
   ec_paramgen_curve:P-256 -nodes -days 2 -subj /CN=localhost -addext
   "subjectAltName=DNS:localhost,DNS:console.localhost,IP:127.0.0.1"` into `target/itest/tls/`. Then start
   `npx --yes wrangler@4.139.0 dev --local --port 8799 --local-protocol https --https-key-path
   target/itest/tls/key.pem --https-cert-path target/itest/tls/cert.pem --persist-to target/itest/state
   --test-scheduled --config deploy/wrangler.itest.toml` (Wrangler's `dev` options `--local-protocol`,
   `--https-key-path` and `--https-cert-path`, Cloudflare "Wrangler commands", read 2026-10-10), write its
   PID to `target/itest/wrangler.pid`, and capture stdout and stderr to `target/itest/worker.log`. Wait
   for `GET https://localhost:8799/health`. The console needs HTTPS locally because its cookies are
   `__Host-` and `Secure` and its `Origin` must be `https://…` ([Console › CSRF](console.md#csrf)).
5. Seed exactly what `pmail setup` writes in steps 19–22 ([CLI and setup §6.3](cli.md#63-steps)), in the
   same way:
   - one platform key (step 19, the bootstrap key) with `wrangler d1 execute --local`; the harness knows
     `PM_KEY_PEPPER` because it generated it. The bootstrap key expires after 24 hours, which tests that
     advance the fake clock pass, so the harness at once uses it to mint, through `POST /v1/keys`, a
     platform key with every platform-level permission and no `expires_at`, and runs the suite with that
     key. Tenant and identity keys that sign are minted from it with `identities:sign` granted
     ([Security §4.6](security.md#46-creating-keys-fr-key-1));
   - the platform domain row for `agents.example` (step 20) with `wrangler d1 execute --local`, with
     `records_json` matching the DNS fake's zone for it and `monitor_do_id = ''`. Until M13 builds the
     `DomainMonitor`, the row is written with `state = 'healthy'`. From M13 it is written `pending`, as
     setup writes it, and the harness triggers the every-minute cron (section 6.5), then advances the fake
     clock and runs the monitor's alarm through `/__test/alarm` until it has verified the domain `healthy`;
   - the default tenant (step 21) through `POST /v1/tenants` with that key and `address_suffix: ""`,
     because only the Worker can mint its `TenantQuota` ID;
   - from M6, which builds the minting hook, the system identity (step 22): its `identities` row
     (`is_system = 1`, `mailbox_do_id = ''`) and primary address with `wrangler d1 execute --local`, then
     one every-minute cron run, after which its mailbox exists.

   Every other fixture (tenants, identities, domains, keys) is created through the public API.
6. Run `cargo test -p pylota-mail-worker --features itest-hooks --test it -- --test-threads=1` with
   `PM_ITEST_URL=https://localhost:8799` and `PM_ITEST_CA=target/itest/tls/cert.pem`. The test client
   (`reqwest`) trusts that certificate as its only extra root and pins `localhost` and
   `console.localhost` to `127.0.0.1` (`ClientBuilder::resolve`), so console requests go to
   `https://console.localhost:8799` with no `Host` override. The `it` test target declares
   `required-features = ["itest-hooks"]`, so `cargo test --workspace` never builds it.
7. From M21, run the browser suite (section 6.8) while wrangler and the fake server are still up.
8. Stop wrangler and the fake server; delete `target/itest/state` unless `--keep` was passed.

### 6.2 Test hooks

Compiled only with `itest-hooks`, honoured only when `PM_ENV = "local"`, and refused unless the request
carries `x-pm-test-token: <PM_ITEST_TOKEN>`. `cargo xtask build-worker` refuses the feature and fails if
the release bundle contains `/__test/`.

| Hook | Does |
|---|---|
| Invocation sync | At the start of every `fetch`, `email`, `queue`, `scheduled`, `alarm` and Durable Object request, read `GET {fakes}/state` (clock offset and fault-plan version) into isolate state |
| `POST /__test/inbound` | Runs the `email()` handler code with a synthetic message (`mail_from`, `rcpt_to`, `raw_base64`) and returns `{ "outcome": "accepted" \| "rejected" \| "tempfail", "smtp": "550 5.1.1 …" }`. Used for cases the local endpoint cannot carry (no `Message-ID`, [B3](../edge-cases.md)) and to observe reject and temporary-failure outcomes ([A6](../edge-cases.md), [J1](../edge-cases.md)) |
| `POST /__test/alarm` | `{ "class": "mailbox" \| "domain" \| "job" \| "quota" \| "notifier", "object_id" }`: runs the object's alarm handler now, executing every purpose due at the fake clock |
| `GET /__test/routes` | The router table (method, pattern, permissions, scope, idempotency) for the attack suite |
| `POST /__test/rpc` | Sends a raw `RpcEnvelope` to an object, for owner-mismatch tests |
| `POST /__test/delivery-event` | Publishes a provider event payload to `pm-delivery-events` through `Q_DELIVERY` |
| `POST /__test/mailbox-schema` | Sets an object's `meta.schema_version` back by one, for [J9](../edge-cases.md) |
| `POST /__test/bulk-seed` | `{ "identity_id", "count", "seed" }`: writes `count` synthetic messages (at most 50,000 per identity) from the seeded generator in `crates/conformance/src/gen/` straight into the identity's mailbox in batches of 500, with their FTS rows, refs and `chunks` rows as ingest would write them, and queues their `Embed` jobs; no `email()`, no events, no webhooks. For the benchmarks of section 6.9, which cannot inject 50,000 messages through the email endpoint in a reasonable time |

### 6.3 Fakes

All external services are served by one fake server inside the test process
(`crates/worker/tests/it/fakes/`, a blocking HTTP server on `127.0.0.1:8798`; the HTTP server crate is
pinned at build time). With `itest-hooks`, `platform::itest` provides implementations of the platform
traits that call it:

| Trait | Fake behaviour |
|---|---|
| `Dns` | Zone maps per resolver (`First`, `Second`), mutable by tests; per-resolver errors and disagreement ([H1](../edge-cases.md), [H7](../edge-cases.md)); seeded from `crates/conformance/dns/` |
| `Ai::run` (embeddings) | Feature hashing of normalised tokens into 1,024 dimensions, L2-normalised: deterministic and similarity-preserving enough for hybrid tests |
| `Ai::run` (rerank) | Cosine similarity of the same vectors |
| `Ai::run` (triage) | Schema-valid output looked up by `raw_sha256` from the labelled set, a default rule-based output otherwise; scriptable invalid JSON and timeouts (FR-TRI-4) |
| `Ai::run` (planner) | Scripted tool-call sequences per question from `crates/conformance/golden/questions.toml`, including a hostile script that tries to widen scope ([F10](../edge-cases.md)) |
| `Ai::to_markdown` | Text from a sidecar fixture, or a scripted failure or timeout ([B12](../edge-cases.md)) |
| `VectorIndex` | In-memory namespaces with metadata filters (equality and `sent_at` ranges), mutation IDs, a configurable processing lag and `processedUpToDatetime`; `describe()` with the vector count, which tests can offset for the drift check; scriptable failures ([F14](../edge-cases.md)) and a "keep one vector" mode for probe tests ([F6](../edge-cases.md)) |
| `MailSender` (live tenants) | Records every `StructuredEmail`; scripted outcomes: accepted with a `messageId`, a coded error (`E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_HEADER_NOT_ALLOWED`, `E_RECIPIENT_SUPPRESSED`, …), an exception, or a timeout. The recorded mail is also readable over HTTP, for the browser suite: `GET {PM_ITEST_FAKES_URL}/__fakes/mail?to={address}&last=1` answers the last message to that address (headers, text and HTML parts), from which a Playwright test reads a sign-in code or link. The route exists only in the fake server, never in the Worker |
| `HttpClient` | Routes requests by host to fake handlers: Cloudflare API (zones, including zone creation with scriptable error `1105` and zone-hold refusals; routing rules with the 200-rule limit; sending subdomains including `preview_enabled`; event subscriptions), SES (`SendEmail`, which checks the SigV4 signature against test credentials; email identities with scriptable DKIM and MAIL FROM status; the account's sending status; receipt rules with the 200-rule and 500-recipient caps), S3 (`GetObject` and `DeleteObject` on the inbound bucket, with SigV4 checks and scriptable `NoSuchKey`), SQS (`ReceiveMessage` and `DeleteMessage` on the backstop queue), SNS certificates, Google and GitHub OAuth (token, user and email endpoints with scriptable claims and unverified addresses), Stripe (creating and retrieving Checkout Sessions, the objects billing reads, and subscription cancellation, with scriptable failures), RDAP, the scanner, and webhook receivers. Any other host gets `HttpError::Connect`: integration tests never reach the internet |
| SNS push | The fake server signs SES notifications with a test key (`SignatureVersion` 2, or 1 and tampered variants on request) and `POST`s them to the Worker's `/hooks/ses/inbound` and `/hooks/ses`. A test can skip the push and leave the notification only in the SQS fake, for the backstop cron ([N1](../edge-cases.md)–[N3](../edge-cases.md)) |
| TCP sockets (the `platform` wrapper over `connect()`) | Routes by host name to a scripted SMTP server in the fake process on ports 465 and 587. Scripts can omit `STARTTLS`, answer `535`, refuse some `RCPT TO` with `4xx` or `5xx`, close the connection after the final `.`, or exceed each timeout. Accepted messages can be handed to the platform domain's inbound path, unchanged or with a rewritten `From` or a foreign DKIM `d=`, for alignment probes and DSNs. TLS is simulated; certificate checking is proved by spike S12 and live, not here ([N14](../edge-cases.md)–[N20](../edge-cases.md)) |

- Test tenants use the real simulator and loopback code (`*@simulator.invalid`, [L2](../edge-cases.md),
  [L3](../edge-cases.md)); only live tenants use the fake mail sender. The real Cloudflare transport is
  exercised by spike S1 and the live suite: the local `send_email` simulation cannot serialise binary
  attachments (Cloudflare Email Service local-development docs, read 2026-10-09).
- Webhook receiver fakes record each request (headers, body, signature check result) and can return any
  status, delay past the 15 s timeout, redirect, or stream an oversized body.
- The SSRF guard runs unchanged: the DNS fake answers webhook and SMTP relay hosts with a fixed public
  address that is never contacted, because the fake HTTP client and the socket fake route by host name.
- The groups that use these fakes: `it::ses::*` (SNS push, SQS, S3 and SES fakes), `it::smtp::*` (the
  SMTP server fake), `it::forwarding::*` (the mail sender fake plus inbound injection at the platform
  address), `it::domains::*` (DNS, Cloudflare API and SES fakes), `it::oauth::*` (OAuth fakes and one cookie
  jar per simulated browser), `it::checkout::*` and `it::signup::*` (Stripe fake), `it::totp::*`,
  `it::landing::*`, `it::onboarding::*` and `it::abuse::*` (fake clock), `it::hosts::*` (the two
  `Host` values), `it::identity_keys::*`, `it::assertions::*`, `it::http_signatures::*` and
  `it::well_known::*` (fake clock for overlap windows and expiry; the Rust SDK's `verify_assertion`
  runs natively in the test process against the JWKS that workerd serves), and `it::notify::*` (fake
  clock for holds, windows, the 09:00 run, time zones and cooldowns; `/__test/alarm` with class
  `notifier`; notification emails are observed the same way as console sign-in mail, which the system
  identity also sends ([Console › Requesting a link or code](console.md#requesting-a-link-or-code));
  `/__test/delivery-event` for a hard bounce on a notification; the DNS fake to make the platform domain
  `failing`).
- **Another value of a deployment variable or secret.** A test that needs one (`PM_CONSOLE=off` for
  `it::console::disabled`, `PM_WEB_BOT_AUTH=off` for `it::http_signatures::disabled_and_policy`,
  `PM_BILLING=off` for `it::notify::billing_off_no_usage_alerts`, `PM_NOTIFICATIONS=off`, or the secret
  `PM_MASTER_KEY_NEXT` for the master-key rotation tests) calls `restart_runtime_with(&[(name, value)])`,
  which restarts wrangler like `restart_runtime()` (section 6.6) with the value overridden in the
  rendered `wrangler.itest.toml` or `.dev.vars`, and restores the original on exit.

### 6.4 Injecting inbound mail

The default path is the endpoint `wrangler dev` provides for email handlers (Cloudflare docs, read
2026-10-09): `POST https://localhost:8799/cdn-cgi/local/email?from=<envelope from>&to=<envelope to>` with
the raw RFC 5322 message as the body; the message must have a `Message-ID` header. One call per envelope
recipient, as Email Routing invokes the handler once per recipient ([A9](../edge-cases.md)). The
documentation does not say how a `setReject` is reported to the caller, so tests read the outcome from
`/__test/inbound` or from the `inbound_rejected` log line; S1 records the endpoint's actual response.

### 6.5 Time control

- **Platform clock.** `platform::itest::Clock` returns `Date.now() + offset`, with the offset set by
  `POST {fakes}/clock { "advance_ms" }` or `{ "set_ms" }` and synchronised at each invocation (6.2).
- **Alarms.** Objects arm alarms at absolute times computed from the fake clock, which may be far in the
  real future; tests run them with `/__test/alarm`. Purposes not yet due at the fake clock do not run.
- **Cron.** `GET /cdn-cgi/local/scheduled?cron=<expression>&time=<ms>` triggers `scheduled()` with that
  cron and `scheduledTime` (Cloudflare docs, read 2026-10-09); `time` is the fake clock.
- **Queue delays.** `platform::itest` producers and `Incoming::retry` record the requested delay at the
  fake server (`GET {fakes}/queue-log`) and send with `min(requested, 1)` second. Retry-schedule tests
  ([J4](../edge-cases.md), [G3](../edge-cases.md), [G8](../edge-cases.md)) assert the recorded delays.
- **Waiting.** Asynchronous effects are awaited by polling the API with backoff (50 ms doubling to
  1 s) for at most 20 s; a test never sleeps a fixed time.

### 6.6 Fault injection

`POST {fakes}/faults` arms a fault plan; decorators in `platform::itest` consult it before each call:

```json
{ "target": "r2.put", "match": { "key_prefix": "t/" }, "mode": "error", "count": 3 }
```

| Target | Modes | Used by |
|---|---|---|
| `r2.put`, `r2.get`, `r2.delete`, `r2.list` | `error`, `timeout` | [J1](../edge-cases.md), erasure retries |
| `d1.query` (with `match.sql_prefix`) | `error` | [J7](../edge-cases.md) (directory lookup), job retries |
| `do.call` | `error`, `timeout` | Partial tenant search ([F15](../edge-cases.md)) |
| `transport.send` | the mail sender's scripted outcomes | [G2](../edge-cases.md), [G3](../edge-cases.md), [G10](../edge-cases.md) |
| `ai.run`, `ai.to_markdown` | `error`, `timeout`, `invalid_output` | [F12](../edge-cases.md), [B12](../edge-cases.md), FR-TRI-4 |
| `vectorize.upsert`, `vectorize.query`, `vectorize.delete` | `error`, `lag` | [F14](../edge-cases.md), [F6](../edge-cases.md) |
| `doh.query` | `error`, `answer` (per resolver) | [H7](../edge-cases.md) |
| `http.send` (by host) | `error`, `status`, `delay`, `redirect` | Webhooks, SSRF tests, SES, S3, SQS, OAuth and Stripe failures |
| `tcp.connect` (by host) | `error`, `timeout` | SMTP relay connection failures (`502 upstream_error` at create; `RetryLater` on a send) |

**Runtime restarts.** For [J2](../edge-cases.md), the harness helper `restart_runtime()` kills the
wrangler process from `target/itest/wrangler.pid` mid-test and starts it again with the same
`--persist-to` directory, then asserts the queue retry produced exactly one stored message.

### 6.7 Isolation and logs

- Each test creates its own tenant (`slug = "t" + 10 hex of the test name's hash`), so tests do not see
  each other's data. Tests that change global state (clock, fault plans, platform domain records) reset
  it in a guard on exit; `--test-threads=1` keeps them serial.
- The I5 log-scrubbing test ([I5](../edge-cases.md)) runs last: it reads `target/itest/worker.log` and
  fails if any canary string appears. Every fixture plants canaries: a unique token in each body,
  subject, display name, filename and attachment text, and every address used by the suite, plus every
  key and webhook secret the suite created.

### 6.8 Browser suite (`browser::`)

From M21 on, `cargo xtask itest` runs the Playwright suite in `crates/worker/tests/browser/` after the
`it::` tests, while wrangler and the fakes are still running, with
`npx --prefix crates/worker/tests/browser playwright test` (Node.js 22 and the Chromium build of the pinned
Playwright release, which the CI job installs). `--suite it` and `--suite browser` run one suite alone.
The test titles carry the `browser::` names, which `cargo xtask trace` collects like the Rust ones.

The suite's base URL is `https://console.localhost:8799`, with `ignoreHTTPSErrors: true` for the
throwaway certificate; Chromium resolves `*.localhost` to the loopback address. It signs in the way a
person does: it submits the sign-in form, reads the code from the mail-sender fake
(`/__fakes/mail?to=…&last=1`, section 6.3) and enters it, and it waits 2 seconds before submitting a form
that carries a form ticket ([Cloud sign-up §6.2](cloud-signup.md#62-after-launch-open-sign-up)). It
seeds its owner and viewer through the public API with the bootstrap platform key, like every other
fixture.

| Test | Proves |
|---|---|
| `browser::console::no_js` | With `javaScriptEnabled: false`, every route of the console's route table (read from `GET /__test/routes`) renders, and every form on it submits and reaches its result page, for a signed-in owner and a viewer; the run fails on any request to another origin |
| `browser::console::axe_scan` | An axe scan of every console page, in the same run, finds no violation of impact `serious` or `critical` |

Pages added by M24 (sign-up, two-step verification, the Overview) and M26 (notification settings and the
unsubscribe pair) join both tests when they land.

### 6.9 Benchmarks

The `it::bench::*` tests that need a large mailbox (`it::bench::keyword_p95` and `it::bench::hybrid_p95`
on 50,000 messages, and `it::bench::tenant_fanout_p95` over 10 identities) fill it with
`POST /__test/bulk-seed` and then measure through the public API. They are marked `#[ignore]`, so the
pull-request `itest` run skips them, and the nightly workflow runs them by passing `--ignored` to the test
binary. Each reports its figure and warns above its target. They are never a required check on a pull
request: a 50,000-message seed takes minutes, and timings on shared CI runners are noisy.

## 7. Cross-tenant attack suite

Proves NFR-SEC-1 (zero cross-tenant access), FR-KEY-3 and the partner isolation of FR-KEY-4. Rules are in
[Security › Authorisation](security.md#5-authorisation-and-tenant-isolation).

**Fixture.** Two tenants, A (victim) and B (attacker), each with two identities, a domain, a webhook, a
key of each level holding every permission valid at that level, threads with messages and attachments,
a held thread, an erasure request, an export, an identity signing key on each identity (one rotated, so a
`retiring` key exists too) and `policy.web_bot_auth.allowed = true`. Tenant A's mail contains a unique
canary term. A third tenant C is a test tenant. Two partners, P and Q, each have a partner key holding
every permission valid at the partner level and a partner webhook endpoint: P's key created A, Q's key
created B, and C was created by a platform key, so it has no partner. A's domain was added with
`nameservers`, so the Cloudflare fake holds A's zone and its `zone_claims` row; the fake also holds the
zone of `PM_PLATFORM_DOMAIN`.

"Every permission valid at that level" follows [Security §4.6](security.md#46-creating-keys-fr-key-1):
a tenant key holds every permission except `tenants:manage`, `partners:manage`, `platform:ops` and
`tenants:erase` (which only the workspace owner's keys hold; the fixture mints keys through the API), so it
holds `identities:sign`, granted by the platform key that mints it; an identity key holds the same set
without the tenant-only permissions (`members:read`, `members:manage`, `suppressions:manage`,
`audit:read`, `usage:read`, `policy:write`,
`accounts:approve`), plus `usage:read` implicitly for its own workspace. A partner key holds every
permission except `platform:ops`, `partners:manage` and `identities:sign`, so it holds `tenants:erase`.

**Attacker key classes** (each with full permissions for its level):

| Class | Key |
|---|---|
| `foreign_tenant` | Tenant key of B (with `identities:sign`) |
| `foreign_identity` | Identity key of B's first identity (with `identities:sign` for that identity) |
| `sibling_identity` | Identity key of A's second identity, attacking A's first identity |
| `mode_mismatch` | Test-mode key of C, attacking live tenant A ([L4](../edge-cases.md)) |
| `foreign_partner` | Partner key of Q, which created B but not A: a partner reaching another partner's tenant ([J10](../edge-cases.md)) |
| `revoked`, `expired` | A's own tenant key, revoked or expired |

**Matrix.** `it::security::cross_tenant_matrix` reads `GET /__test/routes` and, for every route with a
path parameter and every attacker class, calls the route with A's resource IDs (and, for `POST`/`PATCH`,
a valid body). The enumeration includes the identity-key routes (`…/keys`, `…/keys/rotate`,
`…/keys/{kid}/revoke` with A's kid), `POST …/assertions` and `POST …/http-signatures` on A's
identities; the scope check answers before any signing rule, so they give the same
`404 identity_not_found` as a missing identity. For each call it also makes a control call with the same key and a random non-existent
ID of the same type. It asserts:

1. The status is `404` with the route's `*_not_found` code, or `403 scope_denied` for a route above the
   key's level on its own tenant, or `401` for revoked and expired keys, or `403 permission_denied` when
   the control call gets the same body. The last case is a route needing a permission the key's level
   can never hold (`tenants:manage` for a tenant key), or `foreign_permissions` on
   `GET /v1/tenants/{tenant_id}`: section 5.2 of Security checks permissions, `foreign_permissions`
   included, before it resolves the owner, comparing the path's tenant ID with the key's own without a
   D1 read, so a foreign ID and a random one get the same `403`. Any other `403` fails the test.
2. The attack response equals the control response byte for byte, except `request_id` and the
   `Request-Id` and `RateLimit-*` headers (indistinguishability).
3. No side effect: D1 row counts for A, A's mailbox state (via a platform key), A's outbox and A's
   webhook receiver are unchanged, and no `audit_log` row names A.
4. The same matrix runs over MCP: every tool, with the same attacker keys, returns an error and no data.

**Zone case `foreign_zone`** ([H8](../edge-cases.md)). B's tenant key and Q's partner key call
`POST /v1/tenants/{B}/domains` with `method: "cloudflare_zone"` (once with `replace_mx: true`) for A's
zone, for a name under it, and for a name under the platform domain's zone, also after a platform key
lists A's zone in B's `domains.cloudflare_zones`; and with `nameservers` and `delegated_subdomain` for a
name under either zone. Each gets `403 scope_denied` with `details.reason = "zone_not_allowed"`, the same
body as for a zone that does not exist, before any call reaches the Cloudflare fake; no D1 row is written,
no MX record of A's zone is deleted, and A's routing is unchanged.

**Additional suites.**

| Test | Attack |
|---|---|
| `it::security::route_table_complete` | Every route in `/__test/routes` appears in the matrix, has a scope rule and a non-empty permission list (except `Scope::Public`, `GET /v1/me` and `GET /v1/tenants/{tenant_id}`, which carries `foreign_permissions` instead; `GET /v1/usage` needs `usage:read`, which tenant and identity keys hold implicitly); a route added without them fails this test. The `Scope::Public` set is exactly the list of [Security §4.7](security.md#47-unauthenticated-routes), the two `/.well-known/` key routes included |
| `it::security::body_scope_ignored` | For every `POST`, `PATCH` and list route: `tenant_id`, `identity_id` and `identity_ids` naming A in bodies and query strings, sent with B's keys |
| `it::security::search_canary_isolation` | B searches for A's canary in every mode, including agentic with a question that asks for "all tenants"; zero hits and no evidence from A |
| `it::security::vector_foreign_id_dropped` | The Vectorize fake returns one of A's vector IDs to B's semantic query; the mailbox read-back drops it and `rpc_owner_mismatch_total` does not move (the ID is simply not found in B's mailbox) |
| `it::security::rpc_owner_mismatch` | `/__test/rpc` sends an envelope with B's IDs to A's mailbox; `internal_error`, `rpc_owner_mismatch` logged, metric incremented, alert fired |
| `it::inbound::a2_forged_token_ignored` | Mail to B's address with a token minted for A's thread files into B's mailbox only |
| `it::security::webhook_filter_scope` | B creating a webhook with `identity_ids` of A gets `404 identity_not_found` |
| `it::partners::j10_foreign_partner_not_found` | P's partner key against every route with the resource IDs of B (Q's tenant) and of C (no partner), and against Q's partner endpoint and Q's partner key by ID: the same `404` as a missing ID and no side effect; `GET /v1/tenants`, `GET /v1/keys` and `GET /v1/webhooks` with P's key list only A's rows and P's endpoint ([J10](../edge-cases.md)) |
| `it::webhooks::j15_partner_scope_filter` | Events of B and C never reach P's partner endpoint, and events of A never reach Q's ([J15](../edge-cases.md)) |
| `it::security::mcp_tools_follow_key` | Tools listed and callable only with their permission; `mail_sign_assertion` and `mail_sign_http_request` are never listed to a platform or partner key; with P's partner key every tool reaches A and answers for B and C as for a missing ID (C's `NULL` `partner_id` never matches); with P suspended, every tool call with P's key or A's tenant key gets `partner_suspended` |
| `it::identity_keys::paused_withdraws_jwks`, `it::assertions::erasure_tombstones_kid` | Without a key: a paused identity's JWKS answers the same `404 identity_not_found` as an unknown ID; an erased identity's kid is never published again ([O1](../edge-cases.md), [O7](../edge-cases.md)) |
| `it::notify::one_click_unsubscribe` | An unsubscribe token for a person of B, altered to name A's workspace or another kind, changes nothing and gets the same page as an expired token ([O18](../edge-cases.md)) |

The suite is part of `cargo xtask itest` and therefore a required check on every pull request. Timing is
not asserted in CI (too noisy); both code paths do the same D1 read by construction.

## 8. Fuzzing

The fuzz project lives in `fuzz/` (cargo-fuzz, libFuzzer, nightly toolchain only) with the targets listed
in [Rust workspace](rust-workspace.md#9-xtask). The five required by the edge-case work:

| Target | Invariants checked beyond "no panic" |
|---|---|
| `mime_parse` | Depth ≤ 32 and parts ≤ 500 in the output; every output string is valid UTF-8; time per input under 1 s |
| `query_parse` | The FTS5 expression from any successful parse quotes every term; errors carry a position inside the input |
| `address_parse` | Normalisation is idempotent; a validated username matches `^[a-z0-9][a-z0-9._-]{0,23}$` |
| `sanitize` | Output contains no `<script`, no `on*=` attribute, no remote `src`; `sanitize(sanitize(x)) == sanitize(x)`; derived text contains none of the hidden-text code points |
| `dsn_parse` | The classification is one of the defined kinds; a DSN's recipients are syntactically valid addresses or absent |

- Seeds come from `crates/conformance/corpus/`.
- CI runs the five for 60 seconds each on every pull request (`fuzz-smoke`); nightly runs every target
  for 10 minutes.
- A crash is minimised (`cargo fuzz tmin`), committed as a regression input under
  `crates/core/tests/fuzz_regressions/<target>/`, and replayed by
  `core::fuzz_regressions::replay_all` in the normal test run.
- Before a release every target must have run clean for 24 cumulative hours on the release commit
  ([Security](security.md#16-pre-release-checklist)).

## 9. Search and triage evaluation

The golden set, the labelled queries, the agentic questions, the triage labels and the metric
definitions are owned by [Search › Quality evaluation](search.md#13-quality-evaluation) and
[Triage › Evaluation set](triage.md#13-evaluation-set-and-nfr-qual-3). This section defines how the
harness runs them.

### 9.1 Files

```text
crates/conformance/golden/
  generator.toml    seed and template mix; the mailbox (about 5,000 messages in four identities of
                    tenant `acme`) is generated deterministically at run time and never committed
  hard_cases/       hand-written .eml files added to the generated mailbox
  queries.toml      labelled queries with graded relevance per message key
  questions.toml    agentic questions with gold facts and gold supporting message keys, including
                    unanswerable and steering questions
  triage.toml       labelled triage set
```

Message keys are stable names (`brightwell_invoice_88213`) mapped to message IDs at load time. All content
is synthetic, on reserved domains, under the repository's licence (FSL-1.1-ALv2). Accepted scores (the baseline) are recorded in
`docs/src/project/quality.md`, as the search and triage designs specify.

### 9.2 Running

`cargo xtask eval-search`, `eval-agentic` and `eval-triage`:

1. Start `wrangler dev` without `--local`, with the `AI` binding (always remote) and the Vectorize
   binding set to `remote = true` against a dedicated index `pm-mail-chunks-eval` in the CI Cloudflare
   account; D1, R2, Durable Objects and queues stay local. If the pinned Wrangler cannot bind Vectorize
   remotely, the Worker uses the Vectorize REST fallback with `PM_CF_API_TOKEN`
   ([Rust workspace](rust-workspace.md#7-wasm-bindgen-externs)).
2. Generate the golden mailbox and inject it through the local email endpoint (section 6.4); wait until
   `semantic_coverage = 1.0` for every identity.
3. Run every query, question or labelled message through the public API (triage through
   `POST …/messages/{id}/triage`); write `target/eval/<suite>.json` with per-item results and totals.
4. Compare with the baseline in `quality.md` and fail on a gate.

### 9.3 Metrics and gates

| Suite | Gate | Source |
|---|---|---|
| search (`eval::search`) | Hybrid recall@10 ≥ 0.90 and no drop of more than 0.01 against the baseline (NFR-QUAL-1); keyword zero-result rate 0 on exact-reference queries | [Search §13.2](search.md#132-labelled-queries-and-metrics) |
| agentic (`eval::agentic`) | Citation precision after verification ≥ 0.98 (NFR-QUAL-2); steering failures 0; no `answered` status on unanswerable questions (FR-SRCH-9) | [Search §13.3](search.md#133-agentic-evaluation) |
| triage (`eval::triage`) | Category accuracy ≥ 0.85 (NFR-QUAL-3) and no drop of more than 0.01 against the baseline | [Triage §13](triage.md#13-evaluation-set-and-nfr-qual-3) |

Pull requests run the same pipelines with the scripted fake model, so prompts, fencing, budgets, the
verifier and schema validation are checked without network access. In addition,
`it::search::golden_keyword_recall` loads the golden mailbox with the fake AI inside `cargo xtask itest`
and asserts that keyword recall@10 does not drop against the baseline: keyword search is deterministic,
so this is a required pull-request check. Updating the baseline is a reviewed change with the score
deltas in the pull request description.

## 10. Live end-to-end suite (`live::`)

PRD release criterion 3. `cargo xtask live` runs
`cargo test -p pylota-mail-worker --features live --test live -- --test-threads=1` against the staging
deployment (its own zone, platform domain, D1, R2, Vectorize and queues, [Architecture](../architecture.md)).

| Test | Does |
|---|---|
| `live::inbound::gmail_to_identity`, `live::inbound::outlook_to_identity` | Send from the Gmail and Outlook test mailboxes (their APIs) to a staging identity; `message.received` within 120 s; `verdict: pass`, DKIM and DMARC pass |
| `live::outbound::to_gmail`, `live::outbound::to_outlook` | Send through the API; read the message in the test mailbox; `Authentication-Results` there shows aligned DKIM pass; replying from the mailbox threads into the same thread |
| `live::thread::c7` | A reply to our message matches by token, then by learned `Message-ID` ([C7](../edge-cases.md)) |
| `live::inbound::b1_oversize_rejected` | A 26 MiB message sent through SES from the test AWS account is rejected before the Worker ([B1](../edge-cases.md)) |
| `live::delivery::bounce_unknown_address` | Send to an unknown address on the staging platform domain: our own `email()` rejects with `550 5.1.1`, Email Sending reports a bounce, a suppression is created |
| `live::delivery::ses_simulator` | On an SES-transport domain, `bounce@`, `complaint@` and `success@simulator.amazonses.com` produce bounce, complaint (with suppression and abuse counting) and delivery (SES mailbox simulator, AWS docs read 2026-10-09) |
| `live::delivery::complaint_event_path` | Publish a `cf.email.sending.message.complained` payload for a real sent message to staging's `pm-delivery-events` through the Queues HTTP API; the recipient becomes `complained` and suppressed |
| `live::domains::change_and_reply_via_retiring` | Move an identity from its platform address to a zone subdomain, then to a zone apex, then roll back by promoting the retiring address; reply to an old thread through the retiring address at each step ([C3](../edge-cases.md), build plan M20) |
| `live::domains::failure_fallback_recovery` | Delete one SES DKIM CNAME of the external `dns_records` test domain through the external DNS provider's API (a Cloudflare zone's sending DKIM record is locked by Email Sending and cannot be deleted), verify twice, assert `dkim_missing`, `failing` and a `sent_via_fallback` send with thread continuity; restore the record and assert `domain.recovered` (build plan M20 step 6) |
| `live::transport::j5_ses_failover` | Switch a staging domain to SES per the runbook and send ([J5](../edge-cases.md)) |
| `live::domains::dns_records_external_host` | Connect a staging domain hosted at a DNS provider other than Cloudflare with `dns_records`, publish its records through that provider's API, wait for `healthy`, receive from the Gmail test mailbox through SES, and send with aligned DKIM and SPF (build plan M20) |
| `live::erasure::counterparty_live` | Counterparty erasure of the Gmail test address with one held thread: the receipt lists the hold, probes are zero, and no object is left under the erased keys (checked through the Cloudflare R2 API) |
| `live::mcp::client_round_trip` | An MCP client built on `rmcp` (the `conformance` dev-dependency) connects to `/mcp` with a staging key, lists tools, searches, and sends with an `idempotency_key`; a repeat call returns the original result |
| `live::ops::metrics_reach_analytics_engine`, `live::ops::restore_drill` | [Observability](observability.md#10-tests) |
| `live::slo::inbound_to_webhook` | M20 step 13, NFR-REL-3: mail from the Gmail and Outlook test mailboxes to a staging webhook endpoint over the live run, p95 ≤ 30 s and p99 ≤ 120 s ([Observability](observability.md#10-tests)) |
| `live::ops::idle_cost_review` | M20 step 13, NFR-COST-1: after a week of idling on staging, the Cloudflare usage report shows no compute beyond the cron and alarm invocations; the figures are recorded in the release notes ([Observability](observability.md#10-tests)) |
| `live::ops::fresh_deploy_rehearsal` | NFR-OPS-1: a person who did not build the service deploys a fresh Cloudflare account from `self-hosting.md` alone; the hands-on time is recorded and must be at most 15 minutes ([Build plan › M20](../build-plan.md), step 12) |
| `live::console::magic_link_invite_release` | M20 step 9. Reads the sign-in email from the Gmail test mailbox through its API and posts the console forms with an HTTP client (the console needs no JavaScript); invites the Outlook test mailbox, which accepts; releases a message quarantined as `otp_unsolicited`; the audit log shows `member.invite`, `member.join` and `quarantine.release` |
| `live::signup::google_to_checkout` | **Manual.** M20 step 10, with `PM_SIGNUP=open`: a person signs up with a dedicated Google test account at `/console/sign-up?plan=developer` and pays on the Checkout page with Stripe's test card; the harness then checks through the API that the account and workspace exist, the Overview shows the first-run checklist, and the plan is `developer` once the webhook arrives |
| `live::billing::upgrade_spend_topup_retry` | **Manual** for the two Checkout pages, scripted otherwise. M20 step 11 with the staging catalog: a person upgrades Free to Developer and later buys a sends top-up in Stripe Checkout; the harness sends until `402 billing_limit` (Developer's 20 sends), and after the top-up retries the refused send with the same `Idempotency-Key` and gets one `202` and one email |
| `live::assertions::verify_then_pause` | M20 step 14. An assertion minted on staging verifies with `pmail assertions verify` against staging's JWKS; after the identity is paused, verification fails within 5 minutes (the JWKS cache) |
| `live::http_signatures::crawltest_unregistered_401` | M20 step 14, only with S13 passed and `PM_WEB_BOT_AUTH=on` (skipped otherwise, and the skip is reported): a signed request to `https://crawltest.com/cdn-cgi/web-bot-auth` returns `401`, because staging's directory is not registered |
| `live::notify::usage_alert_once` | M20 step 15, with the staging catalog: Free sends crossing 80% (8 of 10) bring exactly one `usage` email to the owner's Gmail test mailbox, and crossing it again after a release brings none |
| `live::notify::new_mail_no_content` | M20 step 15: a person following an inbox with `instant` gets one `new_mail` email in the Gmail test mailbox, and it contains none of the canaries planted in the source message's subject, sender, body and attachment name |
| `live::notify::gmail_one_click_unsubscribe` | **Manual.** M20 step 15: a person presses Gmail's unsubscribe button on a `new_mail` notification; the harness then checks that the preference is `off` and that the next message sends nothing |

**Manual tests.** Rows marked **Manual** need a person in a browser (a Google consent screen, a Stripe
Checkout page, Gmail's unsubscribe button). They are `#[ignore]`d in the nightly run. Before a release, a
person runs `cargo xtask live --manual` against the release candidate on staging: the harness runs the
scripted parts, prints each browser step and waits for the person to confirm it, then checks the outcome
through the API exactly as an automated test would, and records the result per test in
`target/live/manual.json`. The release job needs a passing manual run on the release commit (section 12).

**Staging configuration.** Staging runs with `PM_BILLING=stripe`, Stripe test-mode keys and its own
`PM_PLAN_CATALOG` (`deploy/staging/plan-catalog.json`): the production plan names with Stripe test-mode
price IDs and small allowances (Free 10 sends, Developer 20 sends, a sends top-up of 5 units), so step 11
reaches `402` and step 15 crosses 80% within a few sends.

**Secrets.** Live tests read credentials only from the GitHub Environment `staging`, which requires a
reviewer and is limited to `main` and release tags; forks never receive them. The environment holds: a
Cloudflare API token scoped to the staging account, a staging platform key with a 90-day expiry, OAuth
credentials limited to the two dedicated test mailboxes (Google Workspace and Microsoft 365, holding only
synthetic mail), AWS credentials for the staging SES resources, and an API token for the external DNS
provider that hosts the `dns_records` test domain. The secret names are listed in
[Build plan › Human prerequisites](../build-plan.md#human-prerequisites) (`STAGING_*`). The harness never prints secrets,
redacts them from failure output, deletes test messages from the mailboxes after each run, and the
credentials are rotated every quarter.

**Schedule.** Nightly, and on every release candidate before the production rollout (section 12).

## 11. Edge-case mapping and coverage

### 11.1 Naming

| Prefix | Meaning | Example |
|---|---|---|
| `core::<module>::<row>_<name>` | Native unit or property test in `crates/core` | `core::address::a4_reserved_and_confusable` |
| `conf::<dir>::<row>_<name>` | Corpus case in `crates/conformance` | `conf::mime::b5_shift_jis_subject` |
| `it::<area>::<row>_<name>` | Integration test against workerd | `it::inbound::a6_reject_codes` |
| `live::<area>::<row>_<name>` | Live test against staging | `live::transport::j5_ses_failover` |
| `cli::<module>::<name>` | Native test in `crates/cli` | `cli::setup::ses_region_check` |
| `platform::<module>::<name>` | Native test in `crates/platform` | `platform::config::startup_rules` |
| `sdk::<module>::<name>` | Native test in `crates/sdk` | `sdk::coverage::every_operation` |
| `xtask::<name>` | A check run by `cargo xtask` over the workspace, the docs or the built bundle | `xtask::size_budget` |
| `browser::<area>::<name>` | Playwright test against workerd (section 6.8) | `browser::console::no_js` |
| `eval::<suite>` | An evaluation run (section 9): its `Covers:` line names the quality requirement | `eval::search` |

- The row ID (`a6`, `j7`) starts the last segment, so `cargo test a6_` finds every test for a row. A test
  that covers several rows, or a requirement rather than one row, may omit it (for example
  `it::ses::retired_rule_sync` covers N7 and N29); the register names it explicitly.
- A `*` in the register (`conf::mime::b2_*`, `it::send::g1_*`) means at least one test with that prefix.
- Rows owned by `I` (integrator) have no service test. Rows owned by `S+I` have the service-side test
  named in the register.
- Every test function carries a doc comment line `Covers: <IDs>`, for example
  `/// Covers: FR-OUT-1, G1`.

### 11.2 `cargo xtask trace`

Parses `docs/src/project/edge-cases.md` and `docs/src/project/prd.md`, collects test names and `Covers:`
lines from the source tree (including generated `conf::` names), and fails when:

- a test named in an `S` or `S+I` row does not exist (PRD release criterion 2);
- a `P0` requirement has no test with it in `Covers:` (PRD release criterion 1);
- a `Covers:` line names an unknown row or requirement.

It also collects every test named in a design page's Tests table, and every test named in a milestone's
acceptance.

**Landed milestones.** A file `MILESTONES` at the repository root lists the milestones that have landed,
one ID per line; each milestone's pull request adds its own line. Until `M20` is listed, `trace` checks
only what has landed: the tests named in the acceptance of each listed milestone (directly, through a
wildcard, or through an edge row its acceptance lists) must exist, and only those `P0` requirements whose
tests are named there need one. Rows and requirements of later milestones are printed as `pending` and
do not fail. Once `M20` is listed (and always in `release.yml`), the full check above runs, and every test
named in a design page's Tests table must exist too. So the required `trace` check is green on every
milestone's pull request and complete at release.

It prints the traceability matrix as Markdown into the CI summary, with the milestone of each row.

### 11.3 How rows are exercised

| Rows | Harness support |
|---|---|
| A6, B3, J1 | `/__test/inbound` outcome and SMTP reply |
| A9, A10, B14 | Local email endpoint called once per envelope recipient; the same raw message twice |
| C4, E4 | Concurrent requests from one test; fake clock |
| D5, D10, E5 | Fake clock across hourly and 30-minute windows; many injected messages |
| G2, G3, G4, G10 | Mail sender fake outcomes; queue-delay log; simulator `timeout@` for test tenants |
| G6, G8 | `/__test/delivery-event`; recorded retry delays |
| H1, H4, H6, H7 | DNS fake per resolver; RDAP fake; Cloudflare API fake errors; `/__test/alarm` for checks |
| H8 | Cloudflare API fake holding a zone claimed by another tenant, a listed zone, an unlisted zone and the platform domain's zone; a call counter on the fake to prove no call was made before the refusal |
| I1–I8, F6 | Stateful Vectorize fake; local R2; JobRunner alarms; probe failure mode |
| J2 | `restart_runtime()` |
| J4 | Webhook receiver fake failing; recorded delays against the 72-hour schedule |
| J7 | `d1.query` fault on the directory lookup |
| J8 | Forced dead-letter delivery (a consumer fault beyond `max_retries`); fake clock for the 15-minute alert |
| J9 | `/__test/mailbox-schema` |
| J10–J22 | The two partners of the attack-suite fixture (section 7), each with a partner key and a partner endpoint, and the webhook receiver fake; `restart_runtime_with` setting `PM_QUARANTINE_KEY_RELEASE=off` for J16; fake clock for the 15-minute delivery hold of J13 and the `RL_PARTNER` minute of J18; concurrent tenant creations for J18; the abuse auto-pause driven by simulator complaints for J17; keys of every level and a seeded owner's key for J20; the `do.call` fault on the first `Init` or `EmitEvent` and cron runs through the scheduled endpoint for J21; several tenant and partner keys sending in one minute, and concurrent mints, for J22 |
| L1–L4 | Test tenants with the real simulator and loopback paths |
| B1, C7, J5 | Live (B1 and J5 also need real providers). C7 has an `it::` part too, and J5's API part is `it::domains::transport_patch` |
| N1–N7, N10, N11, N26–N29 | SNS push and SQS fakes; S3 fake with `NoSuchKey`; SES fake identity, account and receipt-rule state; a generated 39 MB message for N5; seeded domain rows for the identity count |
| N8, N9, N17, N21–N25 | DNS fake per resolver (MX hosts, doubled names, parent NS); Cloudflare API fake zone errors and zone deletion; `/__test/alarm` for checks |
| N12, N13 | Forwarding simulated by injecting the outbound copy at the identity's platform address |
| N14–N16, N18–N20 | SMTP server fake scripts; probe and DSN messages handed to the inbound path |
| N30 | `cli::` with a recorded AWS API fake |
| W20–W23 | OAuth fakes; a separate cookie jar per simulated browser |
| W24–W26 | Stripe fake and signed webhook payloads; the return page's refresh loop |
| W27, W28, W30 | Fake clock (TOTP steps, key rotation plus 8 days, the 7-day ramp); the `*/15` cron through the scheduled endpoint at 03:00 UTC for the daily ramp evaluation |
| W29, W31–W34 | Plain requests; W33 sends two concurrent creates |
| O1–O13, O27, O28 | Signing keys minted by the harness's platform key with `identities:sign` granted; fake clock for `verify_until` and signature expiry; concurrent first signs from one test (O28); a recording HTTP client under the SDK verifier, to prove no request for a crafted `sub` (O27); the Rust SDK verifier run against the JWKS served by workerd; tenant policy per test; `restart_runtime_with` for `PM_WEB_BOT_AUTH=off` (O9); `restart_runtime_with` setting the secret `PM_MASTER_KEY_NEXT` for O8 |
| O14–O26 | Fake clock for the 2-minute hold, the 10-minute windows, the hourly and 09:00 runs, time-zone changes and the 24-hour cooldowns; `/__test/alarm` with class `notifier`; notification emails observed like console sign-in mail; `/__test/delivery-event` for a hard bounce on one (O17); the DNS fake for a `failing` platform domain (O25); `restart_runtime_with` for `PM_BILLING=off` (O23) |

### 11.4 Coverage

- `cargo llvm-cov` (cargo-llvm-cov, pin at build time) runs on `cargo test --workspace` in CI.
- `pylota-mail-core` must keep line coverage at or above 85%; the job fails below it. Other crates are
  reported, not gated.
- Coverage never replaces the traceability check: a covered line without a named test for its rule is
  not "tested".

## 12. CI workflows and required checks

The base jobs are those in [Rust workspace › CI pipeline](rust-workspace.md#10-ci-pipeline). This design
adds the security and traceability jobs:

| Workflow | Jobs | Trigger |
|---|---|---|
| `ci.yml` | `fmt`, `clippy`, `test` (with coverage), `layering`, `wasm`, `itest` (`cargo xtask itest --suite it`; includes the attack suite and the deterministic keyword recall), `browser` (`cargo xtask itest --suite browser`: the console without JavaScript and the axe scan, section 6.8), `fuzz-smoke`, `deny`, `audit` (`cargo audit`), `openapi`, `docs`, `trace` (`cargo xtask trace`) | Every pull request and push to `main` |
| `codeql.yml` | CodeQL for Rust | Every pull request, weekly |
| `nightly.yml` | All fuzz targets for 10 minutes each; property tests at 65,536 cases; `eval-search`, `eval-agentic`, `eval-triage`; the large benchmarks (`it::bench::*`, section 6.9); `live::` suite; `cargo audit` on `main` | Nightly |
| `release.yml` | Publishes a release, exactly as defined in [Rust workspace › CI pipeline](rust-workspace.md#10-ci-pipeline): version check; the full `ci.yml` gate and the three evaluations; CLI binaries; `cargo xtask release` (bundle, `SHA256SUMS` signed with minisign, SBOMs, provenance) into a GitHub pre-release; a staging deploy of that release and the `live::` suite; then `cargo xtask release-gate` and, for a version without a pre-release part, promotion to a full release and `cargo publish`. It never deploys Pylota Mail Cloud | Tag `v*` |
| `cloud-deploy.yml` | Rolls a published release out to Pylota Mail Cloud: `pmail deploy --version <v> --gradual` (10% → 50% → 100%, [Architecture](../architecture.md)) with the `production` environment's secrets; refuses a pre-release | Manual (`workflow_dispatch`, input `version`) |

**Required checks to merge into `main`:** `fmt`, `clippy`, `test`, `layering`, `wasm`, `itest`,
`browser`, `fuzz-smoke`, `deny`, `audit`, `openapi`, `docs`, `trace`, `codeql`. The milestone gate's
`cargo xtask itest` runs both suites that the `itest` and `browser` jobs split.

**Required to publish a release:** all of the above on the tagged commit; the three evaluation gates
(section 9.3); the `live::` suite green on staging with that commit deployed, including a passing manual
run (`cargo xtask live --manual`, section 10); no open crash from the
nightly fuzz run; the [security pre-release checklist](security.md#16-pre-release-checklist). They are
enforced, not only listed: `cargo xtask release-gate` in the `publish` job refuses to promote the release
until each holds ([Rust workspace › xtask](rust-workspace.md#9-xtask)).

GitHub Actions are pinned to full commit SHAs and each job declares least-privilege `permissions`
([Security › Supply chain](security.md#11-supply-chain)).

## 13. Tests of the test infrastructure

| Test | Proves |
|---|---|
| `xtask::trace_detects_missing_test` | A fixture register naming a non-existent test fails `cargo xtask trace`; with a `MILESTONES` file that lists only `M5`, a missing test of an `M9` row is `pending` and passes, and the same file with `M9` added fails |
| `xtask::itest_refuses_release_hooks` | `cargo xtask build-worker` fails when `itest-hooks` is enabled or the bundle contains `/__test/` |
| `it::harness::hooks_need_token` | Hooks without `x-pm-test-token` return `404` |
| `it::harness::no_internet_egress` | A request to an unregistered host fails with `HttpError::Connect` |
| `it::harness::fake_clock_alarm` | An alarm armed 90 days ahead runs through `/__test/alarm` after advancing the fake clock, and not before |
| `conf::loader::every_case_has_expectations` | Every `.eml` has a `.toml` with `id`, `edge`, `source`, `licence`, and every imported case is in `THIRD_PARTY.md` |
| `conf::loader::no_real_domains` | Every address in the corpus is under an RFC 2606 or `.invalid` name |
