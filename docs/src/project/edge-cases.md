# Edge-case register

Every row is a required behaviour. The register has 213 rows in 15 sections (A–L, N, O and W). The 207 rows
that Pylota Mail owns (`S` or `S+I`) each name a test; the 6 integrator-owned rows (C5, E6, E7, K1, K2 and
K4) are tested in the integrator's own suites. Section W was section M; it was renamed so that its rows
(W1–W34) can never be mistaken for build-plan milestones (M0–M26).
The **Owner** column says where the behaviour is enforced:

- **S**: Pylota Mail;
- **I**: the integrating application (for example Pylota). The service gives it what it needs, and the
  integrator's own suites test it;
- **S+I**: both.

Each **Test** cell names the planned test:

- `core::` tests are native unit tests in `crates/core`;
- `conf::` tests are corpus cases in `crates/conformance`;
- `cli::` tests are native tests in `crates/cli`, against recorded provider API fakes;
- `it::` tests are integration tests against a local workerd (`cargo xtask itest`);
- `live::` tests run against staging with real mailboxes.

Pull requests that change a behaviour here must update the row and its test in the same change.

## A · Addresses and identity

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| A1 | Case and dots in the local part | Matched case-insensitively and stored lower case. Dots are significant (no provider-style folding) | S | `core::address::a1_case_and_dots` |
| A2 | Plus sub-address `bookings.acme+t03k.9f2mq7xa@` | Routes to the identity. The tag is a thread token only if its HMAC verifies; otherwise it is ignored and the message threads by headers. Tags never change the identity | S | `core::thread_token::a2_*`, `it::inbound::a2_forged_token_ignored` |
| A3 | Internationalised (SMTPUTF8) local parts | Creation refused with `address_unsupported`. Unicode display names allowed | S | `core::address::a3_smtputf8_refused` |
| A4 | Reserved or confusable usernames: `postmaster`, `abuse`, `security`, `support`, `sales`, `info`, `marketing`, `noreply`, `mailer-daemon`, `hostmaster`, `webmaster`, homoglyphs (`rn`/`m`, Cyrillic `а`), mixed scripts | Refused with `address_reserved`. On the shared platform domain every RFC 2142 role name is reserved. Mail to the operational names (`postmaster`, `abuse`, `security`, `hostmaster`, `webmaster`, `noc`) routes to the operator's `PM_SECURITY_CONTACT` (`550 5.1.1` when it is unset); mail to the other role names (`info`, `sales`, `support`, `marketing` and the rest) is rejected `550 5.1.1`, because no identity can own them. On a tenant's own domain only `postmaster` and `abuse` are reserved, and their mail routes to the tenant's owner contact; `support`, `sales`, `info`, `marketing` and the other role names are allowed there. `noreply`, `mailer-daemon` and the service's own names are reserved everywhere | S | `core::address::a4_reserved_and_confusable`, `core::address::a4_role_names_by_domain`, `it::inbound::a4_role_mail_routing` |
| A5 | Reusing a deleted address | Tombstoned permanently (keyed hash), across tenants. Only the original identity may reclaim it, and only while that identity exists | S | `it::identities::a5_tombstone_blocks_reuse` |
| A6 | Mail to unknown, retired, suspended-tenant or erased addresses | Unknown: `550 5.1.1`. Retired: `550 5.1.6`. Suspended tenant: a temporary failure for up to 5 days (`email()` throws, because `setReject` only sends permanent errors; spike S2 records the reply the sender sees), then `550 5.2.1`. Erased: `550 5.1.1`, indistinguishable from unknown. Domains that receive through SES differ: N6, N7, and a suspended tenant's SES mail is held for 5 days, then dropped without a bounce | S | `it::inbound::a6_reject_codes`, `it::ses::suspended_tenant_held` |
| A7 | Paused identity (manual, abuse, tenant) | Inbound still stored. Outbound refused with `identity_paused` | S+I | `it::send::a7_paused_refuses_send` |
| A8 | Identity with no accountable human | Cannot send (`identity_owner_required`) | S | `it::send::a8_owner_required` |
| A9 | One message to two identities in the same tenant (To: bookings, Cc: compliance) | One linked copy per identity, same `raw_sha256`. The `delivered_to` and `is_primary_recipient` fields let the integrator act only on the primary recipient's copy | S+I | `it::inbound::a9_two_identities_two_copies` |
| A10 | Identity BCC'd (envelope recipient not in headers) | Delivered with flag `bcc`. `reply-all` never includes BCC recipients, and never exposes that the identity was BCC'd | S+I | `it::inbound::a10_bcc_copy_flagged`, `it::send::a10_reply_all_excludes_bcc` |
| A11 | A second domain change while the first is still verifying | One pending address per identity and domain. The newer request cancels the older pending one | S | `it::addresses::a11_newer_pending_replaces` |
| A12 | Username and tenant suffix leave no room for a thread token | Refused with `local_part_too_long` (combined maximum 40 characters) | S | `core::address::a12_local_part_budget` |
| A13 | Deleting an identity whose address is the `Reply-To` of in-flight threads | Addresses tombstoned. Later replies get `550 5.1.1` | S | `it::identities::a13_delete_then_reply_rejected` |
| A14 | Promoting a custom address away from the platform address, then trying to retire the platform address | The platform address becomes an `active` alias, not `retiring`. Retiring or deleting it is refused with `409 address_in_use`, because it is the fallback address for domain failures. Promoting it again rolls back | S | `it::addresses::a14_platform_address_kept` |

## B · Inbound content

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| B1 | Larger than 25 MiB | Rejected by Cloudflare before the Worker. Documented in limits | S | `live::inbound::b1_oversize_rejected` |
| B2 | Malformed MIME, missing boundaries, deep nesting | Raw message kept. Best-effort parse with depth 32 and 500 parts. Flag `parse_degraded`. Never dropped | S | `conf::mime::b2_*` (corpus), `core::mime::b2_caps` |
| B3 | Missing `Message-ID`, or duplicate ID with a different body | Missing: synthetic ID `sha256(raw)@synthetic.invalid`, flag set. Same ID and body: deduplicated. Same ID, different body: both kept, flag `message_id_conflict` | S | `it::inbound::b3_*` |
| B4 | HTML-only mail | Text derived from HTML. Sanitised HTML kept | S | `conf::mime::b4_html_only` |
| B5 | Charsets and encodings: Windows-1252, ISO-2022-JP, Shift-JIS, GB18030, encoded-word subjects, quoted-printable, base64 with bad padding | Decoded to UTF-8. Undecodable bytes replaced, flag `parse_degraded` | S | `conf::mime::b5_*` |
| B6 | TNEF `winmail.dat`; forwarded `message/rfc822` | TNEF unpacked where possible (attachments extracted), else kept as an attachment. A forwarded message is parsed as nested, not merged into the outer thread | S | `conf::mime::b6_*` |
| B7 | Inline `cid:` images; remote images | Inline images kept with their Content-ID. Remote content is never fetched by the service | S | `conf::mime::b7_cid`, `core::sanitize::b7_no_remote_fetch` |
| B8 | Calendar invites; read-receipt requests | Invites become `kind: calendar` with a parsed summary and are never auto-accepted. Read receipts (MDNs) are never sent | S+I | `conf::mime::b8_ics`, `core::classify::b8_mdn_request_ignored` |
| B9 | S/MIME or PGP encrypted | Stored, flag `encrypted`, body unavailable. Signed-only messages: content available. v1 stores the signature and never verifies it: `auth_json.signature` is `{type: smime or pgp, status: present_unverified}` | S | `conf::mime::b9_*` |
| B10 | Executables, macro documents, encrypted archives, archive bombs, misleading extensions | `risk` set and message quarantined (`risky_attachment`). The sniffed type wins over the declared type and the extension. Never passed to agents or extraction | S | `core::attach::b10_*` |
| B11 | Hidden text: zero-width characters, white-on-white, `display:none`, tiny fonts, HTML comments | Stripped from agent-facing text (`extracted_text`, snippets, triage input), flag `hidden_text`, risk flag `hidden_text` | S | `core::sanitize::b11_*` |
| B12 | Attachment text extraction fails or times out | The attachment stays fetchable with `text_status: unavailable`. Search reports `attachment_text_unavailable` in `why` when relevant | S | `it::index::b12_extraction_failure` |
| B13 | Mail with no `From`, or several `From` addresses | Stored. `from` is the first parseable mailbox, flag `parse_degraded`. Several From addresses lower the trust verdict | S | `conf::mime::b13_from_anomalies` |
| B14 | Duplicate delivery of the same raw message (sender retry after a timeout) | Deduplicated on `raw_sha256` within the identity. No second event | S | `it::inbound::b14_redelivery_deduped` |

## C · Threading

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| C1 | Reply with no `In-Reply-To` or `References` | Joined by a valid thread token, else a new thread. The subject alone never joins | S | `core::thread::c1_*` |
| C2 | More than 100 `References` entries | Our replies keep the first plus the 19 most recent. We always use `send()`, never `message.reply()`, so its 100-entry limit never applies | S | `core::thread::c2_trim_references` |
| C3 | Reply to an old thread after the address moved | Accepted through the retiring alias. We reply from the address the sender wrote to until it retires, then from the primary | S | `it::addresses::c3_reply_from_retiring` |
| C4 | Two sends into the same thread at once | Per-thread lock in the mailbox. The second waits up to 10 s, then gets `thread_busy` | S+I | `it::send::c4_thread_lock` |
| C5 | New mail arrives while an integrator's draft awaits approval | The integrator marks the draft stale and re-validates. The service exposes `thread.last_inbound_at` and `sequence` | I | integrator |
| C6 | Hand-off between identities (bookings → compliance) | `forward` keeps `References` and adds a transfer note. Or the integrator replies from the new identity in a new thread with an explicit note | S+I | `it::send::c6_forward_keeps_refs` |
| C7 | Outbound `Message-ID` is set by Cloudflare, not by us | We store the provider message ID and learn the header form (spike S7). Replies match by thread token first, then by header ID or provider ID | S | `it::thread::c7_reply_to_cloudflare_message_id`, `live::thread::c7` |
| C8 | Subject changed mid-thread, or `Re:`/`AW:`/`SV:`/`Fwd:` prefixes | Thread membership is unaffected. The normalised subject strips localised prefixes for display only | S | `core::thread::c8_prefixes` |

## D · Authentication, spoofing and abuse

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| D1 | The sender's domain has no DMARC, or `p=none` | No DMARC record: verdict `none`, with DKIM and SPF alignment recorded separately in `auth_json` (`dmarc.aligned_by`). `p=none` that fails alignment: `unaligned`. Never quarantined for that alone. Integrators refuse automations that need authenticity (payments, PCNs) unless the verdict is `pass` | S+I | `core::auth::d1_*` |
| D2 | Display-name spoofing; look-alike domains | Flags `display_name_spoof` / `lookalike_domain` (confusable skeleton compared against known contacts and the tenant's own domains). Trust shows the real address and `known_sender` | S | `core::trust::d2_*` |
| D3 | `Reply-To` differs from `From` | For unknown senders, replies go to `From`. `Reply-To` is used only when the sender is known, or it shares the organisational domain, or the identity has written to it. Flag `reply_to_mismatch` | S | `core::reply::d3_reply_target` |
| D4 | Backscatter: bounces for mail we never sent | A DSN that matches no sent message is dropped and counted (`backscatter_total`) | S | `it::inbound::d4_backscatter_dropped` |
| D5 | Inbound flood from one sender | Per-sender limit per identity (default 60 per hour). The excess is stored `throttled`, hidden from agents, counted, alerted | S | `it::inbound::d5_sender_throttle` |
| D6 | Agent-to-agent ping-pong, auto-replies, out-of-office, mailing lists | RFC 3834 classification plus an `X-Pylota-Mail-Hop` counter. Auto-replies to automated mail are refused. Automatic exchanges per thread are capped (default 2) | S+I | `core::classify::d6_*`, `it::send::d6_exchange_cap` |
| D7 | Mail from a suppressed or receive-blocked address | Stored `hidden` for audit, never shown to agents, never auto-replied to | S | `it::inbound::d7_blocked_hidden` |
| D8 | A request to change bank details or pay urgently | Risk flag `payment_change_request`. The service never acts; the integrator requires human approval | S+I | `core::triage_rules::d8_payment_change` |
| D9 | `Authentication-Results` header forged by the sender | Only the authserv-id in `PM_TRUSTED_AUTHSERV_ID` is trusted, and only the topmost instance. Our own `mail-auth` result always runs | S | `core::auth::d9_forged_ar_ignored` |
| D10 | Thread-token brute force | Tokens are 40-bit HMACs. Failed verifications are rate-limited per sender and flagged `thread_join_unverified`. A token never grants access to data | S | `it::inbound::d10_token_bruteforce` |

## E · Agent behaviour and safety

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| E1 | Prompt injection in the body, subject, display name, filename or attachment text | Content is delivered as untrusted with trust metadata. Triage and the agentic planner receive it fenced. Risk flag `prompt_injection_suspected` from heuristics and the model. Sends go through the integrator's approvals | S+I | `core::injection::e1_*`, `it::agentic::e1_fenced`, `it::triage::e1_fenced` |
| E2 | Mail asks the agent to send data to a new address | With `send_policy.require_known_recipient`, a recipient with no `contacts` history is not sent to: the send is accepted and that recipient's delivery is `suppressed` (`policy: unknown_recipient`), never an error. The integrator gates exfiltration | S+I | `it::send::e2_require_known_recipient` |
| E3 | Bulk or many-recipient sends | `max_recipients` (default 10, maximum 49: Cloudflare's 50 less the journal copy). Per-identity and tenant daily caps | S | `it::send::e3_caps` |
| E4 | Waiting for a verification code | `wait` long-polls with a timeout and an expected-sender filter. Codes are released only for authenticated mail from the expected domain | S | `it::wait::e4_*` |
| E5 | Reset or OTP mail nobody asked for | Quarantined (`otp_unsolicited`) when no `wait` for that sender domain was active in the previous 30 minutes | S | `it::inbound::e5_unsolicited_otp` |
| E6 | A human takes over mid-thread | The integrator pauses the thread. The service offers labels and identity pause | I | integrator |
| E7 | Approval expiry | Integrator-side. The service's `cancel` covers queued mail | I | integrator |
| E8 | AI disclosure | Tenant policy adds a footer or header. The integrator's disclosure rules stay authoritative | S+I | `it::send::e8_disclosure_footer` |

## F · Search

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| F1 | Query syntax injection (FTS5 operators, quotes, `NEAR`, column filters) | Parsed into a typed tree. Every term is quoted for FTS5. Raw input never reaches `MATCH` | S | `core::query::f1_*` (property tests) |
| F2 | A renter- or customer-facing agent tries to search | Only keys with `search:read` can search. Integrators never give such keys to public-facing agents | S+I | `it::auth::f2_permission` |
| F3 | An identity key asks for tenant scope | `403 scope_denied`. Scope comes from the key, never from the body | S | `it::search::f3_tenant_scope_denied` |
| F4 | The semantic index is behind | `semantic_coverage` is reported. Keyword search is never behind | S | `it::search::f4_coverage` |
| F5 | Typos, partial words, plates with or without spaces | Reference normalisation (`AB12CDE` = `AB12 CDE`). Trigram fallback when keyword hits are fewer than 3. Semantic fallback in hybrid mode | S | `core::refs::f5_*`, `it::search::f5_trigram` |
| F6 | Search after an erasure | FTS rows, refs and vectors deleted together. A probe query returns nothing (recorded in the receipt) | S | `it::erasure::f6_probe_empty` |
| F7 | Quarantined mail in results | Excluded unless `include_quarantined` and `quarantine:review` | S | `it::search::f7_quarantine_hidden` |
| F8 | Huge result sets; context overflow | `limit` ≤ 50, `snippet_chars`, `group_by=thread`, a 256 KB cap that sets `truncated` | S | `it::search::f8_budget` |
| F9 | Date filters across time zones | Filters resolve in the tenant time zone to UTC. Results show UTC | S | `core::query::f9_timezone` |
| F10 | Mail tries to steer the agentic planner | The planner sees fenced snippets only, and its tools are read-only. Caller scope and filters cannot be widened. Steering attempts are flagged in the trace | S | `it::agentic::f10_steering` |
| F11 | An agentic answer cites a message that does not support it | The citation verifier removes the sentence and records it in the trace | S | `core::citations::f11_*` |
| F12 | Agentic budget exhausted, or the model is down | `budget_exhausted` with the evidence so far, or `degraded` hybrid results. Never a fabricated answer | S | `it::agentic::f12_*` |
| F13 | A question the mailbox cannot answer | `insufficient_evidence`, listing what was searched | S | `it::agentic::f13_insufficient` |
| F14 | A Vectorize write fails or lags | Retried from the queue. Coverage reflects it. A nightly reconciliation compares chunk counts | S | `it::index::f14_retry_and_reconcile` |
| F15 | A tenant search where one identity's mailbox is slow or unavailable | Partial results with `partial: true` and `failed_identities[]` after a 900 ms per-identity deadline | S | `it::search::f15_partial` |

## G · Outbound and delivery

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| G1 | Idempotency key reused with different content | `409 idempotency_conflict`. Same content returns the original with `deduplicated: true` | S | `it::send::g1_*` |
| G2 | Transport timeout | `uncertain`, never resent. Reconciled from provider events when possible. `resolve` lets a human decide | S+I | `it::send::g2_timeout_uncertain` (simulator `timeout@`) |
| G3 | Provider quota exhausted or rate-limited | Definitely not sent, so the queue backs off and retries for up to 24 h, then `failed: quota_exhausted`. Cloudflare does not expose the daily quota, so the 80% alert needs `PM_DAILY_SEND_QUOTA`; without it the alert fires on the first quota error | S | `it::send::g3_quota_backoff`, `it::ops::provider_quota_80` |
| G4 | One suppressed recipient in a multi-recipient send | Filtered before sending. The rest are delivered, with per-recipient outcomes. When the provider's own suppression rejects the send, we sync its list and resend to the others. This is safe because the rejection is definitive | S | `it::send::g4_partial_suppression` |
| G5 | Attachments that make the composed message larger than 5 MiB less 8 KiB (5,234,688 bytes). Base64 with 76-character lines grows each attachment by about 37%, so the limit is about 3.6 MiB of attachment bytes, less the body | `413 message_too_large` by default. Signed expiring links with `large_attachments: link` | S | `it::send::g5_large_attachment` |
| G6 | Hard bounce, soft bounce, complaint, late bounce | Hard: suppression. Soft: provider retries, then `bounced` (soft). Complaint: permanent suppression and rate tracking, auto-pause at threshold. Late events match by provider message ID | S+I | `it::delivery::g6_*` |
| G7 | Sending from a retiring, pending or failing domain | Retiring: only on threads already using it. Pending: `domain_not_ready`. Failing: fallback to the platform address (or `failed` if fallback is off) | S | `it::send::g7_domain_states` |
| G8 | Delivery event arrives before the send ledger records the provider ID | Delivery consumer retries with a 30 s delay up to 10 times, then parks the event as orphaned and counts it | S | `it::delivery::g8_race` |
| G9 | Marketing vs transactional | Every message is typed. Marketing needs consent, RFC 8058 headers and a visible link | S+I | `it::send::g9_marketing_requirements` |
| G10 | Provider rejects a header or content (`E_HEADER_*`, validation) | `rejected` with `provider_validation`. Never retried | S | `it::send::g10_provider_validation` |
| G11 | Send to an address on the same deployment | Goes out through the transport and back in through Email Routing like any other mail. Test tenants use loopback injection | S | `it::send::g11_loopback` |

## H · Domains and DNS

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| H1 | A record removed after verification | Two resolvers, two consecutive checks, then `failing`. Sending switches to the platform address with thread continuity. Exact fix sent, with reminders | S+I | `it::domains::h1_failing_fallback` (DNS fake) |
| H2 | SPF near the 10-lookup limit, where the record Pylota Mail needs must be merged with an existing one: the zone apex (`inbound = routing`), and the custom MAIL FROM name `pm-bounce.{domain}` of external domains (`dns_records`, `send_only`) | Preflight counts lookups and refuses with `400 spf_lookup_limit` and guidance rather than publish an SPF that fails | S | `core::dns::h2_spf_lookup_count`, `it::ses::h2_mail_from_spf_preflight` |
| H3 | Strict DMARC alignment (`adkim=s`, `aspf=s`) | Preflight checks the alignment tags against the transport's DKIM domain | S | `core::dns::h3_strict_alignment` |
| H4 | The domain expires or changes hands | Weekly NS and RDAP check. A change suspends the domain until ownership is re-proved | S | `it::domains::h4_ownership_change` |
| H5 | A conflicting MX or SPF at the apex (existing mail provider) | Adding a `zone` apex domain with existing MX records refuses unless `"replace_mx": true`, and warns that existing mail would stop. For `dns_records`, see N9 | S | `it::domains::h5_existing_mx` |
| H6 | Literal routing rule creation fails (subdomain domain) | The address stays `pending` with reason `routing_rule_failed`, retried with backoff. It is never marked active without its rule | S | `it::domains::h6_rule_failure` |
| H7 | A single resolver is down or lies | One resolver's error or disagreement never changes state. It records `error` and retries | S | `core::domain_fsm::h7_resolver_disagreement` |
| H8 | A tenant or partner key adds a `cloudflare_zone` domain (or uses `replace_mx`) on a zone of the deployment's Cloudflare account that its tenant does not own: another tenant's zone, the zone of the platform domain, API host or console host, or any unassigned zone; or a `nameservers` or `delegated_subdomain` name inside one of the first two | `403 scope_denied`, `details.reason = "zone_not_allowed"`, before any Cloudflare call or write, with the same body whether or not the zone exists. Allowed only for a zone this deployment created for the tenant (`zone_claims`, written by `nameservers` and `delegated_subdomain`) or one in its platform-only policy `domains.cloudflare_zones`, which grants names strictly under the listed zone, never its apex or `replace_mx` there; a zone claimed by another tenant is refused even when listed. Platform keys may use any zone | S | `it::domains::h8_zone_permission`, `it::security::cross_tenant_matrix` (`foreign_zone`) |

## I · Privacy, retention and erasure

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| I1 | Counterparty erasure | Every message to or from the address across the tenant's identities: rows, attachments, extracted text, FTS, refs, vectors, raw R2 objects, sent copies, outbox events. Receipt with counts and probe results | S+I | `it::erasure::i1_counterparty` |
| I2 | Legal hold | Held threads survive retention and erasure. The receipt lists each held item and its reason | S+I | `it::erasure::i2_hold` |
| I3 | Subject-access request | Export of every message to or from the address as `.eml` plus JSON | S+I | `it::export::i3_counterparty` |
| I4 | Retention expiry | Raw MIME purged at `raw_days`. Messages purged at `message_days` if set. Each purge is audit-logged | S | `it::retention::i4_*` |
| I5 | Mail content in webhooks, dead-letter queues and logs | Events are thin. Dead-letter queues hold pointers only (14-day retention). Logs never hold bodies or clear addresses (a log-scrubbing test greps captured logs) | S | `it::logs::i5_no_content_in_logs` |
| I6 | Backups after an erasure | R2 has no versioning or replication. The optional backup bucket (`PM_BACKUP_BUCKET`, off by default) is purged in the same erasure step as the source. The 30-day point-in-time recovery for D1 and Durable Objects is documented as residual retention, and erasures are re-applied after a restore | S | docs + `it::erasure::i6_backup_purge` |
| I7 | Suppressions after counterparty erasure | Kept as a keyed hash and masked hint, to honour the objection to contact. Documented | S | `it::erasure::i7_suppression_kept_hashed` |
| I8 | A partner key writes to a tenant while it is being erased, or after it is erased (creates an identity, sends, adds a domain, mints a key, changes its status or policy), or requests its erasure again | Every write from a non-platform key, apart from a tenant-scope erasure request, gets `404 tenant_not_found` (or the resource's `*_not_found`); the tenant's own tenant and identity keys are revoked by the erasure and get `401 key_revoked`. The partner key can still read the tenant and its erasure requests with the receipt. Only the erasure job changes the tenant's status (a platform `PATCH` with `status` gets `409 tenant_erased`). A second tenant-scope erasure returns the existing request (`200`, same `era_`) while `erasing`, and `409 tenant_erased` once `erased`. Tenant erasure also deletes the idempotency records whose stored response belongs to the tenant | S | `it::erasure::i8_erasing_tenant_frozen` |

## J · Operations and failure

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| J1 | R2 write fails inside `email()` | Never accept mail without a durable copy. Two retries, then throw, so the sender gets a temporary failure (confirmed by spike S2) | S | `it::inbound::j1_r2_failure` (fault injection) |
| J2 | Durable Object evicted or reset mid-write | Writes are transactional, the queue retries, ingest is idempotent on `raw_sha256` | S | `it::inbound::j2_retry_idempotent` |
| J3 | A parser bug is found | A `reparse` job, started with `POST /v1/platform/jobs` (`platform:ops`), re-parses from raw with the new `parser_version`. Events are re-emitted with `reprocessed: true` | S | `it::jobs::j3_reparse` |
| J4 | The integrator's webhook endpoint is down | Retries for about 72 h, then `dead`, and replayable while the event is younger than the tenant's `events_days` (default 30 days) | S | `it::webhooks::j4_retry_schedule` |
| J5 | Cloudflare Email Sending outage | The runbook switches affected domains to `transport: ses` with `PATCH /v1/domains/{domain_id}` (platform key). They are pre-verified with SES: when SES is configured, `cloudflare_zone`, `nameservers` and `delegated_subdomain` onboarding creates the domain's SES identity and publishes its three DKIM CNAMEs through the Cloudflare DNS API; while the transport is `cloudflare` those records are informational and never change the domain's state. Each transport's DKIM alignment is documented (with SES, DKIM aligns and SPF does not, because no custom MAIL FROM is set up) | S | `it::domains::transport_patch`, `live::transport::j5_ses_failover` |
| J6 | Compromised API key | Revoke immediately, or rotate with overlap. The audit trail shows the key's actions | S | `it::keys::j6_revoke_rotate` |
| J7 | The D1 directory lookup fails transiently in `email()` | Accept to `inbound-staging/`, queue a pointer with the envelope, and route in the consumer. Never reject for our own outage | S | `it::inbound::j7_d1_transient` |
| J8 | A dead-letter queue receives messages | The dead-letter consumer records each item in `dlq_items`, emits a metric, and alerts after 15 minutes non-empty. `GET /v1/platform/dlq` and `POST /v1/platform/dlq/{dlq_id}/redrive` (CLI `pmail dlq list` and `redrive`) list and redrive | S | `it::ops::j8_dlq_consumer`, `cli::dlq::j8_list_redrive` |
| J9 | Deploy with a new Durable Object schema while old instances are live | Migrations are idempotent and run on wake, inside a transaction, guarded by `schema_version` | S | `it::mailbox::j9_migration_on_wake` |
| J10 | A partner key addresses a tenant another partner's key created, a tenant no partner created, anything inside one (identity, message, domain, key, webhook endpoint), or another partner's endpoints or keys | The same `404 …_not_found` as for a missing ID, with no side effect. A partner key reaches only the tenants its own partner's keys created | S | `it::security::cross_tenant_matrix`, `it::partners::j10_foreign_partner_not_found` |
| J11 | A partner key tries to mint a partner or platform key, or a key holding `platform:ops`, `partners:manage` or `identities:sign` | A partner or platform key, or a key for a tenant outside its partner: `403 key_scope_exceeded`. A permission partner keys can never hold: `400 invalid_request` with `details.reason = "permission_not_allowed_for_level"`. Only a platform key mints, rotates or revokes partner keys | S | `it::keys::j11_partner_key_limits` |
| J12 | A partner is deleted while it still has tenants | `409 partner_has_tenants` while any tenant with its `partner_id` is not `erased`, and nothing changes. Once every one is erased, the deletion is soft: the partner stays with `status: "deleted"` and an empty name, its keys are revoked and deleted, its endpoints are deleted, and the erased tenants keep their `partner_id` | S | `it::partners::j12_delete_with_tenants` |
| J13 | A partner is suspended | Its keys, and every tenant and identity key of its tenants, get `403 partner_suspended` on every route, so nothing can send for those tenants. The tenants' status does not change and their inbound mail is still stored. Deliveries to the partner's endpoints and its tenants' endpoints are held, with no attempt used, and resume when the partner is `active` again | S | `it::partners::j13_suspended_partner`, `it::webhooks::j13_held_while_partner_suspended` |
| J14 | A self-serve tenant's key tries to set `quarantine.key_release` on its own tenant | `403 permission_denied`: `PATCH /v1/tenants/{tenant_id}` needs `tenants:manage`, which a tenant key can never hold. The policy is unchanged, and the console shows it read-only. Only a platform key, or the tenant's own partner key, can set it | S | `it::quarantine::j14_key_release_policy` |
| J15 | A partner's webhook endpoint, and events of another partner's tenants or of a tenant no partner created | Never delivered, by fan-out or by replay: a partner endpoint matches only events of tenants with its `partner_id`, and replay selects on `event_index.partner_id`. `webhook.disabled` for an endpoint of a partner (a partner endpoint, or a tenant endpoint of one of its tenants) goes to that partner's other endpoints and to platform endpoints, never to tenant endpoints | S | `it::webhooks::j15_partner_scope_filter` |
| J16 | A key with `quarantine:review` releases held mail where `PM_QUARANTINE_KEY_RELEASE=off` (Pylota Mail Cloud) | Allowed only on a tenant whose policy has `quarantine.key_release: true`, its partner key included; on any other tenant every key gets `403 permission_denied` and a person releases in the console. Each release is audit-logged with its key | S | `it::quarantine::j16_key_release_override` |
| J17 | A partner tries to undo what the platform operator enforced on one of its tenants: lifts a platform suspension, raises a lower-only policy field above the platform's value or the deployment default, raises it one identity at a time through `send_policy.daily_cap`, or resumes an identity paused for `abuse_threshold` | `403 scope_denied` (`details.field` for the field or `status`); nothing changes. `tenants.suspended_by` records who suspended; a platform key's value on a lower-only field becomes that field's ceiling (`tenants.policy_ceilings_json`), so the effective ceiling is min(deployment default, platform ceiling); an `abuse_threshold` pause on a partner's tenant is resumed only by a platform key | S | `it::partners::j17_operator_enforcement`, `it::partners::policy_caps_lower_only` |
| J18 | A partner key creates tenants, or sends invitations, without limit | At most `partners.max_tenants` tenants that are not erased (default 25, platform-set): the next creation gets `403 partner_tenant_limit`, checked in the insert so concurrent creations cannot overshoot. Tenant creations and invitations together are limited to 10 a minute per partner across all its keys (`RL_PARTNER`, `429 rate_limited`) | S | `it::partners::j18_partner_limits` |
| J19 | A request is retried with the same `Idempotency-Key` by another key, or the original response carried a one-time secret | The record is keyed by the calling key: another key gets no replay. A response carrying a secret (`POST /v1/keys`, key rotation, webhook create, webhook secret rotation) is stored without it, and a replay returns the stored body with `"secret_replayed": false`; the secret exists only in the first response | S | `it::idempotency::j19_per_key_no_secret` |

## K · Integration and cutover (integrator side)

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| K1 | Webhook redelivered | Deduplicate on `webhook-id`. Process in a durable job, so a downstream failure never re-runs the agent turn | I | integrator |
| K2 | Autonomy paused or conversation taken over | The integrator stops sends. The service keeps receiving | I | integrator |
| K3 | A send fails after approval | `message.failed` / `rejected` carry a readable reason. The integrator allows a retry with a new key | S+I | `it::send::k3_failure_reason` |
| K4 | Mixed providers during migration | Each tenant is bound to one provider. No thread crosses providers | I | integrator |

## L · Test mode

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| L1 | A test tenant sends to a real external address | Refused with `test_mode_recipient` | S | `it::testmode::l1_refuse_external` |
| L2 | A test tenant sends to `*@simulator.invalid` | Scripted outcomes: `delivered@`, `bounce@`, `softbounce@`, `complaint@`, `deferred@`, `reject@` and `timeout@` (which produces `uncertain`) | S | `it::testmode::l2_simulator_matrix` |
| L3 | A test tenant sends to an identity on the same deployment | Delivered by loopback injection into the inbound pipeline, with `verdict: pass` and flag `loopback` | S | `it::testmode::l3_loopback` |
| L4 | A live key used on a test tenant, or the reverse | Impossible: a key's mode follows its tenant. Platform keys, and partner keys on their own tenants, act on both and are logged | S | `it::testmode::l4_mode_binding` |

## N · Domains on any DNS host

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| N1 | A forged or invalid SNS message on `/hooks/ses` or `/hooks/ses/inbound`: bad signature, `SignatureVersion` 1, a `SigningCertURL` off `sns.{PM_SES_REGION}.amazonaws.com`, another topic, or a stale `Timestamp` | `403 invalid_signature`, `ses_sns_rejected_total` incremented, nothing enqueued | S | `core::sns::verify_v2_vectors`, `it::ses::invalid_signature_403` |
| N2 | A `SubscriptionConfirmation` for another topic | Ignored: never confirmed | S | `core::sns::verify_v2_vectors`, `it::ses::invalid_signature_403` |
| N3 | The same SES notification arrives by push, from the SQS backstop, or both | The `ses_ingest` ledger admits it once per object and recipient; the repeat is a no-op. A row whose pointer was never enqueued is re-sent by the backstop cron after 15 minutes, and the consumer skips a pointer whose row is no longer `queued` | S | `it::ses::push_and_backstop_once`, `it::ses::stuck_queued_row_resent` |
| N4 | The S3 object is gone before it is ingested | Ledger row `lost`, `ses_object_lost_total` incremented, the `ses_object_lost` alert pages | S | `it::ses::object_lost` |
| N5 | An SES message of up to 40 MB | Accepted; the parser's part and depth caps still apply | S | `it::ses::large_message_40mb` |
| N6 | Mail to an unknown address on an SES domain | Dropped without a bounce (no backscatter); `inbound_dropped_total{reason="unknown_recipient", source="ses"}` | S | `it::ses::unknown_recipient_dropped` |
| N7 | Mail to a retired address on an SES domain | SES bounces it with `550 5.1.6` through a `pm-retired-{n}` receipt rule | S | `it::ses::retired_rule_sync` |
| N8 | The domain's MX points at another region's SES inbound host | Health issue `mx_wrong_region` (fail) | S | `it::domains::mx_wrong_region` |
| N9 | An existing or extra MX at a `dns_records` domain (split mail) | Without `"replace_mx": true`, `409 existing_mx`. With it, created, and `mx_unexpected` (degraded) until the other MX records are gone | S | `it::domains::existing_mx_external` |
| N10 | SES DKIM verification fails for a domain, or SES sending is paused for the account | `ses_dkim_failed` takes the domain to `failing`; a pause raises the `ses_sending_paused` platform alert. Either way sends fall back to the platform address | S | `it::ses::dkim_failed_or_paused` |
| N11 | The MAIL FROM MX (`pm-bounce.{domain}`) is missing | SES uses its default MAIL FROM; DKIM still aligns, so the domain is `degraded` with `mail_from_failed`, not `failing` | S | `it::ses::mail_from_mx_missing` |
| N12 | A `send_only` address whose forwarding rule is not set up yet | The address's `forwarding` is `unverified` until a test or real message arrives through forwarding. `test-forwarding` sets it to `ok` or `failed` | S | `it::forwarding::test_forwarding` |
| N13 | A forwarding loop: an agent writes to its own external address, which forwards back to its platform address | Caught by loop detection: the `X-Pylota-Mail-Hop` counter and the automatic-exchange cap (D6); never an endless exchange | S | `it::forwarding::loop_capped` |
| N14 | The SMTP relay answers `535` to `AUTH` | At create or `PATCH`: `422 smtp_auth_failed`, nothing stored. On a send: `rejected` (`sender_domain_unavailable`), health issue `smtp_auth_failed` (fail), and later sends fall back once the domain is `failing` | S | `core::smtp::state_machine`, `it::smtp::create_connect_check` |
| N15 | The connection is lost after the final `.` and before the reply | `uncertain`, never resent | S | `it::smtp::uncertain_after_final_dot` |
| N16 | The relay does not offer STARTTLS on 587 (or TLS on 465) | Refused before `AUTH`; credentials are never sent. `422 smtp_tls_required` at create or `PATCH`; health issue `smtp_tls_required` (fail) | S | `core::smtp::state_machine`, `it::smtp::create_connect_check` |
| N17 | The customer's DNS host appends the zone name, so a record lands at `agents.brightwell.example.brightwell.example` | Records carry `host` (relative) next to `name`; health reports `record_doubled_name` (degraded) with a fix | S | `core::dns::doubled_name_detected` |
| N18 | The relay rewrites `From` or signs with an unaligned `d=` | The alignment probe fails (`smtp_from_rewritten` or `smtp_unaligned`), the domain goes `failing`, and sends fall back to the platform address | S | `it::smtp::probe_unaligned_falls_back` |
| N19 | A DSN bounce arrives for a message sent through an SMTP relay | Matched by `Message-ID`: `bounced` (hard for `5.x.x`, soft for `4.x.x`), with a suppression for a hard bounce | S | `it::smtp::dsn_to_bounce` |
| N20 | The relay answers `4xx` or `5xx` to some `RCPT TO` commands | Per recipient: `4xx` is retried later, `5xx` is `rejected` with the code; the other recipients are sent | S | `core::smtp::state_machine`, `it::smtp::partial_rcpt` |
| N21 | `nameservers` on a domain that already has A, AAAA or MX records, or a `www` record | `409 domain_not_dedicated` listing them, unless `"confirm_dedicated": true` | S | `it::domains::nameservers_dedicated_check` |
| N22 | Cloudflare answers error `1105` when creating a zone | `429 upstream_rate_limited` with `Retry-After: 10800` (3 hours) | S | `it::domains::zone_create_rate_limited` |
| N23 | A Free-plan zone from `nameservers` is not activated within 28 days | Final `domain.reminder` on day 21. When Cloudflare deletes the zone: `removed` with `zone_expired`, and `domain.removed` with `reason: "zone_expired"` | S | `it::domains::zone_expired` |
| N24 | A zone hold blocks creating the child zone | `409 zone_hold`, with a fix asking the customer to release the hold for subdomains | S | `it::domains::zone_hold` |
| N25 | The parent removes or changes the delegation of a `delegated_subdomain` | `nameservers_changed` (ownership): the domain is `suspended` | S | `it::domains::delegation_removed` |
| N26 | The SES region approaches or reaches 10,000 identities | At 9,000 the operator alert `ses_identities_90pct` fires and `pmail doctor` warns. At 10,000, a domain that needs an SES identity gets `422 transport_unavailable` with `details.reason = "ses_identity_limit"` | S | `it::domains::ses_identity_limit` |
| N27 | SES reports virus `FAIL` or spam `FAIL` | Virus: quarantined by the attachment-risk rule (`quarantine_reason: risky_attachment`). Spam: score 0.9, so the default threshold quarantines it | S | `it::ses::verdict_mapping` |
| N28 | One SES message has recipients in several tenants | One pointer and one message per recipient, each resolved separately; no tenant sees another's copy | S | `it::ses::cross_tenant_recipients` |
| N29 | Retired addresses exceed the rule capacity (150 rules × 500 addresses) | The oldest retired addresses leave the rules; their mail is then dropped like an unknown address's | S | `it::ses::retired_rule_sync` |
| N30 | `PM_SES_REGION` cannot receive mail, or is outside the EU and the UK while `PM_JURISDICTION=eu` | `pmail setup ses` refuses it (the EU-or-UK check yields only to `--allow-non-eu`); `eu-west-2` (London) is accepted | S | `cli::setup::ses_region_check` |

## O · Agent keys and notifications

Rows O1–O13 are specified in [Agent signing keys and signed requests](design/agent-keys.md) and built in
M25; rows O14–O26 in [Notifications and usage alerts](design/notifications.md), built in M26.

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| O1 | A paused identity, or an identity of a suspended tenant (paused with `tenant_suspended`), asks to sign, or its JWKS is fetched | Assertions and HTTP signatures are refused with `403 tenant_suspended` for a suspended tenant (checked first, as on sends) and `409 identity_paused` for a paused identity; the JWKS answers `404 identity_not_found` until the identity resumes. A `deleting` or `deleted` identity gets `404 identity_not_found` on both | S | `it::identity_keys::paused_withdraws_jwks` |
| O2 | A verifier holds an assertion signed just before the identity key was rotated | The previous key is `retiring` and stays in the JWKS until `verify_until` (`PM_IDENTITY_KEY_OVERLAP_DAYS`, default 7 days), so the assertion still verifies; new assertions use the new key | S | `it::identity_keys::lazy_create_and_rotate` |
| O3 | An identity key is revoked after a suspected leak | The key becomes `retired` at once and is absent from the next JWKS response. Verifiers cache the JWKS for at most 5 minutes (`max-age=300`), so they stop accepting it within that time | S | `it::identity_keys::revoke_removes_from_jwks` |
| O4 | An assertion request with no `audience`, or one longer than 256 characters or not printable ASCII | `400 invalid_request` naming `audience`; nothing is signed | S | `it::assertions::claims_and_limits` |
| O5 | An assertion `expires_in` below 60 or above 600 seconds | `400 invalid_request`. The default is 300 | S | `it::assertions::claims_and_limits` |
| O6 | `ext` uses a registered or Pylota claim name (`iss`, `sub`, `aud`, `exp`, `email`, `org` and the rest), or is larger than 2 KB as JSON | `400 invalid_request`. A claim the service sets is never overwritten | S | `it::assertions::claims_and_limits` |
| O7 | An identity that has signing keys is deleted or erased | Its `identity_keys` rows are deleted and each thumbprint is written to `key_tombstones`; key generation refuses a tombstoned thumbprint, so that key ID is never published again | S | `it::assertions::erasure_tombstones_kid` |
| O8 | `PM_MASTER_KEY` is rotated | `pmail secrets rotate-master` re-seals `identity_keys.private_enc` and the `web_bot_auth` seed. Public keys and key IDs do not change, and tokens signed before and after the rotation verify with the same public key | S | `it::secrets::rotate_master_reseals_identity_keys` |
| O9 | A signed HTTP request, or a rotation of the `web_bot_auth` key, while `PM_WEB_BOT_AUTH=off` | `422 web_bot_auth_disabled`. The key directory answers `404 key_not_found` | S | `it::http_signatures::disabled_and_policy` |
| O10 | The URL to sign has an internationalised host, or a signed component's value is not ASCII | The host is converted to its A-label for `@authority`. A component whose value is not ASCII is refused with `400 invalid_request`, because RFC 9421 and Cloudflare reject non-ASCII values | S | `core::httpsig::signature_base_rfc9421` |
| O11 | An HTTP-signature `expires_in` below 30 or above 300 seconds | `400 invalid_request`. The default is 60, because too short an expiry fails in transit | S | `it::http_signatures::expiry_bounds` |
| O12 | Someone mirrors the key directory to register it as theirs, or the deployment key was just rotated | The directory response is signed once per listed key (tag `http-message-signatures-directory`, component `@authority`), so a copy served from another host does not verify. During an overlap it lists at most three keys: one active, two retiring | S | `it::well_known::directory_signed_per_key` |
| O13 | A signed HTTP request for an identity whose tenant has not opted in (`web_bot_auth.allowed: false`, the default) | `403 policy_denied`; nothing is signed | S | `it::http_signatures::disabled_and_policy` |
| O14 | 500 messages reach one inbox within a minute, for a person with `new_mail` notifications | One email per person and inbox per window. `instant`: the first message opens a 2-minute hold and one email covers it all, then at most one email every 10 minutes. `hourly` and `daily` send one email per period, with counts | S | `it::notify::new_mail_coalesces` |
| O15 | Mail that is quarantined, hidden, marked spam, loopback, or on a test tenant | Never counted in a `new_mail` notification. A message released from quarantine counts when it is released | S | `it::notify::invisible_mail_never_notifies` |
| O16 | A `new_mail` preference with `filter = needs_reply` | Each message waits up to 5 minutes in the Notifier's `held` table. It counts when `message.triaged` says `needs_reply` (score ≥ 0.5), is dropped on any other triage result, and counts when the 5 minutes pass with no triage event (skipped or disabled triage emits none) | S | `it::notify::needs_reply_filter_waits_for_triage` |
| O17 | A notification email hard-bounces or draws a complaint | The address is suppressed as usual, and `paused_reason` is set on every preference of that person, so only `account` emails go out. The console shows a banner; confirming the address clears the pause | S | `it::notify::bounce_pauses_prefs` |
| O18 | A one-click unsubscribe (RFC 8058 `POST`) from a notification email; or a request whose token is expired, belongs to another person or workspace, or is forged | A valid token turns that kind off for that person and workspace, without sign-in. Any other token changes nothing and shows a page that links to the settings. The token is `u1:{kid}:{user_id}:{tenant_id}:{kind}:{expires}` with a 16-byte MAC, as specified in Notifications § 5 | S | `it::notify::one_click_unsubscribe`, `it::notify::unsubscribe_token_format` |
| O19 | A member is removed from a workspace | Their `notification_prefs` rows for that workspace are deleted, and their pending notifications are dropped | S | `it::notify::member_removed_drops_pending` |
| O20 | Use of `sends` crosses 80% several times in one period, as holds are released and taken again | One email per threshold per billing period, recorded in the `TenantQuota` meta key `alerted:{feature}:{threshold}:{period}` | S | `it::notify::usage_once_per_threshold_per_period` |
| O21 | A count that does not reset (seats, inboxes, custom domains, storage) moves 9 → 10 → 9 → 10 within a day, against a limit of 10 | An alert when a threshold is crossed upwards, then a 24-hour cooldown per feature and threshold: one email | S | `it::notify::count_feature_cooldown` |
| O22 | The workspace's time zone changes | The change takes effect from the next day. No daily email is sent twice or skipped, across daylight-saving changes too | S | `it::notify::timezone_change` |
| O23 | Billing is off (`PM_BILLING=off`) | No usage alert is sent: no feature has a limit. The daily caps in tenant policy still return `429`; the identity and tenant send caps also emit `quota.warning`, the agentic-search cap does not | S | `it::notify::billing_off_no_usage_alerts` |
| O24 | A person would get a 51st notification email in a day, or a workspace a 201st | Further items that day are folded into the person's `digest`, one email at the next 09:00 that lists counts, is not capped and can be unsubscribed from; the person's settings page says so. `account` emails are not capped | S | `it::notify::daily_caps` |
| O25 | The platform domain is `failing` when notifications are due | The platform domain has no fallback, and a send from a failing domain is accepted and fails later, so the Notifier checks the platform domain's state before each submit and submits nothing while it is `failing` or `suspended`. It keeps the items and retries hourly for 24 hours; after recovery each email goes out once, under its original key. The existing platform-domain alert tells the operator | S | `it::notify::platform_domain_failing_retries` |
| O26 | The tenant is suspended | Its people get `account` emails only | S | `it::notify::suspended_tenant_account_only` |

## W · Plans, billing, seats and the console

| # | Case | Required behaviour | Owner | Test |
|---|---|---|---|---|
| W1 | Two sends race for the last unit of the monthly allowance | Holds are atomic in the workspace's `TenantQuota` object. Exactly one wins; the other gets `402 billing_limit` | S | `it::billing::w1_last_unit_race` |
| W2 | Stripe is unreachable when an agent sends | Metering is local, so sends work normally. Only checkout and portal links fail (with a retryable error in the console) | S | `it::billing::w2_stripe_down_sends_ok` |
| W3 | A send is denied with `402`, the workspace upgrades, the agent retries with the same key | The denial wrote no idempotency record, so the retry succeeds and sends once | S | `it::billing::w3_retry_after_upgrade` |
| W4 | A completed send is replayed after the allowance is spent | The original result is returned (`deduplicated: true`); no hold is taken | S | `it::billing::w4_replay_when_spent` |
| W5 | A send ends `uncertain` | The hold is released. If reconciliation later shows it was sent, one unit is consumed then | S | `it::billing::w5_uncertain_release` |
| W6 | A hold is never settled (Worker evicted mid-request) | The `TenantQuota` alarm releases it after 10 minutes | S | `it::billing::w6_hold_expiry` |
| W7 | Inbound mail arrives when storage or triage allowance is exhausted | Mail is always accepted and stored. Triage is skipped with `triage_status: skipped` and reason `allowance`; storage over-use blocks only new identities, domains and outbound attachments | S | `it::billing::w7_inbound_never_refused` |
| W8 | An invitation is sent with no seat left | `402 billing_limit` with `feature: seats`. Pending invitations count as seats | S | `it::members::w8_seat_limit` |
| W9 | A member is removed while signed in | Their sessions are revoked at once; the next request redirects to sign-in | S | `it::members::w9_remove_revokes_sessions` |
| W10 | The owner tries to leave, or is demoted | Refused with `owner_required` until ownership is transferred to an admin | S | `it::members::w10_owner_required` |
| W11 | A downgrade leaves more identities, domains or members than the new plan allows | Nothing is deleted. Creating more is refused until counts fit | S | `it::billing::w11_downgrade_keeps_data` |
| W12 | Stripe webhooks arrive late, twice or out of order | Deduplicated by event ID; subscription state is re-read from Stripe and applied only if newer than the stored state | S | `it::billing::w12_webhook_order` |
| W13 | Payment fails | `past_due` keeps the plan for the grace period (7 days), sends a `billing.payment_failed` event and console banner, then applies Free limits without deleting data | S | `it::billing::w13_grace_then_free` |
| W14 | A forged or replayed Stripe webhook | `Stripe-Signature` verified (HMAC-SHA256 over `t.payload`, 5-minute tolerance, constant-time compare); failures return 400 and are logged | S | `it::billing::w14_webhook_signature` |
| W15 | Magic-link or code brute force, or enumeration of registered emails | 3 link or code requests per 10 minutes per address; 10 attempts per code (the token is burned after 10 failures); `RL_SIGNIN` 10 requests per 60 s per client network (an IPv6 /64 counts as one) on the sign-in, sign-up, waitlist and pending-step routes and the OAuth start; identical responses for known and unknown addresses | S | `it::console::w15_signin_limits` |
| W16 | Cross-site request forgery against the console | Every POST needs the session's CSRF token and a matching `Origin`; cookies are `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax` | S | `it::console::w16_csrf` |
| W17 | Rendering hostile HTML mail in the console | Sanitised HTML is shown inside a sandboxed `iframe` (`srcdoc`, no scripts, no same-origin, no remote images by default) under a strict CSP; text view is the default | S | `it::console::w17_hostile_html` |
| W18 | A viewer tries a write action, or any member reaches another workspace | Role checks on every console handler; workspace scope from the session, never from the form | S | `it::console::w18_role_and_scope` |
| W19 | Billing is off (self-hosted) | No plan checks; `GET /v1/usage` reports `billing: disabled`, each feature with `granted: null`, `unlimited: true` and the real `used`; the daily caps in tenant policy still apply (`429`) | S | `it::billing::w19_disabled` |
| W20 | Google or GitHub callback whose `state` is missing, reused, expired, or from another browser (no matching `__Host-pm_oauth` cookie) | Refused before the code is exchanged. No session, no account; the page never reveals whether an account exists | S | `it::oauth::state_cookie_binding` |
| W21 | The provider's email is not verified (Google `email_verified: false`, or GitHub has no verified primary address) | Refused with a page asking the person to verify an address with the provider. No account is created or linked | S | `it::oauth::unverified_email_refused` |
| W22 | A person signs up with Google, then signs in with an email link for the same address | One user: either method opens the same account. The reverse order (an email account first, then Google or GitHub with that verified address) links the provider identity only after a code emailed to the address is entered ([W42](#w--plans-billing-seats-and-the-console)) | S | `it::oauth::link_by_verified_email` |
| W23 | An invitation is accepted through Google or GitHub with a different verified email | Refused. No account is created or linked, and the invitation stays pending | S | `it::oauth::invitation_email_mismatch` |
| W24 | Sign-up with a paid plan intent (`?plan=team`), then Checkout is cancelled | The workspace stays on Free. Checkout's `cancel_url` is `/console?upgrade=team`, and the Overview shows a banner to finish upgrading; nothing is stored | S | `it::signup::plan_intent_to_checkout` |
| W25 | The person returns from Checkout before Stripe's webhook arrives | The return page waits (meta refresh, at most 7 times), then says the plan updates within a minute. Only the webhook changes the plan | S | `it::checkout::return_before_webhook` |
| W26 | The Checkout return URL carries another workspace's session ID | The retrieved session's `client_reference_id` and `metadata.tenant_id` must name this workspace, and its customer must equal `stripe_customer_id`, which the console writes before it creates the session. Otherwise a neutral "Nothing to show" page; nothing changes | S | `it::checkout::return_wrong_workspace` |
| W27 | A workspace requires two-step verification and a member has not enrolled | The member is sent to enrolment before entering that workspace. API keys are unaffected | S | `it::totp::workspace_requirement` |
| W28 | A person loses their authenticator | Each recovery code works once; new codes invalidate the old. With none left there is no way back: no support route exists, because nothing the deployment holds proves who is asking (a Free workspace has no billing record either) | S | `it::totp::recovery_code_single_use`, `it::totp::recovery_codes_survive_key_rotation` |
| W29 | Sign-up with a disposable email address | Refused before any mail is sent (`PM_SIGNUP_BLOCKED_DOMAINS`). No account is created | S | `it::signup::disposable_domain_refused` |
| W30 | A Free workspace created to send spam | New-workspace ramp (billing on): the effective tenant daily cap is min(policy, 50) while `ramp_lifted_at` is unset, which covers the first 7 days on Free (`429 daily_cap_reached` on the 51st). A daily evaluation lifts it from day 7 if bounce and complaint rates are under the auto-pause thresholds; otherwise it stays, is evaluated daily, and the third failure alerts an operator (no automatic suspension). A paid plan lifts it once its invoice is paid, and a disputed payment restores it. A tenant a partner's key created is ramped the same way whatever its billing mode (`exempt` included) and whether billing is on, unless a platform key set the partner's `ramp_exempt` | S | `it::abuse::free_ramp`, `it::abuse::ramp_evaluator`, `it::abuse::partner_ramp` |
| W31 | A hostile `next` (absolute URL, `//host`, a backslash, a scheme, or a path outside `/console/`) | Ignored; the next landing rule applies. Never an open redirect | S | `it::landing::routing_table` |
| W32 | Someone without an invitation signs in while sign-up is `closed` or `waitlist` | The "No workspace yet" page; no account is created | S | `it::signup::closed_and_waitlist` |
| W33 | The chosen address suffix is taken by another workspace created at the same moment | The form returns with `suffix_taken`; exactly one workspace gets the suffix | S | `it::signup::suffix_taken_race` |
| W34 | A person deletes their account while they own a workspace | `409 owner_required` until ownership is transferred or the workspace is deleted | S | `it::console::delete_account_owner_required` |
| W37 | A Portal upgrade or top-up increase whose invoice is not paid yet; a subscription `active` while its first payment is processing; a payment that fails during grace | Allowances never rise on a subscription's status alone: an increase applies only when the subscription's latest invoice is `paid`, and the `invoice.paid` re-read grants it. Decreases apply at once. Checkout takes cards only. A paid plan lifts the send ramp only once its invoice is paid | S | `it::billing::w37_grant_after_payment` |
| W38 | A customer disputes a charge, or the operator refunds one | A dispute stops the workspace's sends (`429 daily_cap_reached`, `details.cap: "billing_dispute"`), applies the default plan, clears `ramp_lifted_at` and pages the operator; won: plan and sending return; lost: every subscription is cancelled and the ramp applies again. A refund is recorded and changes no plan | S | `it::billing::w38_dispute_and_refund` |
| W39 | Two plan Checkouts paid before the first webhook | One Customer per workspace, created before the first Checkout; Applying state keeps the oldest subscription and cancels the other at once with its unused time credited | S | `it::billing::w39_duplicate_subscription` |
| W40 | An invitation link used by a person enrolled in two-step verification, or a person who signs in with a pending invitation | No session and no membership until the second factor passes; acceptance is always an explicit click on **Accept**, never automatic at sign-in | S | `it::members::w40_invitation_needs_second_factor` |
| W41 | A first factor passes and the second step is abandoned, replayed or submitted twice; a workspace turns on `require_two_factor` while members are signed in | The pending step is a `pending_auth` row behind the `__Host-pm_pending` cookie: 5 minutes, single use, no session before it ends. `require_two_factor` is checked on every request | S | `it::totp::w41_pending_auth_single_use` |
| W42 | A Google or GitHub identity whose verified address matches an existing account | Linked only after a code emailed to that address is entered; a person can unlink a provider in settings | S | `it::oauth::w42_link_needs_code` |
| W43 | Code guessing spread over many tokens and client networks | 30 failed codes per address per UTC day lock code sign-in for that address until 00:00 UTC; the link still works; the person is told once; the OAuth start counts against `RL_SIGNIN` | S | `it::console::w43_failed_code_daily_cap` |
| W44 | Strangers trigger system mail (sign-in, sign-up, waitlist, invitations) to drain the shared sender and quota | Budgets per recipient (10 a day), per client network (20) and ASN (200), and per inviting tenant (50 invitations a day, `429 daily_cap_reached` with `details.cap: "invitations"`); a form ticket on the mail-sending forms; `invitation` and `notification` mail capped at 20% and 50% of the system identity's day, so sign-in mail always has a share | S | `it::abuse::w44_system_mail_budgets` |
| W45 | A console account, invitation or owner whose address is a mailbox this deployment receives | Refused (platform-domain addresses and identities' `pending`, `active` or `retiring` addresses); an identity address equal to a console sign-in address is refused with `409 address_taken` | S | `it::console::w45_hosted_address_refused` |
| W46 | Many Free workspaces send at once and threaten the shared domain or the account's daily quota | With `PM_DAILY_SEND_QUOTA` set, the shared-domain breaker stops Free and ramped workspaces at 60% of the day's quota and every tenant at 90% until 00:00 UTC (`details.cap: "shared_domain"`); one self-serve Free workspace per person, `+tag` variants included (`workspace_limit`) | S | `it::abuse::w46_shared_domain_breaker` |
