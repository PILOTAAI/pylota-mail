# Security

Binding for implementation. This page is the threat model and the security rules every other design
must respect: authentication, authorisation, tenant isolation, secrets, cryptography, untrusted content,
SSRF, abuse controls, the supply chain and logging. Where another design owns a mechanism (for example
the thread token in [Threading](threading.md)), this page states the security property and links to it.

| | |
|---|---|
| Requirements | FR-KEY-1, FR-KEY-2, FR-KEY-3, FR-TEN-1, FR-TEN-2, FR-TEN-3, FR-IN-4, FR-IN-5, FR-IN-9, FR-IDN-6, FR-IDN-7, FR-IDN-8, FR-IDN-9, FR-WH-2, FR-WH-5, FR-TRI-3, FR-TRI-4, FR-SRCH-3, FR-SRCH-8, FR-SRCH-10, FR-MCP-1, FR-PRV-6, FR-DOM-9, FR-DOM-11, FR-CON-3, FR-CON-9, FR-CON-10, FR-CON-13, FR-CON-14, NFR-SEC-1, NFR-SEC-2 |
| Edge cases | [A2](../edge-cases.md), [A4](../edge-cases.md), [A6](../edge-cases.md), [B7](../edge-cases.md), [B10](../edge-cases.md), [B11](../edge-cases.md), [D2](../edge-cases.md), [D5](../edge-cases.md), [D9](../edge-cases.md), [D10](../edge-cases.md), [E1](../edge-cases.md), [E2](../edge-cases.md), [F1](../edge-cases.md), [F3](../edge-cases.md), [F7](../edge-cases.md), [F10](../edge-cases.md), [I5](../edge-cases.md), [J6](../edge-cases.md), [L4](../edge-cases.md), [W15](../edge-cases.md)–[W18](../edge-cases.md), [W20](../edge-cases.md)–[W22](../edge-cases.md), [W27](../edge-cases.md), [W28](../edge-cases.md), [W31](../edge-cases.md), [N1](../edge-cases.md)–[N3](../edge-cases.md), [N14](../edge-cases.md), [N16](../edge-cases.md), [N18](../edge-cases.md), [N28](../edge-cases.md), [O1](../edge-cases.md), [O3](../edge-cases.md), [O7](../edge-cases.md), [O8](../edge-cases.md), [O12](../edge-cases.md), [O13](../edge-cases.md), [O15](../edge-cases.md), [O18](../edge-cases.md), [O24](../edge-cases.md) |
| Code | `crates/worker/src/auth/` (keys, router table, scope), `crates/core/src/ssrf.rs`, `crates/core/src/injection.rs`, `crates/core/src/sanitize.rs`, `crates/core/src/crypto.rs` (sealing, pure; nonces passed in), `crates/core/src/{jwk.rs, jwt.rs, httpsig.rs}` (agent signing, pure), `crates/worker/src/net.rs` (guarded HTTP), `crates/worker/src/log.rs` |
| Reporting | [SECURITY.md](https://github.com/PILOTAAI/pylota-mail/blob/main/SECURITY.md) |

## 1. Assets and invariants

| Asset | Where it lives | Why it matters |
|---|---|---|
| Mail content: raw MIME, parsed text, attachments, extracted text | R2, `IdentityMailbox` SQLite | Personal data of counterparties and operators |
| Addresses and contact history | `IdentityMailbox` (`contacts`, `messages`), D1 (`addresses`) | Personal data; address enumeration |
| API key secrets | Shown once; stored as HMAC in `api_keys.hash` | Full access within a key's scope |
| Webhook endpoint secrets (`whsec_…`) | `webhook_endpoints.secret_enc` (AES-256-GCM) | Forged events to integrators |
| Identity signing keys | `identity_keys.private_enc`: the 32-byte Ed25519 seed in the pm1 envelope, sealed under `PM_MASTER_KEY` ([Agent signing keys](agent-keys.md#8-data-model)) | Forged agent assertions: impersonation of an agent identity towards third-party services |
| The Web Bot Auth key | D1 `signing_keys` purpose `web_bot_auth`: the seed sealed in `ciphertext` under `PM_MASTER_KEY`, the public JWK in `public_jwk` | Forged signed HTTP requests attributed to this deployment and, through the signed `From`, to any of its identities |
| Deployment secrets `PM_*` | Worker secrets | See [section 6](#6-secrets) |
| Thread, link and cursor keys | D1 `signing_keys`, sealed under `PM_MASTER_KEY` | Forged thread tokens, download links, console tokens, notification unsubscribe tokens or search cursors ([section 6](#6-secrets)) |
| SMTP relay credentials (`smtp_relay` domains) | `domains.smtp_sealed`, sealed under `PM_MASTER_KEY` | Sending as the customer through their own provider |
| Console second factors | `users.totp_sealed`, `users.recovery_codes_sealed`, sealed under `PM_MASTER_KEY` | Bypassing two-step verification for that person |
| Raw inbound mail on SES domains | The deployer's S3 bucket `{prefix}-inbound`, until ingested | Personal data of counterparties, outside Cloudflare |
| Sending reputation | Platform domain and tenant domains | Shared by every tenant on the platform domain |
| Authentication verdicts | `messages.auth_json`, `verdict` | Agents act on "verified" mail |
| Audit trail | D1 `audit_log` | Accountability for keys, releases and erasure |

Each invariant below is enforced in code and covered by a named test (section 13).

| ID | Invariant |
|---|---|
| SEC-1 | Tenant and identity scope come only from the authenticated key, never from the request body, query or path (FR-KEY-3). A key reaches nothing outside its scope, and an out-of-scope resource is indistinguishable from a missing one (NFR-SEC-1) |
| SEC-2 | A key never creates a key wider than itself in level, tenant, identity or permissions (FR-KEY-1) |
| SEC-3 | Every secret has exactly one purpose and no secret is derived from another |
| SEC-4 | The service never sends as a domain whose authentication records are broken or whose ownership signals changed (FR-DOM-5). For an `smtp_relay` domain, whose signing the relay controls, a passing alignment probe stands in for the records (FR-DOM-11, U4) |
| SEC-5 | Content from email is data. It is never interpreted as instructions by triage or the agentic planner, whose tools are read-only (FR-TRI-3, FR-TRI-4, FR-SRCH-8) |
| SEC-6 | The service never dereferences a URL found in mail ([B7](../edge-cases.md)) |
| SEC-7 | Only the trusted authserv-id's topmost `Authentication-Results` counts, and the service's own DKIM, ARC and DMARC check always runs ([D9](../edge-cases.md)) |
| SEC-8 | Logs never contain message bodies, subjects, attachment content, filenames, display names, clear-text addresses or secrets (FR-PRV-6, [I5](../edge-cases.md)) |
| SEC-9 | Every outbound HTTP request or TCP connection to a host chosen by a tenant passes the SSRF guard (FR-WH-5, FR-DOM-11) |
| SEC-10 | Erasure never reports success while data remains: the receipt carries probe results ([Privacy](privacy.md)) |
| SEC-11 | Private signing keys (identity keys and the Web Bot Auth key) are generated, sealed, used and zeroised inside the Worker. No API, log or export returns one, and a minted assertion or signature is never stored (FR-IDN-6) |
| SEC-12 | A notification email never contains content from mail: no subject, sender, snippet or attachment name (FR-CON-14) |

## 2. Trust boundaries

```text
                  TB1                                         TB2 / TB3 / TB7
 Internet MTA ─┬ SMTP ──▶ Email Routing ──▶ email()          Integrator, agent ── HTTPS ──▶ fetch() (API host)
               └ SMTP ──▶ SES receiving ──▶ S3, SNS (TB5)      /v1  /mcp                          │
                                              │              Person, browser ── HTTPS ──▶ fetch() (console host)
                                              ▼                /console/*                         ▼
                        ┌─────────────────────────────── Worker (one deployment) ─────────────────────┐
                        │  router + auth ──▶ D1 scope check ──▶ Durable Object (owner re-check)        │
                        │  queues (pointers) · R2 · Vectorize · Workers AI                              │
                        └──────┬──────────────────────────────┬──────────────────────────────┬──────────┘
                           TB4 │ signed POST              TB5 │ API calls, sockets       TB5 │ SNS POST, SQS poll
                               ▼                              ▼                              ▼
                     integrator webhook URLs     Cloudflare APIs, SES, S3, DoH,     AWS SNS and SQS (SES
                                                 RDAP, scanner, SMTP relays,        delivery and inbound
                                                 Google, GitHub                     notifications)
 TB6: people and systems that operate the deployment (Cloudflare account members, platform-key holders,
      the CLI machine, the release pipeline)
 TB8: third-party services and sites that receive agent assertions and signed HTTP requests, and anyone
      who fetches the public JWKS and key directory (GET /.well-known/* on the API host)
```

| Boundary | Untrusted side | Trusted side |
|---|---|---|
| TB1 Internet → inbound sources | Any sender on the internet, every byte of the message, the envelope, whether it arrives through Email Routing (`email()`) or through SES receiving | `email()`, the SES inbound handler, the inbound consumer, the mailbox |
| TB2 Integrator → REST API | The caller until its key is verified; request bodies always | Router, handlers, Durable Objects |
| TB3 Agent → MCP | The agent, which may be steered by mail it has read | The MCP endpoint, which reuses the REST authorisation path |
| TB4 Worker → webhook endpoints | The endpoint URL, its DNS, its responses | The webhook consumer |
| TB5 Worker ↔ Cloudflare APIs, SES, S3, SNS, SQS, SMTP relays, OAuth providers, DoH, RDAP, scanner | Responses, notifications and relay replies | The Worker |
| TB6 Operators of the deployment | — (trusted, but limited and audited) | — |
| TB7 People → console | The browser and everything it sends until a session is verified; form fields always; the token of an unsubscribe link | The console router, its route table and the same services as the API |
| TB8 Agent proofs → third parties | Verifiers and sites that receive assertions and signed requests; anyone reading the JWKS or the key directory | The signing handlers and the sealed keys, which never leave the Worker |

## 3. STRIDE threat model

Each row names its mitigation and the test that proves it. Tests named in the edge-case register are
reused; the others are defined in section 13.

### 3.1 TB1: internet → inbound sources

| STRIDE | Threat | Mitigation | Test |
|---|---|---|---|
| S | Forged `From`, display-name spoofing, look-alike domains | Own `mail-auth` DKIM/ARC/DMARC verification, verdict and quarantine (FR-IN-4, FR-IN-5); `display_name_spoof` and `lookalike_domain` flags ([D2](../edge-cases.md)) | `core::trust::d2_*`, `core::auth::d1_*` |
| S | Forged `Authentication-Results` | Only `PM_TRUSTED_AUTHSERV_ID`, only the topmost instance; own verification always runs ([D9](../edge-cases.md)) | `core::auth::d9_forged_ar_ignored` |
| S | Forged thread token to file mail into another thread | 40-bit HMAC under a Worker-generated key, bound to the identity and the key ID; failed verifications rate-limited per sender and globally; a token never grants data access ([A2](../edge-cases.md), [D10](../edge-cases.md), [Threading](threading.md)) | `it::inbound::a2_forged_token_ignored`, `it::inbound::d10_token_bruteforce` |
| T | Message altered in transit | DKIM verdict recorded; `raw_sha256` stored; raw kept for `raw_days` | `conf::auth::*` (corpus) |
| R | Sender disputes having sent a message | Raw MIME and `auth_json` retained for `raw_days`; `received_at` from the platform clock | `it::inbound::b3_*` |
| I | Address enumeration through SMTP replies | Erased and deleted addresses return the same `550 5.1.1` as unknown ones, on the same code path (directory miss, then tombstone lookup) ([A6](../edge-cases.md)). Retired (`550 5.1.6`) and suspended (a temporary failure, then `550 5.2.1`) are disclosed deliberately (FR-ADR-3, FR-TEN-3). On SES domains, SES accepts every recipient; unknown, deleted and erased addresses are all dropped the same way without a bounce, and only retired addresses are bounced (`5.1.6`, by `pm-retired-{n}` rules) ([N6](../edge-cases.md), [Domains on any DNS host](domain-connections.md#46-retired-and-unknown-recipients)) | `it::inbound::a6_reject_codes`, `it::ses::unknown_recipient_dropped` |
| I | Tracking pixels and remote content | Never fetched; remote `src` removed from sanitised HTML ([B7](../edge-cases.md)) | `core::sanitize::b7_no_remote_fetch` |
| D | Floods from one sender, oversized or deeply nested mail, archive bombs, backscatter | Per-sender limit per identity ([D5](../edge-cases.md)); Cloudflare's 25 MiB cap ([B1](../edge-cases.md)) and 40 MB on the SES source ([N5](../edge-cases.md)); depth 32 and 500 parts ([B2](../edge-cases.md)); 100:1 and 100 MB archive checks ([B10](../edge-cases.md)); unmatched DSNs dropped ([D4](../edge-cases.md)); no bounce after SES has accepted a message, except the retired-address rule ([N6](../edge-cases.md)) | `it::inbound::d5_sender_throttle`, `core::mime::b2_caps`, `core::attach::b10_*`, `it::inbound::d4_backscatter_dropped`, `it::ses::large_message_40mb` |
| E | Parser exploits, malicious attachments | Memory-safe Rust parsers, fuzzing ([Testing](testing.md#8-fuzzing)); sniffed type wins; risky attachments quarantined and never passed to extraction or agents ([B10](../edge-cases.md)) | fuzz targets `mime_parse`, `sanitize`, `dsn_parse`; `core::attach::b10_*` |
| E | Prompt injection in body, subject, display name, filename or attachment text | Fenced untrusted content (section 8.3); read-only planner tools; `prompt_injection_suspected` flag ([E1](../edge-cases.md), [F10](../edge-cases.md)) | `core::injection::e1_*`, `it::agentic::e1_fenced`, `it::agentic::f10_steering` |
| E | Mail to role addresses (`security@`, `abuse@`) reaching an agent | On the shared platform domain, role names are refused for identities and RFC 2142 operational names route to `PM_SECURITY_CONTACT`; on a tenant's own domain only `postmaster` and `abuse` stay reserved, and they route to the tenant's owner contact ([A4](../edge-cases.md), [Identities and domains](identity-domains.md#username-validation)) | `core::address::a4_reserved_and_confusable` |

### 3.2 TB2: integrator → REST API

| STRIDE | Threat | Mitigation | Test |
|---|---|---|---|
| S | Stolen or guessed key | 256-bit secret, HMAC lookup with constant-time comparison, expiry, revocation, rotation with overlap (section 4) | `it::auth::unknown_key_uniform`, `it::keys::j6_revoke_rotate` |
| S | Probing a key's status with only its lookup prefix | `key_revoked` and `key_expired` are returned only after the secret matched; otherwise `unauthenticated` | `it::auth::status_after_secret_match` |
| T | Replayed or altered send | Idempotency fingerprint; a changed body under the same key is `409 idempotency_conflict` (FR-OUT-1) | `it::send::g1_*` |
| R | A key holder denies an administrative action | `audit_log` row with `actor_key_id` and `request_id` for every key, identity-key (`identity_key.*`), tenant, identity-status, quarantine, hold, suppression-removal, erasure, resolve and platform-operation action (signing-key rotation, `web_bot_auth` included, transport change, jobs, redrive); `GET /v1/audit-events?actor_key_id=` lists one key's actions; every request log line carries `key_id`. Sends are not audit rows: the message, its events and the delivery log record them. Signing calls are not audit rows either: each is logged as `signature_minted` with `key_id` and `identity_id` and counted in `usage_daily` ([Observability §2.2](observability.md#22-event-names)) | `it::keys::j6_revoke_rotate` |
| I | Reading another tenant's or identity's data (IDOR) | Section 5: scope check against D1 before any Durable Object call, owner re-check inside the object, `*_not_found` for out-of-scope IDs | `it::security::cross_tenant_matrix` |
| I | Quarantined, hidden or throttled mail reaching agents | Filtered inside the mailbox query layer: lists show it only for an explicit `status` filter from a key holding `quarantine:review`, and search never shows hidden or throttled mail and shows quarantined mail only with `include_quarantined` and `quarantine:review` (section 5.3, FR-IN-5, [F7](../edge-cases.md)) | `it::messages::list_hides_review_statuses`, `it::search::f7_quarantine_hidden` |
| E | A key signing as an identity it should not, or a platform key signing at all | `identities:sign` is held only by tenant keys and by identity keys for their own identity; a platform key cannot hold it (section 4.6); the identity path is scope-checked like every route (section 5.2) | `it::keys::permission_level_rules`, `it::security::cross_tenant_matrix` |
| D | Request floods, expensive searches | Rate-limit bindings per key and per identity, exact daily caps in `TenantQuota`, 7 MiB body cap, search and fan-out caps (section 10) | `it::auth::rate_limited`, `it::search::f8_budget` |
| E | Minting a wider key | Section 4.6 subset rule, `403 key_scope_exceeded` | `it::keys::scope_exceeded` |
| E | Test key acting on a live tenant, or the reverse | A key's mode follows its tenant; platform keys act on both, and every state-changing action they take is audit-logged except sends, which are recorded as messages ([L4](../edge-cases.md)) | `it::testmode::l4_mode_binding` |

### 3.3 TB3: agent → MCP

| STRIDE | Threat | Mitigation | Test |
|---|---|---|---|
| S | Unauthenticated MCP use, DNS rebinding from a browser | `Authorization: Bearer pmk_…` on every request, through the REST authentication code; an `Origin` header other than `https://{PM_API_HOST}` gets `403`; no CORS grant ([MCP › Request handling](mcp.md#21-request-handling)) | `it::security::mcp_requires_key` |
| E | A steered agent calls a send tool | Send tools require `idempotency_key`; `send_policy.require_known_recipient` suppresses deliveries to new recipients ([E2](../edge-cases.md)); tools the key lacks permission for are not listed and refused if called | `it::send::e2_require_known_recipient`, `it::security::mcp_tools_follow_key` |
| I | Tool results leaking across scope | Each tool dispatches to the same handler and router entry as its REST equivalent; there is no MCP-only data path | `it::security::cross_tenant_matrix` (MCP column) |
| D | Long polls tying up the endpoint | `mail_wait` timeout ≤ 60 s; requests count against `RL_API` | `it::wait::e4_*` |

### 3.4 TB4: Worker → webhook endpoints

| STRIDE | Threat | Mitigation | Test |
|---|---|---|---|
| S | Integrator receives forged events | Standard Webhooks HMAC-SHA256 with a per-endpoint secret; 5-minute timestamp window documented for receivers (FR-WH-2) | `it::webhooks::signature_vectors` |
| T | Payload altered | Signature covers `{id}.{timestamp}.{body}` | `it::webhooks::signature_vectors` |
| R | Delivery disputes | `webhook_deliveries` row per attempt with status, HTTP status and error code | `it::webhooks::j4_retry_schedule` |
| I | Content over-shared | Thin payloads, `extracted_text` capped by `webhook_text_bytes` (≤ 64 KB), none for quarantined mail (FR-WH-4) | `it::webhooks::thin_payloads` |
| I/E | SSRF into private networks or the deployment itself | Section 9 guard at create, update and every attempt; no redirects; 15 s; 4 KB response read | `core::ssrf::*`, `it::webhooks::ssrf_refused`, `it::webhooks::no_redirects_and_caps` |
| D | Slow or failing endpoints exhaust the consumer | Per-attempt timeout, retry schedule, disable after 100 failures over ≥ 24 h, `410` disables | `it::webhooks::j4_retry_schedule` |

### 3.5 TB5: Worker ↔ Cloudflare APIs, AWS, SMTP relays, OAuth providers, DoH, RDAP, scanner

| STRIDE | Threat | Mitigation | Test |
|---|---|---|---|
| S | Forged SES delivery event via `POST /hooks/ses`, or forged inbound notification via `POST /hooks/ses/inbound` (which would inject mail with chosen verdicts) | Both endpoints verify the SNS signature with the same code: `SignatureVersion` must be `2` (SHA256withRSA); version 1 (SHA-1) is refused. `SigningCertURL` must be `https` on host `sns.{PM_SES_REGION}.amazonaws.com`. `TopicArn` must equal that endpoint's topic (`PM_SES_SNS_TOPIC_ARN` for `/hooks/ses`, `PM_SES_INBOUND_TOPIC_ARN` for `/hooks/ses/inbound`). `Timestamp` within one hour (14 days on the SQS backstop path). Subscription confirmation only for that exact topic. Any failure → `403 invalid_signature` and `ses_sns_rejected_total`. `pmail setup ses` sets `SignatureVersion=2` on both topics ([N1](../edge-cases.md), [N2](../edge-cases.md), [Outbound › Amazon SES](outbound.md#amazon-ses), [Domains on any DNS host §4.5](domain-connections.md#45-inbound-through-ses)) | `core::sns::verify_v2_vectors`, `it::ses::sns_tampered_rejected` |
| S | SES verdicts used to mark forged mail as authenticated | Verdicts are read only from a notification signed for our inbound topic. SPF is taken from SES (it saw the connecting IP); DKIM, ARC and DMARC are recomputed over the raw bytes as for every source, and a disagreement with SES increments `ses_auth_disagreement_total` | `it::ses::verdict_mapping` |
| T | The same inbound notification delivered twice (SNS retry, SQS backstop, or both) | `ses_ingest` ledger: `INSERT OR IGNORE` on `(object_key, recipient)`; only an inserted row enqueues a pointer ([N3](../edge-cases.md)) | `it::ses::push_and_backstop_once` |
| I | One SES message with recipients in several tenants | Each recipient becomes its own pointer and is resolved in the directory separately ([N28](../edge-cases.md)) | `it::ses::cross_tenant_recipients` |
| I | Raw inbound mail at rest in S3 | Bucket in the SES region with all public access blocked and SSE-S3. The bucket policy lets only `ses.amazonaws.com` `s3:PutObject` on `in/*`, and only with `aws:SourceAccount` = the account and `aws:SourceArn` = the receipt rule. The consumer deletes each object once every recipient is ingested; a lifecycle rule deletes `in/` after 14 days ([Domains on any DNS host §4.2](domain-connections.md#42-deployment-set-up-for-ses)) | — (`pmail setup ses`, spike S11) |
| E | Over-privileged SES credentials | The IAM user `pylota-mail-worker` has one policy listing exactly the SES, receipt-rule, S3 (`in/*` only) and SQS actions of [Domains on any DNS host §4.2](domain-connections.md#42-deployment-set-up-for-ses); setup prints it for review. Its access key goes into Worker secrets and is never written to disk | — (`pmail setup ses`) |
| I | SMTP relay credentials read in transit or at rest | Ports `465` (implicit TLS) and `587` (STARTTLS) only; anything else is `400 smtp_port_not_allowed`. TLS is required before `AUTH`: a relay that does not advertise `STARTTLS` gets no credentials (`smtp_tls_required`) ([N16](../edge-cases.md)). The runtime must check the certificate host name (spike S12; otherwise `smtp_relay` does not ship). Credentials are sealed in `domains.smtp_sealed` (section 7.2) and never returned, logged or exported | `core::smtp::state_machine` |
| I/E | A relay host used to reach private networks | `smtp.host` must be a DNS name with public addresses; the [SSRF rules](#93-other-outbound-destinations) apply to every connection | `core::ssrf::*` |
| S | A relay that rewrites `From` or signs with its own `d=` makes the deployment send mail that fails DMARC (U4) | Alignment probe before the first send and every day; a failing probe moves the domain to `failing` and sends fall back to the platform address (SEC-4, [N18](../edge-cases.md)). A `535` reply is `smtp_auth_failed` ([N14](../edge-cases.md)) | `it::smtp::probe_unaligned_falls_back` |
| S | Forged OAuth callback or ID token | Section 4.9: state bound to the browser, PKCE, exact redirect URI, ID token claims checked | `it::oauth::state_cookie_binding` |
| S | Forged delivery event on `pm-delivery-events` | Only Cloudflare event subscriptions produce to the queue; payloads are schema-validated, routed by sender address through the directory and matched by provider message ID; unmatched events are orphaned, never applied by guess ([G8](../edge-cases.md)) | `it::delivery::g8_race` |
| S | A lying DNS resolver flips a domain state | Two independent resolvers, two consecutive agreeing results ([H7](../edge-cases.md)) | `core::domain_fsm::h7_resolver_disagreement` |
| I | Mail content stored by AI Gateway | When `PM_AI_GATEWAY` is set, every model call that carries mail content disables gateway log collection and caching (gateway options `collectLog: false`, `skipCache: true`, confirmed by spike S6) | `it::ai::gateway_options_no_log` |
| I | `PM_CF_API_TOKEN` leak | Optional; scoped to the permissions in [Identities and domains](identity-domains.md); never logged; rotated per section 6 | `it::logs::i5_no_content_in_logs` |
| D | Cloudflare API rate limits | Backoff in `DomainMonitor` and job runners; one verification per minute per domain | `it::domains::verify_rate_limited` |
| E | Over-privileged automation | Without `PM_CF_API_TOKEN`, tenant domains are added from the CLI with the operator's own token | — (configuration) |

### 3.6 TB6: operators of the deployment

| Threat | Mitigation |
|---|---|
| A Cloudflare account member reads D1, R2 or Durable Object data | Out of scope for the software (SECURITY.md). Deployers keep account membership minimal and use Cloudflare's own audit logs. Secrets are Worker secrets and are never written to disk unless `pmail setup --print-secrets` is used |
| A platform key is misused | Platform keys reach every tenant: issue few, set `expires_at`, store them in a secrets manager (`key_command` in the CLI profile). Every state-changing platform-key action on a tenant is audit-logged; sends are not audit rows: each is a stored message, and the request's structured log carries `key_id` ([Observability §2.1](observability.md#21-schema)). A platform key cannot sign as an identity: `identities:sign` is not allowed at that level (section 4.6) |
| The CLI machine leaks a key | `~/.config/pylota-mail/config.toml` is created `0600` and refused when group- or world-readable ([Configuration](../../reference/configuration.md#cli-configuration)) |
| The release pipeline is compromised | Section 11: pinned dependencies and actions, signed `SHA256SUMS`, build provenance attestations, protected tags and environments |

### 3.7 TB7: people → console

The console's own rules are in [Console and workspaces](console.md) and [Cloud sign-up](cloud-signup.md);
section 4.9 states the security properties.

| STRIDE | Threat | Mitigation | Test |
|---|---|---|---|
| S | Guessing a six-digit code; sign-in mail used to flood an address | 3 link or code requests per 10 minutes per address; 10 attempts per code, then the token is burned; `RL_SIGNIN` 10 requests per 60 s per client IP ([W15](../edge-cases.md)) | `it::console::w15_signin_limits` |
| S | Login CSRF or a stolen OAuth `code` replayed in another browser | `state` hashed under the link keyring and bound to the `__Host-pm_oauth` cookie, single use, 10 minutes; PKCE S256; `nonce` for Google; exact redirect URI ([W20](../edge-cases.md)) | `it::oauth::state_cookie_binding` |
| S | Taking over an account through a provider account with an unverified address | Only a verified email is accepted, and accounts are linked only by that verified email ([W21](../edge-cases.md), [W22](../edge-cases.md)) | `it::oauth::unverified_email_refused`, `it::oauth::link_by_verified_email` |
| S | A stolen first factor (mailbox access, provider account) | Two-step verification (TOTP), optional per person and required by a workspace with `require_two_factor`; attempt limits and replay refusal ([W27](../edge-cases.md), [W28](../edge-cases.md)) | `core::totp::rfc6238_vectors`, `it::totp::workspace_requirement`, `it::totp::recovery_code_single_use` |
| T | Cross-site form posts | CSRF token, `Origin` equal to `https://{PM_CONSOLE_HOST}`, `SameSite=Lax` ([W16](../edge-cases.md), [Console › CSRF](console.md#csrf)) | `it::console::w16_csrf` |
| I | Session cookies reaching the API, or API keys reaching browser history | Host split: with two hosts, console paths answer only on `PM_CONSOLE_HOST` and API paths only on `PM_API_HOST`; no cookie is set or read on the API host | `it::hosts::console_api_split` |
| I | Open redirect through `next` | Only a relative path under `/console/`, with no `//`, no backslash and no scheme ([W31](../edge-cases.md)) | `it::landing::routing_table` |
| I | Hostile HTML in mail acting inside the console | Text view by default; sanitised HTML in a token-less `sandbox` `srcdoc` frame; no script source in the CSP ([W17](../edge-cases.md)) | `it::console::w17_hostile_html` |
| E | A viewer acting beyond its role, or an ID from another workspace | The console route table registers each route with its permission, like the API's ([W18](../edge-cases.md)) | `it::console::w18_role_and_scope` |
| S/T | A forged unsubscribe token, or a real one replayed for another person, workspace or kind | The token is a MAC under a `link` key, with that key's kid, over the person, the workspace and the kind (section 4.9); it is compared in constant time, lives 90 days and verifies only while its link key is current or inside the 7-day window after a rotation. It can only set that one kind to `off` for that person in that workspace: it reads nothing and never touches `account`. An altered, foreign or expired token changes nothing and gets the same page linking to settings ([O18](../edge-cases.md)) | `it::notify::one_click_unsubscribe` |
| I | Notification content read on a lock screen, or by the person's mail provider | Notifications carry counts, inbox addresses, the workspace name and links only: never a subject, sender, snippet or attachment name from any message, and only mail visible in the inbox is counted ([Notifications §1](notifications.md#1-kinds), [O15](../edge-cases.md)) | `core::notify::no_content_in_body`, `it::notify::invisible_mail_never_notifies` |
| D | Notification mail used to flood a person | At most 50 notification emails per person and 200 per workspace a day, `account` excepted, the rest going into the next daily digest ([O24](../edge-cases.md)); a hard bounce or complaint pauses that person's preferences ([O17](../edge-cases.md)) | `it::notify::daily_caps`, `it::notify::bounce_pauses_prefs` |
| D | Free workspaces created to send spam | New-workspace send ramp, disposable-domain block, `RL_SIGNIN` ([W29](../edge-cases.md), [W30](../edge-cases.md), [Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud)) | `it::abuse::free_ramp` |

### 3.8 TB8: agent proofs → third parties

How assertions and signed requests are built is in [Agent signing keys](agent-keys.md); these are the
security properties.

| STRIDE | Threat | Mitigation | Test |
|---|---|---|---|
| S | A forged agent assertion: a token this deployment did not mint | Ed25519 signature under the identity's own key. Verifiers accept only `alg: EdDSA` with `typ: agent-assertion+jwt`, take keys only from `{trusted iss}/.well-known/jwks/{sub}.json` (never from a URL the token supplies) and pick the key by `kid` ([Agent signing keys §4.3](agent-keys.md#43-how-a-verifier-checks-it)); the Rust SDK's `verify_assertion` and `pmail assertions verify` do exactly this | `core::jwt::eddsa_rfc8037_vector`, `it::assertions::sdk_verifies` |
| S/T | A replayed assertion or signed request | Assertions carry `jti` (a new ULID), `aud`, `exp` at most 600 s after `iat` (default 300 s) and the verifier's optional `nonce`. HTTP signatures carry a 64-byte random `nonce`, `created` and `expires` (30–300 s, default 60 s) in the signed parameters, and always cover `@authority`. The service mints both and stores neither, so replay detection belongs to the verifier: it keeps each `jti` until `exp`, and each signature nonce until `expires` ([Agent signing keys §10](agent-keys.md#10-security-and-privacy)) | `it::assertions::claims_and_limits`, `it::http_signatures::expiry_bounds` |
| I | Exfiltration of a private key: an identity's seed or the deployment's `web_bot_auth` seed | Generated from `platform::Rng`, sealed at once (section 7.2), unsealed only in memory for one signing call and zeroised after it (`zeroize`). No API returns, logs or exports a private key; a minted token or signature is returned once to its caller and never stored or logged. Reading a sealed seed needs both D1 access and `PM_MASTER_KEY`. After a suspected leak: revoke the identity key (`POST /v1/identities/{identity_id}/keys/{kid}/revoke` removes it from the JWKS at once, cached at most 5 minutes, [O3](../edge-cases.md)), or rotate `web_bot_auth` with `revoke_previous=true`; then rotate `PM_MASTER_KEY`, which re-seals every key without changing a public key ([O8](../edge-cases.md)) | `it::identity_keys::revoke_removes_from_jwks`, `it::secrets::rotate_master_reseals_identity_keys` |
| S | A mirrored key directory: someone serves a copy of `/.well-known/http-message-signatures-directory` and registers it as theirs | The response is signed once per listed key with `("@authority";req)`, `tag="http-message-signatures-directory"`, a fresh nonce, `created` and `expires` = `created` + 300 s, so a copy served from another authority fails verification. At most three keys are listed ([O12](../edge-cases.md)) | `it::well_known::directory_signed_per_key` |
| I | Probing the JWKS for which identities exist, are paused or were deleted | An unknown, deleted, paused or suspended identity gets the same `404 identity_not_found`; identity IDs are ULIDs, never derived from addresses ([Agent signing keys §3.1](agent-keys.md#31-identity-jwks)) | `it::identity_keys::paused_withdraws_jwks` |
| E | A misbehaving agent keeps proving who it is after it was stopped | The kill switch (FR-IDN-9): pausing an identity, or suspending its tenant (which pauses every identity), stops signing at once (`409 identity_paused`) and withdraws its JWKS (`404`), so a verifier that refetches stops accepting it within the 5-minute cache ([O1](../edge-cases.md)). Erasure deletes the keys and writes each kid to `key_tombstones`, so a deleted kid is never published again ([O7](../edge-cases.md)) | `it::identity_keys::paused_withdraws_jwks`, `it::assertions::erasure_tombstones_kid` |
| E | Signed HTTP requests from a tenant that never chose them | `PM_WEB_BOT_AUTH` is `off` by default and stays off until spike S13 passes (`422 web_bot_auth_disabled`, [O9](../edge-cases.md)); a tenant must opt in with `policy.web_bot_auth.allowed` (`403 policy_denied`, [O13](../edge-cases.md)) | `it::http_signatures::disabled_and_policy` |
| D | Signing calls used to exhaust the Worker | `RL_SIGN`: 600 signing calls per 60 s per identity, assertions and HTTP signatures together (section 10) | `it::auth::rate_limited` |

## 4. Authentication

### 4.1 Key format

```text
pmk_{mode}_{lookup}_{secret}

mode    live | test                         (follows the key's tenant; platform keys are live)
lookup  12 chars, lower-case Crockford base32 (alphabet 0123456789abcdefghjkmnpqrstvwxyz), 60 random bits
secret  52 chars, same alphabet, encoding 32 random bytes (256 bits)

regex   ^pmk_(live|test)_[0-9a-hjkmnp-tv-z]{12}_[0-9a-hjkmnp-tv-z]{52}$
example pmk_live_7k2m9q4xa0bc_…(52 characters)
```

- All randomness comes from `platform::Rng`. A `lookup` collision on insert (unique index) is retried
  with a new value.
- The value returned once as `secret` by `POST /v1/keys` and `POST /v1/keys/{id}/rotate` is the whole
  string. It is never stored, logged or returned again.
- `api_keys.hash` is `hex(HMAC-SHA256(PM_KEY_PEPPER, <whole key string>))`.

### 4.2 Verification

Every authenticated request (REST and MCP) runs `auth::authenticate` once, before routing to a handler:

1. Read `Authorization: Bearer <token>`. Missing, or not matching the regex: `401 unauthenticated`.
2. `SELECT … FROM api_keys WHERE lookup = ?1` (one indexed D1 read; no cross-request cache, so a
   revocation takes effect on the next request).
3. Compute `mac = HMAC-SHA256(PM_KEY_PEPPER, token)`. If no row was found, compute it anyway and
   compare against a fixed dummy value, so a miss and a mismatch cost the same.
4. Compare `mac` with `hex_decode(hash)` using `Mac::verify_slice` (`hmac =0.13.0`, whose output type
   compares in constant time). Never compare hex strings with `==`.
5. If that fails and `prev_hash` is set and `now < prev_expires_at`, compare with `prev_hash` the same
   way.
6. No match: `401 unauthenticated`. The response is byte-identical for an unknown lookup, a wrong
   secret and an expired overlap (except `request_id`).
7. Only now: `revoked_at` set → `401 key_revoked`; `expires_at ≤ now` → `401 key_expired`.
8. The `mode` in the token must equal the row's `mode`; otherwise `401 unauthenticated`.
9. Resolve `Scope { key_id, level, tenant_id, identity_id, mode, permissions }`. For tenant and
   identity keys, `permissions` is the key's list plus the implicit `usage:read` (section 4.6), and the
   tenant row is loaded; a tenant in status `erasing` or `erased` gives
   `401 key_revoked` (its keys were revoked by the erasure job; this covers the window before that
   step commits). A `suspended` tenant still authenticates: suspension is enforced by policy
   (`403 tenant_suspended` on sends, FR-TEN-3).

### 4.3 `last_used_at`

After a successful authentication the handler schedules, with `wait_until` (never on the response
path):

```sql
UPDATE api_keys SET last_used_at = ?1
WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?1 - 60000);
```

At most one write per key per minute (data model). A failure of this write is logged and ignored.

### 4.4 Expiry

`expires_at` is optional and checked on every request (step 7). `GET /v1/me` returns it so agents can
warn before expiry. Expired keys are kept for audit and can be deleted (revoked) like any other.

### 4.5 Rotation

`POST /v1/keys/{key_id}/rotate { "overlap_hours": 0–168 }`:

1. Generate a new 32-byte secret; keep `id`, `lookup`, `level`, scope and permissions.
2. In one D1 statement: `prev_hash = hash`, `prev_expires_at = now + overlap_hours`,
   `hash = HMAC(new token)`. With `overlap_hours = 0`, `prev_hash` and `prev_expires_at` are set to NULL.
3. Return the new token once; audit `key.rotate`.

A second rotation during an overlap replaces `prev_hash` with the current hash, so at most two secrets
are ever valid. Revocation (`DELETE /v1/keys/{key_id}`) sets `revoked_at` and clears `prev_hash`.

### 4.6 Creating keys (FR-KEY-1)

`POST /v1/keys` checks, in this order:

1. **The request.** `permissions` is required and non-empty at every level, `level: platform` included:
   there is no implicit full set (`400 invalid_request` when it is missing or empty).
   `pmail keys create` without `--permissions` exits 2 with a message ([CLI and setup](cli.md)).
2. **Permissions allowed at the new key's level.** Some permissions can never be held at some levels,
   whoever the caller is. Listing one is `400 invalid_request` with
   `details.reason = "permission_not_allowed_for_level"`:

   | Permission | Platform key | Tenant key | Identity key |
   |---|---|---|---|
   | `tenants:manage`, `platform:ops` (platform-only) | yes | no | no |
   | `members:read`, `members:manage`, `suppressions:manage`, `audit:read`, `usage:read` (tenant-only) | yes | yes | no |
   | `identities:sign` | no | yes | yes, for its own identity |
   | Every other permission | yes | yes | yes |

3. **Scope.** Every condition below holds; otherwise `403 key_scope_exceeded`:

   | Caller level | New key's level | Tenant | Identity |
   |---|---|---|---|
   | platform | any | any existing tenant (tenant, identity levels) | any identity of that tenant (identity level) |
   | tenant | tenant or identity | must equal the caller's tenant | any identity of the caller's tenant |
   | identity | identity | must equal the caller's tenant | must equal the caller's identity |

   and `permissions` is a subset of the caller's permissions.

- **Implicit `usage:read`.** Every tenant and identity key holds `usage:read` for its own workspace
  without listing it: authentication adds it to the resolved permissions (section 4.2, step 9). A key
  reaches only its own workspace, so the grant never reaches another one. An identity key still cannot
  list it (step 2), and a platform key holds it only when listed.
- The caller needs `keys:manage`. The new key's `mode` is its tenant's mode; platform keys are `live`.
- `created_by_key_id` records the lineage. Revoking a key does not revoke its children; the
  compromised-key runbook ([Observability](observability.md#compromised-key)) revokes descendants
  explicitly.

### 4.7 Unauthenticated routes

Only these routes skip authentication, and they are listed explicitly in the router table:
`GET /health`, `GET /openapi.json`, `GET /v1/plans`, `GET /.well-known/security.txt`, the identity
JWKS `GET /.well-known/jwks/{identity_id}.json` and the Web Bot Auth key directory
`GET /.well-known/http-message-signatures-directory` (`404 key_not_found` while `PM_WEB_BOT_AUTH=off`;
both serve public keys only, [Agent signing keys §3](agent-keys.md#3-publication)), the SNS
notification endpoints `POST /hooks/ses` (SES delivery events) and `POST /hooks/ses/inbound` (SES
inbound notifications), both authenticated by the SNS signature (section 3.5), and signed links
`GET /v1/links/{token}` (authenticated by their MAC, section 7.3). The console (`/console/*`) and the
Stripe webhook (`/billing/stripe/webhook`) are separate route tables with session and signature checks
of their own. In the console table, the routes that need no session are the sign-in, sign-up, waitlist,
OAuth start and callback, and invitation-accept routes, and the unsubscribe pair
(`GET` and `POST /console/notifications/unsubscribe`), which is authenticated by its token alone
(section 4.9). Which host answers which path is in section 4.9. The Worker does not serve an MTA-STS
policy: the operator publishes one as the self-hosting guide describes.

### 4.8 The first platform key

No API call can create a key without a key, and the CLI never reads a secret back from the Worker. The
CLI therefore mints a platform key only together with a `PM_KEY_PEPPER` it has just generated and still
holds in memory ([CLI and setup › The bootstrap key](cli.md#65-the-bootstrap-key)):

1. `pmail setup` generates the pepper, uploads it with `wrangler secret put`, computes the hash of a new
   platform key with it, and inserts the `api_keys` row and a `key.create` audit row through the
   Cloudflare D1 query API with the operator's `CLOUDFLARE_API_TOKEN`. This **bootstrap key** expires
   after 24 hours; `pmail keys create --level platform --permissions …` (an explicit list: a platform key
   has no implicit permission set, [§4.6](#46-creating-keys-fr-key-1)) then creates the long-lived key through
   `POST /v1/keys` like any other.
2. A re-run of setup that finds the pepper already set and keys in `api_keys` stops: the CLI cannot know
   the old pepper. Only `pmail setup --rotate-pepper` replaces it, which invalidates every key (the
   `PM_KEY_PEPPER` procedure in section 6.2).

### 4.9 Console authentication and hosts

People authenticate to the console; the REST API and `/mcp` accept API keys only. The flows are in
[Console › Sign-in](console.md#sign-in) and [Cloud sign-up §3–§5](cloud-signup.md#3-sign-in-methods).
The security properties:

| Mechanism | Rules |
|---|---|
| Email link and code | Link tokens, codes, invitation tokens and session cookies are stored only as `HMAC-SHA256(link key {kid}, value)` with the kid in `key_kid`. 3 requests per 10 minutes per address; 10 attempts per code, then the token is burned; 10-minute lifetime, single use; `RL_SIGNIN` (section 10). Responses are identical for known and unknown addresses ([W15](../edge-cases.md)) |
| Google and GitHub | `GET /console/oauth/{provider}/start` writes an `oauth_states` row valid for 10 minutes. Its `state_hash` and `cookie_hash` are keyed hashes under the current link key, whose kid is stored in `key_kid`, and the PKCE verifier is sealed in `pkce_sealed`. The cookie `__Host-pm_oauth` (HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes) binds the flow to the browser. The redirect carries PKCE `S256`, a `nonce` (Google) and the exact redirect URI `https://{PM_CONSOLE_HOST}/console/oauth/{provider}/callback`. The callback requires the row to exist, be unexpired and unused, and match the cookie, and marks it used before exchanging the code ([W20](../edge-cases.md)). Google: `iss`, `aud`, `exp`, `nonce` and `email_verified = true` are checked. GitHub: the primary address must be marked verified. Without a verified address the flow is refused ([W21](../edge-cases.md)). A provider identity links to an existing person only through that verified email ([W22](../edge-cases.md)). Scopes: `openid email profile` (Google), `read:user user:email` (GitHub) |
| Two-step verification | TOTP per RFC 6238: HMAC-SHA1, 30-second step, six digits, one step of drift either way. The 20-byte secret is sealed in `users.totp_sealed`. A code already used in its step is refused (`users.totp_last_step`). 5 attempts a minute per person; 10 failures in a row lock two-step sign-in for 15 minutes. It is asked for after every first factor and at re-authentication. Turning it off needs re-authentication with a current code, emails the person and writes an audit row |
| Recovery codes | Ten codes of 10 Crockford base32 characters, shown once. Stored in `users.recovery_codes_sealed`, a pm1 envelope (section 7.2) of `[{ "hash": SHA-256(code), "used_at": null }]`. Each works once; generating new codes replaces the old ones ([W28](../edge-cases.md)). They are sealed rather than hashed under the link keyring because link keys are deleted 7 days after a rotation and recovery codes live for months |
| Sessions | `__Host-pm_session` (`Secure`, `HttpOnly`, `SameSite=Lax`); 7 days rolling, 30 days absolute; sensitive actions need a sign-in within the last 10 minutes ([Console › Sessions](console.md#sessions)) |
| Notification unsubscribe links | `https://{PM_CONSOLE_HOST}/console/notifications/unsubscribe?t={token}`, in the `List-Unsubscribe` header of every `usage`, `new_mail` and `needs_person` email. The token is a MAC under the current link key, carrying that key's kid, over the person, the workspace and the kind; it is valid for 90 days, and only while its link key is current or inside its 7-day verify window. `GET` changes nothing (a confirmation page with a one-click form); `POST` sets that one kind to `off` for that person and workspace. Neither needs a session, and both are exempt from the console's CSRF token and `Origin` check, because a mail provider sends the RFC 8058 `POST` without either: the token is their only authority, and the most it can do is turn one kind off. They are served even with `PM_CONSOLE=off` ([Notifications §5](notifications.md#5-the-emails), [O18](../edge-cases.md)) |
| Hosts | `PM_CONSOLE_HOST` defaults to `PM_API_HOST`. When the two differ, console paths answer only on `PM_CONSOLE_HOST`, and API paths only on `PM_API_HOST`: REST `/v1/*` (signed links `/v1/links/*` included), MCP `/mcp`, `/openapi.json`, `/health`, `/.well-known/*` (the security contact, the identity JWKS and the Web Bot Auth key directory), `/hooks/*` and `/billing/stripe/webhook`. Anything else gets `404`. No cookie is set or read on the API host. This keeps session cookies off the API and API keys out of browser history ([Cloud sign-up §2](cloud-signup.md#2-hostnames)) |

## 5. Authorisation and tenant isolation

### 5.1 Deny-by-default router table

Every route is registered with its method, path pattern, required permission(s), scope rule and
idempotency rule. The router is built from that table only; a request matching no entry gets
`404` with the standard envelope. A route cannot be registered without a permission list and a scope
rule (the registration function takes them as non-optional arguments), and public routes use the
explicit `Scope::Public` variant. The permission list may be empty only for `Scope::Public` and for
the two routes that every key may call on its own workspace: `GET /v1/me` and
`GET /v1/tenants/{tenant_id}`. For the second, `foreign_permissions` (`tenants:manage`) is required as
well when the target is not the key's own tenant, and always for a platform key. A unit test fails when
any other route has an empty list. `GET /v1/usage` is not one of them: it is registered with
`usage:read`, which every tenant and identity key holds implicitly for its own workspace (section 4.6),
while a platform key needs it listed and must pass `tenant_id` (`400 invalid_request` without it).

```rust
// crates/worker/src/auth/routes.rs
pub enum Scope {
    Public,                                  // section 4.7 only
    AnyKey,                                  // GET /v1/me
    PlatformOnly,                            // e.g. POST /v1/tenants, POST /v1/webhooks, /v1/platform/*
    TenantPath { param: &'static str },      // /v1/tenants/{tenant_id}/...
    IdentityPath { param: &'static str },    // /v1/identities/{identity_id}/...
    Resource { kind: ResourceKind, param: &'static str }, // domain, webhook, key, erasure, export
    TenantFilter,                            // collection with optional tenant_id filter (GET /v1/usage, /v1/audit-events)
}

pub struct RouteSpec {
    pub method: Method,
    pub pattern: &'static str,
    pub permissions: &'static [Permission],  // all required
    pub foreign_permissions: &'static [Permission], // also required when the target is not the key's own tenant
    pub scope: Scope,
    pub idempotency: Idempotency,            // Required | Optional
    pub min_level: Option<Level>,            // e.g. Tenant for tenant search (FR-SRCH-10)
}
```

Builds with the `itest-hooks` cargo feature expose the table at `GET /__test/routes`, so the attack
suite can prove it covers every route ([Testing](testing.md#7-cross-tenant-attack-suite)).

### 5.2 Order of checks

For each request, before any Durable Object or R2 call:

1. **Authenticate** (section 4.2).
2. **Permission.** The key must hold every permission in `RouteSpec.permissions`; otherwise
   `403 permission_denied` with `details.required`. This check does not depend on the target, so it
   leaks nothing.
3. **Level.** If the route is above the key's level and the target is the key's own tenant (an identity
   key holding `search:read` on `POST /v1/tenants/{own}/search`), the result is `403 scope_denied`
   ([F3](../edge-cases.md)). A route that needs a permission the key's level can never hold (a tenant key
   on `GET /v1/tenants`, which needs `tenants:manage`) already failed step 2 with `permission_denied`. This also reveals nothing, because the target is the
   key's own tenant.
4. **Resolve the target's owner** from D1 with the key's scope as a mandatory parameter of the data-access
   function (`tenant_id` is a required argument of every tenant-data query):
   - `TenantPath`: the tenant ID must equal the key's tenant (platform keys: the tenant must exist).
   - `IdentityPath`: `SELECT tenant_id, status, mailbox_do_id FROM identities WHERE id = ?1`, then
     compare with the key; identity keys must match their own identity.
   - `Resource`: load the row and compare its `tenant_id` (and `identity_id` where relevant). The
     platform domain (`tenant_id IS NULL`) is readable by every key with `domains:read`.
   - Any mismatch returns the resource's own `*_not_found` code with the same body as for a
     non-existent ID. The check runs whether or not the ID exists, so both paths do one D1 read.
5. **Body and query parameters naming a tenant or identity** (`tenant_id` in `POST /v1/keys`,
   `POST /v1/erasure-requests`, `POST /v1/exports`, `identity_ids` filters, `tenant_id` filters):
   for non-platform keys, a value outside the key's scope returns `404 tenant_not_found` or
   `404 identity_not_found` (for `POST /v1/keys`, `403 key_scope_exceeded`, as api.md states). A value
   equal to the key's own scope is accepted. Missing values default to the key's scope; a platform key
   has no default tenant, so on `GET /v1/usage` it must pass `tenant_id` (`400 invalid_request`).
6. **Call the Durable Object** with an `RpcEnvelope` carrying `tenant_id`, `identity_id`,
   `actor_key_id` and `request_id` taken from the resolved scope, never from the request. The object
   compares them with the owner in its `meta` and refuses a mismatch with `internal_error`, logging
   `rpc_owner_mismatch` and incrementing `rpc_owner_mismatch_total`, which alerts at 1
   ([Design conventions](index.md#5-internal-durable-object-rpc)). `TenantQuota` and `Notifier` keep
   their owner in their `meta` table under `tenant_id`, written by `QuotaRequest::Init` and
   `NotifierRequest::Init` when the tenant is created, like the other objects
   ([Data model §3](data-model.md#3-other-durable-objects)).

### 5.3 Cross-level read access

- An **identity** key reaches its tenant's domains read-only with `domains:read`, and its tenant's
  webhook endpoints and deliveries read-only with `webhooks:read` (api.md). Writes to either from an
  identity key return `403 scope_denied`.
- `webhooks:manage` includes `webhooks:read`. `platform:ops` can only be held by platform keys, like
  `tenants:manage`.
- **Quarantined, hidden and throttled mail in lists** (FR-IN-5). This rule is the reference the API,
  MCP and console pages follow. A mail list (`GET /v1/identities/{identity_id}/messages`, and every
  MCP tool and console view built on it) excludes messages with status `quarantined`, `hidden` or
  `throttled` by default, whatever the key holds. One of them appears only when **both** hold: the
  request filters on that status (`status=quarantined`, `status=hidden` or `status=throttled`), and the
  key holds `quarantine:review`. A key without `quarantine:review` that sends such a filter gets `200`
  with none of those messages, never `403`, as search treats `include_quarantined`. A thread list has no
  `status` filter, so it never shows them. The dedicated quarantine list
  (`GET /v1/identities/{identity_id}/quarantine`) requires `quarantine:review` and lists only
  `quarantined` messages. Reading a `quarantined`, `hidden` or `throttled` message by ID (the message itself, its attachments,
  its raw MIME or its thread view) requires `quarantine:review` too; otherwise `404 message_not_found`,
  the same answer as for a message that does not exist, so its presence is not revealed.
- **Search** keeps its own explicit flag and does not contradict the list rule: it never returns
  `hidden` or `throttled` mail, and returns `quarantined` mail only when the request sets
  `include_quarantined` (or uses `is:quarantined`) and the key holds `quarantine:review`; without
  `quarantine:review` the flag is ignored, never refused ([Search § 2](search.md#2-request-handling)).
- Attachments with a `risk` require `quarantine:review` (api.md).
- Resuming an identity paused for `abuse_threshold` requires a tenant or platform key and is
  audit-logged (api.md).

### 5.4 Agentic planner and MCP scope

- The planner's tools are built from the caller's resolved scope. Tool arguments can narrow the scope
  (fewer identities, more filters) but never widen it: identity IDs outside the caller's set are
  dropped, `include_quarantined` is honoured only when the caller holds `quarantine:review` and asked
  for it, and an attempt to widen is recorded in the trace ([F10](../edge-cases.md),
  [Search](search.md)).
- MCP tools call the same handler functions as REST, through the same `RouteSpec` entries, so the
  permission, level and owner checks are identical.

### 5.5 Inbound isolation

The `email()` handler takes tenant and identity only from the directory row of the envelope recipient.
Header recipients, sub-address tags and message content never select an identity ([A2](../edge-cases.md)).
Thread tokens are bound to the identity ID, so a token minted for one identity never verifies for
another ([Threading](threading.md)).

## 6. Secrets

### 6.1 Inventory

| Secret | Single purpose | Generated by | Leak impact |
|---|---|---|---|
| `PM_MASTER_KEY` | AES-256-GCM encryption at rest of webhook secrets, identity signing keys, the `signing_keys` keyring (the `web_bot_auth` seed included), SMTP relay credentials, TOTP secrets, recovery-code hashes and OAuth PKCE verifiers (section 7.2) | `pmail setup`: 32 bytes from the OS CSPRNG, base64 | Decrypts stolen D1 ciphertexts (needs D1 access too) |
| `PM_MASTER_KEY_NEXT` (rotation only) | The new master key while `pmail secrets rotate-master` runs | `pmail secrets rotate-master` | As `PM_MASTER_KEY` |
| `PM_KEY_PEPPER` | HMAC-SHA256 of API key strings | `pmail setup` (section 4.8) | Offline guessing of stolen hashes is still infeasible (256-bit secrets); rotate as break-glass |
| Thread keys (`signing_keys`, purpose `thread`) | HMAC of thread tokens | The Worker: 32 bytes from `platform::Rng`, sealed under `PM_MASTER_KEY` | Forged thread tokens (still rate-limited, still no data access) |
| Link keys (`signing_keys`, purpose `link`) | MACs and keyed hashes on tokens the service issues and later verifies: signed download links, console sign-in, invitation and session tokens, OAuth state hashes, and notification unsubscribe tokens | The Worker, as above | Forged download links; console tokens matched against stolen hashes; forged unsubscribe tokens, which can only turn a notification kind off |
| Cursor keys (`signing_keys`, purpose `cursor`) | MACs on search cursors ([Search › Cursors](search.md#58-cursors-and-as_of-pinning)) | The Worker, as above | Forged cursor positions or `as_of`; scope still comes from the key (SEC-1) |
| The Web Bot Auth key (`signing_keys`, purpose `web_bot_auth`) | Ed25519 signatures on Web Bot Auth HTTP requests and on the key directory | The Worker: a 32-byte seed from `platform::Rng`, sealed under `PM_MASTER_KEY`, created on first use while `PM_WEB_BOT_AUTH=on` | Requests signed as this deployment, naming any of its identities in `From`, until it is rotated with `revoke_previous=true` |
| Identity signing keys (`identity_keys.private_enc`) | Ed25519 signatures on one identity's agent assertions | The Worker: a 32-byte seed from `platform::Rng`, sealed under `PM_MASTER_KEY`, created on the identity's first signing request or by `POST /v1/identities/{identity_id}/keys` | Assertions forged for that one identity until its key is revoked |
| `PM_HASH_KEY` | Pseudonymisation: address tombstones, suppression hashes, counterparty hashes, log pseudonyms | `pmail setup` | Dictionary tests of which addresses are tombstoned, suppressed or erased |
| `PM_CF_API_TOKEN` (optional) | Runtime automation of tenant domains, event subscriptions, REST fallbacks of spike S6 | The operator, in the Cloudflare dashboard | Changes to the account's routing and sending configuration within the token's permissions |
| `PM_SES_ACCESS_KEY_ID`, `PM_SES_SECRET_ACCESS_KEY` (optional) | The SES integration: sending, identities, receipt-rule updates, reading and deleting inbound objects, draining the backstop queue | The operator, in AWS IAM (`pmail setup ses` creates the user with one policy) | Sending through the deployer's SES account; reading inbound mail still in S3 (at most 14 days); nothing outside that one policy |
| `PM_OAUTH_GOOGLE_CLIENT_SECRET`, `PM_OAUTH_GITHUB_CLIENT_SECRET` (optional) | Exchanging an authorization code at that provider's token endpoint | The operator, in the provider's developer console | Acting as the deployment's OAuth client. Signing in as a person still needs that person's code, the PKCE verifier and the browser-bound state |
| `PM_STRIPE_SECRET_KEY` (only with `PM_BILLING=stripe`) | Stripe API calls: Checkout sessions, Customer Portal sessions, subscription reads ([Billing › Stripe integration](billing.md#stripe-integration)) | The operator, in the Stripe dashboard, as a restricted key (`rk_live_…`) with only those permissions | Creating Checkout and Portal sessions and reading subscriptions in the deployer's Stripe account, within the restricted key's permissions; no access to Pylota Mail data |
| `PM_STRIPE_WEBHOOK_SECRET` (only with `PM_BILLING=stripe`) | Verifying `Stripe-Signature` on `/billing/stripe/webhook` ([Billing › Webhook endpoint](billing.md#webhook-endpoint)) | Stripe, when the webhook endpoint is created (`whsec_…`) | Forged Stripe events. Every event only triggers a re-read of the subscription from the Stripe API ([Billing › Events handled](billing.md#events-handled)), so a forger can cause extra Stripe reads but cannot change a plan or a top-up |
| SMTP relay credentials (`domains.smtp_sealed`) | Authenticating to one customer's relay | The customer, through the API or console | Sending as that customer through their own provider |
| TOTP secrets and recovery codes (`users.totp_sealed`, `users.recovery_codes_sealed`) | One person's second factor | The Worker: 20 bytes from `platform::Rng`; ten codes | Bypassing two-step verification for that person; a first factor is still needed |
| Webhook secrets `whsec_…` | Signing deliveries to one endpoint | The Worker: 32 bytes from `platform::Rng`, `whsec_` + base64 | Forged events to that endpoint |
| API keys `pmk_…` | Authenticating one caller | The Worker (section 4.1) | Access within the key's scope |
| `CLOUDFLARE_API_TOKEN` | CLI only: the commands in [CLI › Commands that use your Cloudflare token](../../reference/cli.md#commands-that-use-your-cloudflare-token), with the permissions in [Deploy › step 2](../../self-hosting.md#2-create-a-cloudflare-api-token) | The operator | Never uploaded to the Worker; never stored in the CLI config file |

Rules:

- **No derivation.** No secret is derived from another (no HKDF from a master key). Each is generated
  independently.
- **Never on disk.** `pmail setup` uploads generated secrets with `wrangler secret put` and does not
  write them anywhere unless `--print-secrets` is passed.
- **Never read back.** Worker secrets are write-only and the `signing_keys` keyring has no read API. The
  CLI only ever knows a secret it has just generated. Sealed values that the Worker must use again (SMTP
  passwords, TOTP secrets, PKCE verifiers, identity and `web_bot_auth` seeds) are never returned by any
  API, logged or included in exports; the domain object shows `smtp.host`, `port`, `username` and
  `probe_from`, never the password, and an identity key shows only its public JWK.
- **Never logged.** Secrets, tokens, `Authorization` headers, signatures, signed-link tokens, minted
  agent assertions and unsubscribe tokens are never logged at any level (section 12).
- **Read once per isolate**, through `platform::Secrets`, and held only in memory. The opened keyring is
  cached per isolate for 5 minutes ([Data model › Notes](data-model.md#notes)).

### 6.2 Rotation procedures

| Secret | Procedure | Effect |
|---|---|---|
| API key | `POST /v1/keys/{id}/rotate` with an overlap (section 4.5) | Old secret valid until the overlap ends |
| Webhook secret | `POST /v1/webhooks/{id}/rotate-secret { "overlap_hours": 0–168 }` | Both signatures sent during the overlap (FR-WH-2) |
| `PM_MASTER_KEY` | `pmail secrets rotate-master` (below) | No downtime; all ciphertexts re-encrypted |
| Thread key | `POST /v1/platform/keys/thread/rotate` (`platform:ops`) | New tokens carry the new kid at once; tokens with the old kid keep verifying for 90 days ([Threading](threading.md#24-key-rotation)). With `?revoke_previous=true` they stop verifying at once, and replies to them fall back to header threading. No secret value is ever handled by a person |
| Link key | `POST /v1/platform/keys/link/rotate` (`platform:ops`) | Download links, console sign-in tokens, invitations, sessions and OAuth flows with the old kid keep verifying for 7 days (the longest link lifetime), then fail; active console sessions are re-hashed under the new key on their next request. Export links are minted on each `GET /v1/exports/{id}`, so callers fetch a new one. With `?revoke_previous=true` everything under the old kid fails at once: open links, sign-in tokens, invitations and OAuth flows fail, and the sessions hashed under it end (normally all of them, because active sessions are re-hashed under the current key). Reading a link key needs both D1 access and `PM_MASTER_KEY`. Without `revoke_previous`, a leaked key keeps verifying for its 7-day window, so after a suspected leak rotate with `revoke_previous=true`, then rotate `PM_MASTER_KEY` |
| Cursor key | `POST /v1/platform/keys/cursor/rotate` (`platform:ops`) | New cursors carry the new kid; cursors with the old kid keep working for 24 hours (the cursor lifetime). With `?revoke_previous=true` open cursors fail at once with `400 invalid_request` (path `cursor`), and callers repeat the search without a cursor |
| Web Bot Auth key | `POST /v1/platform/keys/web_bot_auth/rotate` (`platform:ops`; `422 web_bot_auth_disabled` while `PM_WEB_BOT_AUTH=off`) | New signatures use the new key at once; the previous key stays in the key directory for 7 days, so requests signed shortly before the rotation still verify. With `?revoke_previous=true` it leaves the directory at once |
| Identity signing key | `POST /v1/identities/{identity_id}/keys/rotate` (`identities:write`; tenant, identity or platform key; or the identity page in the console) | The new key signs at once; the previous one is `retiring` and stays in the JWKS until `verify_until` = now + `PM_IDENTITY_KEY_OVERLAP_DAYS` (default 7) ([O2](../edge-cases.md)). After a suspected leak, `POST …/keys/{kid}/revoke` moves the key to `retired` and removes it from the JWKS at once ([O3](../edge-cases.md)). Key management stays available while the identity is paused |
| OAuth client secrets | Create a new client secret in the provider's console, `wrangler secret put PM_OAUTH_GOOGLE_CLIENT_SECRET` (or `…_GITHUB_…`), then delete the old secret at the provider | Sign-ins that are mid-flow during the switch may fail and are retried by the person. Whether a provider keeps two secrets valid at once: verify at build time |
| SMTP relay credentials | `PATCH /v1/domains/{domain_id}` with `smtp` (tenant or platform key with `domains:write`) | The new values are kept pending until a probe passes; the old ones are used until then |
| TOTP secret, recovery codes | At `/console/settings/security`, with re-authentication: turn two-step verification off and enrol again, or generate new recovery codes | The old secret or codes stop working at once |
| `PM_KEY_PEPPER` | Break-glass: `pmail setup --rotate-pepper` (a new pepper and a new bootstrap key in one step, section 4.8), then reissue every key | Every existing key stops working immediately |
| `PM_HASH_KEY` | Not rotatable in v1.0 | Tombstones, suppressions and erasure records would stop matching, which would let an erased address be reassigned (A5). A rotation needs a re-keying migration and an ADR |
| `PM_CF_API_TOKEN` | Create a new token with the same permissions, `wrangler secret put PM_CF_API_TOKEN`, revoke the old token | No downtime |
| SES keys | Create a second IAM access key, put both secrets, deactivate then delete the old key | No downtime |
| `PM_STRIPE_SECRET_KEY` | In the Stripe dashboard, **Rotate key** with an expiration (both keys work for up to 7 days), `wrangler secret put PM_STRIPE_SECRET_KEY`, then let the old key expire ([API keys › Rotate an API key](https://docs.stripe.com/keys#rolling-keys), read 2026-10-09) | No downtime |
| `PM_STRIPE_WEBHOOK_SECRET` | In the Stripe dashboard, **Roll secret** on the endpoint and keep the old secret for up to 24 hours, then `wrangler secret put PM_STRIPE_WEBHOOK_SECRET` inside that window. Stripe signs with every active secret, and the verifier accepts any matching `v1` ([Webhooks › Roll endpoint signing secrets](https://docs.stripe.com/webhooks#roll-endpoint-secrets), read 2026-10-09) | No downtime; no event is rejected |

**`pmail secrets rotate-master`.** Worker secrets are write-only, so the rotation never needs the old
value:

1. Every ciphertext carries the key ID of the key that sealed it (section 7.2).
2. The CLI generates a new key `K2` and uploads it as the secret `PM_MASTER_KEY_NEXT`.
3. While `PM_MASTER_KEY_NEXT` is set, the Worker decrypts with whichever of `PM_MASTER_KEY` and
   `PM_MASTER_KEY_NEXT` matches the ciphertext's key ID, and seals every new value with
   `PM_MASTER_KEY_NEXT`. The `*/15` cron re-seals up to 500 values per run in
   `webhook_endpoints.secret_enc`, `webhook_endpoints.prev_secret_enc`, `identity_keys.private_enc`,
   `signing_keys.ciphertext`, `domains.smtp_sealed`, `domains.smtp_pending_sealed`, `users.totp_sealed`,
   `users.recovery_codes_sealed` and `oauth_states.pkce_sealed` whose key ID is not `kid(K2)`.
4. The CLI polls D1 through the Cloudflare D1 query API until no value has a different key ID, then
   uploads `PM_MASTER_KEY = K2` and deletes `PM_MASTER_KEY_NEXT`.
5. The Worker logs `secrets_reseal_progress` counts; the CLI prints them.

`PM_MASTER_KEY_NEXT` is listed in [Configuration › Secrets](../../reference/configuration.md#secrets).
`pmail doctor` warns while it is set, because a rotation is unfinished.

**Rotating the signing keys.** `POST /v1/platform/keys/{purpose}/rotate` (`purpose` is `thread`,
`link`, `cursor` or `web_bot_auth`, permission `platform:ops`, audit-logged as `signing_key.rotate` with
`details.revoke_previous`) runs one D1 batch: set `verify_until` on the current key (now + 90 days for
`thread`, now + 7 days for `link`, now + 24 hours for `cursor`), and insert a new key with the next kid.
Kids are single Crockford base32 characters assigned in alphabet order and wrapping after `z`. Any
existing row with the next kid is deleted in the same batch: normally a key past its verify window that
the daily clean-up has not reached yet, and only after 32 rotations of one purpose within its window a
key still inside it. With the query `?revoke_previous=true`, the previous kid is deleted in the same
batch instead of getting a verify window, so everything it signed stops verifying at once. The response
carries the purpose, the new kid, `created_at` and the previous kid with its `verify_until` (equal to
the rotation time, with `previous.revoked: true`, when revoked), never key material. CLI:
`pmail keys rotate thread|link|cursor|web_bot_auth [--revoke-previous]`.

The purpose `web_bot_auth` follows the same batch with three differences: its kid is the 43-character
RFC 7638 thumbprint of the new key's public JWK (stored with it in `public_jwk`), not the next letter;
the previous key's `verify_until` is now + 7 days, during which it stays in the key directory; and the
call is refused with `422 web_bot_auth_disabled` while `PM_WEB_BOT_AUTH=off`
([Agent signing keys §2](agent-keys.md#2-keys)).

Residual risk: without `revoke_previous`, a leaked signing key keeps verifying for its window (90 days,
7 days or 24 hours). After a suspected leak, rotate that purpose with `revoke_previous=true`, then rotate
`PM_MASTER_KEY`, which sealed it.

## 7. Cryptography

### 7.1 Choices

| Use | Algorithm | Crate |
|---|---|---|
| API key hashes, thread tokens, signed links, console token hashes and search cursors (keys from `signing_keys`), pseudonyms, Standard Webhooks signatures | HMAC-SHA256 | `hmac =0.13.0`, `sha2 =0.11.0` |
| Console TOTP codes (RFC 6238) | HMAC-SHA1, as the RFC and authenticator apps require | `hmac =0.13.0`, `sha1` (RustCrypto, pin at build time) |
| OAuth PKCE code challenge, recovery-code hashes | SHA-256 (`S256`); recovery-code hashes are stored only inside a sealed envelope | `sha2 =0.11.0` |
| Secrets at rest | AES-256-GCM, random 96-bit nonce, associated data binding the row | `aes-gcm` (RustCrypto), pin at build time |
| Agent assertions (compact JWS, `alg: EdDSA`, RFC 8037) and Web Bot Auth HTTP message signatures (RFC 9421, `alg="ed25519"`), the key directory's own signatures | Ed25519 | `ed25519-dalek =3.0.0` (`default-features = false, features = ["zeroize"]`), `zeroize =1.9.0` for the unsealed seed ([Agent signing keys](agent-keys.md)) |
| Key IDs of identity and Web Bot Auth keys | RFC 7638 JWK thumbprint (SHA-256), base64url | `sha2 =0.11.0` |
| Fingerprints, dedupe, request fingerprints | SHA-256 | `sha2 =0.11.0` |
| DKIM, ARC, DMARC verification | As specified by the RFCs | `mail-auth =0.13.3` (feature `rust-crypto`) |
| SES request signing | AWS SigV4 (HMAC-SHA256) | `hmac`, `sha2` (spike S8) |
| SNS notification signatures | RSA with SHA256 (`SignatureVersion` 2) only; version 1 (SHA1) is refused | chosen by spike S8, pin at build time |
| Release signatures (`SHA256SUMS.sig`) | Ed25519 in the minisign format | `minisign-verify` in the CLI, pin at build time ([CLI and setup](cli.md#82-signature-and-checksums)) |
| Encodings | base64, Crockford base32 | `base64 =0.23.1`; base32 in `core` |
| Constant-time comparison | — | `Mac::verify_slice`, or `subtle` (pin at build time) for non-MAC values |
| Randomness | Web Crypto `crypto.getRandomValues` in the Worker, the OS CSPRNG natively | `platform::Rng` |

No custom primitives. Truncated MACs are used only for thread tokens (40 bits, rate-limited), signed
link tokens and search cursors (128 bits) and log pseudonyms (64 bits, correlation only).

### 7.2 Encryption envelope

```text
pm1.{kid}.{nonce}.{ciphertext}

kid         first 8 bytes of SHA-256(key bytes), lower-case hex (16 chars); identifies the key, reveals nothing useful
nonce       12 random bytes, base64url without padding
ciphertext  AES-256-GCM ciphertext with its 16-byte tag, base64url without padding
aad         "pm1|{table}|{column}|{row id}", e.g. "pm1|webhook_endpoints|secret_enc|whk_01J9…"
            (signing_keys use "{purpose}:{kid}" as the row id, e.g. "pm1|signing_keys|ciphertext|thread:3",
            and "web_bot_auth:{thumbprint}" for the Web Bot Auth seed; identity keys use their
            thumbprint, e.g. "pm1|identity_keys|private_enc|kPrK_qmx…")
```

Sealed columns: `webhook_endpoints.secret_enc` and `prev_secret_enc`, `identity_keys.private_enc` (the
32-byte Ed25519 seed), `signing_keys.ciphertext` (the `web_bot_auth` seed included), `domains.smtp_sealed` (aad `pm1|domains|smtp_sealed|{domain_id}`) and
`domains.smtp_pending_sealed`, `users.totp_sealed`, `users.recovery_codes_sealed` and `oauth_states.pkce_sealed`. The master-key
rotation re-seals every one of them (section 6.2).

The associated data stops a ciphertext copied into another row or column from decrypting. With random
nonces a key must seal fewer than 2^32 values; the volume here is endpoint secrets, signing keys, relay
credentials, second factors and short-lived PKCE verifiers, many orders of magnitude below that.

### 7.3 Signed links

One link format serves large-attachment links ([Outbound](outbound.md)) and export downloads
([Privacy](privacy.md#9-subject-access-export)):

```text
https://{PM_API_HOST}/v1/links/{token}
token   = base64url(payload || HMAC-SHA256(link key {kid}, payload)[0..16])
payload = "l1:{kid}:att:{tenant_id}:{identity_id}:{message_id}:{attachment_id}:{expires_unix_s}"
        | "l1:{kid}:export:{tenant_id}:{export_id}:{expires_unix_s}"
kid     = the one-character kid of the link key that signed it (signing_keys, purpose link)
```

- The handler splits the token, reads the kid, looks up that link key (current, or still inside its
  verify window), recomputes the MAC and compares it in constant time, then checks the expiry and that
  the target still exists. An unknown or expired kid, a bad MAC, an expired link or a missing target all
  return `404` with the target's `*_not_found` code (`attachment_not_found` or `export_not_found`), so a
  link reveals nothing about why it failed.
- No API key is needed: the MAC authenticates the link. The response uses the serving headers of
  section 8.5. The route is `GET /v1/links/{token}` in [REST API](../../reference/api.md#signed-links-and-provider-hooks).

## 8. Untrusted content

### 8.1 What is untrusted

Everything from mail (headers, display names, subjects, bodies, filenames, attachment text, DSN text),
provider responses (`smtpResponse`, error messages), DNS answers, RDAP data and webhook endpoint
responses. Untrusted strings are stored and returned, but never used as instructions, file paths,
header values or SQL.

### 8.2 Sanitising and normalisation

The [Inbound pipeline](inbound.md) owns the details. The security properties:

- HTML is sanitised with `ammonia =4.2.1` using an allow-list: no scripts, event handlers, forms,
  frames, objects, embeds or `<meta http-equiv>`; links only `http`, `https` and `mailto`, with
  `rel="noopener noreferrer nofollow"`; images only `cid:` (remote `src` removed). The service never
  renders HTML.
- Agent-facing text (`extracted_text`, snippets, triage and planner input) has hidden text removed
  ([B11](../edge-cases.md)): zero-width and bidirectional control characters (U+200B–U+200F,
  U+202A–U+202E, U+2066–U+2069, U+FEFF), CSS-hidden and white-on-white content, tiny fonts and HTML
  comments, with the `hidden_text` flag set. Text is NFC-normalised and C0 control characters other
  than tab and newline are removed.
- Filenames are stripped of path components and control characters, capped at 255 bytes, and never
  used as storage keys (R2 keys use IDs only).
- Display names and subjects are stored as received, but CR and LF are rejected in every value the
  service writes into an outbound header (`display_name` validation, custom-header validation, subject).
- Tenant-defined reference patterns use the `regex` crate (linear time, compiled size capped at 64 KB).
- Search input is parsed into a typed tree and every term is quoted for FTS5; raw input never reaches
  `MATCH` ([F1](../edge-cases.md)).
- All SQL uses bound parameters. Building SQL text from request or mail values is forbidden;
  the native test `worker::db::no_formatted_sql` fails on `format!`-built SQL in the data-access modules
  ([Testing](testing.md#12-ci-workflows-and-required-checks)).

### 8.3 Fencing content for models

Triage and the agentic planner receive mail content only inside fences, in the format owned by
[Search › Fencing mail content](search.md#116-fencing-mail-content) and reused by
[Triage](triage.md):

```text
<<<MAIL_CONTENT nonce=K7Q2M9XWD3TJ8B5N field=subject>>>Invoice 88213 – AB12 CDE<<<END_MAIL_CONTENT nonce=K7Q2M9XWD3TJ8B5N>>>
```

- The nonce is 16 Crockford base32 characters from `platform::Rng`, new for every model call or run.
  `core::injection::fence` escapes each untrusted string first: control characters removed, runs of
  three or more `<` or `>` replaced so content can never form a marker, and any occurrence of the nonce
  replaced.
- Service-generated facts (IDs, verdicts, counts) are outside the fences; every string from mail
  (display names, addresses, subjects, bodies, filenames, attachment text) is inside one.
- The system prompt states that fenced text is data from third parties, that instructions inside it
  must be ignored, and that only the listed tools exist.
- Tool results returned to the planner (snippets, thread reads, attachment text) are fenced the same
  way.
- Model output is never trusted: triage output is validated against its JSON schema and recorded as
  `failed` when invalid (FR-TRI-4); planner tool calls are validated against the tool schemas (no
  additional properties, so a call cannot add scope fields) and the scope clamp (section 5.4); answer
  sentences pass the deterministic citation verifier (FR-SRCH-8). No model output is executed, rendered
  or used to choose a recipient.
- `core::injection::scan` heuristics plus the model set `prompt_injection_suspected`
  ([E1](../edge-cases.md)).

### 8.4 No remote fetch

The service never fetches a URL found in mail: no link previews, no image proxy, no automatic
`List-Unsubscribe` calls for inbound mail, no fetching of verification links (they are returned by
`wait`, never followed). Sends accept attachment content only as `content_base64`; there is no
"attach from URL". `POST /v1/identities/{identity_id}/http-signatures` signs a URL the caller names and
returns headers; the Worker never requests that URL, so it is not an SSRF path
([Agent signing keys §5.1](agent-keys.md#51-request)).

### 8.5 Serving attachments and raw MIME

`GET …/attachments/{attachment_id}` and `GET …/messages/{message_id}/raw` respond with:

| Header | Value |
|---|---|
| `Content-Type` | The sniffed type if it is one of `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `text/plain`, `text/csv` or an Office Open XML type; otherwise `application/octet-stream`. Raw MIME: `message/rfc822` |
| `Content-Disposition` | `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded sanitised name>` |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `sandbox` |
| `Cache-Control` | `private, no-store` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Referrer-Policy` | `no-referrer` |

Every API response also carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
`Strict-Transport-Security: max-age=31536000`; authenticated responses carry `Cache-Control: no-store`.
The API and `/mcp` emit no CORS headers in v1.0: browser code cannot call them cross-origin, and keys
must never be placed in browser code. The API sets and reads no cookies, so CSRF does not apply to it;
when `PM_CONSOLE_HOST` differs from `PM_API_HOST`, no cookie is set or read on the API host at all
(section 4.9). The console's own headers and CSRF rules are in [Console › CSRF](console.md#csrf).

## 9. SSRF controls

This section is the single definition of the SSRF guard (FR-WH-5). `core::ssrf` decides (pure functions
over the URL and the resolved addresses); `worker::net::GuardedHttp` (`crates/worker/src/net.rs`)
enforces, resolving through `platform::Dns` and sending through `platform::HttpClient` (the `platform`
crate holds no business rules). One guard serves every request to a host that is not a fixed Cloudflare
or AWS API host: webhook deliveries and test deliveries ([Webhooks](webhooks.md#http-client-and-ssrf-rules)),
the scanner hook in [Inbound](inbound.md), and SMTP relay connections for `smtp_relay` domains
(section 9.3).

### 9.1 URL rules (at create, update and every attempt)

1. Scheme `https` only. No userinfo, no fragment, length at most 2,048 bytes.
2. The host must be a DNS name of at least two labels. IP literals in any notation are refused: dotted
   IPv4, bracketed IPv6, and integer, hexadecimal or octal IPv4 forms such as `2130706433`,
   `0x7f000001` and `0177.0.0.1`.
3. Refused names: `localhost` and any name under the suffixes `localhost`, `local`, `internal`,
   `invalid`, `test`, `example`, `onion`, `home.arpa` and `arpa`; the API host `PM_API_HOST` and the
   console host `PM_CONSOLE_HOST`; the platform domain `PM_PLATFORM_DOMAIN` and every name under it. Only the reserved top-level name
   `example` is refused: second-level names such as `hooks.example.com` are allowed, so tests and
   documentation can use RFC 2606 names.
4. The port is absent, 443, or 1024 to 65535.
5. Resolve A and AAAA through the configured DoH resolvers (first resolver, then the second on error).
   Refuse if no address is returned, or if **any** returned address is in a blocked range:

   ```text
   IPv4  0.0.0.0/8  10.0.0.0/8  100.64.0.0/10  127.0.0.0/8  169.254.0.0/16  172.16.0.0/12
         192.0.0.0/24  192.0.2.0/24  192.88.99.0/24  192.168.0.0/16  198.18.0.0/15
         198.51.100.0/24  203.0.113.0/24  224.0.0.0/4  240.0.0.0/4 (includes 255.255.255.255)
   IPv6  ::/128  ::1/128  ::ffff:0:0/96 (check the embedded IPv4)
         64:ff9b::/96 and 64:ff9b:1::/48 (NAT64: check the embedded IPv4)
         100::/64  2001::/23  2001:db8::/32  2002::/16 (6to4: check the embedded IPv4)
         3fff::/20  5f00::/16  fc00::/7  fe80::/10  fec0::/10  ff00::/8
   ```

   The table follows the IANA IPv4 and IPv6 special-purpose address registries; re-check it against the
   registries at build time.

Webhook create and update fail with `400 invalid_request` (`details.errors[].path = "url"`) when a rule
fails. At delivery time a failure is recorded as a failed attempt with error `ssrf_blocked`.

### 9.2 Request rules

- `redirect: manual`; any `3xx` is a failure and is never followed (FR-WH-5).
- Per-attempt deadline 15 s for webhooks (through `AbortController`); at most 4 KB of the response body is
  read, then the stream is cancelled.
- No cookies, no forwarding of any inbound header, a fixed `User-Agent`.
- Resolution runs before every attempt, with no cache shared between attempts. The guard cannot pin the
  address that the runtime's `fetch` resolves, so a DNS-rebinding race remains possible; its reach is
  limited to addresses routable from Cloudflare's edge, because the Worker has no Tunnel, VPC or service
  binding to private networks. This residual risk is accepted and recorded in the threat model
  (section 3.4).

### 9.3 Other outbound destinations

| Destination | Rules |
|---|---|
| `PM_SCANNER_URL` (P1 malware scanner) | Deployer-configured; validated at isolate start with section 9.1; same request rules with the timeout defined in [Inbound](inbound.md#attachment-safety); attachment bytes sent only when configured |
| `PM_DOH_RESOLVERS` | Exactly two distinct `https` URLs from configuration; validated at isolate start; queries carry only DNS names |
| SMTP relay `smtp.host` (`smtp_relay` domains) | A DNS name, never an IP literal. Rules 2, 3 and 5 of section 9.1 at domain create, at `PATCH` with `smtp`, and before every connection (send or probe); rule 1 does not apply, and rule 4 is replaced by "port `465` or `587` only" (`400 smtp_port_not_allowed`). TLS before `AUTH`; certificate host name checked by the runtime (spike S12). Timeouts: 10 s to connect, 30 s per command, 60 s for the reply to the final `.`. Cloudflare blocks outbound sockets to port `25` and to Cloudflare IP ranges ([TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), read 2026-10-09). The rebinding residual of section 9.2 applies: `connect()` resolves the name itself ([Domains on any DNS host §5](domain-connections.md#5-smtp_relay-the-customers-own-sending-provider)) |
| SNS `SigningCertURL` and `SubscribeURL` | `https`, host exactly `sns.{PM_SES_REGION}.amazonaws.com`, certificate cached for 24 h by URL |
| RDAP | `https` only, servers taken from the IANA bootstrap file; at most one redirect, to another bootstrap-listed `https` host; response ≤ 256 KB; 10 s |
| Cloudflare and AWS APIs | Fixed hosts compiled into `platform` (`api.cloudflare.com`, `email.{PM_SES_REGION}.amazonaws.com`), the inbound bucket host `{PM_SES_INBOUND_BUCKET}.s3.{PM_SES_REGION}.amazonaws.com`, and the host of `PM_SES_INBOUND_QUEUE_URL`, which is validated at isolate start to be `https` under `amazonaws.com` |
| Google and GitHub (console sign-in) | Fixed provider endpoints compiled in, re-read from the providers' documentation when M24 is built ([Cloud sign-up §4](cloud-signup.md#4-google-and-github)); `https` only; no redirects followed |

## 10. Rate limiting and abuse

| Control | Limit | Mechanism | Error |
|---|---|---|---|
| Requests per key | 600 / 60 s | `RL_API`, keyed by key ID | `429 rate_limited` |
| Failed authentications | 600 / 60 s per client | `RL_API`, keyed by `anon:` + HMAC(`PM_HASH_KEY`, `CF-Connecting-IP`) truncated to 16 hex; the IP is never logged | `429 rate_limited` |
| Search per key | 120 / 60 s | `RL_SEARCH` | `429 rate_limited` |
| Agentic search | 20 / 60 s per key; tenant daily cap (default 500) | `RL_AGENTIC`; exact count in `TenantQuota` | `429 rate_limited`, `429 agentic_budget_exhausted` |
| Sends per identity | 120 / 60 s; daily caps from policy | `RL_SEND`; exact daily counters in `TenantQuota` | `429 rate_limited`, `429 daily_cap_reached` |
| Signing per identity (agent assertions and HTTP signatures together) | 600 / 60 s | `RL_SIGN`, keyed by identity ID. Signing is not metered against any plan allowance | `429 rate_limited` |
| Notification emails | 50 per person and 200 per workspace a day, every kind except `account` | The tenant's `Notifier` (`sent` counters, [Notifications §3](notifications.md#3-how-notifications-are-produced)) | Not an error: the overflow goes into the next daily digest ([O24](../edge-cases.md)) |
| Inbound per sender per identity | `inbound.per_sender_per_hour` (default 60) | Mailbox `rate_windows` ([D5](../edge-cases.md)) | Excess stored `throttled` |
| Failed thread-token verifications | 10 per sender per hour, 100 per mailbox per hour | Mailbox `rate_windows` ([Threading](threading.md), [D10](../edge-cases.md)) | Tokens not verified for the rest of the window |
| Domain verification | 1 per minute per domain | `DomainMonitor` | `429 rate_limited` |
| Alignment probe (`smtp_relay`) | 1 per minute per domain | `DomainMonitor` | `429 rate_limited` |
| Console sign-in link or code requests | 3 per 10 minutes per address | `login_tokens` rows ([Console › Sign-in](console.md#sign-in)) | "Too many requests" page, the same for known and unknown addresses |
| Sign-in code attempts | 10 per code; the token is burned after 10 failures | `login_tokens.attempts` | Code refused |
| Console sign-in, sign-up and waitlist requests per client IP | 10 / 60 s on `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-up` and `/console/waitlist` | `RL_SIGNIN`, keyed by `CF-Connecting-IP`; the IP is never logged | `429` page |
| Two-step verification codes | 5 attempts a minute per person; 10 failures in a row lock two-step sign-in for 15 minutes | A per-person failure counter ([Cloud sign-up §5](cloud-signup.md#5-two-step-verification)) | Code refused; lock page |
| Sends from a new Free workspace | `tenant_daily_send_cap` 50 for the first 7 days; lifts on day 7 if bounce and complaint rates are under the auto-pause thresholds, or at once on a paid plan | `TenantQuota` ([W30](../edge-cases.md)) | `429 daily_cap_reached` |

- The rate-limiting bindings are approximate and per location. Anything that must be exact (daily send
  caps, the agentic budget, abuse windows) is counted in `TenantQuota`.
- **Abuse auto-pause** (FR-DLV-3): `TenantQuota.outcomes` keeps the last 1,000 outcomes per identity.
  When the complaint rate over the last 1,000 exceeds `abuse.complaint_rate_pause` (default 0.003), or
  the bounce rate over the last 200 exceeds `abuse.bounce_rate_pause` (default 0.05), the identity is
  paused with reason `abuse_threshold` and `identity.paused` is emitted with the metrics.
- **Kill switches.** Revoke a key (`DELETE /v1/keys/{id}`, immediate). Pause an identity
  (`PATCH … {"status": "paused"}`): besides stopping its sends, this stops it signing at once
  (`409 identity_paused`) and withdraws its JWKS (`404 identity_not_found`), so verifiers stop accepting
  its assertions within the 5-minute JWKS cache (FR-IDN-9, [O1](../edge-cases.md)). Revoke one identity
  key (`POST /v1/identities/{identity_id}/keys/{kid}/revoke`) to withdraw that key alone. Suspend a
  tenant (`PATCH /v1/tenants/{id} {"status": "suspended"}`): every send is refused at once, inbound gets
  a temporary failure, and every identity of the tenant is paused, so the same signing stop applies.
  Stop signed HTTP requests for the whole deployment with `PM_WEB_BOT_AUTH=off`. For a platform-wide
  stop, suspend every tenant or roll back the Worker version with `npx --yes wrangler@4.139.0 rollback`.
- **Platform domain reputation.** Per-identity caps, complaint and bounce auto-pause, a DMARC policy
  ramped from `p=none` to `p=reject` on the platform domain, and custom domains encouraged (PRD risk
  table).

## 11. Supply chain

| Control | Rule |
|---|---|
| Exact pins | Every Cargo dependency is pinned `=x.y.z` (AGENTS.md); `Cargo.lock` is committed; every build and install uses `--locked`. `rust-toolchain.toml` pins the toolchain. The CLI invokes `npx --yes wrangler@4.139.0`, never an unpinned wrangler |
| `cargo deny check` | In CI on every pull request: advisories, licences (allow-list: Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, Unicode-3.0, MPL-2.0; everything else needs an ADR), bans (no `openssl-sys`, no `tokio` in the wasm dependency graph, no duplicate versions of `sha2`, `hmac` or `aes-gcm`), sources (crates.io only, no git dependencies) |
| `cargo audit` | RustSec advisories on every pull request and daily on `main`; a new advisory opens an issue |
| SBOM | `cargo cyclonedx --format json` for the Worker (`--target wasm32-unknown-unknown`) and for the CLI, attached to every release |
| Signed releases | `SHA256SUMS` lists the Worker bundle and CLI binaries and has a detached signature `SHA256SUMS.sig` made with the release signing key ([Rust workspace](rust-workspace.md#9-xtask)). The verification key is compiled into `pmail`, which checks the signature and the bundle checksum before deploying (FR-OPS-2; signature format and verification in [CLI and setup](cli.md)). The signing key lives only in a GitHub Environment with required reviewers. Releases also carry build provenance from `actions/attest@v4` (permissions `id-token: write`, `attestations: write`, `contents: read`), verifiable with `gh attestation verify <file> -R PILOTAAI/pylota-mail` |
| CodeQL | CodeQL for Rust (supported for editions 2021 and 2024, per codeql.github.com, read 2026-10-09) on pull requests and weekly; open high-severity alerts block a release |
| Renovate | Cargo and GitHub Actions managers; exact pins kept; weekly grouped pull requests; `worker` and `worker-build` upgrades are never grouped and must pass spike S1's smoke checks plus the full integration suite; security updates raised immediately; nothing auto-merges |
| GitHub Actions | Actions pinned to full commit SHAs; `permissions:` least privilege per job; no `pull_request_target` workflow checks out pull-request code; secrets only in protected environments |
| Secret scanning | GitHub secret scanning with push protection on the repository |
| Bundle hygiene | `cargo xtask build-worker` refuses the `itest-hooks` feature and fails if the bundle contains the string `/__test/`; the size budget (NFR-SEC-2) is checked on every build |

## 12. Logging rules

[Observability](observability.md#2-structured-logs) defines the schema. The security rules:

- **Never logged:** message bodies, subjects, attachment content, filenames, display names, clear-text
  email addresses, raw URLs or query strings (they can contain addresses, for example
  `/v1/identities/lookup?address=…`), search queries, verification codes or links, IP addresses,
  `Authorization` headers, API key strings, webhook secrets, signed-link tokens, provider `smtpResponse`
  text, DNS TXT values, SMTP relay credentials and relay reply text, SNS message bodies (an SES inbound
  notification carries the message's headers), OAuth codes, `state` and tokens, TOTP and recovery codes,
  cookie values, private keys and seeds, minted agent assertions, their `audience`, `nonce` and `ext`,
  the URL and headers of a signed HTTP request (`Signature`, `Signature-Input`, `From`), notification
  unsubscribe tokens and the bodies of notification emails.
- **Logged instead:** IDs (`ten_`, `idn_`, `msg_`, `key_` …), the matched route pattern, error codes,
  SMTP status codes, counts, sizes, durations, and pseudonyms.
- **Pseudonyms:** `ph_` + the first 16 hex characters of `HMAC-SHA256(PM_HASH_KEY, normalised address)`
  (the same HMAC as `address_tombstones` and `suppressions`, truncated). Search queries are logged only
  as `query_hash = hex(HMAC-SHA256(PM_HASH_KEY, q))[..16]`, as in [MCP](mcp.md).
- **By construction:** `worker::log` accepts only typed fields (IDs, codes, counts, durations,
  pseudonyms, and a `detail` string matching `^[a-z0-9_.:-]{1,64}$`). There is no free-text field.
- **Panics:** the platform installs a panic hook that logs `event = "panic"` with the source location
  only, never the panic payload, which could contain content.
- **Cloudflare invocation logs** record the request URL and, for the email handler, the recipient
  address. The generated `wrangler.toml` therefore sets `invocation_logs = false`, and Workers traces
  are disabled in production ([Observability](observability.md#1-signals)).
- **Audit log** `details_json` never contains message content or clear addresses (data model).

The log-scrubbing test [I5](../edge-cases.md) plants canary strings in every content field and every
address used by the integration suite, captures all Worker output, and fails if any canary appears.

## 13. Tests

| Test | Proves | Covers |
|---|---|---|
| `core::keys::format_round_trip` (property) | Generated keys match the regex; parsing rejects every other shape; lookup and secret alphabets exclude `i l o u` | FR-KEY-2 |
| `it::auth::unknown_key_uniform` | Unknown lookup, wrong secret and expired overlap return byte-identical `401 unauthenticated` bodies (except `request_id`) | FR-KEY-2, SEC-1 |
| `it::auth::status_after_secret_match` | `key_revoked` / `key_expired` appear only when the secret matches | FR-KEY-2 |
| `it::auth::rotation_overlap` | Both secrets work during the overlap; only the new one after; overlap 0 cuts over at once; a second rotation keeps at most two | FR-KEY-2 |
| `it::auth::last_used_throttle` | Twenty requests within a minute produce one `last_used_at` write | data model |
| `it::auth::rate_limited` | `429 rate_limited` with `Retry-After`, including the 601st signing call in a minute for one identity (`RL_SIGN`); failed authentications are limited per client without logging the IP | section 10 |
| `it::keys::scope_exceeded` | Every row of the scope table in section 4.6 (step 3), plus permissions wider than the caller's → `403 key_scope_exceeded` | FR-KEY-1, SEC-2 |
| `it::keys::permission_level_rules` | Section 4.6, steps 1 and 2: `permissions` missing or empty (every level, `platform` included) → `400 invalid_request`; `identities:sign` on a platform key, a tenant-only permission on an identity key, and `tenants:manage` or `platform:ops` on a tenant or identity key → `400 invalid_request` with `details.reason = "permission_not_allowed_for_level"`, even from a caller that holds the permission; a tenant or identity key holds `usage:read` implicitly and reads its own `GET /v1/usage`; a platform key needs `usage:read` listed and `tenant_id` passed | FR-KEY-1, SEC-2 |
| `it::messages::list_hides_review_statuses` | A message list never shows `quarantined`, `hidden` or `throttled` mail without a `status` filter, also to a key holding `quarantine:review`; with the filter, only a key holding `quarantine:review` sees them, and any other key gets `200` without them; a thread list never shows them | section 5.3, FR-IN-5 |
| `it::keys::j6_revoke_rotate` | Revocation is immediate; rotation overlaps; audit rows name the actor | [J6](../edge-cases.md) |
| `it::security::cross_tenant_matrix` | Section 5 matrix: every route × every foreign key class → `*_not_found` or `scope_denied`, identical to a missing ID, no side effects; REST and MCP | NFR-SEC-1, FR-KEY-3, FR-TEN-1 |
| `it::security::route_table_complete` | Every entry of `GET /__test/routes` appears in the matrix; every route has a permission and scope | SEC-1 |
| `it::security::body_scope_ignored` | `tenant_id` / `identity_id` / `identity_ids` naming another scope in bodies and queries never widen access | FR-KEY-3 |
| `it::security::rpc_owner_mismatch` | A forged envelope (test hook) is refused with `internal_error`, logs `rpc_owner_mismatch`, increments the metric | SEC-1 |
| `it::search::f3_tenant_scope_denied` | Identity key on tenant search → `403 scope_denied` | [F3](../edge-cases.md) |
| `it::security::search_canary_isolation` | A canary term in tenant B's mail is never returned to tenant A in keyword, semantic, hybrid or agentic mode | NFR-SEC-1 |
| `it::security::vector_foreign_id_dropped` | A fake Vectorize result containing another tenant's vector ID is dropped by the mailbox read-back | NFR-SEC-1 |
| `it::security::mcp_requires_key`, `it::security::mcp_tools_follow_key` | No key, no MCP; tools listed and callable only with their permission | FR-MCP-1 |
| `core::ssrf::refuses_private_ranges` (with a property test over each range) | Every address in each blocked range (including mapped and embedded IPv4) is refused; public addresses pass | FR-WH-5 |
| `core::ssrf::url_rules` | Section 9.1 rules 1 to 4, including integer, hexadecimal and octal IPv4 literals and `hooks.example.com` allowed | FR-WH-5 |
| `it::webhooks::ssrf_refused`, `it::webhooks::no_redirects_and_caps` | Guard at create and at delivery; `3xx` is a failure and is not followed; 15 s deadline; bodies over 4 KB are cut | FR-WH-5 |
| `it::webhooks::signature_vectors` | Signatures match Standard Webhooks test vectors; both signatures during rotation | FR-WH-2 |
| `core::sns::verify_v2_vectors`, `it::ses::sns_tampered_rejected` | Real version 2 notifications verify; version 1, a changed byte, a wrong certificate host, a wrong topic and a stale timestamp are refused with `403 invalid_signature`, on both `/hooks/ses` and `/hooks/ses/inbound` ([Outbound](outbound.md), [Domains on any DNS host](domain-connections.md#14-tests)) | spike S8, [N1](../edge-cases.md), [N2](../edge-cases.md) |
| `it::ses::push_and_backstop_once`, `it::ses::cross_tenant_recipients`, `it::ses::verdict_mapping` | One message per object and recipient whichever path delivers it; no leakage between tenants in one object; SES verdicts used only as section 3.5 states | FR-DOM-9, [N3](../edge-cases.md), [N28](../edge-cases.md) |
| `core::smtp::state_machine`, `it::smtp::probe_unaligned_falls_back` | No credentials without TLS; `535` is an auth failure; an unaligned relay goes to `failing` and sends fall back | FR-DOM-11, SEC-4, [N14](../edge-cases.md), [N16](../edge-cases.md), [N18](../edge-cases.md) |
| `it::oauth::state_cookie_binding`, `it::oauth::unverified_email_refused`, `it::oauth::link_by_verified_email` | Missing, reused, expired or other-browser state refused; unverified addresses refused; linking only by verified email | FR-CON-9, [W20](../edge-cases.md)–[W22](../edge-cases.md) |
| `core::totp::rfc6238_vectors`, `it::totp::workspace_requirement`, `it::totp::recovery_code_single_use` | RFC 6238 vectors, drift, replay refused; attempt limits and lock; the workspace requirement; recovery code works once | FR-CON-10, [W27](../edge-cases.md), [W28](../edge-cases.md) |
| `it::hosts::console_api_split` | With two hosts, console paths `404` on the API host and API paths `404` on the console host; no `Set-Cookie` on the API host | section 4.9 |
| `core::injection::e1_*` (includes a fence property test) | No content, including content containing the nonce or marker-like runs, can close a fence | SEC-5, [E1](../edge-cases.md) |
| `it::ai::gateway_options_no_log` | With `PM_AI_GATEWAY` set, content-bearing model calls disable log collection and caching | section 3.5 |
| `it::attachments::serving_headers` | Section 8.5 headers on attachments and raw MIME; `text/html` and SVG served as `application/octet-stream` | [B10](../edge-cases.md) |
| `it::security::response_headers` | Global headers present; no CORS headers; no `Set-Cookie` | section 8.5 |
| `core::crypto::envelope_round_trip` | Seal/open round trip; wrong AAD, wrong key or flipped bit fails | SEC-3 |
| `it::secrets::master_key_rotation` | With `PM_MASTER_KEY_NEXT` set, old and new ciphertexts open, new ones use the new kid, the sweep re-seals every sealed column of section 7.2, including `signing_keys` (the `web_bot_auth` seed too), `identity_keys`, `domains.smtp_sealed` and the `users` second factors | section 6.2 |
| `it::secrets::rotate_master_reseals_identity_keys` | Assertions signed before and after a master-key rotation verify with the same public key and kid | [O8](../edge-cases.md) |
| `core::jwk::thumbprint_rfc8037_vector`, `core::jwt::eddsa_rfc8037_vector`, `core::httpsig::signature_base_rfc9421` | The RFC 8037 thumbprint and signing vectors; RFC 9421 signature bases, an IDN host as its A-label, non-ASCII components refused | section 7.1, [O10](../edge-cases.md) |
| `it::assertions::sdk_verifies` | The SDK verifier accepts a fresh assertion and rejects a wrong audience, an expired token, an unknown kid and `alg: none` | section 3.8 |
| `it::identity_keys::paused_withdraws_jwks`, `it::identity_keys::revoke_removes_from_jwks`, `it::assertions::erasure_tombstones_kid` | Kill switch: a paused identity gets `409` on signing and `404` on its JWKS; a revoked key leaves the JWKS at once; an erased identity's kid is never published again | FR-IDN-9, [O1](../edge-cases.md), [O3](../edge-cases.md), [O7](../edge-cases.md) |
| `it::http_signatures::disabled_and_policy`, `it::well_known::directory_signed_per_key` | `PM_WEB_BOT_AUTH=off` → `422`; a tenant not opted in → `403 policy_denied`; the directory carries one signature per listed key | [O9](../edge-cases.md), [O12](../edge-cases.md), [O13](../edge-cases.md) |
| `it::notify::one_click_unsubscribe`, `core::notify::no_content_in_body` | An unsubscribe token turns off exactly one kind for one person and workspace, with no session, CSRF token or `Origin`; an altered, foreign or expired token changes nothing; a rendered notification holds no content from the source message | section 3.7, [O18](../edge-cases.md) |
| `it::secrets::signing_key_rotation` | For `thread`, `link` and `cursor`: after `POST /v1/platform/keys/{purpose}/rotate`, new tokens, links and cursors carry the new kid; old ones verify until `verify_until` and fail after it; with `?revoke_previous=true` they fail at once and the response has `previous.revoked: true`; the response holds no key material; the 33rd rotation inside the window retires the oldest kid | section 6.2, [Threading](threading.md#24-key-rotation) |
| `cli::setup::bootstrap_key` ([CLI and setup](cli.md)) | The bootstrap key authenticates and expires after 24 hours; a re-run with keys present refuses without `--rotate-pepper` | section 4.8 |
| `it::security::well_known_security_txt` | `security.txt` fields and the 404 when `PM_SECURITY_CONTACT` is unset | section 14 |
| `it::logs::i5_no_content_in_logs` | No canary content or address appears in captured output | [I5](../edge-cases.md), FR-PRV-6 |
| `worker::db::no_formatted_sql`, `cargo xtask check-layering`, `cargo xtask build-worker` | No `format!`-built SQL in data-access code; no `worker` import outside `platform`; release bundle without `/__test/` or `itest-hooks` | sections 8.2, 11 |

## 14. security.txt

`GET /.well-known/security.txt` (RFC 9116), served when `PM_SECURITY_CONTACT` is set, `404` otherwise:

```text
Contact: mailto:security@example.com
Expires: 2027-10-09T00:00:00Z
Preferred-Languages: en
Canonical: https://mail.example.com/.well-known/security.txt
Policy: https://github.com/PILOTAAI/pylota-mail/security/policy
```

- `Contact` is `PM_SECURITY_CONTACT`, prefixed with `mailto:` when it is a bare address.
- `Expires` is the release build date plus 365 days, compiled into the bundle. `pmail doctor` warns
  within 30 days of it; an expired file is a correct signal that the deployment is stale.
- `Canonical` uses `PM_API_HOST`. `Policy` points to the upstream project's policy for flaws in the
  software; the `Contact` is the deployment's own operator.

## 15. Vulnerability handling

[SECURITY.md](https://github.com/PILOTAAI/pylota-mail/blob/main/SECURITY.md) is the policy: private
reporting through GitHub, acknowledgement within 3 working days, a fix and disclosure date agreed with
the reporter, and fixes for the latest release only until 1.0. The process behind it:

1. Triage in a private GitHub security advisory; reproduce against a local workerd or staging.
2. Fix in the advisory's private fork with a regression test (`it::security::*` or the relevant edge
   test).
3. Request a CVE through the advisory when the impact warrants it.
4. Release a patch with signed artefacts; publish the advisory and release notes that tell deployers
   what to run (`pmail upgrade`) and whether any key or secret rotation is needed.

## 16. Pre-release checklist

Before v1.0 (PRD release criterion 5) and before every minor release:

- [ ] This threat model reviewed against the code; every finding rated high fixed.
- [ ] An external penetration test completed before v1.0, findings rated high fixed and retested.
- [ ] `it::security::cross_tenant_matrix` and `it::security::route_table_complete` green (NFR-SEC-1 = 0).
- [ ] Every fuzz target clean for 24 cumulative hours on the release commit.
- [ ] `cargo deny check`, `cargo audit` and CodeQL clean (no open high-severity finding).
- [ ] SBOM, signed `SHA256SUMS` and attestations produced; a fresh-account `pmail deploy` rehearsal
      verified them (PRD release criterion 6).
- [ ] Secret rotation procedures in section 6.2 rehearsed on staging.
- [ ] `it::logs::i5_no_content_in_logs` green; the generated `wrangler.toml` has
      `invocation_logs = false` and traces disabled for production.
- [ ] Email preview disabled on every sending domain ([Privacy](privacy.md#3-jurisdiction-and-residency)).
- [ ] `security.txt` served on staging; `SECURITY.md` current.
- [ ] Signing-key rotation (`thread`, `link` and `cursor`) rehearsed on staging; old tokens verify until
      `verify_until`, and stop at once with `revoke_previous=true`.
- [ ] Identity-key rotation and revocation rehearsed on staging: a revoked key leaves the JWKS, and
      pausing an identity withdraws its JWKS. `PM_WEB_BOT_AUTH` is `on` only where spike S13 passed.
- [ ] With SES configured: both SNS topics have `SignatureVersion=2`, the inbound bucket blocks public
      access, and the IAM policy matches [Domains on any DNS host §4.2](domain-connections.md#42-deployment-set-up-for-ses).
- [ ] Release bundle checked for `/__test/` and the `itest-hooks` feature.
