# Product requirements (PRD)

| | |
|---|---|
| Product | Pylota Mail |
| Document owner | Pylota engineering |
| Status | Approved for build (v1.0) |
| Last reviewed | 2026-10-10 |
| Licence | FSL-1.1-ALv2 (Fair Source; each release becomes Apache-2.0 two years after it ships) |
| Related | [Architecture](architecture.md) · [Design](design/index.md) · [Build plan](build-plan.md) · [Edge cases](edge-cases.md) |

Requirement IDs (`FR-*`, `NFR-*`) are stable. Tests, design documents and pull requests cite them.
The words **must**, **should** and **may** are used as in RFC 2119.

## 1. Summary

Pylota Mail is an email and identity service for AI agents. Each agent gets an **identity**: a mailbox
with one or more addresses, authenticated sending, verified inbound mail, threads, attachments with
extracted text, triage and search, plus signing keys that let it prove who it is to other services. Applications and agents use it through a REST API, an MCP server and
a CLI. It reports what happened through signed webhooks.

It is source available under the Functional Source License (FSL-1.1-ALv2), written entirely in Rust, and
runs as one Cloudflare Worker on the deployer's own Cloudflare account. Pylota also operates it as a hosted
service, **Pylota Mail Cloud**, with Free, Developer and Team plans (section 13). Pylota (a platform for independent car-rental operators) is the first
user, as a partner on Pylota Mail Cloud. Pylota gives each operator four agent identities (bookings, inquiry, compliance, maintenance), and
operators move those identities from a shared platform domain to their own domain over time.

## 2. Problem

Agents that act for a business need to send and receive email as a stable, trustworthy identity. The
options before this product were:

- **Hosted agent-mail APIs.** They work, but data lives with a third party, residency is limited,
  and pricing is per inbox. They also lack features agents need: verified citations from search,
  safe-retry semantics, domain changes without breaking threads.
- **Transactional email providers.** They send, but receiving, threading, search and identity are the
  application's problem.
- **Raw Cloudflare Email Routing and Email Sending.** These are the right primitives. On their own they
  give no mailbox, threading, search, idempotency, domain lifecycle, authentication verdicts or erasure.

Pylota's own experience showed the cost of these gaps:

- operator mail never reached production because DNS records were copied from documentation instead
  of being read from an API;
- HTML-only mail was dropped;
- a failed send re-ran an LLM turn;
- agents could not search their own mail at all.

## 3. Users

| Persona | Needs |
|---|---|
| **Integrator** (a developer building an agent product, e.g. Pylota's API, which uses a partner key on Pylota Mail Cloud) | Provision a tenant and identities per customer, send and receive reliably, get events, change domains, erase data, all through a stable API; on a shared deployment, with a partner key that reaches only its own customers' tenants (FR-KEY-4) |
| **Agent** (an LLM driving tools through MCP or an integrator's tool layer) | Small, well-described tools; search that finds the right email; reads that fit a context window; sends that are safe to retry; content marked untrusted |
| **Operator** (the integrator's customer, e.g. a car-rental business) | Their agents email from their brand, history survives domain changes, nothing is sent from a broken domain, clear instructions when DNS breaks |
| **Self-hoster / maintainer** | Deploy to their own Cloudflare account in minutes, upgrade safely, observe health, restore after mistakes |

## 4. Goals and non-goals

### Goals (v1.0)

1. Agent identities with addresses that can change domain without losing history or breaking threads,
   and that can prove who they are to other services with short-lived signed assertions, verifiable
   against a published key set.
2. Reliable inbound mail: no acknowledged message is ever lost, and every message carries an
   authentication verdict and trust metadata.
3. Safe outbound mail. A retry never produces a second email. An outcome that cannot be known is
   reported as uncertain, never guessed.
4. Search that agents can rely on: keyword, semantic, hybrid and agentic (cited answers whose citations
   are verified by code).
5. Triage on every inbound message: category, needs-reply, urgency, summary and risk flags.
6. REST API, MCP server, CLI and Rust SDK, all generated from or checked against one contract.
7. Deployable by a stranger to their own Cloudflare account in under 15 minutes of hands-on time.
8. Privacy by design: EU jurisdiction when chosen, retention policies, erasure with receipts,
   subject-access export.
9. A console for the people who run the agents: passwordless sign-in (email, Google or GitHub, with
   optional two-step verification), self-serve sign-up on Pylota Mail Cloud, workspaces with members,
   roles and enforced seats, inbox views, quarantine review, keys, domains, plan and usage, and email
   notifications (usage alerts, new mail, and a daily list of what needs a person). It works with no
   JavaScript.
10. Plans that are enforced exactly: atomic holds so two requests can never both pass on the last unit, a
    `402 billing_limit` that is safe to retry with the same idempotency key after an upgrade, and metering
    that never depends on a billing provider being reachable.
11. Custom domains wherever their DNS is hosted. Six connection methods cover a domain on Cloudflare, a
    domain whose DNS stays at any other host, and a domain whose mailbox stays with the customer's own
    provider. Every method keeps the rule of never sending unauthenticated mail.

### Non-goals (v1.0)

- A full webmail client. The console is for oversight and the actions that need a person (keys, domains,
  members, quarantine release, billing). Agents work through the API and MCP.
- IMAP, POP3 or SMTP submission access for humans.
- Bulk marketing campaigns. Marketing mail is supported per message with consent and unsubscribe
  headers, but there are no list-management or campaign features.
- Scheduled send and server-side drafts (planned for v1.1).
- OAuth 2.1 for the MCP endpoint (planned for v1.1; v1.0 uses API keys as bearer tokens).
- Running on platforms other than Cloudflare Workers.

### Unique selling propositions

Each proposition is a guarantee enforced in code, with the requirements and tests that prove it. Marketing
copy (README, landing page) may only claim what this table lists.

| # | Proposition | Guaranteed by | Proved by |
|---|---|---|---|
| U1 | **Answers you can check.** Agentic search cites message IDs, and a deterministic verifier removes any sentence the evidence does not support | FR-SRCH-8, FR-SRCH-9 | F10–F13, NFR-QUAL-2 |
| U2 | **One email per intent.** Idempotency is required; an unknown outcome becomes `uncertain` and is never resent; plan limits never break a retry | FR-OUT-1, FR-OUT-2, FR-BILL-6 | G1, G2, L2, W3 |
| U3 | **Identities outlive domains.** Addresses move between domains with history and threads intact, with rollback and a clean `550 5.1.6` after retirement | FR-ADR-1–5 | A11, C3, live domain-change test |
| U4 | **Never sends mail that fails authentication.** Two-resolver health checks, aligned fallback in the same thread, suspension when ownership changes, and, for a relay we do not control, an alignment probe before the first send and every day | FR-DOM-4–6, FR-DOM-11 | H1, H4, H7, N18 |
| U5 | **Built for untrusted input.** Verdicts and trust flags on every message, hidden text stripped, fenced model input, quarantine release only with the human-review permission | FR-IN-4–9, FR-CON-6 | B10, B11, D2, D9, E1 |
| U6 | **Your account, your receipts.** Runs in the deployer's Cloudflare account (EU optional); erasure returns per-store counts and empty probe queries | FR-PRV-1–6 | I1–I7 |
| U7 | **Real team seats.** Members, roles and seat limits are enforced, with an audit log of every privileged action and two-step verification that a workspace can require | FR-CON-2–5, FR-CON-10 | W8–W10, W27 |
| U8 | **Tested against the edge cases.** A public edge-case register where every row the service owns names its test, a MIME conformance corpus, and quality gates in CI | Release criteria §9 | the register itself |
| U9 | **Nothing to keep running.** One Rust Worker on Cloudflare primitives: no servers, no external database, no billing vendor in the request path | NFR-COST-1, NFR-BILL-2 | W2 |
| U10 | **Agents that can prove who they are.** Each identity signs short-lived assertions with its own Ed25519 key, which any service verifies against the identity's published key set; the private key never leaves the Worker, and pausing the identity withdraws its keys at once | FR-IDN-6, FR-IDN-7, FR-IDN-9 | O1–O8, `it::assertions::sdk_verifies` |

### Competitive landscape

Researched on 2026-10-09 from each product's public documentation and repository; re-check before quoting
externally. "–" means the capability is not offered or not documented.

| Capability | AgentMail (hosted) | goshen-email (FSL, self-host or hosted) | Pylota Mail |
|---|---|---|---|
| Identity separate from address; domain change with rollback | – (the address is the inbox) | – | Yes (U3) |
| Required idempotency; uncertain sends never resent | Optional keys | Yes | Yes, plus reconciliation (U2) |
| Keyword search | Yes | Yes (full-text) | Yes, with exact references |
| Semantic and hybrid search | Semantic | – | Yes, with reranking |
| Agentic search with verified citations | – | – | Yes (U1) |
| Domain health checks with aligned fallback | – | – | Yes (U4) |
| Authentication verdicts and quarantine before an agent reads | Spam labels | At the gateway | Yes, per message (U5) |
| Triage | – | Yes (metered) | Yes, with deterministic rules |
| Erasure with receipts | Per message | Per inbox | Message, thread, counterparty, identity, tenant (U6) |
| Team seats | – | Listed; one member per account today | Enforced, with roles (U7) |
| Plan metering | Hosted | Third-party (Autumn), fails closed when it is down | In-process atomic holds (U9) |
| Runs in your own Cloudflare account | – | Yes | Yes |
| Language | – | TypeScript | Rust |

## 5. Scope and priorities

`P0` must ship in v1.0. `P1` ships in v1.0 unless it threatens the release, in which case it moves to
v1.1 with a written ADR. `P2` is v1.1 or later.

| Area | P0 | P1 | P2 |
|---|---|---|---|
| Tenancy and keys | Tenants (live and test), API keys at four levels, partner keys for integrators on a shared deployment (FR-KEY-4) | – | – |
| Identities | CRUD, idempotent create, pause, accountable human; agent signing keys and assertions (JWKS) | Signed HTTP requests (Web Bot Auth, spike S13) | – |
| Addresses | Platform domain, aliases, promote, retire, rollback | – | – |
| Domains | Platform domain; `cloudflare_zone`; `nameservers` | `dns_records` (spike S11); `send_only` (S8); `smtp_relay` (S12); `delegated_subdomain` behind `PM_CF_SUBDOMAIN_SETUP` (S10) | Mailgun and SendGrid inbound sources |
| Inbound | Parse, verdicts, quarantine, loops, attachments, extracted text | Malware scanner hook | – |
| Outbound | Send, reply, reply-all, forward, idempotency, uncertain, suppression | Signed links for large files | Scheduled send |
| Delivery | All six provider event types, per-recipient status | Uncertain-send reconciliation | – |
| Search | Keyword, semantic, hybrid, agentic; facets; tenant scope | Contacts, find-related | – |
| Triage | Category, needs-reply, urgency, summary, risk flags; rules | Custom categories | – |
| Integrations | REST, OpenAPI, MCP (API key), CLI, Rust SDK, webhooks; `wait` long-poll and verification extraction (quarantine rule 5, unsolicited OTP, depends on it: E4, E5) | – | MCP OAuth 2.1, WebSocket push |
| Privacy | Retention, erasure with receipts, legal hold | Subject-access export | – |
| Operations | Setup, deploy, doctor, metrics, DLQ consumers, test mode | Restore drill tooling | – |
| Console | Sign-in, workspaces, members, roles, seats, inboxes, quarantine release, keys, domains, plan and usage; Cloud sign-up (waitlist and open); Google and GitHub sign-in; two-step verification (TOTP); the Overview; notifications | – | Passkeys; SSO (SAML/OIDC) |
| Plans and billing | Plan catalog, metering with holds, `402 billing_limit`, usage API, Stripe checkout and portal, top-ups; usage alerts | – | Annual billing, invoicing |

## 6. Functional requirements

### 6.1 Tenancy and access

- **FR-TEN-1** The service **must** support many tenants in one deployment. Every record belongs to
  exactly one tenant, except platform-level settings and the platform domain.
- **FR-TEN-2** A tenant **must** be either `live` or `test`. Mail a `test` tenant sends **must not**
  leave the deployment (see FR-OUT-12).
- **FR-TEN-3** A tenant **must** be suspendable. While it is suspended, inbound mail is answered with a
  temporary failure for up to five days, then refused permanently, and every send is refused. On domains
  that receive through SES, which accepts mail before the Worker sees it, inbound mail is held for the same
  five days and then dropped without a bounce (FR-DOM-9).
- **FR-KEY-1** API keys **must** be scoped at one of four levels: `platform`, `partner`, `tenant` or `identity`.
  Each key holds a list of permissions. A key can never create a key wider than itself.
- **FR-KEY-2** Key secrets **must** be shown once, stored only as a keyed hash, support expiry, and
  support rotation with an overlap window.
- **FR-KEY-3** Tenant and identity scope **must** come from the authenticated key, never from the request body.
- **FR-KEY-4** A deployment **must** support **partners**: integrators that run their own customers as
  tenants of a shared deployment (Pylota on Pylota Mail Cloud). A platform key creates, suspends and
  deletes a partner and mints its **partner keys**. A partner key **must** be able to create tenants and
  act on them as a platform key does, and on nothing else: a tenant created by another partner or by no
  partner, and everything in it, **must** answer it as a missing one does. It **must never** mint a partner
  or platform key, hold `platform:ops`, `partners:manage` or `identities:sign`, or change a tenant's
  billing mode, which comes from the partner's `default_billing_mode`. A partner's webhook endpoints
  **must** receive only its own tenants' events. A suspended partner's keys **must** be refused while its
  tenants keep working, and a partner **must not** be deletable while it has a tenant that is not erased
  ([REST API › Partners](../reference/api.md#partners), [Security › Partner keys](design/security.md#partner-keys)).

### 6.2 Identities and addresses

- **FR-IDN-1** Create, read, list, update, pause, resume and delete identities. A create with a
  `client_id` the tenant has already used **must** return the existing identity, or `409` if the
  request differs.
- **FR-IDN-2** An identity **must** record an accountable human (name and email). Until it has one,
  it **must not** send.
- **FR-IDN-3** A paused identity **must** still receive and store mail. It **must** refuse every send
  with `identity_paused`.
- **FR-IDN-4** Deleting an identity **must** run an identity-scope erasure and tombstone all of its
  addresses permanently.
- **FR-IDN-5** Not assigned. IDs are never reused, so the gap stays.
- **FR-IDN-6** Each identity **must** have Ed25519 signing keys that are generated, sealed and used only
  inside the Worker and are never exported or imported. An identity has one `active` key, created on its
  first signing request or on request, and **must** support rotation with an overlap
  (`PM_IDENTITY_KEY_OVERLAP_DAYS`, default 7 days) during which the previous key stays published, and
  revocation that removes a key from publication at once. Key IDs are RFC 7638 thumbprints
  ([Agent signing keys](design/agent-keys.md)).
- **FR-IDN-7** An identity **must** be able to mint short-lived agent assertions (JWT signed with
  `EdDSA`, 60–600 seconds) for an audience it names. An assertion carries the identity's address,
  display name and workspace name and whether it has an accountable human, and **must never** carry the
  owner's personal data. Each identity's public keys **must** be published as a JWKS at
  `/.well-known/jwks/{identity_id}.json`, so any service can verify an assertion; the Rust SDK and the
  CLI **must** include a verifier.
- **FR-IDN-8** An identity **should** be able to obtain Web Bot Auth signature headers (RFC 9421, signed
  with the deployment key, with its address in a signed `From` header) for HTTP requests its agent makes,
  with the deployment's key directory published at `/.well-known/http-message-signatures-directory`. It is
  off unless the operator sets `PM_WEB_BOT_AUTH=on` (allowed only once spike S13 has passed) and the
  tenant's policy has `web_bot_auth.allowed: true`.
- **FR-IDN-9** Pausing an identity, or suspending its tenant, **must** stop new signatures at once and
  withdraw the identity's JWKS (`404`). Deleting or erasing an identity **must** delete its keys and
  tombstone their key IDs, so a deleted key ID is never published again.
- **FR-ADR-1** An identity **must** support several addresses over time. Each address has a role
  (`primary` or `alias`) and a status (`pending`, `active`, `retiring` or `retired`).
- **FR-ADR-2** Promoting an address **must**:
  - make it the primary, so new threads send from it;
  - keep existing threads replying from the address the other party wrote to;
  - move the old primary to `retiring` for a configurable grace period (default 90 days), except the
    identity's platform address, which becomes an `active` alias. The platform address is the fallback
    address of FR-DOM-6, so it **must never** be retired or deleted (`409 address_in_use`).
- **FR-ADR-3** A retiring address **must** keep receiving mail into the same identity. After the grace
  period it becomes `retired`, and mail to it **must** be refused with `550 5.1.6`.
- **FR-ADR-4** Promoting a retiring address again **must** roll back the change.
- **FR-ADR-5** A deleted or erased address **must** never be assigned to a different identity. Mail to an
  erased address **must** get `550 5.1.1`, with no hint that the address existed.
- **FR-ADR-6** Reserved and confusable local parts **must** be refused:
  - on the shared platform domain, every RFC 2142 role name (including `info`, `marketing`, `sales` and
    `support`) where it would stand alone as the local part (usernames of the default tenant, whose
    address suffix is empty); mail to the operational names goes to the operator rather than an agent;
  - on a tenant's own domain, only `postmaster` and `abuse`, which route to the tenant's owner contact;
    the other role names are allowed there, because the tenant owns the domain;
  - everywhere, `noreply`, `mailer-daemon` and similar names, and names the service uses itself;
  - homoglyph look-alikes of the names reserved on that domain.
- **FR-ADR-7** Internationalised (SMTPUTF8) local parts **must** be refused with a clear error, because
  Cloudflare Email Routing cannot route them. Unicode display names are allowed.

### 6.3 Domains

- **FR-DOM-1** The deployment **must** have one platform domain: a zone apex with catch-all routing to
  the Worker. All tenants can use it. Addresses on it take the form `{username}{tenant_suffix}@{platform}`.
- **FR-DOM-2** A tenant **may** add its own domains. The connection method chosen when a domain is added
  (FR-DOM-7) fixes its kind: `zone` (a zone, apex or subdomain, in the deployment's Cloudflare account),
  `delegated` (a child zone for one subdomain) or `external` (a domain whose DNS stays at any other host).
- **FR-DOM-3** DNS records shown to users **must** come from the provider API at request time. They are
  never copied from documentation or templates.
- **FR-DOM-4** Verification and health checks **must** run on a schedule:
  - every 15 minutes for each domain;
  - immediately after any change;
  - with two independent DNS-over-HTTPS resolvers, and two consecutive results before state changes.
- **FR-DOM-5** The domain health states `healthy`, `degraded`, `failing` and `suspended`, and the
  recovery transition (reported as `domain.recovered`), **must** behave as specified in
  [Identities, addresses and domains](design/identity-domains.md#domain-health).
  In particular, the service **must never** send as a domain whose authentication records are broken, and
  **must never** send as a domain whose ownership signals have changed.
- **FR-DOM-6** When a domain fails, sending **must** fall back to the identity's platform address,
  keeping the display name and thread continuity. Each fallback message is marked `sent_via_fallback`.
  The platform address therefore stays `active` for the identity's whole life (FR-ADR-2).
- **FR-DOM-7** Adding a domain **must** use one of six connection methods: `cloudflare_zone`,
  `nameservers`, `dns_records`, `send_only`, `smtp_relay` and `delegated_subdomain`. The method fixes the
  domain's `kind`, its inbound source (`inbound`) and its outbound transport (`transport`), as specified
  in [Domains on any DNS host](design/domain-connections.md#2-inbound-source-and-outbound-transport-are-separate-choices).
  Users **must not** combine them by hand. A request without `method` maps the old `kind` (`zone` →
  `cloudflare_zone`, `external` → `send_only`).
- **FR-DOM-8** `dns_records` **must** connect a domain, apex or subdomain, whose DNS stays at any host,
  with Amazon SES in both directions. The customer publishes one MX, three DKIM CNAMEs, a MAIL FROM MX and
  TXT, and an ownership TXT, each returned by the API with `name` and `host`. The domain **must** use a
  custom MAIL FROM (`pm-bounce.{domain}`), and health checks **must** cover every record and setting its
  method needs.
- **FR-DOM-9** Mail received through SES **must** be ingested exactly once per S3 object and recipient:
  an SNS HTTPS push, an SQS backstop drained every minute, and the `ses_ingest` ledger. The SNS endpoints
  **must** accept only signature version 2. On an SES domain, mail to an unknown address **must** be dropped without
  a bounce, and mail to a retired address **must** be bounced with `550 5.1.6`.
- **FR-DOM-10** `send_only` **must** let agents send as addresses on a domain whose mailbox stays with the
  customer's provider: SES sends, and inbound mail arrives through a forwarding rule in the customer's
  mailbox to the identity's platform address. Each address on such a domain **must** report its
  `forwarding` state (`unverified`, `ok` or `failed`), and a forwarding test **must** be available.
- **FR-DOM-11** `smtp_relay` **must** send through the customer's own provider over SMTP submission on
  port 465 or 587 only, and **must** require TLS before any credentials are sent. The credentials are
  sealed and never returned. An alignment probe **must** pass before the first send and again every day; a
  failing probe moves the domain to `failing`, and sends fall back to the platform address (FR-DOM-6).
- **FR-DOM-12** `nameservers` **must** create a Cloudflare zone for a domain used only for mail. It
  **must** refuse a name that has A, AAAA or MX records, or a CNAME, A or AAAA record at `www`, with
  `409 domain_not_dedicated` unless the request carries `"confirm_dedicated": true`. A tenant key **may**
  use it only when its policy has `domains.allow_create_zone: true`. `delegated_subdomain` **must** stay
  off unless `PM_CF_SUBDOMAIN_SETUP=on`, the Cloudflare account is Enterprise, and spike S10 has passed.

### 6.4 Inbound

- **FR-IN-1** Raw mail **must** be written to object storage before the message is acknowledged. If the
  write fails, the sender **must** get a temporary failure.
- **FR-IN-2** Unknown addresses get `550 5.1.1`. Retired addresses get `550 5.1.6`. Suspended tenants
  get a temporary failure (4xx) for up to five days, then `550 5.2.1` (FR-TEN-3). Domains that receive
  through SES cannot answer during the SMTP session; FR-DOM-9 sets their behaviour.
- **FR-IN-3** Every message **must** be parsed with size and depth caps. Mail that cannot be parsed is
  kept raw and flagged `parse_degraded`, never dropped.
- **FR-IN-4** Every message **must** carry:
  - an authentication verdict (SPF, DKIM, DMARC, ARC);
  - a spam signal;
  - `known_sender`;
  - a quarantine decision.
- **FR-IN-5** Messages that fail authentication, carry a risky attachment or exceed the spam threshold
  **must** be quarantined. Quarantined mail is hidden from agents unless the key holds `quarantine:review`.
- **FR-IN-6** Automated mail **must** be classified and marked `automated`, so agents never auto-reply to
  it. This covers:
  - auto-replies (RFC 3834) and out-of-office replies;
  - mailing lists;
  - bounces (DSNs, which update delivery state instead of reaching agents);
  - read receipts.
- **FR-IN-7** Every message **must** expose `text`, sanitised `html`, and `extracted_text` (the new
  content with quoted history and signatures removed). HTML-only mail **must** produce text.
- **FR-IN-8** Attachments **must** be stored and fetchable. Text **must** be extracted for PDF, Office
  and text formats, and for images when the tenant enables it.
- **FR-IN-9** Hidden text (zero-width characters, CSS-hidden content, white-on-white) **must** be removed
  from agent-facing text and raised as a risk flag.

### 6.5 Outbound

- **FR-OUT-1** Send, reply, reply-all and forward **must** require an `Idempotency-Key`:
  - the same key with the same request returns the original result with `deduplicated: true`;
  - the same key with a different request returns `409 idempotency_conflict`.

  Keys are kept for 30 days.
- **FR-OUT-2** A transport outcome that cannot be known (a timeout, or a connection lost after
  submission) **must** set the status to `uncertain`. The service **must never** resend it automatically.
- **FR-OUT-3** Policy **must** run before transport:
  - the identity and tenant are active, and the identity has an accountable human;
  - per-identity and per-tenant caps;
  - suppressions and block lists;
  - the recipient-count limit;
  - the size limit;
  - no automatic reply to automated mail.
- **FR-OUT-4** Suppressed recipients **must** be removed per recipient, with the rest delivered and each
  outcome reported. A send where every recipient is suppressed ends `suppressed`.
- **FR-OUT-5** Replies **must** set `In-Reply-To` and `References`. They **must** send from the address
  the counterparty last wrote to, unless that address is retired.
- **FR-OUT-6** Every outbound message **must** carry a thread token in its `Reply-To` sub-address, where
  the domain supports it.
- **FR-OUT-7** Agent-initiated automatic replies **must** carry `Auto-Submitted: auto-replied`.
- **FR-OUT-8** Marketing mail (`kind: marketing`) **must** include RFC 8058 one-click unsubscribe headers
  and a visible link, and **must** be refused without them.
- **FR-OUT-9** Two concurrent sends into the same thread **must** be serialised. The second gets
  `thread_busy` if the first holds the lock for longer than 10 seconds.
- **FR-OUT-10** Attachments **must** be refused once the message exceeds the transport limit (5 MiB with
  Cloudflare). A tenant **may** enable expiring signed links instead.
- **FR-OUT-11** A message **may** be cancelled while it is `queued`.
- **FR-OUT-12** Test tenants **must** use the simulator transport:
  - mail to `*@simulator.invalid` produces a scripted outcome (`delivered`, `bounce`, `softbounce`,
    `complaint`, `deferred`, `reject`, `timeout`);
  - mail to addresses on this deployment is delivered internally;
  - all other recipients are refused with `test_mode_recipient`.

### 6.6 Delivery

- **FR-DLV-1** Provider events (`delivered`, `deferred`, `bounced`, `failed`, `rejected`, `complained`)
  **must** update each recipient's status and emit webhook events.
- **FR-DLV-2** A hard bounce **must** create a suppression. A complaint **must** create a permanent
  suppression and count towards the identity's complaint rate.
- **FR-DLV-3** An identity whose complaint rate exceeds 0.3% over its last 1,000 sends, or whose bounce
  rate exceeds 5% over its last 200, **must** be paused automatically with reason `abuse_threshold`. This
  applies to every identity except the deployment's system identity, whose outcomes are recorded but
  never pause it (its bounces and complaints pause the affected person's notifications instead).
- **FR-DLV-4** Uncertain sends **should** be reconciled from provider events by matching sender,
  recipient and subject within 30 minutes. A match moves the send to its real status with `reconciled: true`.
- **FR-DLV-5** DSNs that do not match a message we sent (backscatter) **must** be dropped and counted.

### 6.7 Threading

- **FR-THR-1** An inbound message joins a thread by, in order:
  1. a valid thread token in the recipient sub-address;
  2. `In-Reply-To` or `References` matching a stored message;
  3. otherwise it starts a new thread.

  The subject alone **must never** join a thread.
- **FR-THR-2** A forwarded message (`message/rfc822` part) **must** be parsed as a nested message and
  **must not** be merged into the outer thread.

### 6.8 Search

- **FR-SRCH-1** Four modes **must** ship together, returning one result shape: `keyword`, `semantic`,
  `hybrid` (the default) and `agentic`.
- **FR-SRCH-2** Keyword search **must** be consistent with the mailbox: a message is searchable in the
  same transaction that stores it.
- **FR-SRCH-3** The query language **must** support:
  - `from:`, `to:`, `participant:`, `subject:`, `ref:`, `label:`;
  - `has:attachment`, `filename:`, `type:`;
  - `after:`, `before:`, `newer_than:`, `older_than:`;
  - `in:inbound|outbound`, `thread:`, `is:unread|needs_reply|quarantined`, `category:`;
  - quoted phrases, `OR`, and `-` negation.

  Queries **must** be parsed into a typed tree, and raw input **must never** reach the FTS engine.
- **FR-SRCH-4** Exact references (vehicle plates, invoice, order and PCN numbers, amounts, phone numbers,
  plus tenant-defined patterns such as booking numbers) **must** be extracted at ingest and matched
  exactly.
- **FR-SRCH-5** Results **must** include facets (`sender`, `sender_domain`, `month`, `label`,
  `attachment_type`, `category`), a `why` list per hit, and trust metadata. They **must** respect size budgets (`limit`,
  `snippet_chars`, a byte cap that sets `truncated`).
- **FR-SRCH-6** Cursors **must** pin an `as_of` point, so pagination is stable while mail arrives.
- **FR-SRCH-7** Semantic results **must** report `semantic_coverage`, the share of the mailbox embedded.
- **FR-SRCH-8** Agentic search **must**:
  - run a bounded loop of planning, searching, judging and refining;
  - stream progress over SSE on request;
  - return the evidence, an answer, a confidence value and a step trace;
  - remove any answer sentence whose citations fail a deterministic check (each cited ID is in the
    evidence set, and each quoted phrase appears in the source).
- **FR-SRCH-9** Agentic search **must** return `insufficient_evidence` when the evidence does not answer
  the question, `budget_exhausted` when it runs out of budget, and degrade to hybrid search (with
  `degraded: true`) when the model is unavailable. It **must never** return a fabricated answer.
- **FR-SRCH-10** Tenant scope (all of a tenant's identities) **must** require a tenant-level key.
- **FR-SRCH-11** Erasure **must** remove keyword rows, references and vectors together. A probe query
  after erasure **must** return nothing.

### 6.9 Triage

- **FR-TRI-1** Every inbound, non-quarantined message **must** be triaged asynchronously. Triage sets:
  - `category`: from the built-in list, or the tenant's custom list;
  - `needs_reply`: 0 to 1;
  - `urgency`: 0 to 3;
  - `summary`: at most 280 characters;
  - `language`: BCP 47;
  - `risk_flags`.
- **FR-TRI-2** Deterministic rules (tenant-defined and built-in) **must** run before the model. They can
  set fields and skip the model.
- **FR-TRI-3** Triage is advisory. It **must never** send, delete or release a message.
- **FR-TRI-4** The triage model **must** receive mail content as fenced, untrusted data. Its output
  **must** be validated against a schema, and invalid output is recorded as `failed`, never guessed.

### 6.10 Events and webhooks

- **FR-WH-1** Webhook endpoints **must** be configurable at platform, partner and tenant level, with event-type
  and identity filters.
- **FR-WH-2** Payloads **must** be signed with Standard Webhooks, using a separate secret per endpoint.
  Rotation **must** support an overlap window, during which both signatures are sent.
- **FR-WH-3** Delivery **must** retry with backoff for up to 72 hours, then move to a dead-letter state,
  from which events can be replayed.
- **FR-WH-4** Payloads **must** be thin: IDs, a header summary, verdicts, triage, and at most 64 KB of
  extracted text. Full content is fetched through the API.
- **FR-WH-5** Endpoint URLs **must** be HTTPS. Private, loopback and reserved addresses are refused,
  redirects are not followed, and responses are capped in size and time.

### 6.11 Interfaces

- **FR-API-1** The REST API is versioned under `/v1` and described by OpenAPI 3.1, generated from
  Rust types and served at `/openapi.json`.
- **FR-API-2** Every error **must** use the [error envelope](../reference/errors.md), with `retryable` set.
- **FR-MCP-1** An MCP server **must** be served at `/mcp` over Streamable HTTP, exposing the tools in
  [MCP reference](../reference/mcp.md). It is authenticated with an API key in v1.0. Tool scope **must**
  follow the key.
- **FR-CLI-1** The `pmail` CLI **must** cover setup, deploy, doctor, administration and mail operations,
  with `--json` output for every command.
- **FR-SDK-1** The Rust SDK **must** cover the whole REST API.

### 6.12 Privacy

- **FR-PRV-1** The jurisdiction (`eu` or `default`) **must** be chosen at setup and applied to D1, R2 and
  every Durable Object.
- **FR-PRV-2** Retention **must** be configurable per tenant:
  - raw MIME: 90 days by default;
  - parsed messages: kept by default;
  - events and delivery logs: 30 days by default (`retention.events_days`, 1–365).

  Every purge **must** write an audit event.
- **FR-PRV-3** Erasure **must** be supported per message, thread, counterparty, identity and tenant. It
  **must** return a receipt counting what was deleted in each store.
- **FR-PRV-4** A legal hold on a thread **must** stop retention and erasure from deleting it. Erasure
  receipts **must** list each held item.
- **FR-PRV-5** Subject-access export **must** produce every message to or from a counterparty across a
  tenant's identities, as `.eml` plus JSON.
- **FR-PRV-6** Logs **must never** contain message bodies, attachment content, or clear-text email addresses.

### 6.13 Operations

- **FR-OPS-1** `pmail setup` **must** create every Cloudflare resource idempotently, and **must** be
  safe to re-run.
- **FR-OPS-2** `pmail deploy` **must** deploy a prebuilt, checksum-verified Worker bundle by default, so
  self-hosters need no Rust toolchain. It **must** also support `--from-source`.
- **FR-OPS-3** `pmail doctor` **must** check DNS, routing, sending, event subscriptions, bindings, secrets
  and quota, and print a fix for each failure.
- **FR-OPS-4** Every queue **must** have a dead-letter queue with a consumer that records and alerts.

### 6.14 Console and workspaces

- **FR-CON-1** The console **must** be served by the same Worker at `/console`, rendered on the server in
  Rust, and **must** work fully without JavaScript. Every state change is a POST with a CSRF token.
- **FR-CON-2** A workspace is a tenant. Each workspace **must** have exactly one owner and any number of
  members up to its seat limit. Roles are `owner`, `admin`, `member` and `viewer`, with the permissions in
  [Console design](design/console.md#roles). Ownership can be transferred to an admin.
- **FR-CON-3** Sign-in **must** be passwordless: a single-use magic link or a six-digit code sent by email,
  valid for 10 minutes. It **must** be rate-limited: 3 link or code requests per 10 minutes per address;
  10 attempts per code (the token is burned after 10 failures); and `RL_SIGNIN`, 10 requests per 60 s per
  client IP on the sign-in, sign-up and waitlist routes. Passkeys (WebAuthn) are P2: they need browser
  JavaScript, which the console does not use (FR-CON-1).
- **FR-CON-4** Members are invited by email. A pending invitation **must** count against the seat limit and
  expire after 7 days. Removing a member **must** end their sessions immediately.
- **FR-CON-5** Sensitive actions **must** require a sign-in within the last 10 minutes and be written to the
  audit log: creating keys, inviting or removing members, changing roles, adding or removing domains,
  releasing quarantine, erasure, and billing changes.
- **FR-CON-6** The console **must** show inboxes, threads and messages (with untrusted content rendered as
  sanitised, inert HTML in a sandboxed frame or as text), search, quarantine with release, keys, domains,
  webhooks, members, plan and usage, and settings. On Cloud, releasing quarantine **must** be possible
  only for a signed-in person (`PM_QUARANTINE_KEY_RELEASE=off`), except in a workspace whose policy has
  `quarantine.key_release: true`, which only a platform key or the workspace's partner key can set; there,
  API keys with `quarantine:review` can release too. Self-hosters can allow release by API keys with
  `quarantine:review` everywhere (`on`, the default for self-hosting).
- **FR-CON-7** A self-hosted deployment **must** create its first owner during `pmail setup`
  (`--owner-email`). The console **must** be optional (`PM_CONSOLE=off` removes its routes).
- **FR-CON-8** Self-serve sign-up **must** follow `PM_SIGNUP`: `closed` (the default; no public sign-up),
  `waitlist` or `open`. A waitlist entry **must** be confirmed by email (double opt-in) and creates no
  account. The operator invites confirmed entries in batches (`POST /v1/platform/waitlist/invite`), each
  with a sign-up link valid for 7 days for the waitlisted address only. With email sign-up, the account
  **must** be created only when the link or code is used.
- **FR-CON-9** Sign-in with Google and GitHub **must** be available when their client credentials are
  configured (on Pylota Mail Cloud). It **must** accept only a verified email address, use PKCE and a
  `state` bound to the browser by a cookie, and link to an existing person with the same verified email.
- **FR-CON-10** A person **must** be able to enrol two-step verification with an authenticator app (TOTP,
  RFC 6238) and ten single-use recovery codes. Once enrolled, it is asked for after every first factor and
  at re-authentication. A workspace owner **may** set `require_two_factor`; a member without two-step
  verification **must** enrol before entering that workspace.
- **FR-CON-11** After sign-in, the console **must** route each person by the rules in
  [Cloud sign-up › Where people land](design/cloud-signup.md#7-where-people-land). A `next` value **must**
  be followed only when it is a relative path under `/console/` with no `//`, backslash or scheme.
- **FR-CON-12** The workspace home (`/console`, the Overview) **must** show banners for conditions that
  need action, the first-run checklist (each step's state derived from real data on every render, never
  stored), "Needs a person" (the actions only a person should take) and usage against each allowance.
- **FR-CON-13** Returning from Stripe Checkout **must** never change the plan: Stripe webhooks are the only
  source of plan state (FR-BILL-10), and another workspace's Checkout session changes nothing. Pylota Mail
  Cloud **must** apply abuse controls: `RL_SIGNIN`, a new-workspace send ramp (a tenant daily cap of at
  most 50 for the first 7 days on Free, lifted by a daily evaluation of bounce and complaint rates or at
  once by a paid plan), refusal of disposable addresses (`PM_SIGNUP_BLOCKED_DOMAINS`), and system mail
  sent from `PM_SYSTEM_FROM`.
- **FR-CON-14** A person **may** opt in, per workspace, to email notifications of new mail in the inboxes
  they choose (`instant`, `hourly` or `daily`). Notifications **must** be coalesced (one email per person
  and inbox per window), **must** count only mail that becomes visible in the inbox, and **must never**
  include content from the mail: no subject, sender, snippet or attachment name
  ([Notifications](design/notifications.md)).
- **FR-CON-15** Owners and admins **must** receive a daily "needs a person" email by default
  (quarantined mail, uncertain sends, failing domains and failing webhooks), and the person concerned
  **must** receive `account` emails for security and billing events, which cannot be turned off. Every
  other notification **must** carry RFC 8058 one-click unsubscribe. Notification email is capped at 50 per
  person and 200 per workspace a day, beyond which items go into one daily digest email (itself
  unsubscribable and not capped).

### 6.15 Plans, metering and billing

- **FR-BILL-1** Each workspace **must** have a billing mode: `metered` (a plan applies), `exempt` (no checks,
  for the operator's own tenants, or a partner's tenants that the operator does not bill per workspace) or
  `disabled` (self-hosting without billing: only the daily caps in tenant policy apply). A tenant created
  with a partner key takes its partner's `default_billing_mode`; only a platform key changes it (FR-KEY-4).
- **FR-BILL-2** The plan catalog **must** be data (`PM_PLAN_CATALOG`), defaulting to the Pylota Mail Cloud
  plans in section 13. A plan defines allowances for `inboxes`, `sends`, `triage`, `custom_domains`,
  `storage_gb` and `seats`, a price, and whether top-ups are allowed.
- **FR-BILL-3** Monthly allowances (`sends`, `triage`) **must** reset at the start of each billing period.
  Counts (`inboxes`, `custom_domains`, `seats`, `storage_gb`) **must not** reset.
- **FR-BILL-4** Every metered action **must** take an atomic hold in the workspace's `TenantQuota` object
  before it runs, and settle it (consume or release) when the outcome is known. Holds that are never
  settled **must** expire after 10 minutes. Two requests **must never** both pass on the last unit.
- **FR-BILL-5** One send is one recipient: a message to three recipients uses three sends. A send is
  consumed when the transport accepts it; a rejected, failed or cancelled send releases its hold; an
  `uncertain` send releases its hold and is consumed later only if reconciliation shows it was sent.
- **FR-BILL-6** A denied metered action **must** return `402 billing_limit` before any idempotency record is
  written, so the same `Idempotency-Key` succeeds after the workspace upgrades or adds a top-up. A replay of
  an already-completed send **must** return its original result even when the allowance is spent.
- **FR-BILL-7** Triage **must** hold one unit when a message arrives and consume it when the analysis is
  stored; a failed analysis refunds it. Quarantined mail is charged only when someone releases it.
- **FR-BILL-8** Inbound mail **must never** be refused or dropped because a plan limit is reached. When
  `storage_gb` is exceeded, new identities, new domains and outbound attachments are refused with
  `402 billing_limit` until usage falls or the plan changes; mail keeps arriving.
- **FR-BILL-9** A downgrade **must never** delete data. Existing identities, domains and members are kept;
  creating more is refused until the counts fit the new plan.
- **FR-BILL-10** Payment **must** go through Stripe: Checkout for plans and top-ups, the Customer Portal for
  payment methods, invoices and cancellation, and signed webhooks (verified, deduplicated by event ID) as
  the only source of subscription state. A failed payment keeps the plan for a 7-day grace period, then
  moves the workspace to Free limits.
- **FR-BILL-11** `GET /v1/usage` **must** return the billing mode, plan, each feature's granted, used,
  remaining and reset time, and the plan catalog, so agents can read their own limits.
- **FR-BILL-12** A self-hosted deployment **must** run with billing off by default and **must not** need a
  Stripe account. Turning billing on (`PM_BILLING=stripe`) is an operator choice.
- **FR-BILL-13** Owners and admins **must** be emailed when an allowance reaches 80% and 100% of its
  limit (top-ups included), unless they turn it off. Each threshold alerts at most once per billing period
  for allowances that reset, and at most once a day per feature and threshold for counts that do not.
  With billing off, no usage alert is sent. Webhook events (`quota.warning`, `billing.limit_reached`) are
  unchanged.

## 7. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-REL-1 | Acknowledged inbound messages lost | 0 |
| NFR-REL-2 | Valid inbound mail accepted | ≥ 99.9% per month |
| NFR-REL-3 | Inbound accepted → webhook delivered | p95 ≤ 30 s, p99 ≤ 120 s |
| NFR-REL-4 | Webhook delivered within 24 h, including retries | ≥ 99.99% |
| NFR-PERF-1 | Send API (accepted into queue) | p95 ≤ 500 ms |
| NFR-PERF-2 | Queued → handed to transport | p95 ≤ 60 s |
| NFR-PERF-3 | Keyword search, one identity | p95 ≤ 200 ms |
| NFR-PERF-4 | Hybrid search, one identity | p95 ≤ 800 ms |
| NFR-PERF-5 | Tenant search across up to 10 identities | p95 ≤ 1 s |
| NFR-PERF-6 | Agentic search | p95 ≤ 8 s, first evidence ≤ 1.5 s |
| NFR-QUAL-1 | Search recall@10 on the golden mailbox | ≥ 0.90 (hybrid), CI fails on a drop over 1 point |
| NFR-QUAL-2 | Agentic citation precision | ≥ 0.98 after verification |
| NFR-QUAL-3 | Triage category accuracy on the labelled set | ≥ 0.85 |
| NFR-SEC-1 | Cross-tenant access in attack tests | 0 |
| NFR-SEC-2 | Worker bundle size | ≤ 10 MiB compressed (startup ≤ 1 s) |
| NFR-PRV-1 | Erasure completes | ≤ 24 h, receipt always produced |
| NFR-OPS-1 | Fresh deploy, hands-on time | ≤ 15 minutes |
| NFR-OPS-2 | Recovery point / time objectives | RPO ≤ 1 min (indexes); ≤ 15 min (blobs) against infrastructure loss, from R2's durability. R2 has no versioning or replication, so blobs deleted by a bug are recoverable only with the optional nightly backup bucket (RPO 24 h, off by default); RTO ≤ 4 h |
| NFR-COST-1 | Idle deployment cost beyond Workers Paid | ≈ 0 (no always-on compute) |
| NFR-BILL-1 | Metered actions allowed beyond a granted allowance | 0 (holds are atomic per workspace) |
| NFR-BILL-2 | Metered actions failed because a billing provider was unreachable | 0 (metering is in-process; Stripe is only needed to change plans) |
| NFR-CON-1 | Console pages, server render time | p95 ≤ 300 ms |

## 8. Success metrics

- Pylota cut over from AgentMail. Every operator has four identities, inbound mail works end to end,
  and none of the edge-case register's `S` rows fails in production for 30 days.
- A third party deploys from the README alone, with no help, inside 15 minutes (measured in usability runs).
- Agents in Pylota's eval suite find and cite the right email in at least 90% of mail-retrieval tasks.
- Zero duplicate sends attributed to retries.

## 9. Release criteria (v1.0)

1. Every `P0` requirement maps to at least one passing test (unit, conformance, or integration against workerd).
2. Every row in the [edge-case register](edge-cases.md) marked `S` or `S+I` has a named, passing test.
3. The live end-to-end suite passes on a staging deployment. It covers real inbound from Gmail and
   Outlook, real outbound to both, bounce and complaint simulation, a domain change, a domain failure
   with fallback, and erasure.
4. Search quality gates (NFR-QUAL-1/2) and triage gate (NFR-QUAL-3) pass.
5. A threat model is written, and the findings rated high are fixed.
6. A fresh-account deploy rehearsal has been run from the docs.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Cloudflare Email Sending is in public beta | A `MailTransport` trait with an SES adapter, plus a documented failover runbook |
| `workers-rs` is pre-1.0 | Exact pins. Only `crates/platform` touches it. Gaps (Vectorize, `toMarkdown`) are covered with `wasm-bindgen` externs |
| Vectorize has no documented jurisdiction option | Vectors hold IDs and filter fields only, never text. Documented in privacy notes |
| A shared platform domain means shared reputation | Per-identity caps, complaint and bounce auto-pause, DMARC ramp, custom domains encouraged |
| An LLM fabricates in agentic search or triage | Deterministic citation check, schema validation, untrusted-content fencing, read-only tools |
| Web Bot Auth is still an IETF draft, and Cloudflare's verifier can change | Spike S13 checks the format against Cloudflare's test endpoint. Signed HTTP requests are P1 and stay off (`PM_WEB_BOT_AUTH=off`) unless S13 passes; agent assertions rely only on published RFCs (7517, 7519, 7638, 8037) |
| SES receiving, SMTP from a Worker and child zones are unproven from a Worker | Spikes S11, S12 and S10 gate `dns_records`, `smtp_relay` and `delegated_subdomain` (`smtp_relay` with `inbound: ses` needs S11 too). A method whose spike fails moves to v1.1 by ADR; `cloudflare_zone`, `nameservers` and `send_only` do not depend on them |

## 11. Open questions

None blocking v1.0. Decisions are recorded in [ADRs](adr/index.md).

## 12. Licensing

- The source is published under the **Functional Source License, Version 1.1, ALv2 Future License**
  (`LICENSE.md`). Anyone may use, modify and redistribute it for any purpose except a *Competing Use*:
  offering it to others in a commercial product or service that substitutes for it or offers substantially
  similar functionality. Internal use, non-commercial education and research, and professional services for
  licensees are explicitly permitted.
- Each version becomes available under the Apache License 2.0 on the second anniversary of its release.
- FSL is a Fair Source licence, not an OSI-approved open-source licence. Public copy says "source available"
  or "Fair Source", never "open source".
- The licensor is **TREFT LTD**, the company behind Pylota (`LICENSE.md`: "Copyright 2026 TREFT LTD").
- Contributions are licensed to TREFT LTD under Apache-2.0 with a DCO sign-off (`CONTRIBUTING.md`), so it can
  publish them under FSL now and Apache-2.0 later.

## 13. Business model and pricing

Self-hosting is free under FSL-1.1-ALv2 with no plan limits. Pylota Mail Cloud is Pylota's hosted deployment
of the same code, with billing on. The plans mirror goshen-email's published plans (read 2026-10-09) with
every allowance identical. Each price is half goshen's figure and is charged in pounds sterling: goshen's
$20 and $99 become £10 and £49.50, and its $2 top-up becomes £1.

| | Free | Developer | Team | Self-host |
|---|---|---|---|---|
| Price (GBP, excl. VAT) | £0 | £10 a month | £49.50 a month | £0 under FSL-1.1-ALv2 |
| Inboxes (identities) | 5 | 10 | 100 | no plan limits |
| Sends per month | 1,000 | 10,000 | 100,000 | |
| Triage analyses per month | 500 | 10,000 | 100,000 | |
| Custom domains | none | 5 | 50 | |
| Storage | 1 GB | 10 GB | 100 GB | |
| Seats | 1 | 2 | 10 | |
| Top-ups | none | £1 per unit | £1 per unit | |
| Support | GitHub issues | email | priority email | contracts available |

- A **top-up unit** is one inbox, 1,000 sends or 1,000 triage analyses, added to the plan each month while
  it is subscribed. Custom domains, storage and seats have no top-up: they come with the plan.
- Every plan includes the full API, MCP server, CLI, console, quarantine review and all four search modes.
  The per-identity rolling send limit stays on every plan as an abuse backstop.
- Prices are in pounds sterling (GBP) and exclude VAT. Stripe Tax adds UK VAT, and VAT or sales tax in
  other countries, where it is due. Every customer is billed in GBP; there are no local-currency prices in v1.

### Cost controls

Sending and model calls are the costs that grow with use. Storage and Vectorize are small next to them.

- Triage and agentic-search models are chosen by evaluation, with cost per call as a scored criterion
  alongside quality ([Triage](design/triage.md), [Search](design/search.md)).
- A top-up is priced above the provider cost of what it adds.
- Usage per workspace is metered (`GET /v1/usage`), so plan allowances can be reviewed against real use.

- Agentic searches are not a separate allowance (goshen has no agentic search), so they are rate-limited per
  key and capped per workspace per day (`agentic_daily_cap`) to bound model cost.
