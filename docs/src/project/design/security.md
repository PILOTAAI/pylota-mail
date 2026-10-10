# Security

Binding for implementation. This page is the threat model and the security rules every other design
must respect: authentication, authorisation, tenant isolation, secrets, cryptography, untrusted content,
SSRF, abuse controls, the supply chain and logging. Where another design owns a mechanism (for example
the thread token in [Threading](threading.md)), this page states the security property and links to it.

| | |
|---|---|
| Requirements | FR-KEY-1, FR-KEY-2, FR-KEY-3, FR-KEY-4, FR-KEY-5, FR-TEN-1, FR-TEN-2, FR-TEN-3, FR-TEN-4, FR-IDN-10, FR-IN-4, FR-IN-5, FR-IN-9, FR-IDN-6, FR-IDN-7, FR-IDN-8, FR-IDN-9, FR-WH-2, FR-WH-5, FR-TRI-3, FR-TRI-4, FR-SRCH-3, FR-SRCH-8, FR-SRCH-10, FR-MCP-1, FR-PRV-6, FR-DOM-9, FR-DOM-11, FR-CON-3, FR-CON-9, FR-CON-10, FR-CON-13, FR-CON-14, NFR-SEC-1, NFR-SEC-2 |
| Edge cases | [A2](../edge-cases.md), [A4](../edge-cases.md), [A6](../edge-cases.md), [B7](../edge-cases.md), [B10](../edge-cases.md), [B11](../edge-cases.md), [D2](../edge-cases.md), [D5](../edge-cases.md), [D9](../edge-cases.md), [D10](../edge-cases.md), [E1](../edge-cases.md), [E2](../edge-cases.md), [F1](../edge-cases.md), [F3](../edge-cases.md), [F7](../edge-cases.md), [F10](../edge-cases.md), [I5](../edge-cases.md), [J6](../edge-cases.md), [J10](../edge-cases.md)–[J16](../edge-cases.md), [J23](../edge-cases.md)–[J27](../edge-cases.md), [E9](../edge-cases.md)–[E14](../edge-cases.md), [J20](../edge-cases.md), [J22](../edge-cases.md), [L4](../edge-cases.md), [W15](../edge-cases.md)–[W18](../edge-cases.md), [W20](../edge-cases.md)–[W22](../edge-cases.md), [W27](../edge-cases.md), [W28](../edge-cases.md), [W31](../edge-cases.md), [W35](../edge-cases.md), [W36](../edge-cases.md), [N1](../edge-cases.md)–[N3](../edge-cases.md), [N14](../edge-cases.md), [N16](../edge-cases.md), [N18](../edge-cases.md), [N28](../edge-cases.md), [O1](../edge-cases.md), [O3](../edge-cases.md), [O7](../edge-cases.md), [O8](../edge-cases.md), [O12](../edge-cases.md), [O13](../edge-cases.md), [O15](../edge-cases.md), [O18](../edge-cases.md), [O24](../edge-cases.md), [O27](../edge-cases.md) |
| Code | `crates/worker/src/auth/` (keys, router table, scope), `crates/core/src/ssrf.rs`, `crates/core/src/injection.rs`, `crates/core/src/sanitize.rs`, `crates/core/src/crypto.rs` (sealing, pure; nonces passed in), `crates/core/src/sealed.rs` (the sealed-column registry, pure), `crates/worker/src/ops/reseal.rs` (the master-key re-seal sweep), `crates/core/src/{jwk.rs, jwt.rs, httpsig.rs}` (agent signing, pure), `crates/worker/src/net.rs` (guarded HTTP), `crates/worker/src/log.rs` |
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
| SEC-1 | Partner, tenant and identity scope come only from the authenticated key, never from the request body, query or path (FR-KEY-3). A key reaches nothing outside its scope (a partner key reaches only the tenants its partner's keys created, FR-KEY-4), and an out-of-scope resource is indistinguishable from a missing one (NFR-SEC-1) |
| SEC-2 | A key never creates, reads, rotates or revokes a key wider than itself in level, scope or permissions (FR-KEY-1). The one exception: a platform or partner key may grant `identities:sign`, which it cannot hold, to a tenant or identity key it mints (section 4.6) |
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
| R | A key holder denies an administrative action | `audit_log` row with `actor_key_id` and `request_id` for every key, identity-key (`identity_key.*`), partner (`partner.create`, `partner.update`, `partner.delete`), tenant (`tenant.create`, with the `partner_id` when a partner key created it; `tenant.policy_update` for every policy write), service-account (`account.request`, `account.approve`, `account.reject`, `account.close`, `account.delete`), identity-status, quarantine, hold, suppression-removal, erasure, resolve and platform-operation action (signing-key rotation, `web_bot_auth` included, transport change, jobs, redrive); `GET /v1/audit-events?actor_key_id=` lists one key's actions; every request log line carries `key_id`. Sends are not audit rows: the message, its events and the delivery log record them. Signing calls are not audit rows either: each is logged as `signature_minted` with `key_id` and `identity_id` and counted in `usage_daily` ([Observability §2.2](observability.md#22-event-names)) | `it::keys::j6_revoke_rotate` |
| I | Reading another tenant's or identity's data (IDOR) | Section 5: scope check against D1 before any Durable Object call, owner re-check inside the object, `*_not_found` for out-of-scope IDs | `it::security::cross_tenant_matrix` |
| I/E | A partner key reaching a tenant another partner created, a tenant no partner created, or another partner's endpoints and keys | The owner check compares the target tenant's `partner_id` with the key's (section 5.2, step 4); a mismatch is the same `*_not_found` as a missing ID ([J10](../edge-cases.md)). Partner keys mint only tenant and identity keys of their own tenants (section 4.6, [J11](../edge-cases.md)), and partner endpoints receive only their partner's tenants' events ([J15](../edge-cases.md)) | `it::security::cross_tenant_matrix` (`foreign_partner`), `it::partners::j10_foreign_partner_not_found`, `it::keys::j11_partner_key_limits`, `it::webhooks::j15_partner_scope_filter` |
| I | Quarantined, hidden or throttled mail reaching agents | Filtered inside the mailbox query layer: lists show it only for an explicit `status` filter from a key holding `quarantine:review`, and search never shows hidden or throttled mail and shows quarantined mail only with `include_quarantined` and `quarantine:review` (section 5.3, FR-IN-5, [F7](../edge-cases.md)) | `it::messages::list_hides_review_statuses`, `it::search::f7_quarantine_hidden` |
| E | A key signing as an identity it should not, or a platform or partner key signing at all | `identities:sign` is held only by tenant keys and by identity keys for their own identity; a platform or partner key cannot hold it, though it may grant it to a tenant or identity key it mints, audit-logged (section 4.6); the identity path is scope-checked like every route (section 5.2) | `it::keys::permission_level_rules`, `it::keys::j11_partner_key_limits`, `it::security::cross_tenant_matrix` |
| D | Request floods, expensive searches | Rate-limit bindings per key and per identity, exact daily caps in `TenantQuota`, 7 MiB body cap, search and fan-out caps (section 10) | `it::auth::rate_limited`, `it::search::f8_budget` |
| D | Many keys of one tenant or partner multiplying the request rate | `RL_TENANT` per tenant and `RL_PARTNER_API` per partner on top of the per-key bucket, and at most 100 active tenant and identity keys per tenant and 10 partner keys per partner (`422 key_limit_reached`; section 4.6, section 10, [J22](../edge-cases.md)) | `it::auth::j22_tenant_aggregate_limits` |
| E | Minting a wider key, or reading, rotating or revoking one (a rotation returns the new secret) | Section 4.6: the subset rule for new keys and the reach and not-wider checks for existing ones, `403 key_scope_exceeded` ([J20](../edge-cases.md)) | `it::keys::scope_exceeded` |
| E | A workspace admin, or a key an admin created, deleting the workspace through a tenant-scope erasure | Tenant-scope erasure also needs `tenants:erase`, which a tenant key holds only when the workspace owner's console session minted it (or a key descended from one); admins never hold it (section 4.6, [W35](../edge-cases.md)) | `it::keys::w35_tenant_erase_owner_only`, `it::console::w18_role_and_scope` |
| R/E | Keys a removed or demoted member created keep working, with nothing to trace them to the person | `api_keys.created_by_user_id` and `created_by_role`, inherited by descendant keys; removal revokes every key traced to the person, and a demotion revokes those the new role could not mint (section 4.6, [W36](../edge-cases.md)) | `it::members::w36_removed_member_keys_revoked` |
| E | An API key releasing quarantined mail where only a person should | With `PM_QUARANTINE_KEY_RELEASE=off` (Pylota Mail Cloud) every key gets `403 permission_denied`, unless the tenant's `policy.quarantine.key_release` is `true`, which only a platform key or the tenant's own partner key can set (section 5.3); every release is audit-logged with its key | `it::quarantine::j14_key_release_policy`, `it::quarantine::j16_key_release_override` |
| E | Test key acting on a live tenant, or the reverse | A key's mode follows its tenant; platform keys act on both, and partner keys on both modes of their own tenants, and every state-changing action they take is audit-logged except sends, which are recorded as messages ([L4](../edge-cases.md)) | `it::testmode::l4_mode_binding` |
| E | A partner raising its tenants' limits or reversing operator enforcement (a cap above the default, a platform suspension lifted, an abuse pause resumed, a cap raised one identity at a time) | Lower-only and platform-only policy fields, platform ceilings in `tenants.policy_ceilings_json`, `tenants.suspended_by`, platform-only abuse resume on partnered tenants, and the identity `send_policy.daily_cap` bound (section 4.6, [J17](../edge-cases.md)) | `it::partners::policy_caps_lower_only`, `it::partners::j17_operator_enforcement` |
| E | A workspace raising its own limits, or an agent's key weakening the protections that apply to it | Workspace writers (a tenant key with `policy:write`, or a console owner or admin) are bounded by the workspace ceiling (deployment default, platform ceiling, partner ceiling) and never reach platform-only fields or `quarantine.key_release`; `policy:write` cannot be held by identity keys; a tenant key may only tighten a guard field unless keys may take decisions reserved for people (section 5.3); every write is a compare-and-set with an audit row and an event ([Workspace policy](workspace-policy.md), [J23](../edge-cases.md)–[J27](../edge-cases.md)) | `it::policy::j23_workspace_ceilings`, `it::policy::j24_workspace_field_classes`, `it::policy::j25_guard_fields_need_person`, `it::policy::j26_partner_ceiling`, `it::policy::j27_concurrent_writes` |
| E | An agent creating third-party accounts with its identity without an operator's approval, or approving its own request | Service sign-up ledger: with `accounts.require_approval`, verification mail matches only an approved entry (authenticated `From` organisational domain, the entry's address), otherwise it is quarantined `account_unapproved`, and `wait` refuses the domain; `accounts:approve` cannot be held by identity keys, and approval by an API key is a decision reserved for people (section 5.3) ([Service sign-up ledger](service-accounts.md), [E9](../edge-cases.md)–[E14](../edge-cases.md)) | `it::accounts::e9_unapproved_code_held`, `core::accounts::e10_match_rules`, `it::accounts::e11_key_approval_rule` |
| D | A partner key creating tenants or invitations without bound | `partners.max_tenants` checked in the insert (`403 partner_tenant_limit`) and `RL_PARTNER` per partner (section 10, [J18](../edge-cases.md)) | `it::partners::j18_partner_limits` |
| E | A tenant or partner key taking over a Cloudflare zone it does not own (another tenant's zone, or the zone of the deployment's own hosts) through `cloudflare_zone` | Zone permission before any Cloudflare call: the zone must be claimed for the tenant in `zone_claims` or listed in its platform-only `domains.cloudflare_zones`, and is never under the zones of `PM_PLATFORM_DOMAIN`, `PM_API_HOST` or `PM_CONSOLE_HOST` (`403 scope_denied`, `details.reason = "zone_not_allowed"`, [Identities and domains › Zone permission](identity-domains.md#zone-permission), [H8](../edge-cases.md)) | `it::domains::h8_zone_permission`, `it::security::cross_tenant_matrix` (`foreign_zone`) |
| I | A one-time secret recovered from an idempotent replay, or a replay crossing keys | Idempotency records are keyed by the calling key, and a response carrying a secret is stored without it (`"secret_replayed": false`, [J19](../edge-cases.md)) | `it::idempotency::j19_per_key_no_secret` |
| T | Changing a tenant while its erasure runs | Non-platform writes to an `erasing` or `erased` tenant are `*_not_found`, and only the erasure job changes its status (section 5.2, [I8](../edge-cases.md)) | `it::erasure::i8_erasing_tenant_frozen` |

### 3.3 TB3: agent → MCP

| STRIDE | Threat | Mitigation | Test |
|---|---|---|---|
| S | Unauthenticated MCP use, DNS rebinding from a browser | `Authorization: Bearer pmk_…` on every request, through the REST authentication code; an `Origin` header other than `https://{PM_API_HOST}` gets `403`; no CORS grant ([MCP › Request handling](mcp.md#21-request-handling)) | `it::security::mcp_requires_key` |
| E | A steered agent calls a send tool | Send tools require `idempotency_key`; `send_policy.require_known_recipient`, on by default, suppresses deliveries to recipients the identity has never sent to, whatever mail they sent first ([E2](../edge-cases.md)); a send whose hop count reaches 10 is refused with `loop_detected` ([N13](../edge-cases.md)); tools the key lacks permission for are not listed and refused if called | `it::send::e2_require_known_recipient`, `it::security::mcp_tools_follow_key` |
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
| S | Forged SES delivery event via `POST /hooks/ses`, or forged inbound notification via `POST /hooks/ses/inbound` (which would inject mail with chosen verdicts) | Both endpoints verify the SNS signature with the same code: `SignatureVersion` must be `2` (SHA256withRSA); version 1 (SHA-1) is refused. `SigningCertURL` must be `https` on host `sns.{PM_SES_REGION}.amazonaws.com`. `TopicArn` must equal that endpoint's topic (`PM_SES_SNS_TOPIC_ARN` for `/hooks/ses`, `PM_SES_INBOUND_TOPIC_ARN` for `/hooks/ses/inbound`). `Timestamp` within one hour (14 days on the SQS backstop path). Subscription confirmation only for that exact topic. Any failure → `403 invalid_signature` and `ses_sns_rejected_total`. `pmail setup ses` sets `SignatureVersion=2` on both topics ([N1](../edge-cases.md), [N2](../edge-cases.md), [Outbound › Amazon SES](outbound.md#amazon-ses), [Domains on any DNS host §4.5](domain-connections.md#45-inbound-through-ses)) | `core::sns::verify_v2_vectors`, `it::ses::invalid_signature_403` |
| S | SES verdicts used to mark forged mail as authenticated | Verdicts are read only from a notification signed for our inbound topic. SPF is taken from SES (it saw the connecting IP); DKIM, ARC and DMARC are recomputed over the raw bytes as for every source, and a disagreement with SES increments `ses_auth_disagreement_total` | `it::ses::verdict_mapping` |
| T | The same inbound notification delivered twice (SNS retry, SQS backstop, or both) | `ses_ingest` ledger: `INSERT OR IGNORE` on `(object_key, recipient)`; only an inserted row enqueues a pointer ([N3](../edge-cases.md)) | `it::ses::push_and_backstop_once` |
| I | One SES message with recipients in several tenants | Each recipient becomes its own pointer and is resolved in the directory separately ([N28](../edge-cases.md)) | `it::ses::cross_tenant_recipients` |
| I | Raw inbound mail at rest in S3 | Bucket in the SES region with all public access blocked and SSE-S3. The bucket policy lets only `ses.amazonaws.com` `s3:PutObject` on `in/*`, and only with `aws:SourceAccount` = the account and `aws:SourceArn` = the receipt rule. The consumer deletes each object once every recipient is ingested; a lifecycle rule deletes `in/` after 14 days ([Domains on any DNS host §4.2](domain-connections.md#42-deployment-set-up-for-ses)) | — (`pmail setup ses`, spike S11) |
| E | Over-privileged SES credentials | The IAM user `pylota-mail-worker-{dep}` has one policy listing exactly the SES, receipt-rule, S3 (`in/*` only) and SQS actions of [Domains on any DNS host §4.2](domain-connections.md#42-deployment-set-up-for-ses); setup prints it for review. Its access key goes into Worker secrets and is never written to disk | — (`pmail setup ses`) |
| I | SMTP relay credentials read in transit or at rest | Ports `465` (implicit TLS) and `587` (STARTTLS) only; anything else is `400 smtp_port_not_allowed`. TLS is required before `AUTH`: a relay that does not advertise `STARTTLS` gets no credentials (`smtp_tls_required`) ([N16](../edge-cases.md)). The runtime must check the certificate host name (spike S12; otherwise `smtp_relay` does not ship). Credentials are sealed in `domains.smtp_sealed` (section 7.2) and never returned, logged or exported | `core::smtp::state_machine` |
| I/E | A relay host used to reach private networks | `smtp.host` must be a DNS name with public addresses; the [SSRF rules](#93-other-outbound-destinations) apply to every connection | `core::ssrf::*` |
| S | A relay that rewrites `From` or signs with its own `d=` makes the deployment send mail that fails DMARC (U4) | Alignment probe before the first send and every day; a failing probe moves the domain to `failing` and sends fall back to the platform address (SEC-4, [N18](../edge-cases.md)). A `535` reply is `smtp_auth_failed` ([N14](../edge-cases.md)) | `it::smtp::probe_unaligned_falls_back` |
| S | Forged OAuth callback or ID token | Section 4.9: state bound to the browser, PKCE, exact redirect URI, ID token claims checked | `it::oauth::state_cookie_binding` |
| S | Forged delivery event on `pm-delivery-events` | Only Cloudflare event subscriptions produce to the queue; payloads are schema-validated, routed by sender address through the directory and matched by provider message ID; unmatched events are orphaned, never applied by guess ([G8](../edge-cases.md)) | `it::delivery::g8_race` |
| S | A lying DNS resolver flips a domain state | Two independent resolvers, two consecutive agreeing results ([H7](../edge-cases.md)) | `core::domain_fsm::h7_resolver_disagreement` |
| I | Mail content stored by AI Gateway | When `PM_AI_GATEWAY` is set, every model call that carries mail content disables gateway log collection and caching (gateway options `collectLog: false`, `skipCache: true`, confirmed by spike S6) | `it::ai::gateway_options_no_log` |
| I | `PM_CF_API_TOKEN` leak | Optional; scoped to the permissions in [Identities and domains](identity-domains.md#cloudflare-api-token-permissions) and to named zones (on Cloud, `pylotamail.com` and `pylota.io` only, [ADR 0010](../adr/0010-cloud-in-the-existing-cloudflare-account.md)); never logged; rotated per section 6. Deploy tokens hold per-Worker roles, never account-wide Workers edit | `it::logs::i5_no_content_in_logs` |
| D | Cloudflare API rate limits | Backoff in `DomainMonitor` and job runners; one verification per minute per domain | `it::domains::verify_rate_limited` |
| E | Over-privileged automation | Without `PM_CF_API_TOKEN`, tenant domains are added from the CLI with the operator's own token | — (configuration) |

### 3.6 TB6: operators of the deployment

| Threat | Mitigation |
|---|---|
| A Cloudflare account member reads D1, R2 or Durable Object data | Out of scope for the software (SECURITY.md). Deployers keep account membership minimal and use Cloudflare's own audit logs. Secrets are Worker secrets and are never written to disk unless `pmail setup --print-secrets` is used |
| A partner key is misused | A partner key reaches only the tenants its partner's keys created, never another Cloud customer's ([FR-KEY-4](../prd.md#61-tenancy-and-access)). A platform key suspends the partner (`PATCH /v1/partners/{partner_id}` with `status: suspended`), which at once refuses every partner key of it and every API key of its tenants (`403 partner_suspended`) and holds deliveries to its and its tenants' endpoints, while inbound mail is still stored ([J13](../edge-cases.md)); the partner cannot raise limits past the operator's or undo the operator's enforcement (section 4.6, [J17](../edge-cases.md)), and its reach is bounded by `max_tenants` ([J18](../edge-cases.md)); every state-changing partner-key action is audit-logged like a platform key's |
| A platform key is misused | Platform keys reach every tenant: issue few, set `expires_at`, store them in a secrets manager (`key_command` in the CLI profile). Every state-changing platform-key action on a tenant is audit-logged, and so is every platform-key or partner-key read of mail content (`mail.read`, one row per request, written before the response by the shared read services, so REST and MCP reads are covered alike; a request whose row cannot be written fails with `503`: [REST API › Audit](../../reference/api.md#get-v1audit-events--auditread)), so access by the operator, or by a partner, to a tenant's mail is recorded break-glass access; sends are not audit rows: each is a stored message, and the request's structured log carries `key_id` ([Observability §2.1](observability.md#21-schema)). A platform key cannot sign as an identity: `identities:sign` is not allowed at that level; it can grant it to a tenant or identity key it mints, and the `key.create` audit row records the grant (section 4.6) |
| The CLI machine leaks a key | `~/.config/pylota-mail/config.toml` is created `0600` and refused when group- or world-readable ([Configuration](../../reference/configuration.md#cli-configuration)) |
| The release pipeline is compromised | Section 11: pinned dependencies and actions, signed `SHA256SUMS` with a key that never enters CI, build provenance attestations, protected tags and environments |
| The one operator is unavailable, asleep or wrong | There is no second person ([ADR 0015](../adr/0015-solo-operator.md)). Mechanical controls instead: automatic containment that fails closed ([Observability § 5.6](observability.md#56-automatic-containment)), alert email plus an external heartbeat ([§ 5.5](observability.md#55-alert-email-and-the-external-heartbeat)), CI gates, a fresh-agent deploy rehearsal and an independent adversarial agent review of T2 changes, and a break-glass record of every recovery credential ([§ 5.7](observability.md#57-break-glass-record)) |

### 3.7 TB7: people → console

The console's own rules are in [Console and workspaces](console.md) and [Cloud sign-up](cloud-signup.md);
section 4.9 states the security properties.

| STRIDE | Threat | Mitigation | Test |
|---|---|---|---|
| S | Guessing a six-digit code; sign-in mail used to flood an address | 3 link or code requests per 10 minutes per address; 10 attempts per code, then the token is burned; 30 failed codes per address per UTC day, then code sign-in is locked until 00:00 UTC and the person is told; `RL_SIGNIN` 10 requests per 60 s per client network (an IPv6 /64 counts as one) ([W15](../edge-cases.md), [W43](../edge-cases.md)) | `it::console::w15_signin_limits`, `it::console::w43_failed_code_daily_cap` |
| S | A session for an enrolled person without the second factor: through an invitation link, or by replaying the step between the factors | No session before the last step: the pending step lives in `pending_auth` (keyed hash of the `__Host-pm_pending` cookie, 5 minutes, single use); accepting an invitation as an enrolled person goes through it; acceptance is always an explicit click, never automatic at sign-in ([W40](../edge-cases.md), [W41](../edge-cases.md)) | `it::members::w40_invitation_needs_second_factor`, `it::totp::w41_pending_auth_single_use` |
| S | A console account whose sign-in address is a mailbox of this deployment, taken over by any key that reads that mailbox | Such addresses are refused for console accounts, invitations and owners, and an identity address equal to a console sign-in address is refused ([W45](../edge-cases.md)) | `it::console::w45_hosted_address_refused` |
| S | Login CSRF or a stolen OAuth `code` replayed in another browser | `state` hashed under the link keyring and bound to the `__Host-pm_oauth` cookie, single use, 10 minutes; PKCE S256; `nonce` for Google; exact redirect URI ([W20](../edge-cases.md)) | `it::oauth::state_cookie_binding` |
| S | Taking over an account through a provider account with an unverified address, or one whose verified address was reassigned | Only a verified email is accepted; a provider identity is linked to an existing account only after a code emailed to that account's address is entered, never on the address match alone (Google: `sub`, not `email`, identifies an account); a person can unlink a provider in settings ([W21](../edge-cases.md), [W22](../edge-cases.md), [W42](../edge-cases.md)) | `it::oauth::unverified_email_refused`, `it::oauth::link_by_verified_email`, `it::oauth::w42_link_needs_code` |
| S | A stolen first factor (mailbox access, provider account) | Two-step verification (TOTP), optional per person and required by a workspace with `require_two_factor`; attempt limits and replay refusal ([W27](../edge-cases.md), [W28](../edge-cases.md)) | `core::totp::rfc6238_vectors`, `it::totp::workspace_requirement`, `it::totp::recovery_code_single_use` |
| T | Cross-site form posts | CSRF token, `Origin` equal to `https://{PM_CONSOLE_HOST}`, `SameSite=Lax` ([W16](../edge-cases.md), [Console › CSRF](console.md#csrf)) | `it::console::w16_csrf` |
| I | Session cookies reaching the API, or API keys reaching browser history | Host split: with two hosts, console paths answer only on `PM_CONSOLE_HOST` and API paths only on `PM_API_HOST`; no cookie is set or read on the API host | `it::hosts::console_api_split` |
| I | Open redirect through `next` | Only a relative path under `/console/`, with no `//`, no backslash and no scheme ([W31](../edge-cases.md)) | `it::landing::routing_table` |
| I | Hostile HTML in mail acting inside the console | Text view by default; sanitised HTML in a token-less `sandbox` `srcdoc` frame; no script source in the CSP ([W17](../edge-cases.md)) | `it::console::w17_hostile_html` |
| E | A viewer acting beyond its role, or an ID from another workspace | The console route table registers each route with its permission, like the API's ([W18](../edge-cases.md)) | `it::console::w18_role_and_scope` |
| S/T | A forged unsubscribe token, or a real one replayed for another person, workspace or kind | The token is a MAC under a `link` key, with that key's kid, over the person, the workspace and the kind (section 4.9); it is compared in constant time, lives 90 days and verifies only while its link key is current or inside the 7-day window after a rotation. It can only set that one kind to `off` for that person in that workspace: it reads nothing and never touches `account`. An altered, foreign or expired token changes nothing and gets the same page linking to settings ([O18](../edge-cases.md)) | `it::notify::one_click_unsubscribe` |
| I | Notification content read on a lock screen, or by the person's mail provider | Notifications carry counts, inbox addresses, the workspace name and links only: never a subject, sender, snippet or attachment name from any message, and only mail visible in the inbox is counted ([Notifications §1](notifications.md#1-kinds), [O15](../edge-cases.md)) | `core::notify::no_content_in_body`, `it::notify::invisible_mail_never_notifies` |
| D | Notification mail used to flood a person | At most 50 notification emails per person and 200 per workspace a day, `account` and `digest` excepted, the rest going into the next daily digest (one `digest` email per person a day at most) ([O24](../edge-cases.md)); a hard bounce or complaint pauses that person's preferences ([O17](../edge-cases.md)) | `it::notify::daily_caps`, `it::notify::bounce_pauses_prefs` |
| D | Free workspaces created to send spam | New-workspace send ramp (lifted by a paid plan only once its invoice is paid, and restored by a dispute), disposable-domain block, `RL_SIGNIN`, one self-serve Free workspace per person, and the automatic shared-domain breaker ([W29](../edge-cases.md), [W30](../edge-cases.md), [W37](../edge-cases.md), [W38](../edge-cases.md), [W46](../edge-cases.md), [Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud)) | `it::abuse::free_ramp`, `it::billing::w37_grant_after_payment`, `it::billing::w38_dispute_and_refund`, `it::abuse::w46_shared_domain_breaker` |
| D | System mail (one sender, one platform domain, one account quota shared with Pylota) drained by strangers, so nobody can sign in | Budgets per recipient, per client network and ASN and per inviting tenant; a form ticket on the mail-sending forms; `invitation` and `notification` mail capped at 20% and 50% of the system identity's day, so sign-in mail always has a share ([W44](../edge-cases.md)) | `it::abuse::w44_system_mail_budgets` |

### 3.8 TB8: agent proofs → third parties

How assertions and signed requests are built is in [Agent signing keys](agent-keys.md); these are the
security properties.

| STRIDE | Threat | Mitigation | Test |
|---|---|---|---|
| S | A forged agent assertion: a token this deployment did not mint | Ed25519 signature under the identity's own key. Verifiers accept only `alg: EdDSA` with `typ: agent-assertion+jwt`, take keys only from `{trusted iss}/.well-known/jwks/{sub}.json` (never from a URL the token supplies), and only after `sub` matched `^idn_[0-9A-HJKMNP-TV-Z]{26}$`, so a crafted `sub` cannot point the fetch at another path of the issuer; the fetch follows no redirect and accepts only `Content-Type: application/jwk-set+json`; they pick the key by `kid` ([Agent signing keys §4.3](agent-keys.md#43-how-a-verifier-checks-it)); the Rust SDK's `verify_assertion` and `pmail assertions verify` do exactly this | `core::jwt::eddsa_rfc8037_vector`, `it::assertions::sdk_verifies` ([O27](../edge-cases.md)) |
| S/T | A replayed assertion or signed request | Assertions carry `jti` (a new ULID), `aud`, `exp` at most 600 s after `iat` (default 300 s) and the verifier's optional `nonce`. HTTP signatures carry a 64-byte random `nonce`, `created` and `expires` (30–300 s, default 60 s) in the signed parameters, and always cover `@authority`. The service mints both and stores neither, so replay detection belongs to the verifier: it keeps each `jti` until `exp`, and each signature nonce until `expires` ([Agent signing keys §10](agent-keys.md#10-security-and-privacy)) | `it::assertions::claims_and_limits`, `it::http_signatures::expiry_bounds` |
| I | Exfiltration of a private key: an identity's seed or the deployment's `web_bot_auth` seed | Generated from `platform::Rng`, sealed at once (section 7.2), unsealed only in memory for one signing call and zeroised after it (`zeroize`). No API returns, logs or exports a private key; a minted token or signature is returned once to its caller and never stored or logged. Reading a sealed seed needs both D1 access and `PM_MASTER_KEY`. After a suspected leak: revoke the identity key (`POST /v1/identities/{identity_id}/keys/{kid}/revoke` removes it from the JWKS at once, cached at most 5 minutes, [O3](../edge-cases.md)), or rotate `web_bot_auth` with `revoke_previous=true`; then rotate `PM_MASTER_KEY`, which re-seals every key without changing a public key ([O8](../edge-cases.md)) | `it::identity_keys::revoke_removes_from_jwks`, `it::secrets::rotate_master_reseals_identity_keys` |
| S | A mirrored key directory: someone serves a copy of `/.well-known/http-message-signatures-directory` and registers it as theirs | The response is signed once per listed key with `("@authority";req)`, `tag="http-message-signatures-directory"`, a fresh nonce, `created` and `expires` = `created` + 300 s, so a copy served from another authority fails verification. At most three keys are listed ([O12](../edge-cases.md)) | `it::well_known::directory_signed_per_key` |
| I | Probing the JWKS for which identities exist, are paused or were deleted | An unknown, deleted, paused or suspended identity gets the same `404 identity_not_found`; identity IDs are ULIDs, never derived from addresses ([Agent signing keys §3.1](agent-keys.md#31-identity-jwks)) | `it::identity_keys::paused_withdraws_jwks` |
| E | A misbehaving agent keeps proving who it is after it was stopped | The kill switch (FR-IDN-9): pausing an identity, or suspending its tenant (which pauses every identity), stops signing at once (suspended tenant → `403 tenant_suspended`; paused identity → `409 identity_paused`) and withdraws its JWKS (`404`), so a verifier that refetches stops accepting it within the 5-minute cache ([O1](../edge-cases.md)). Erasure deletes the keys and writes each kid to `key_tombstones`, so a deleted kid is never published again ([O7](../edge-cases.md)) | `it::identity_keys::paused_withdraws_jwks`, `it::assertions::erasure_tombstones_kid` |
| E | Signed HTTP requests from a tenant that never chose them | `PM_WEB_BOT_AUTH` is `off` by default and stays off until spike S13 passes (`422 web_bot_auth_disabled`, [O9](../edge-cases.md)); a tenant must be opted in with `policy.web_bot_auth.allowed`, which only a platform key can set (`403 policy_denied`, [O13](../edge-cases.md)) | `it::http_signatures::disabled_and_policy` |
| D | Signing calls used to exhaust the Worker | `RL_SIGN`: 600 signing calls per 60 s per identity, assertions and HTTP signatures together (section 10) | `it::auth::rate_limited` |

## 4. Authentication

### 4.1 Key format

```text
pmk_{mode}_{lookup}_{secret}

mode    live | test                         (follows the key's tenant; platform and partner keys are live)
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
9. Resolve `Scope { key_id, level, partner_id, tenant_id, identity_id, mode, permissions }`. For tenant and
   identity keys, `permissions` is the key's list plus the implicit `usage:read` (section 4.6), and the
   tenant row is loaded with its partner's `status` (a join on `tenants.partner_id`); a tenant in status
   `erasing` or `erased` gives `401 key_revoked` (its keys were revoked by the erasure job; this covers
   the window before that step commits). A `suspended` tenant still authenticates: suspension is enforced
   by policy (`403 tenant_suspended` on sends, FR-TEN-3). For a partner key the `partners` row is loaded
   in the same D1 read (a join on `api_keys.partner_id`). When the partner is `suspended`, its partner
   keys **and every tenant and identity key of its tenants** get `403 partner_suspended` on every route,
   `GET /v1/me` included, and nothing else runs ([J13](../edge-cases.md)); inbound mail is still accepted
   and stored, and the tenants' status does not change. This comes after the secret matched, so it tells
   a guesser nothing. A partner key gets no implicit permission. A `deleted` partner has no keys left
   (deletion deletes them), so no request reaches this step for it.

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

Rotating, revoking and reading a key are bounded like minting one: the caller must reach the key and
must not be narrower than it ([Managing existing keys](#managing-existing-keys)). Otherwise a narrow key
with `keys:manage` could rotate a wider key and receive its new secret.

### 4.6 Creating keys (FR-KEY-1)

Key levels, from widest to narrowest (FR-KEY-1, FR-KEY-4): `platform` (every tenant), `partner` (the tenants created with its
partner's keys, [Partner keys](#partner-keys)), `tenant` (one tenant) and `identity` (one identity).

`POST /v1/keys` checks, in this order:

1. **The request.** `permissions` is required and non-empty at every level, `level: platform` included:
   there is no implicit full set (`400 invalid_request` when it is missing or empty).
   `pmail keys create` without `--permissions` exits 2 with a message ([CLI and setup](cli.md)).
   `level: partner` needs `partner_id` and no `tenant_id` or `identity_id`; every other level refuses
   `partner_id` (`400 invalid_request`).
2. **Permissions allowed at the new key's level.** Some permissions can never be held at some levels,
   whoever the caller is. Listing one is `400 invalid_request` with
   `details.reason = "permission_not_allowed_for_level"`:

   | Permission | Platform key | Partner key | Tenant key | Identity key |
   |---|---|---|---|---|
   | `platform:ops`, `partners:manage` (platform-only) | yes | no | no | no |
   | `tenants:manage` | yes | yes, for its own tenants | no | no |
   | `members:read`, `members:manage`, `suppressions:manage`, `audit:read`, `usage:read`, `policy:write`, `accounts:approve` (tenant-only: never on identity keys) | yes | yes | yes | no |
   | `tenants:erase` (tenant-scope erasure: deleting the workspace) | yes | yes, for its own tenants | only a key whose `created_by_role` is `owner` | no |
   | `identities:sign` | no (it may grant it, step 3) | no (it may grant it, step 3) | yes | yes, for its own identity |
   | Every other permission | yes | yes | yes | yes |

   A tenant key listing `tenants:erase` is refused unless the new key's `created_by_role` will be
   `owner`, that is, unless the workspace owner's console session mints it or the caller is a key whose
   own `created_by_role` is `owner` ([Who minted a key](#who-minted-a-key)): `400 invalid_request` with
   `details.reason = "permission_owner_only"`. A platform or partner key cannot give it to a tenant key.

3. **Scope.** Every condition below holds; otherwise `403 key_scope_exceeded`:

   | Caller level | New key's level | Partner | Tenant | Identity |
   |---|---|---|---|---|
   | platform | any | an existing partner that is not `deleted` (partner level) | any existing tenant (tenant, identity levels) | any identity of that tenant (identity level) |
   | partner | tenant or identity | – | a tenant whose `partner_id` is the caller's | any identity of that tenant (identity level) |
   | tenant | tenant or identity | – | must equal the caller's tenant | any identity of the caller's tenant |
   | identity | identity | – | must equal the caller's tenant | must equal the caller's identity |

   and every listed permission is one the caller can **grant**: one it holds (its resolved permissions,
   section 4.2, step 9), or `identities:sign` when the caller is a platform or partner key and the new key
   is a tenant or identity key. That grant is the one exception to the subset rule (FR-KEY-1). Without it
   no API call could produce a signing key, because platform and partner keys can never hold
   `identities:sign`: the integration harness, a deployment run without the console and a partner
   provisioning its tenants' agents all need it. The platform or partner key still never signs, and the
   `key.create` audit row lists the permissions granted without being held in
   `details.granted_without_holding` (for example `["identities:sign"]`). A partner key that asks for a
   `partner` or `platform` key, or names a tenant outside its own, gets `403 key_scope_exceeded`
   ([J11](../edge-cases.md)). A platform key naming a partner that does not exist or is `deleted` gets
   `404 partner_not_found`.
4. **Active-key cap** ([J22](../edge-cases.md)). A tenant has at most 100 tenant and identity keys that
   are neither revoked nor expired, and a partner at most 10 partner keys. The next mint gets
   `422 key_limit_reached` with `details.limit`. The `INSERT … SELECT … WHERE (SELECT COUNT(*) …) < ?`
   statement checks the count itself, so concurrent mints cannot overshoot. Platform keys are not capped:
   only the operator holds them.

- **Implicit `usage:read`.** Every tenant and identity key holds `usage:read` for its own workspace
  without listing it: authentication adds it to the resolved permissions (section 4.2, step 9). A key
  reaches only its own workspace, so the grant never reaches another one. An identity key still cannot
  list it (step 2), and platform and partner keys hold it only when listed.
- The caller needs `keys:manage`. The new key's `mode` is its tenant's mode; platform and partner keys
  are `live`.
- `created_by_key_id` records the lineage. Revoking a key does not revoke its children; the
  compromised-key runbook ([Observability](observability.md#compromised-key)) revokes descendants
  explicitly.
- Minting and revoking a key write `key.create` and `key.revoke` audit rows; for a partner key
  `tenant_id` is `NULL` and `details_json` holds `level` and `partner_id`.

#### Who minted a key

FR-KEY-5, [W36](../edge-cases.md). `api_keys.created_by_user_id` and `api_keys.created_by_role` trace a
key to the person behind it:

- A key minted in the console (owners and admins, [Console › Roles](console.md#roles)) records the
  person's `usr_` ID and role (`owner` or `admin`).
- A key minted with an API key copies its parent's two values, so a key descended from a person's key
  stays traced to that person, and an owner can delegate `tenants:erase` only along keys it minted.
- A key minted by a platform or partner key whose own values are `NULL`, and the bootstrap key of
  `pmail setup`, record `NULL`.

`created_by_user_id` is returned in the API key object. Two console events revoke keys, in the same D1
batch as the change, each with a `key.revoke` audit row whose `details.reason` names the cause:

- **Removal or leaving.** When a person is removed from a workspace, leaves it, or deletes their account
  (which leaves every workspace first), every key of that workspace that is neither revoked nor expired
  and has their `created_by_user_id` is revoked (`creator_removed`).
- **Role change.** When a person's role is lowered (an admin made a member or viewer, or the owner made an
  admin by an ownership transfer), every such key that holds a permission the new role's session
  principal lacks is revoked (`creator_role_changed`); the others stay and get the new
  `created_by_role`. So the former owner's keys holding `tenants:erase` end with the transfer.

The keys are revoked rather than offered for revocation, because a removed person must not keep access
through a key, and the integrator can mint a replacement with its own key at once.

**No cooling-off for tenant-scope erasure.** A 24-hour delay with an email to the owner and a cancel link
was considered for a tenant-scope erasure requested with a tenant key. It is not in v1.0: only keys that
the owner minted after re-authentication can hold `tenants:erase`, each such mint and each erasure request
is audit-logged, and a delay needs a new erasure status, a cancel route, a signed cancel link and a new
email kind across the API, the console and [Privacy](privacy.md#66-tenant-scope). It is an open point for
v1.1.

#### Managing existing keys

FR-KEY-1, [J20](../edge-cases.md). `GET /v1/keys/{key_id}`, `DELETE /v1/keys/{key_id}` (revoke) and
`POST /v1/keys/{key_id}/rotate` need `keys:manage` and two checks on the target key, in this order:

1. **Reach** (section 5.2, step 4). A platform key reaches every key. A partner key reaches the tenant and
   identity keys of its own tenants. A tenant key reaches the tenant and identity keys of its own tenant.
   An identity key reaches only the identity keys of its own identity, never a tenant key. A key out of
   reach is `404 key_not_found`, the same body as for a missing ID.
2. **Not wider.** The target's level is at most the caller's (`Identity < Tenant < Partner < Platform`),
   and every permission of the target is one the caller can grant (step 3 above: its own resolved
   permissions, plus `identities:sign` for a platform or partner key). Otherwise
   `403 key_scope_exceeded`: nothing changes and nothing about the key is returned.

A key always passes both checks for itself, so it can rotate or revoke itself. `GET /v1/keys` lists only
the keys that pass both. Only a platform key reaches a partner key, as above.

#### Partner keys

A **partner** is an integrator that provisions tenants for its own customers on a shared deployment
(on Pylota Mail Cloud, Pylota for its car-rental operators). It is a row in `partners`, created and
managed by platform keys with `partners:manage` ([REST API › Partners](../../reference/api.md#partners)).
Only a platform key mints a partner key (`POST /v1/keys` with `level: "partner"` and `partner_id`), and
only a platform key rotates or revokes one.

- **Reach.** A partner key reaches the tenants whose `tenants.partner_id` equals its `partner_id`, and
  everything inside them, used with a `tenant_id` or a resource ID exactly as a platform key uses them. It
  also reaches its partner's endpoints (`scope: "partner"`, [Webhooks](webhooks.md#endpoint-resolution-and-filters))
  and, read-only with `domains:read`, the platform domain, as every key does. It never reaches a tenant
  another partner created, a tenant no partner created, the platform's endpoints, any partner or platform
  key (its own included: `GET /v1/me` describes it), or a deployment-wide route (`/v1/platform/*`,
  `/v1/partners/*`).
- **A `NULL` partner never matches.** Owner checks and the fan-out compare a tenant's or endpoint's
  `partner_id` only with a partner key's own `Some(partner_id)`. A `NULL` `partner_id` (a tenant no
  partner created, a platform or tenant endpoint) matches nothing. Implementers must not compare two
  optional values directly: in Rust `None == None` is `true`, so `key.partner_id == tenant.partner_id`
  would hand every unpartnered tenant to any key without a partner. Branch on the key's level first, and
  for a partner key compare `tenant.partner_id == Some(key_partner_id)`; in SQL, `partner_id = ?` is never
  true for `NULL`. `it::partners::j10_foreign_partner_not_found` includes the unpartnered case.
- **Tenants it creates.** `POST /v1/tenants` with a partner key writes the key's `partner_id` to
  `tenants.partner_id` and the partner's `default_billing_mode` to the tenant's billing mode. Neither can
  be changed by a partner key: `partner_id` is never updated, and the `billing` field of
  `POST /v1/tenants` and `PATCH /v1/tenants/{tenant_id}/billing` are platform-only (`403 scope_denied`).
  A partner has at most `partners.max_tenants` tenants that are not `erased` (default 25, set by a platform
  key); the next creation gets `403 partner_tenant_limit`. The insert itself checks that the partner is
  `active` and below its limit (`INSERT … SELECT … WHERE` in one statement), so concurrent creations
  cannot overshoot. Each creation also counts in `RL_PARTNER` (section 10). A partner key may set
  `quarantine.key_release` in the `policy` of the creation.
- **Policy writes** ([Configuration › Who may change a field](../../reference/configuration.md#who-may-change-a-field)).
  Every policy write by a partner key, the `policy` of `POST /v1/tenants` as well as of
  `PATCH /v1/tenants/{tenant_id}`, is checked field by field, for the fields present only:
  - a **platform-only** field (`web_bot_auth.allowed`, `domains.allow_create_zone`,
    `domains.cloudflare_zones`) gets `403 scope_denied` with `details.field`;
  - a **lower-only** field may be set at most to its ceiling, otherwise `403 scope_denied` with
    `details.field`. The ceiling is the more restrictive of the deployment default (the built-in defaults
    merged with `PM_DEFAULT_POLICY`) and the tenant's platform ceiling, the value a platform key last set on
    that field (`tenants.policy_ceilings_json`): min(deployment default, platform ceiling) for numbers, and
    for a switch, its looser value (`true` for the switches that cost or loosen, `false` for
    `accounts.require_approval`) only when both allow it;
  - `quarantine.key_release` is accepted from the tenant's own partner key;
  - every other field (the guard fields included) is **free** for the partner key.

  Every lower-only value the partner key sets, at creation or later, is also stored in
  `tenants.partner_ceilings_json` and becomes that field's partner ceiling for the tenant's workspace
  writers ([Workspace policy §2](workspace-policy.md#2-classes-and-ceilings)); it never bounds the partner key
  itself.

  One failing field refuses the whole write and nothing is stored. For every non-platform key, an
  identity's `send_policy.daily_cap` (`POST …/identities`, `PATCH /v1/identities/{identity_id}`) may not
  exceed the tenant's effective `identity_daily_send_cap` (`403 scope_denied`,
  `details.field = "send_policy.daily_cap"`), so a lower-only cap cannot be raised one identity at a time.
- **Operator enforcement stays** ([J17](../edge-cases.md)). A partner cannot undo what a platform key
  enforced on its tenants:
  - `tenants.suspended_by` records who suspended a tenant (`platform` or `partner`); a partner key that
    sets `status: "active"` on a tenant a platform key suspended gets `403 scope_denied`
    (`details.field = "status"`). A partner key's `status: "suspended"` on a tenant that is already
    suspended changes nothing: `suspended_by` and `suspended_at` keep their values, so a partner cannot
    turn a platform suspension into its own and then lift it. The update is one statement,
    `SET status = 'suspended', suspended_by = CASE WHEN ?caller = 'platform' THEN 'platform'
    WHEN status = 'suspended' THEN suspended_by ELSE ?caller END, suspended_at = COALESCE(suspended_at, ?now)`,
    so a platform key's suspension replaces a partner's (`suspended_by = 'platform'`, `suspended_at`
    kept) and nothing else changes who suspended;
  - a value a platform key sets on a lower-only field is stored in `tenants.policy_ceilings_json` and
    becomes that field's ceiling for partner keys; a platform key's `null` for the field (reset to the
    default) removes it;
  - resuming an identity paused for `abuse_threshold` on a tenant a partner created needs a platform key;
    a partner or tenant key gets `403 scope_denied`.
- **Erasing and erased tenants** ([I8](../edge-cases.md)). For every non-platform key, a write to a tenant
  in status `erasing` or `erased`, or to anything in it, gets `404 tenant_not_found` (or the resource's own
  `*_not_found` on a route by resource ID), except a repeated tenant-scope erasure request (`200` with
  the running request, `202` with a resumption of a failed one or a continuation of one that ended
  `completed_with_holds`, or `409 tenant_erased`) and the hold routes on a tenant that is `erasing` with
  held threads ([Privacy § 6.6](privacy.md#66-tenant-scope)); in practice this is the partner key, because the tenant's own
  tenant and identity keys are revoked by the erasure and get `401 key_revoked` (section 4.2, step 9). `GET /v1/tenants/{tenant_id}` and the tenant's erasure
  requests (`GET /v1/erasure-requests` filtered on it, and by ID) keep answering its partner key, so a
  partner can follow an erasure to its receipt after the tenant is gone
  ([Privacy § 6.10](privacy.md#610-partners)). Only the erasure job changes the status of an `erasing` or
  `erased` tenant: a platform key's `PATCH` with `status` gets `409 tenant_erased`.
- **What it may hold.** `tenants:manage` (create, update, suspend and read its own tenants),
  `keys:manage` (tenant and identity keys of its own tenants), `webhooks:manage` and `webhooks:read`
  (its partner endpoints, and its tenants' endpoints), `quarantine:review`, `usage:read`, `tenants:erase`
  (deleting its own tenants, which `DELETE /v1/partners/{partner_id}` needs first), and every other
  tenant-level permission. Never `platform:ops`, `partners:manage` or `identities:sign` (step 2); it may
  grant `identities:sign` to the tenant and identity keys it mints (step 3).
- **Suspension contains the partner** ([J13](../edge-cases.md)). While a partner is `suspended`, its keys
  and every API key of its tenants get `403 partner_suspended` (section 4.2, step 9), so nothing can send
  for those tenants. Their status does not change and their inbound mail is still accepted and stored.
  Deliveries to the partner's endpoints and to its tenants' endpoints are held, not dropped, and resume
  when the partner is `active` again ([Webhooks › Delivering an attempt](webhooks.md#delivering-an-attempt)).
  Console sessions of the tenants' members are not API keys and keep working; the console sends no mail
  for them.
- **Deletion.** `DELETE /v1/partners/{partner_id}` needs every tenant of the partner `erased`
  (`409 partner_has_tenants`). It is a soft delete: the row stays with `status: "deleted"` and an empty
  `name`, its keys are revoked and deleted and its endpoints deleted, and `tenants.partner_id` never
  changes ([Privacy § 6.10](privacy.md#610-partners)).
- **Mode and limits.** Partner keys are `live` and act on the `live` and `test` tenants of their partner.
  They count against the same rate-limit buckets as platform keys, keyed by their own key ID, against
  `RL_PARTNER_API`, keyed by the partner, for every request, and against `RL_PARTNER`, keyed by the
  partner, for tenant creation and invitations (section 10). A partner has at most 10 partner keys.
- **Aggregate bound.** Whatever the number of its keys, one partner can at most: keep `max_tenants`
  tenants that are not erased (25 by default); send, across them, `max_tenants` × the ceiling of
  `tenant_daily_send_cap` messages a day (25 × 5,000 = 125,000 with the defaults, and 25 × 50 = 1,250 while
  its new tenants are on the send ramp, [Cloud sign-up § 10.1](cloud-signup.md#101-new-workspace-send-ramp));
  run `max_tenants` × `search.agentic_daily_cap` agentic searches a day (12,500); create tenants and send
  invitations 10 times a minute together (`RL_PARTNER`), which bounds the owner and invitation mail it
  can make the system identity send to 10 a minute (14,400 a day), under that identity's own caps; and make
  1,800 requests a minute with all its partner keys together (`RL_PARTNER_API`), plus 1,800 a minute per
  tenant with that tenant's own keys (`RL_TENANT`). Raising `max_tenants`, a ceiling or `ramp_exempt` is an
  operator decision, made with a platform key.

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
| Email link and code | Link tokens, codes, invitation tokens, session cookies and pending-step cookies are stored only as `HMAC-SHA256(link key {kid}, value)` with the kid in `key_kid`. 3 requests per 10 minutes per address; 10 attempts per code, then the token is burned; 30 failed codes per address per UTC day; 10-minute lifetime, single use; `RL_SIGNIN` (section 10). Responses are identical for known and unknown addresses ([W15](../edge-cases.md)) |
| Pending step | A first factor for a person enrolled in two-step verification, or a Google or GitHub identity waiting to be linked, creates no session: a `pending_auth` row (keyed hash of the `__Host-pm_pending` cookie; 5 minutes, or 10 when it starts with an emailed link code; single use, enforced by a conditional `UPDATE`) and the cookie, then `/console/sign-in/verify`. Invitation acceptance by an enrolled person goes through it ([Cloud sign-up §5.1](cloud-signup.md#51-the-pending-step), [W40](../edge-cases.md), [W41](../edge-cases.md)) |
| Google and GitHub | `GET /console/oauth/{provider}/start` writes an `oauth_states` row valid for 10 minutes. Its `state_hash` and `cookie_hash` are keyed hashes under the current link key, whose kid is stored in `key_kid`, and the PKCE verifier is sealed in `pkce_sealed`. The cookie `__Host-pm_oauth` (HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes) binds the flow to the browser. The redirect carries PKCE `S256`, a `nonce` (Google) and the exact redirect URI `https://{PM_CONSOLE_HOST}/console/oauth/{provider}/callback`. The callback requires the row to exist, be unexpired and unused, and match the cookie, and marks it used before exchanging the code ([W20](../edge-cases.md)). Google: `iss`, `aud`, `exp`, `nonce` and `email_verified = true` are checked. GitHub: the primary address must be marked verified. Without a verified address the flow is refused ([W21](../edge-cases.md)). A provider identity links to an existing person with that verified email only after a code emailed to the address is entered ([W22](../edge-cases.md), [W42](../edge-cases.md)). The start counts against `RL_SIGNIN`. Scopes: `openid email profile` (Google), `read:user user:email` (GitHub) |
| Two-step verification | TOTP per RFC 6238: HMAC-SHA1, 30-second step, six digits, one step of drift either way. The 20-byte secret is sealed in `users.totp_sealed` (and, during enrolment, in `users.totp_pending_sealed` for at most 10 minutes). A code already used in its step is refused (`users.totp_last_step`). 5 attempts a minute per person; 10 failures in a row lock two-step sign-in for 15 minutes. It is asked for after every first factor, before any session exists, and at re-authentication. A workspace's `require_two_factor` is checked on every request. Turning it off needs re-authentication with a current code, emails the person and writes an audit row. There is no support route around it |
| Recovery codes | Ten codes of 10 Crockford base32 characters, shown once. Stored in `users.recovery_codes_sealed`, a pm1 envelope (section 7.2) of `[{ "hash": SHA-256(code), "used_at": null }]`. Each works once; generating new codes replaces the old ones ([W28](../edge-cases.md)). They are sealed rather than hashed under the link keyring because link keys are deleted 7 days after a rotation and recovery codes live for months |
| Sessions | `__Host-pm_session` (`Secure`, `HttpOnly`, `SameSite=Lax`); 7 days rolling, 30 days absolute; sensitive actions need a sign-in within the last 10 minutes ([Console › Sessions](console.md#sessions)) |
| Notification unsubscribe links | `https://{PM_CONSOLE_HOST}/console/notifications/unsubscribe?t={token}`, in the `List-Unsubscribe` header of every `usage`, `new_mail` and `needs_person` email. The token is a MAC under the current link key, carrying that key's kid, over the person, the workspace and the kind; it is valid for 90 days, and only while its link key is current or inside its 7-day verify window. `GET` changes nothing (a confirmation page with a one-click form); `POST` sets that one kind to `off` for that person and workspace. Neither needs a session, and both are exempt from the console's CSRF token and `Origin` check, because a mail provider sends the RFC 8058 `POST` without either: the token is their only authority, and the most it can do is turn one kind off. They are served even with `PM_CONSOLE=off` ([Notifications §5](notifications.md#5-the-emails), [O18](../edge-cases.md)) |
| Hosts | `PM_CONSOLE_HOST` defaults to `PM_API_HOST`. When the two differ, console paths answer only on `PM_CONSOLE_HOST`, and API paths only on `PM_API_HOST`: REST `/v1/*` (signed links `/v1/links/*` included), MCP `/mcp`, `/openapi.json`, `/health`, `/.well-known/*` (the security contact, the identity JWKS and the Web Bot Auth key directory), `/hooks/*` and `/billing/stripe/webhook`. Anything else gets `404`. No cookie is set or read on the API host. This keeps session cookies off the API and API keys out of browser history ([Cloud sign-up §2](cloud-signup.md#2-hostnames)) |

## 5. Authorisation and tenant isolation

### 5.1 Deny-by-default router table

Every route is registered with its method, path pattern, required permission(s), scope rule and
idempotency rule. The router is built from that table only, and it matches a request before
authenticating it. A path that matches no entry, or an API path on the console host or a console path on
the API host (section 4.9), gets `404 route_not_found` with the standard envelope; a path that matches an
entry for other methods only gets `405 method_not_allowed` with an `Allow` header listing them. The one
exception is `/mcp`, whose `405` (to `GET`, `DELETE` and any method but `POST` and `OPTIONS`) has an empty
body with `Allow: POST`, as the MCP transport expects ([MCP › Request handling](mcp.md#21-request-handling)).
Neither reads a key or D1, and route patterns are public, so
neither reveals anything about data. A route cannot be registered without a permission list and a scope
rule (the registration function takes them as non-optional arguments), and public routes use the
explicit `Scope::Public` variant. The permission list may be empty only for `Scope::Public` and for
two other routes: `GET /v1/me`, which any valid key may call (`Scope::AnyKey`), and
`GET /v1/tenants/{tenant_id}`, which only platform, partner and tenant keys may call (`min_level: Tenant`; an
identity key gets `403 scope_denied` on its own tenant, step 3 of section 5.2). For the second,
`foreign_permissions` (`tenants:manage`) is required as well when the target is not the key's own
tenant, and always for a platform or partner key, so a tenant key reads only its own tenant.
`foreign_permissions` is checked with the other permissions in step 2 of section 5.2, before the owner is
resolved: "not the key's own tenant" compares the tenant ID in the path with the key's own, without a D1
read, so a foreign tenant and a missing one give the same `403 permission_denied`. A unit test fails when
any other route has an empty list. `GET /v1/usage` is not one of them: it is registered with
`usage:read`, which every tenant and identity key holds implicitly for its own workspace (section 4.6),
while a platform or partner key needs it listed and must pass `tenant_id` (`400 invalid_request` without it).

Levels are ordered `Identity < Tenant < Partner < Platform`. `min_level` compares against that order,
so a route with `min_level: Tenant` accepts a partner key on its own tenants, and a route or field with
`min_level: Platform` (`PATCH /v1/tenants/{tenant_id}/billing`, the `billing` field of
`POST /v1/tenants`, a domain's `transport`) answers a partner key `403 scope_denied` on its own tenant.

```rust
// crates/worker/src/auth/routes.rs
pub enum Scope {
    Public,                                  // section 4.7 only
    AnyKey,                                  // GET /v1/me
    PlatformOnly,                            // /v1/platform/*, /v1/partners/*
    PlatformOrPartner,                       // POST /v1/tenants, GET /v1/tenants, POST /v1/webhooks
                                             // (a partner key: its own tenants, or a partner endpoint)
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
    pub idempotency: Idempotency,            // Required | Optional | None (openapi x-idempotency)
    pub min_level: Option<Level>,            // e.g. Tenant for tenant search (FR-SRCH-10), Platform for billing
}
```

Builds with the `itest-hooks` cargo feature expose the table at `GET /__test/routes`, so the attack
suite can prove it covers every route ([Testing](testing.md#7-cross-tenant-attack-suite)).

### 5.2 Order of checks

For each request, before any Durable Object or R2 call:

1. **Authenticate** (section 4.2).
2. **Permission.** The key must hold every permission in `RouteSpec.permissions`, and those in
   `foreign_permissions` when the tenant ID in the path is not its own (section 5.1); otherwise
   `403 permission_denied` with `details.required`. This check reads only the key and the path, never
   the target, so a missing ID gets the same answer as an existing one and it leaks nothing. A
   permission that depends on the body is checked here too, once the body is parsed: a tenant-scope
   erasure request also needs `tenants:erase` (section 4.6).
3. **Level.** If the route is above the key's level and the target is the key's own tenant (an identity
   key holding `search:read` on `POST /v1/tenants/{own}/search`), the result is `403 scope_denied`
   ([F3](../edge-cases.md)), as is a partner key on a platform-only route or field of one of its own tenants
   (`PATCH /v1/tenants/{own}/billing`). A route that needs a permission the key's level can never hold (a tenant key
   on `GET /v1/tenants`, which needs `tenants:manage`, or a partner key on `/v1/partners`, which needs
   `partners:manage`) already failed step 2 with `permission_denied`. This also reveals nothing, because the target is the
   key's own tenant.
4. **Resolve the target's owner** from D1 with the key's scope as a mandatory parameter of the data-access
   function (`tenant_id` is a required argument of every tenant-data query):
   - `TenantPath`: the tenant ID must equal the key's tenant (platform keys: the tenant must exist;
     partner keys: the tenant's `partner_id` must equal the key's `partner_id`, compared as
     `Some(key_partner_id)`, so a tenant with a `NULL` `partner_id` never matches, [Partner keys](#partner-keys)).
   - `IdentityPath`: `SELECT i.tenant_id, i.status, i.mailbox_do_id, t.partner_id FROM identities i JOIN tenants t ON t.id = i.tenant_id WHERE i.id = ?1`, then
     compare with the key; identity keys must match their own identity, and partner keys need
     `t.partner_id` equal to their own.
   - `Resource`: load the row and compare its `tenant_id`; an identity key also needs the row's
     `identity_id` to equal its own when the row has one (an API key, an erasure request or an export of
     one identity), and reaches tenant-wide rows only as section 5.3 says. For a partner key, the row's
     tenant must have the key's `partner_id`. The
     platform domain (`tenant_id IS NULL`) is readable by every key with `domains:read`. A webhook
     endpoint with `tenant_id IS NULL` is reachable by a platform key, and by a partner key only when its
     `partner_id` is the key's. An API key row is reachable as [Managing existing keys](#managing-existing-keys)
     says: by a partner key only when it is a tenant or identity key of one of its tenants (a partner-level
     or platform-level key ID, its own included, is `404 key_not_found` to it), by a tenant key when it is
     a key of its tenant, and by an identity key only when it is an identity key of its own identity. A
     reachable key that is wider than the caller is then `403 key_scope_exceeded`.
   - Any mismatch returns the resource's own `*_not_found` code with the same body as for a
     non-existent ID. The check runs whether or not the ID exists, so both paths do one D1 read.
   - **Erasing and erased tenants.** For a non-platform key, a write (any method but `GET`) whose
     resolved tenant is `erasing` or `erased` gets the same `*_not_found` (`404 tenant_not_found` on a
     tenant path), so nothing is created, changed or sent in a tenant being erased ([I8](../edge-cases.md)).
     The exceptions are a tenant-scope erasure request for that tenant, which while it is `erasing`
     returns the running request (`200`) or starts a resumption or continuation (`202`,
     [Privacy § 6.1](privacy.md#61-request)), and `409 tenant_erased` once it is `erased`, for every key
     that may request it; and `POST` and `DELETE …/threads/{thread_id}/hold` on a tenant that is
     `erasing` with held threads, for partner keys with `erasure:manage`
     ([Privacy § 8](privacy.md#8-legal-holds)).
   - **Freeze and read-only.** While `PM_FREEZE = "on"`, every request from a key that is not a platform
     key, and every console request, gets `503 unavailable` (`details.reason = "frozen"`) before this step;
     while the `read_only` switch is `on`, every request other than a `GET` from a non-platform key gets
     `503 unavailable` (`read_only`) ([Observability § 5.6](observability.md#56-automatic-containment)).
     Reads still resolve; for a partner key `GET /v1/tenants/{tenant_id}` and its tenant's erasure
     requests are the reads that remain useful, because the erasure deleted the rest. A platform key's
     write to such a tenant follows the route (a `PATCH` with `status` gets `409 tenant_erased`, a new
     tenant-scope erasure request returns the running one, starts a resumption or continuation (`202`),
     or answers `409 tenant_erased`, [Privacy § 6.1](privacy.md#61-request)).
5. **Body and query parameters naming a tenant or identity** (`tenant_id` in `POST /v1/keys`,
   `POST /v1/erasure-requests`, `POST /v1/exports`, `identity_ids` filters, `tenant_id` filters):
   for non-platform keys, a value outside the key's scope returns `404 tenant_not_found` or
   `404 identity_not_found` (for `POST /v1/keys`, `403 key_scope_exceeded`, as api.md states), in a list
   filter as in a body, never an empty page; for a
   partner key, every tenant whose `partner_id` is not its own is outside its scope. A value
   equal to the key's own scope is accepted. Missing values default to the key's scope; platform and
   partner keys have no default tenant, so on `GET /v1/usage` they must pass `tenant_id`
   (`400 invalid_request`). A list without a `tenant_id` filter returns, for a partner key, only rows of
   its own tenants (`GET /v1/tenants`, `GET /v1/identities`, `GET /v1/keys`, `GET /v1/audit-events`,
   `GET /v1/erasure-requests`).
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
- `webhooks:manage` includes `webhooks:read`. `platform:ops` and `partners:manage` can only be held by
  platform keys; `tenants:manage` by platform and partner keys; `tenants:erase` by platform and partner
  keys and by tenant keys the workspace owner minted (section 4.6).
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
- Resuming an identity paused for `abuse_threshold` requires a tenant, partner or platform key and is
  audit-logged (api.md). On a tenant a partner created it requires a platform key: a partner or tenant
  key gets `403 scope_denied` ([J17](../edge-cases.md)), so a partner cannot reverse the platform's
  abuse controls on its own tenants.
- **Quarantine release by API keys** (FR-CON-6). `POST …/messages/{message_id}/release` with
  `quarantine:review` is allowed when `PM_QUARANTINE_KEY_RELEASE` is `on` (or `PM_CONSOLE=off`), or when
  the message's tenant has `policy.quarantine.key_release: true`; otherwise `403 permission_denied` and
  only a signed-in person can release, in the console. Only a platform key, or the partner key of the
  tenant's own partner, can set that policy field: `PATCH /v1/tenants/{tenant_id}` needs `tenants:manage`,
  which a tenant key can never hold (`403 permission_denied` at step 2), and on
  `PATCH /v1/tenants/{tenant_id}/policy` the field is not writable for a tenant key with `policy:write`
  (`403 scope_denied`, `details.reason = "not_writable"`); the console shows it read-only to every role
  ([Configuration › Tenant policy](../../reference/configuration.md#tenant-policy), [J14](../edge-cases.md),
  [J16](../edge-cases.md)).
- **Decisions reserved for people.** Releasing quarantined mail, loosening a guard field of the policy
  and approving a service account each let mail or codes that nobody reviewed reach agents. One function,
  `auth::people::key_may_decide`, decides for all three whether an API key may take them: only when
  `PM_QUARANTINE_KEY_RELEASE` is `on`, `PM_CONSOLE` is `off`, or the tenant's `quarantine.key_release` is
  `true`; otherwise `403 permission_denied` (for the last two with `details.reason = "person_required"`)
  and a signed-in person decides in the console
  ([Workspace policy §3](workspace-policy.md#3-decisions-reserved-for-people)).

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
| `PM_MASTER_KEY` | Master-key slot `a` (section 6.2): AES-256-GCM encryption at rest of webhook secrets, identity signing keys, the `signing_keys` keyring (the `web_bot_auth` seed included), SMTP relay credentials, TOTP secrets, recovery-code hashes and OAuth PKCE verifiers (section 7.2) | `pmail setup`: 32 bytes from the OS CSPRNG, base64 | Decrypts stolen D1 ciphertexts (needs D1 access too) |
| `PM_MASTER_KEY_B` | Master-key slot `b`: after a rotation either the active key or the previous one (section 6.2) | `pmail secrets rotate-master` | As `PM_MASTER_KEY` |
| `PM_MASTER_KEY_ACTIVE` | Which slot seals new values (`a` or `b`); not a key | `pmail secrets rotate-master` | None on its own |
| `PM_KEY_PEPPER` | HMAC-SHA256 of API key strings | `pmail setup` (section 4.8) | Offline guessing of stolen hashes is still infeasible (256-bit secrets); rotate as break-glass |
| Thread keys (`signing_keys`, purpose `thread`) | HMAC of thread tokens | The Worker: 32 bytes from `platform::Rng`, sealed under `PM_MASTER_KEY` | Forged thread tokens (still rate-limited, still no data access) |
| Link keys (`signing_keys`, purpose `link`) | MACs and keyed hashes on tokens the service issues and later verifies: signed download links, console sign-in, invitation and session tokens, OAuth state hashes, and notification unsubscribe tokens | The Worker, as above | Forged download links; console tokens matched against stolen hashes; forged unsubscribe tokens, which can only turn a notification kind off |
| Cursor keys (`signing_keys`, purpose `cursor`) | MACs on search cursors ([Search › Cursors](search.md#58-cursors-and-as_of-pinning)) and list cursors ([REST API › Pagination](../../reference/api.md#pagination)) | The Worker, as above | Forged cursor positions or `as_of`; scope still comes from the key (SEC-1) |
| The Web Bot Auth key (`signing_keys`, purpose `web_bot_auth`) | Ed25519 signatures on Web Bot Auth HTTP requests and on the key directory | The Worker: a 32-byte seed from `platform::Rng`, sealed under `PM_MASTER_KEY`, created on first use while `PM_WEB_BOT_AUTH=on` | Requests signed as this deployment, naming any of its identities in `From`, until it is rotated with `revoke_previous=true` |
| Identity signing keys (`identity_keys.private_enc`) | Ed25519 signatures on one identity's agent assertions | The Worker: a 32-byte seed from `platform::Rng`, sealed under `PM_MASTER_KEY`, created on the identity's first signing request or by `POST /v1/identities/{identity_id}/keys` | Assertions forged for that one identity until its key is revoked |
| `PM_HASH_KEY` | Pseudonymisation: address tombstones, suppression hashes, counterparty hashes, log pseudonyms | `pmail setup` | Dictionary tests of which addresses are tombstoned, suppressed or erased |
| `PM_CF_API_TOKEN` (optional) | Runtime automation of tenant domains, event subscriptions, REST fallbacks of spike S6 | The operator, in the Cloudflare dashboard | Changes to the account's routing and sending configuration within the token's permissions |
| `PM_SES_ACCESS_KEY_ID`, `PM_SES_SECRET_ACCESS_KEY` (optional) | The SES integration: sending, identities, receipt-rule updates, reading and deleting inbound objects, draining the backstop queue | The operator, in AWS IAM (`pmail setup ses` creates the user with one policy) | Sending through the deployer's SES account; reading inbound mail still in S3 (at most 14 days); nothing outside that one policy |
| `PM_OAUTH_GOOGLE_CLIENT_SECRET`, `PM_OAUTH_GITHUB_CLIENT_SECRET` (optional) | Exchanging an authorization code at that provider's token endpoint | The operator, in the provider's developer console | Acting as the deployment's OAuth client. Signing in as a person still needs that person's code, the PKCE verifier and the browser-bound state |
| `PM_STRIPE_SECRET_KEY` (only with `PM_BILLING=stripe`) | Stripe API calls: create and retrieve Checkout Sessions, create Customer Portal sessions, read subscriptions, cancel subscriptions on workspace deletion ([Billing › Stripe integration](billing.md#stripe-integration)) | The operator, in the Stripe dashboard, as a restricted key (`rk_live_…`) with exactly those permissions | Creating and retrieving Checkout Sessions, creating Portal sessions, and reading and cancelling subscriptions in the deployer's Stripe account, within the restricted key's permissions; no access to Pylota Mail data |
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
| `PM_MASTER_KEY` (two slots, below) | `pmail secrets rotate-master` (below) | No downtime; all ciphertexts re-sealed under the new key; the previous key stays in the other slot for restores |
| Thread key | `POST /v1/platform/keys/thread/rotate` (`platform:ops`) | New tokens carry the new kid at once; tokens with the old kid keep verifying for 90 days ([Threading](threading.md#24-key-rotation)). With `?revoke_previous=true` they stop verifying at once, and replies to them fall back to header threading. No secret value is ever handled by a person |
| Link key | `POST /v1/platform/keys/link/rotate` (`platform:ops`) | Download links, console sign-in tokens, invitations, sessions and OAuth flows with the old kid keep verifying for 7 days (the longest link lifetime), then fail; active console sessions are re-hashed under the new key on their next request. Export links are minted on each `GET /v1/exports/{id}`, so callers fetch a new one. With `?revoke_previous=true` everything under the old kid fails at once: open links, sign-in tokens, invitations and OAuth flows fail, and the sessions hashed under it end (normally all of them, because active sessions are re-hashed under the current key). Reading a link key needs both D1 access and `PM_MASTER_KEY`. Without `revoke_previous`, a leaked key keeps verifying for its 7-day window, so after a suspected leak rotate with `revoke_previous=true`, then rotate `PM_MASTER_KEY` |
| Cursor key | `POST /v1/platform/keys/cursor/rotate` (`platform:ops`) | New cursors carry the new kid; cursors with the old kid keep working for 24 hours (the cursor lifetime). With `?revoke_previous=true` open cursors fail at once with `400 invalid_request` (path `cursor`), and callers repeat the search without a cursor |
| Web Bot Auth key | `POST /v1/platform/keys/web_bot_auth/rotate` (`platform:ops`; `422 web_bot_auth_disabled` while `PM_WEB_BOT_AUTH=off`) | New signatures use the new key at once; the previous key stays in the key directory for 7 days, so requests signed shortly before the rotation still verify. With `?revoke_previous=true` it leaves the directory at once |
| Identity signing key | `POST /v1/identities/{identity_id}/keys/rotate` (`identities:write`; tenant, identity or platform key; or the identity page in the console) | The new key signs at once; the previous one is `retiring` and stays in the JWKS until `verify_until` = now + `PM_IDENTITY_KEY_OVERLAP_DAYS` (default 7) ([O2](../edge-cases.md)). After a suspected leak, `POST …/keys/{kid}/revoke` moves the key to `retired` and removes it from the JWKS at once ([O3](../edge-cases.md)). Key management stays available while the identity is paused |
| OAuth client secrets | Create a new client secret in the provider's console, `wrangler secret put PM_OAUTH_GOOGLE_CLIENT_SECRET` (or `…_GITHUB_…`), then delete the old secret at the provider | Sign-ins that are mid-flow during the switch may fail and are retried by the person. Whether a provider keeps two secrets valid at once: verify at build time |
| SMTP relay credentials | `PATCH /v1/domains/{domain_id}` with `smtp` (tenant, partner or platform key with `domains:write`) | The new values are kept pending until a probe passes; the old ones are used until then |
| TOTP secret, recovery codes | At `/console/settings/security`, with re-authentication: turn two-step verification off and enrol again, or generate new recovery codes | The old secret or codes stop working at once |
| `PM_KEY_PEPPER` | Break-glass: `pmail setup --rotate-pepper` (a new pepper and a new bootstrap key in one step, section 4.8), then reissue every key | Every existing key stops working immediately |
| `PM_HASH_KEY` | Not rotatable in v1.0 | Tombstones, suppressions and erasure records would stop matching, which would let an erased address be reassigned (A5). A rotation needs a re-keying migration and an ADR |
| `PM_CF_API_TOKEN` | Create a new token with the same permissions, `wrangler secret put PM_CF_API_TOKEN`, revoke the old token | No downtime |
| SES keys | Create a second IAM access key, put both secrets, deactivate then delete the old key | No downtime |
| `PM_STRIPE_SECRET_KEY` | In the Stripe dashboard, **Rotate key** with an expiration (both keys work for up to 7 days), `wrangler secret put PM_STRIPE_SECRET_KEY`, then let the old key expire ([API keys › Rotate an API key](https://docs.stripe.com/keys#rolling-keys), read 2026-10-09) | No downtime |
| `PM_STRIPE_WEBHOOK_SECRET` | In the Stripe dashboard, **Roll secret** on the endpoint and keep the old secret for up to 24 hours, then `wrangler secret put PM_STRIPE_WEBHOOK_SECRET` inside that window. Stripe signs with every active secret, and the verifier accepts any matching `v1` ([Webhooks › Roll endpoint signing secrets](https://docs.stripe.com/webhooks#roll-endpoint-secrets), read 2026-10-09) | No downtime; no event is rejected |

**Master-key slots.** The master key has two secret slots and a selector, so a rotation never needs to
move or read back a key value:

- `PM_MASTER_KEY` is slot `a` (written by `pmail setup`) and `PM_MASTER_KEY_B` is slot `b`;
- `PM_MASTER_KEY_ACTIVE` (a Worker secret holding `a` or `b`; absent means `a`) names the slot that
  seals. It is a secret rather than a `[vars]` entry so that the CLI can change it with
  `wrangler secret put`, which deploys a new version without a build;
- the Worker opens a ciphertext with whichever slot's key ID matches the envelope's `kid` (section 7.2),
  and seals every new value with the active slot. A ciphertext whose `kid` matches neither slot does not
  open (`secret_unavailable`);
- startup rule ([Rust workspace › Startup rules](rust-workspace.md#61-errors-and-configuration)): the active
  slot must hold a 32-byte key, and when both slots are set their key IDs must differ; otherwise the
  configuration is invalid (`config_invalid`).

A rotation writes the new key into the inactive slot and then switches `PM_MASTER_KEY_ACTIVE`, so the
previous key stays in the other slot until the next rotation overwrites it.

**`pmail secrets rotate-master`** ([CLI and setup §12.1](cli.md#121-secrets-rotate-master)):

1. The CLI reads `master_key` from `GET /v1/platform/status`: the active slot, each slot's presence and
   key ID, `remaining` (sealed values whose `kid` is not the active key's, counted by the Worker over
   the sealed-column registry `crates/core/src/sealed.rs`) and `activated_at` (when the Worker first
   saw the active key ID: the every-minute cron writes the audit row `master_key.activated`, target the
   key ID, whenever the active key ID differs from the latest such row's) and `resealed_at` (when
   `remaining` first reached 0 under the active key: the same cron writes `master_key.resealed`, target
   the key ID, once per key).
2. `remaining > 0` means the previous rotation's sweep has not finished. The CLI refuses unless
   `--resume` is given, which skips to step 5: the new key is already in its slot, so nothing needs to
   be known or generated again.
3. When the inactive slot holds a key and `resealed_at` is less than 30 days ago, the CLI refuses unless
   `--discard-previous` is given (the first rotation, into an empty slot, is never refused).
   The inactive slot holds the key that sealed values in D1 until the previous re-seal finished at
   `resealed_at`, and a D1 Time Travel restore reaches back 30 days: overwriting that key would leave a
   restore to any earlier point unable to open the values still sealed with it. `--discard-previous` (after a suspected leak of the
   previous key) prints that consequence and continues.
4. The CLI generates `K2` (32 bytes from the OS CSPRNG), writes it to the inactive slot with
   `wrangler secret put` (value on stdin), drops it from memory, then writes that slot's letter to
   `PM_MASTER_KEY_ACTIVE`. Each `wrangler secret put` deploys a new version; in this order every version
   that seals with `K2` also holds the previous key, so every value opens throughout the rollout.
5. The Worker's every-minute cron re-seals up to 500 values per run whose `kid` is not the active
   key's (about 720,000 a day), in every column of the registry: for v1.0,
   `webhook_endpoints.secret_enc`, `webhook_endpoints.prev_secret_enc`, `identity_keys.private_enc`,
   `signing_keys.ciphertext`, `domains.smtp_sealed`, `domains.smtp_pending_sealed`, `users.totp_sealed`,
   `users.recovery_codes_sealed` and `oauth_states.pkce_sealed` (section 7.2). It logs
   `secrets_reseal_progress` counts. The CLI polls `GET /v1/platform/status` every 60 seconds and prints
   `remaining` with an estimate (`remaining / 500` minutes) until it is 0. There is no deadline:
   interrupting the CLI changes nothing, and `--resume` goes back to polling.
6. The CLI prints the new key ID and the first date a next rotation is allowed without
   `--discard-previous` (30 days after `resealed_at`).

`PM_MASTER_KEY_B` and `PM_MASTER_KEY_ACTIVE` are listed in
[Configuration › Secrets](../../reference/configuration.md#secrets). `pmail doctor` warns while
`remaining > 0` (an unfinished rotation) and fails when the active slot is empty.

**Restores and rotation.** A D1 Time Travel restore to a point before the last rotation brings back
values sealed under the previous key, which the inactive slot still holds; the sweep then re-seals them
under the active key. Because a rotation within 30 days of the previous re-seal's end needs `--discard-previous`,
every restore inside D1's 30-day window can open its sealed values unless the operator chose otherwise
after a leak ([Observability › Restore from PITR](observability.md#restore-from-pitr)).

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
`domains.smtp_pending_sealed`, `users.totp_sealed`, `users.recovery_codes_sealed` and `oauth_states.pkce_sealed`. Each is an
entry of the sealed-column registry `crates/core/src/sealed.rs` (table, column, row-ID expression), which
the master-key rotation reads to re-seal and count them (section 6.2); code that adds a sealed column adds
its entry.

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
        | "l1:{kid}:export:{tenant_id}:{export_id}:{expires_unix_s}"    -- export: at most 1 hour ahead
kid     = the one-character kid of the link key that signed it (signing_keys, purpose link)
```

- The handler splits the token, reads the kid, looks up that link key (current, or still inside its
  verify window), recomputes the MAC and compares it in constant time, then checks the expiry and that
  the target still exists. An unknown or expired kid, a bad MAC, an expired link or a missing target all
  return `404` with the target's `*_not_found` code (`attachment_not_found` or `export_not_found`), so a
  link reveals nothing about why it failed.
- No API key is needed: the MAC authenticates the link. The response uses the serving headers of
  section 8.5. The route is `GET /v1/links/{token}` in [REST API](../../reference/api.md#signed-links-and-provider-hooks).
- A link is a bearer URL that cannot be recalled once copied, so export links expire one hour after they
  are minted (a new one on every `GET /v1/exports/{export_id}`), and `DELETE /v1/exports/{export_id}`
  revokes every link of an export at once by deleting its target ([Privacy › Download link](privacy.md#94-download-link)).

## 8. Untrusted content

### 8.1 What is untrusted

Everything from mail (headers, display names, subjects, bodies, filenames, attachment text, DSN text),
provider responses (`smtpResponse`, error messages), DNS answers, RDAP data and webhook endpoint
responses. Untrusted strings are stored and returned, but never used as instructions, file paths,
header values or SQL.

### 8.2 Sanitising and normalisation

The [Inbound pipeline](inbound.md) owns the details. The security properties:

- HTML is sanitised with `ammonia =4.2.0` using an allow-list: no scripts, event handlers, forms,
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

`GET …/attachments/{attachment_id}` and `GET …/messages/{message_id}/raw`, and the console's
session-authenticated attachment route ([Console › Showing untrusted mail](console.md#showing-untrusted-mail)),
respond with:

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
| Requests per tenant, all its tenant and identity keys together | 1,800 / 60 s | `RL_TENANT`, keyed by tenant ID, on top of `RL_API` ([J22](../edge-cases.md)) | `429 rate_limited` (`details.bucket = "tenant"`) |
| Requests per partner, all its partner keys together | 1,800 / 60 s | `RL_PARTNER_API`, keyed by partner ID, on top of `RL_API` ([J22](../edge-cases.md)) | `429 rate_limited` (`details.bucket = "partner"`) |
| Active keys | 100 tenant and identity keys per tenant; 10 partner keys per partner (neither revoked nor expired) | Checked in the `api_keys` insert (section 4.6) | `422 key_limit_reached` |
| Failed authentications | 600 / 60 s per client | `RL_API`, keyed by `anon:` + HMAC(`PM_HASH_KEY`, `CF-Connecting-IP`) truncated to 16 hex; the IP is never logged | `429 rate_limited` |
| Search per key | 120 / 60 s | `RL_SEARCH` | `429 rate_limited` |
| Agentic search | 20 / 60 s per key; tenant daily cap (default 500) | `RL_AGENTIC`; exact count in `TenantQuota` | `429 rate_limited`, `429 agentic_budget_exhausted` |
| Sends per identity | 120 / 60 s; daily caps from policy | `RL_SEND`; exact daily counters in `TenantQuota` | `429 rate_limited`, `429 daily_cap_reached` |
| Sends when the shared domain is at risk | With `PM_DAILY_SEND_QUOTA` set: at 60% of the day's quota, Free and ramped workspaces stop until 00:00 UTC; at 90%, every tenant does, and the system identity keeps the rest | The `*/15` cron writes `platform_state`; outbound step 18 reads it ([W46](../edge-cases.md)) | `429 daily_cap_reached`, `details.cap: "shared_domain"` |
| Sends of a workspace with a disputed payment | None until the dispute closes | `billing_accounts.dispute_open_at`, outbound step 18 ([W38](../edge-cases.md)) | `429 daily_cap_reached`, `details.cap: "billing_dispute"` |
| Signing per identity (agent assertions and HTTP signatures together) | 600 / 60 s | `RL_SIGN`, keyed by identity ID. Signing is not metered against any plan allowance | `429 rate_limited` |
| Notification emails | 50 per person and 200 per workspace a day, every kind except `account` and `digest` (the `digest` is one email per person a day at most) | The tenant's `Notifier` (`sent` counters, [Notifications §3](notifications.md#3-how-notifications-are-produced)) | Not an error: the overflow goes into the next daily digest ([O24](../edge-cases.md)) |
| Inbound per sender per identity | `inbound.per_sender_per_hour` (default 60) | Mailbox `rate_windows` ([D5](../edge-cases.md)) | Excess stored `throttled` |
| Failed thread-token verifications | 10 per sender per hour, 100 per mailbox per hour | Mailbox `rate_windows` ([Threading](threading.md), [D10](../edge-cases.md)) | Tokens not verified for the rest of the window |
| Domain verification | 1 per minute per domain | `DomainMonitor` | `429 rate_limited` |
| Alignment probe (`smtp_relay`) | 1 per minute per domain | `DomainMonitor` | `429 rate_limited` |
| Console sign-in link or code requests | 3 per 10 minutes per address | `login_tokens` rows ([Console › Sign-in](console.md#sign-in)) | "Too many requests" page, the same for known and unknown addresses |
| Sign-in code attempts | 10 per code; the token is burned after 10 failures | `login_tokens.attempts` | Code refused |
| Failed sign-in codes per address | 30 per UTC day | `SUM(login_tokens.attempts)` for the address since 00:00 UTC ([W43](../edge-cases.md)) | Code refused until 00:00 UTC; links still work |
| Console sign-in, sign-up and waitlist requests per client network | 10 / 60 s on `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-in/verify`, `/console/sign-up` and `/console/waitlist`, and `GET /console/oauth/{provider}/start` | `RL_SIGNIN`, keyed by `CF-Connecting-IP`, an IPv6 address by its /64 prefix; the IP is never logged | `429` page |
| System mail | 10 a UTC day per recipient; sign-in mail 20 per client network and 200 per ASN; invitations 50 per tenant; `invitation` at most 20% and `notification` at most 50% of the system identity's day | Exact counters in the default tenant's `TenantQuota` (`SystemMail`; [Cloud sign-up §10.2](cloud-signup.md#102-system-mail-budgets), [W44](../edge-cases.md)) | Nothing sent (same page); invitations: `429 daily_cap_reached`, `details.cap: "invitations"` |
| Two-step verification codes | 5 attempts a minute per person; 10 failures in a row lock two-step sign-in for 15 minutes | A per-person failure counter ([Cloud sign-up §5](cloud-signup.md#5-two-step-verification)) | Code refused; lock page |
| Sends from a new Free workspace | `tenant_daily_send_cap` 50 for the first 7 days; lifts on day 7 if bounce and complaint rates are under the auto-pause thresholds, or at once on a paid plan | `TenantQuota` ([W30](../edge-cases.md)) | `429 daily_cap_reached` |
| Sends from a new tenant of a partner | The same ramp, whatever `PM_BILLING` and the tenant's billing mode (`exempt` included), unless a platform key set the partner's `ramp_exempt`; an `exempt` tenant has no plan, so only the daily evaluation lifts it | `TenantQuota` ([W30](../edge-cases.md), [Cloud sign-up § 10.1](cloud-signup.md#101-new-workspace-send-ramp)) | `429 daily_cap_reached` |
| Tenant creation and invitations per partner | 10 / 60 s together, across every key of the partner: `POST /v1/tenants` and `POST /v1/tenants/{tenant_id}/invitations` called with a partner key | `RL_PARTNER`, keyed by the partner ID ([J18](../edge-cases.md)) | `429 rate_limited` |
| Tenants per partner | `partners.max_tenants` tenants not `erased` (default 25, set by a platform key) | Checked in the tenant insert ([J18](../edge-cases.md)) | `403 partner_tenant_limit` |

- **Aggregate buckets.** A key's own buckets bound one key, and keys are cheap to mint, so two buckets
  bound the keys of one owner together: every request with a tenant or identity key also counts in
  `RL_TENANT` under its tenant ID, and every request with a partner key in `RL_PARTNER_API` under its
  partner ID. Platform keys count only per key. With the active-key caps of section 4.6, one tenant can
  make at most 1,800 requests a minute however many keys it mints, and one partner at most 1,800 with its
  partner keys plus 1,800 per tenant with its tenants' keys.
- **Partner keys** use the same buckets as platform keys: `RL_API`, `RL_SEARCH` and `RL_AGENTIC` keyed by
  the partner key's own ID, so one partner key's 600 requests a minute cover all of its tenants. The
  per-identity buckets (`RL_SEND`, `RL_SIGN`) and each tenant's exact daily caps in `TenantQuota` apply
  as for every key. A partner that needs more throughput mints tenant keys for its tenants (section 4.6),
  each with its own bucket. `RL_PARTNER` is keyed by the partner, not the key, so minting more partner
  keys does not raise it. Cloudflare's rate-limiting binding accepts only a 10- or 60-second period
  (`simple.period` is `enum [10, 60]` in wrangler's `config-schema.json`, wrangler 4.87.0, read
  2026-10-10), so the daily bound comes from `max_tenants` and the minute bound from `RL_PARTNER`: at most
  10 owner and invitation emails a minute per partner (14,400 a day), which the system identity's own
  daily caps bound again. The aggregate bound for one partner is stated in section 4.6
  ([Partner keys](#partner-keys)).
- The rate-limiting bindings are approximate and per location. Anything that must be exact (daily send
  caps, the agentic budget, abuse windows) is counted in `TenantQuota`.
- **Headers.** A binding's `limit()` answers only allow or deny, so the Worker cannot report what is left.
  Every authenticated response carries `RateLimit-Limit`: on a `429`, the limit of the bucket that
  refused; otherwise the limit of the route's per-key bucket (`RL_API`, or `RL_SEARCH` and `RL_AGENTIC` on
  search routes). A Worker cannot read a binding's configuration, so the limits are constants compiled
  into `worker::ratelimit`, and `xtask::ratelimit_limits_match_template` fails when a constant differs
  from the `simple.limit` of its binding in `deploy/wrangler.toml.tmpl`. A `429 rate_limited` also
  carries `Retry-After` and `RateLimit-Reset`, both the seconds to the end of the current period, computed from the clock as
  `period − (now_s mod period)`. `RateLimit-Remaining` is never sent
  ([REST API › Rate limits](../../reference/api.md#rate-limits)).
- **Abuse auto-pause** (FR-DLV-3): `TenantQuota.outcomes` keeps the last 1,000 outcomes per identity.
  When the complaint rate over the last 1,000 exceeds `abuse.complaint_rate_pause` (default 0.003), or
  the bounce rate over the last 200 exceeds `abuse.bounce_rate_pause` (default 0.05), the identity is
  paused with reason `abuse_threshold` and `identity.paused` is emitted with the metrics. This applies to
  every identity except the system identity (`is_system = 1`), whose outcomes are recorded but never
  pause it: pausing it would stop every sign-in, invitation and notification email
  ([Outbound › Abuse auto-pause](outbound.md#abuse-auto-pause-fr-dlv-3)).
- **Kill switches.** Revoke a key (`DELETE /v1/keys/{id}`, immediate). Pause an identity
  (`PATCH … {"status": "paused"}`): besides stopping its sends, this stops it signing at once
  (`409 identity_paused`) and withdraws its JWKS (`404 identity_not_found`), so verifiers stop accepting
  its assertions within the 5-minute JWKS cache (FR-IDN-9, [O1](../edge-cases.md)). Revoke one identity
  key (`POST /v1/identities/{identity_id}/keys/{kid}/revoke`) to withdraw that key alone. Suspend a
  tenant (`PATCH /v1/tenants/{id} {"status": "suspended"}`): every send is refused at once, inbound gets
  a temporary failure, and every identity of the tenant is paused, so the same signing stop applies.
  Suspend a partner (`PATCH /v1/partners/{partner_id} {"status": "suspended"}`): its keys and every API
  key of its tenants get `403 partner_suspended`, and deliveries to its and its tenants' endpoints are
  held ([J13](../edge-cases.md)). Stop signed HTTP requests for the whole deployment with `PM_WEB_BOT_AUTH=off`. Stop
  writes from every non-platform key with the `read_only` switch, and sends from Free and ramped
  workspaces with `free_sending off` (`pmail ops switch`; both are also set automatically,
  [Observability § 5.6](observability.md#56-automatic-containment)). For a platform-wide stop that loses
  nothing, freeze the deployment (`pmail ops freeze`), or roll back the Worker version with `npx --yes wrangler@4.139.0 rollback`.
- **Platform domain reputation.** Per-identity caps, complaint and bounce auto-pause, a DMARC policy
  ramped from `p=none` to `p=reject` on the platform domain, and custom domains encouraged (PRD risk
  table).

## 11. Supply chain

| Control | Rule |
|---|---|
| Exact pins | Every Cargo dependency is pinned `=x.y.z` (AGENTS.md); `Cargo.lock` is committed; every build and install uses `--locked`. `rust-toolchain.toml` pins the toolchain. The CLI invokes `npx --yes wrangler@4.139.0`, never an unpinned wrangler. Workflows that deploy with a secret install Wrangler from a committed lockfile with integrity hashes (`npm ci`), never by name at run time (Site deploy, below) |
| `cargo deny check` | In CI on every pull request: advisories, licences (allow-list: Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, Unicode-3.0, MPL-2.0; everything else needs an ADR), bans (no `openssl-sys`; `tokio` only as a direct dependency of `worker`, which depends on it with no features: `{ crate = "tokio", wrappers = ["worker"] }`; no duplicate versions of `sha2`, `hmac` or `aes-gcm`), sources (crates.io only, no git dependencies). Bans are checked on the Worker's wasm graph (`cargo deny --manifest-path crates/worker/Cargo.toml --target wasm32-unknown-unknown --exclude-dev check bans`), because the native crates use tokio legitimately (`reqwest` in `sdk` and `cli`, `rmcp` as a dev-dependency); licences, advisories and sources over the whole workspace (`cargo deny --workspace check licenses advisories sources`). The flags are checked against the pinned `cargo-deny` at build time. `deny.toml` sets `[graph] targets` to the targets actually built (`wasm32-unknown-unknown` for the Worker; `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` and `x86_64-pc-windows-msvc` for the CLI), so dependencies of other targets are ignored: cargo-deny drops a dependency link that none of the listed targets satisfies (cargo-deny configuration, "The `[graph]` field", <https://embarkstudios.github.io/cargo-deny/checks/cfg.html>, read 2026-10-10). `webpki-root-certs` (the Mozilla root certificates as data; CDLA-Permissive-2.0 on crates.io for 1.0.7 to 1.0.9, read 2026-10-10) is allowed for that crate alone with `[[licenses.exceptions]] allow = ["CDLA-Permissive-2.0"] name = "webpki-root-certs"` (cargo-deny licences configuration, <https://embarkstudios.github.io/cargo-deny/checks/licenses/cfg.html>, read 2026-10-10), never through the general allow-list; this sentence is the record the allow-list rule asks for. Which crate pulls it in on wasm32 is not verified here; `cargo deny` reports the path on the first run of M0 `cargo xtask check-layering` also proves that tokio has no feature enabled in that graph ([Rust workspace §2](rust-workspace.md#2-crate-responsibilities-and-allowed-dependencies)) |
| `cargo audit` | RustSec advisories on every pull request and daily on `main`; a new advisory opens an issue |
| SBOM | `cargo cyclonedx --format json` for the Worker (`--target wasm32-unknown-unknown`) and for the CLI, attached to every release |
| Signed releases | `SHA256SUMS` lists the Worker bundle and CLI binaries and has a detached minisign signature `SHA256SUMS.sig` with the trusted comment `pylota-mail v{version}` ([Rust workspace](rust-workspace.md#9-xtask)). The verification keys are compiled into `pmail`, which checks the signature, the trusted comment and the bundle checksum before deploying (FR-OPS-2; signature format and verification in [CLI and setup](cli.md)). Releases carry build provenance from `actions/attest@v4` (permissions `id-token: write`, `attestations: write`, `contents: read`), verifiable with `gh attestation verify <file> -R PILOTAAI/pylota-mail`. **The signing key never enters CI** or any online system: the minisign secret key lives on an encrypted removable drive, with a second drive at the break-glass record's location and the password in the owner's password manager ([Observability § 5.7](observability.md#57-break-glass-record)). `release.yml` builds and attests the files, uploads them with `SHA256SUMS` to a draft release, and stops. The owner runs `cargo xtask release sign v<x.y.z>` on their own machine with the drive attached: it downloads `SHA256SUMS` and every file it lists, checks each checksum and each file's attestation (`gh attestation verify`, whose provenance must name `release.yml` on that tag), and only then signs, uploads `SHA256SUMS.sig` and starts `release-publish.yml` on the tag. That workflow's `verify` job checks the signature against the public keys compiled into `pmail` before the draft becomes a pre-release, and its `publish` job promotes it only through `cargo xtask release-gate` (section 16) ([Rust workspace › CI pipeline](rust-workspace.md#10-ci-pipeline)). A compromised CI can build and attest a bad release but cannot sign it, and the owner signs only files whose provenance is the tagged workflow. There is no second signer ([ADR 0015](../adr/0015-solo-operator.md)): the attestation check is the mechanical second look |
| Site deploy (`.github/workflows/site.yml`) | The landing page and docs Worker `pylota-mail-site` is deployed with Wrangler installed from `site/package-lock.json` by `npm ci --ignore-scripts` (exact `wrangler` 4.139.0, every package with its `integrity` hash), never fetched by name at run time. Its token, the `production` environment's `CLOUDFLARE_API_TOKEN`, is an account-owned token scoped to the single Worker `pylota-mail-site` with the per-Worker **Editor** role, plus **Zone (pylotamail.com) › Workers Routes › Edit**, and nothing else: no account-wide Workers Scripts Edit (in Pylota's shared account that would reach every Worker) and no DNS Edit. Custom Domains that already exist need only Editor to redeploy; adding, changing or removing one needs Workers Routes Write on the zone (Cloudflare "Workers roles and permissions" and the changelog "Grant teammates and agents access to specific Workers", 2026-09-15, both read 2026-10-10). Editor cannot create a Worker, so the first deploy of a new site Worker is done once by hand with a wider token |
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
| `it::auth::rate_limited` | `429 rate_limited` with `Retry-After`, including the 601st signing call in a minute for one identity (`RL_SIGN`) and the 601st request in a minute from one partner key across two of its tenants (`RL_API`, keyed by the key ID); failed authentications are limited per client without logging the IP | section 10 |
| `it::keys::scope_exceeded` | Every row of the scope table in section 4.6 (step 3), plus permissions wider than the caller's → `403 key_scope_exceeded`. Managing existing keys: a tenant key with `keys:manage` and three permissions gets `403 key_scope_exceeded` on `GET`, `DELETE` and `POST …/rotate` of a tenant key of its tenant holding `identities:sign`, of one holding `erasure:manage` and of the owner's key holding `tenants:erase`, and the target is unchanged (its old secret still works, no audit row); an identity key gets `404 key_not_found` for a tenant key and for another identity's key of its tenant, and rotates its own key; a partner key gets `404 key_not_found` for a platform or partner key and rotates a tenant key of its tenant holding `identities:sign`; a platform key with `keys:manage` alone gets `403 key_scope_exceeded` for a platform key holding `platform:ops`; `GET /v1/keys` lists only the keys that pass both checks | FR-KEY-1, SEC-2, [J20](../edge-cases.md) |
| `it::keys::permission_level_rules` | Section 4.6, steps 1 to 3: `permissions` missing or empty (every level, `platform` included) → `400 invalid_request`; `identities:sign` on a platform key, a tenant-only permission on an identity key, `tenants:erase` on an identity key, and `tenants:manage` or `platform:ops` on a tenant or identity key → `400 invalid_request` with `details.reason = "permission_not_allowed_for_level"`, even from a caller that holds the permission; `tenants:erase` on a tenant key minted by a platform or partner key, or by a key whose `created_by_role` is not `owner` → `400 invalid_request` with `details.reason = "permission_owner_only"`; a platform key without `identities:sign` mints a tenant key and an identity key holding it, the `key.create` row has `details.granted_without_holding = ["identities:sign"]`, and the identity key signs an assertion. The `GET /v1/usage` part (added with M22's route): a tenant or identity key holds `usage:read` implicitly and reads its own usage; a platform key needs `usage:read` listed and `tenant_id` passed | FR-KEY-1, SEC-2 |
| `it::messages::list_hides_review_statuses` | A message list never shows `quarantined`, `hidden` or `throttled` mail without a `status` filter, also to a key holding `quarantine:review`; with the filter, only a key holding `quarantine:review` sees them, and any other key gets `200` without them; a thread list never shows them | section 5.3, FR-IN-5 |
| `it::keys::j6_revoke_rotate` | Revocation is immediate; rotation overlaps; audit rows name the actor | [J6](../edge-cases.md) |
| `it::keys::j11_partner_key_limits` | A partner key asking for a `partner` or `platform` key, or for a tenant or identity key of a tenant outside its partner, gets `403 key_scope_exceeded`; `platform:ops`, `partners:manage` or `identities:sign` on a partner key gets `400 invalid_request` (`permission_not_allowed_for_level`) from any caller; a partner key without `identities:sign` mints a tenant key and an identity key of its own tenant holding it (`details.granted_without_holding` in `key.create`), but not `tenants:erase` on a tenant key (`permission_owner_only`); a tenant or identity key cannot list `partner_id` or ask for `level: partner`; a platform key mints a partner key with `partner_id` (`404 partner_not_found` for an unknown one), and `key.create` and `key.revoke` rows record `level` and `partner_id` | FR-KEY-1, FR-KEY-4, [J11](../edge-cases.md) |
| `it::partners::routes_and_audit` | The five partner routes need a platform key with `partners:manage` (a partner key gets `403 permission_denied`); create, update and delete write `partner.create`, `partner.update` and `partner.delete`; a tenant created by a partner key has `partner_id` and the partner's `default_billing_mode`, and writes `tenant.create` with that `partner_id`; a partner key sending `billing` in `POST /v1/tenants`, or calling `PATCH /v1/tenants/{own}/billing`, gets `403 scope_denied`; a partner key may set `quarantine.key_release` in the `policy` of `POST /v1/tenants`; `GET /v1/tenants` with a partner key lists only its tenants; changing `default_billing_mode` leaves existing tenants' billing modes unchanged; idempotency records of a partner key's `POST /v1/tenants` are scoped to its partner and its key, so another partner's key, or another key of the same partner, sending the same `Idempotency-Key` and body gets no replay: its request runs and gets `409 slug_taken`, because slugs are unique across the deployment | FR-KEY-4 |
| `it::partners::policy_caps_lower_only` | For every field of each class of [Configuration › Who may change a field](../../reference/configuration.md#who-may-change-a-field), in the `policy` of `POST /v1/tenants` and of `PATCH /v1/tenants/{tenant_id}`: a partner key lowers a lower-only field (`tenant_daily_send_cap`, an `abuse` threshold, `retention.raw_days`, `auto_reply.max_automatic_exchanges`) and turns off a cost switch (`inbound.extract_image_text`, `triage.enabled`, `search.agentic_enabled`); raising one above the deployment default (the built-in defaults merged with `PM_DEFAULT_POLICY`), or turning a switch on that the default has off, gets `403 scope_denied` with `details.field` and stores nothing, also when other fields of the write are valid; a field absent from the write is not compared; a platform-only field (`web_bot_auth.allowed`, `domains.allow_create_zone`, `domains.cloudflare_zones`) gets `403 scope_denied` with `details.field`; a free field is accepted; a platform key raises a lower-only field; an identity's `send_policy.daily_cap` above the tenant's effective `identity_daily_send_cap` gets `403 scope_denied` with `details.field = "send_policy.daily_cap"` from a partner, tenant or identity key, on `POST …/identities` and `PATCH /v1/identities/{identity_id}`, and is accepted from a platform key | FR-KEY-4, FR-TEN-2 |
| `it::partners::j10_foreign_partner_not_found` | A partner key against another partner's tenant, a tenant no partner created, the identities, messages, domains, keys and endpoints inside them, and another partner's endpoints and keys, gets the same `404 …_not_found` as for a missing ID, with no side effect | FR-KEY-4, NFR-SEC-1, [J10](../edge-cases.md) |
| `it::partners::j12_delete_with_tenants` | `DELETE /v1/partners/{partner_id}` gets `409 partner_has_tenants` while one of its tenants is `active`, `suspended` or `erasing`, and changes nothing; once all are `erased` it soft-deletes the partner (`status: "deleted"`, empty `name`), revokes and deletes its keys (their next request is `401 unauthenticated`), deletes its endpoints and their deliveries, and leaves `partner_id` unchanged on the erased tenants; `GET /v1/partners/{partner_id}` shows it `deleted`, and `PATCH`, a second `DELETE` and a key mint for it get `404 partner_not_found` | FR-KEY-4, [J12](../edge-cases.md) |
| `it::partners::j13_suspended_partner` | With the partner `suspended`, each of its keys and every tenant and identity key of its tenants gets `403 partner_suspended` on every route, `GET /v1/me` included, and no send is accepted for those tenants; their status does not change and inbound mail to them is stored; deliveries to the partner's endpoints and to its tenants' endpoints are held with no attempt recorded; `active` again restores every key and the held deliveries are sent | FR-KEY-4, [J13](../edge-cases.md) |
| `it::partners::j17_operator_enforcement` | A partner key setting `status: "active"` on a tenant a platform key suspended gets `403 scope_denied` with `details.field = "status"`, and lifts its own suspension; a partner key setting `status: "suspended"` on a tenant a platform key suspended leaves `suspended_by: "platform"` and `suspended_at` unchanged, so its `status: "active"` that follows still gets `403 scope_denied`; a platform key's suspension of a tenant the partner suspended makes `suspended_by` `platform`; after a platform key sets `tenant_daily_send_cap` to 200 on a partner's tenant, the partner key may set at most 200 (`403 scope_denied` at 201) even though the deployment default is 5,000; a platform `null` removes the ceiling; resuming an identity paused for `abuse_threshold` on a partner's tenant gets `403 scope_denied` from the partner key and from a tenant key, and works with a platform key | FR-KEY-4, [J17](../edge-cases.md) |
| `it::partners::j18_partner_limits` | With `max_tenants` 2, a partner's third tenant gets `403 partner_tenant_limit`, also when two creations race for the last place (exactly one succeeds); an `erased` tenant frees its place; the eleventh tenant creation or invitation in a minute across two keys of one partner gets `429 rate_limited` (`RL_PARTNER`, keyed by the partner); only a platform key sets `max_tenants` and `ramp_exempt` (a partner key cannot reach `/v1/partners`) | FR-KEY-4, [J18](../edge-cases.md) |
| `it::idempotency::j19_per_key_no_secret` | A replay needs the same key: a second key of the same tenant or partner sending the same `Idempotency-Key` gets no replay; a replay of `POST /v1/keys`, `POST /v1/keys/{key_id}/rotate`, `POST /v1/webhooks`, `POST /v1/tenants/{tenant_id}/webhooks` and `POST /v1/webhooks/{webhook_id}/rotate-secret` returns the stored body without `secret` and with `"secret_replayed": false`; no `idempotency_records.response_body` contains a secret | FR-KEY-2, FR-WH-2, [J19](../edge-cases.md) |
| `it::quarantine::j14_key_release_policy` | Only a platform key or the tenant's own partner key sets `quarantine.key_release`; a tenant key gets `403 permission_denied` on `PATCH /v1/tenants/{tenant_id}`, and on `PATCH /v1/tenants/{tenant_id}/policy` `403 permission_denied` without `policy:write` and `403 scope_denied` (`details.field = "quarantine.key_release"`, `reason = "not_writable"`) with it; the policy is unchanged; another partner's key gets `404 tenant_not_found` | FR-CON-6, [J14](../edge-cases.md) |
| `it::quarantine::j16_key_release_override` | With `PM_QUARANTINE_KEY_RELEASE=off`, a key with `quarantine:review` (a tenant key, an identity key and the partner key) releases mail of a tenant whose policy has `quarantine.key_release: true`, writing `quarantine.release` with the key; on a tenant without it every key gets `403 permission_denied`; with `on`, the policy changes nothing | FR-CON-6, [J16](../edge-cases.md) |
| `it::security::cross_tenant_matrix` | Section 5 matrix: every route × every foreign key class, the `foreign_partner` class included → `*_not_found`, `scope_denied`, or `permission_denied` where the control call gets the same body, identical to a missing ID, no side effects; REST and MCP ([Testing §7](testing.md#7-cross-tenant-attack-suite)) | NFR-SEC-1, FR-KEY-3, FR-KEY-4, FR-TEN-1 |
| `it::security::route_table_complete` | Every entry of `GET /__test/routes` appears in the matrix; every route has a permission and scope | SEC-1 |
| `it::routes::unknown_route_and_method` | An unknown path gets `404 route_not_found`, an API path on the console host and a console path on the API host too (two hosts); `PUT /v1/keys` gets `405 method_not_allowed` with `Allow: GET, POST`, and `GET /mcp` a `405` with an empty body and `Allow: POST`; none needs a key, and the bodies are the same with and without one | section 5.1 |
| `it::auth::missing_permission` | A key lacking a route's permission gets `403 permission_denied` with `details.required` naming it, on a real and on a missing target alike | section 5.2 |
| `it::keys::w35_tenant_erase_owner_only` | A tenant-scope erasure request with `erasure:manage` but without `tenants:erase` gets `403 permission_denied` (`details.required = ["tenants:erase"]`) and starts nothing, from an admin's console key and from keys it minted; the owner's console session mints a tenant key with `tenants:erase`, which erases the tenant and mints a child that may hold it too; an admin's session cannot list it; a partner key with both permissions erases its own tenant | section 4.6, [W35](../edge-cases.md) |
| `it::members::w36_removed_member_keys_revoked` | Keys an admin minted in the console, and a key one of them minted, record the admin's `created_by_user_id`; removing the admin, or the admin leaving, revokes all of them in the removal batch (`401 key_revoked` next, `key.revoke` rows with `creator_removed`) and no other key; making an admin a member revokes their keys holding a permission a member lacks and keeps the others; an ownership transfer revokes the former owner's keys holding `tenants:erase` | section 4.6, [W36](../edge-cases.md) |
| `it::auth::j22_tenant_aggregate_limits` | Four tenant keys of one tenant together get `429 rate_limited` (`details.bucket = "tenant"`) on the 1,801st request in a minute although each is under 600; three partner keys of one partner the same with `details.bucket = "partner"`; the 101st active key of a tenant and the 11th partner key of a partner get `422 key_limit_reached`, also when two mints race for the last place (exactly one succeeds); a revoked or expired key frees its place | section 10, [J22](../edge-cases.md) |
| `it::tenants::create_idempotent_replay` | A `POST /v1/tenants` replayed with the same `Idempotency-Key` and body returns the stored `201` body with `Idempotent-Replayed: true` and creates one tenant and one `TenantQuota`; a changed body gets `409 idempotency_conflict`; `owner` and `billing` are stored but send no mail and change no limit | section 4.6, M5 |
| `worker::quota::stub_answers_every_variant` | The M5 `TenantQuota` stub answers every `QuotaRequest` variant with the answer type of [Outbound › TenantQuota](outbound.md#tenantquota) as the build plan's stub table says, and refuses each one before `Init` and for a mismatched owner | section 5.2, M5 |
| `it::keyring::one_key_per_purpose_concurrent` | Ten concurrent first uses of each `signing_keys` purpose leave exactly one key per purpose, and every token minted during the race verifies | section 6.2, M5 |
| `xtask::ratelimit_limits_match_template` | Each compiled-in `RateLimit-Limit` constant equals the `simple.limit` of its binding in `deploy/wrangler.toml.tmpl`, and every `RL_*` binding has a constant | section 10 |
| `it::security::body_scope_ignored` | `tenant_id` / `identity_id` / `identity_ids` naming another scope in bodies and queries never widen access | FR-KEY-3 |
| `it::security::rpc_owner_mismatch` | A forged envelope (test hook) is refused with `internal_error`, logs `rpc_owner_mismatch`, increments the metric | SEC-1 |
| `it::search::f3_tenant_scope_denied` | Identity key on tenant search → `403 scope_denied` | [F3](../edge-cases.md) |
| `it::security::search_canary_isolation` | A canary term in tenant B's mail is never returned to tenant A in keyword, semantic, hybrid or agentic mode | NFR-SEC-1 |
| `it::security::vector_foreign_id_dropped` | A fake Vectorize result containing another tenant's vector ID is dropped by the mailbox read-back | NFR-SEC-1 |
| `it::security::mcp_requires_key`, `it::security::mcp_tools_follow_key` | No key, no MCP; tools listed and callable only with their permission; with a partner key, tools act only on its own tenants and a `NULL`-partner tenant is unreachable | FR-MCP-1, FR-KEY-4 |
| `core::ssrf::refuses_private_ranges` (with a property test over each range) | Every address in each blocked range (including mapped and embedded IPv4) is refused; public addresses pass | FR-WH-5 |
| `core::ssrf::url_rules` | Section 9.1 rules 1 to 4, including integer, hexadecimal and octal IPv4 literals and `hooks.example.com` allowed | FR-WH-5 |
| `it::webhooks::ssrf_refused`, `it::webhooks::no_redirects_and_caps` | Guard at create and at delivery; `3xx` is a failure and is not followed; 15 s deadline; bodies over 4 KB are cut | FR-WH-5 |
| `it::webhooks::signature_vectors` | Signatures match Standard Webhooks test vectors; both signatures during rotation | FR-WH-2 |
| `core::sns::verify_v2_vectors`, `it::ses::invalid_signature_403` | Real version 2 notifications verify; version 1, a changed byte, a wrong certificate host, a wrong topic and a stale timestamp are refused with `403 invalid_signature`, on both `/hooks/ses` and `/hooks/ses/inbound` ([Outbound](outbound.md), [Domains on any DNS host](domain-connections.md#14-tests)) | spike S8, [N1](../edge-cases.md), [N2](../edge-cases.md) |
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
| `it::security::mail_reads_audited` | A platform key and a partner key reading a message, its raw MIME, an attachment, a thread and a search each write one `mail.read` audit row (target and route, no content) before the response; a tenant or identity key's reads write none; with the audit insert failing, the platform key's read gets `503 unavailable` and returns no content | section 3.6, [ADR 0016](../adr/0016-plan-items-changed-for-v1.md) |
| `it::secrets::master_key_rotation` | With a key in each slot and `PM_MASTER_KEY_ACTIVE` switched to the new one, old and new ciphertexts open, new ones use the new kid; `GET /v1/platform/status` reports `remaining` falling to 0, `activated_at` and then `resealed_at` (a second rotation inside 30 days of `resealed_at` is refused, even when `activated_at` is older); a D1 state from before the rotation (restored from a snapshot) still opens and is re-sealed; with only the active slot set, a ciphertext of the overwritten key reports `secret_unavailable`; and the sweep re-seals every column of the sealed-column registry, with one case per registered column: `signing_keys` (the `web_bot_auth` seed too), the webhook secrets, `identity_keys`, the `domains` SMTP credentials, the `users` second factors and `oauth_states.pkce_sealed`; the registry names exactly the sealed columns of `0001_init.sql` (those ending `_enc` or `_sealed`, and `signing_keys.ciphertext`) | section 6.2 |
| `it::secrets::rotate_master_reseals_identity_keys` | Assertions signed before and after a master-key rotation verify with the same public key and kid | [O8](../edge-cases.md) |
| `core::jwk::thumbprint_rfc8037_vector`, `core::jwt::eddsa_rfc8037_vector`, `core::httpsig::signature_base_rfc9421` | The RFC 8037 thumbprint and signing vectors; RFC 9421 signature bases, an IDN host as its A-label, non-ASCII components refused | section 7.1, [O10](../edge-cases.md) |
| `it::assertions::sdk_verifies` | The SDK verifier accepts a fresh assertion and rejects a wrong audience, an expired token, an unknown kid and `alg: none`; a token whose `sub` is `../../v1/links/{token}?`, or any value not matching `^idn_[0-9A-HJKMNP-TV-Z]{26}$`, is rejected as `Malformed` with no request made (the test's HTTP recorder sees none); a JWKS answer that is a redirect, or whose `Content-Type` is not `application/jwk-set+json`, is rejected and the redirect is not followed | section 3.8, [O27](../edge-cases.md) |
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

Before v1.0 (PRD release criteria 5 and 7) and before every release that is promoted from pre-release,
this checklist is a gate, not a reminder: `cargo xtask release-gate` in the `publish` job of
`release-publish.yml` refuses to promote until `release-gates/v{version}.md`, committed on the tagged commit, ticks every
item below with a link to its evidence, and until the items it can check itself hold (the tag's
`release.yml` gate and this run's staging and live jobs, the SBOMs, signature and attestations on the
release, no open
`fuzz-crash` issue, no open CodeQL alert of high severity; [Rust workspace › xtask](rust-workspace.md#9-xtask)).
The owner ticks the file; there is no second person, so the evidence links are what a later reader, or
an independent agent verifying the release, checks.

- [ ] This threat model reviewed against the code; every finding rated high fixed.
- [ ] An external penetration test completed before v1.0, findings rated high fixed and retested.
- [ ] `it::security::cross_tenant_matrix` and `it::security::route_table_complete` green (NFR-SEC-1 = 0).
- [ ] Every fuzz target clean for 24 cumulative hours on the release commit.
- [ ] `cargo deny check`, `cargo audit` and CodeQL clean (no open high-severity finding).
- [ ] SBOMs of the Worker and the CLI (`cargo cyclonedx --format json`), signed `SHA256SUMS` with the
      trusted comment `pylota-mail v{version}`, and attestations produced by this run; a fresh-account
      `pmail deploy` rehearsal verified them (PRD release criterion 6).
- [ ] The manual live run (`cargo xtask live --manual`) passed on staging with the tagged commit; its date
      is in the gate file.
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
