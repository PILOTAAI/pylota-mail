# Concepts

This page defines the things Pylota Mail is made of and how they relate. Each section ends with links
to the reference and design documents that hold the detail.

```text
Deployment (platform) ── platform keys, the platform mail domain, platform webhooks
  ├─ Partner (ptn_)          partner keys, partner webhooks · creates and manages its own tenants
  └─ Tenant (ten_)           live | test · policy · address suffix · quotas · partner_id (optional)
       ├─ Domain (dom_)      zone | delegated | external · connection method
       ├─ Webhook (whk_)     tenant endpoints
       ├─ API key (key_)     tenant or identity level
       └─ Identity (idn_)    one mailbox (Durable Object)
            ├─ Address (adr_)      primary | alias · pending | active | retiring | retired
            ├─ Signing key (kid)   active | retiring | retired
            └─ Thread (thr_)
                 └─ Message (msg_) inbound | outbound
                      └─ Attachment (att_)
```

## Tenants

A **tenant** is one customer of the deployment, for example one car-rental operator. Every record
belongs to exactly one tenant, apart from platform-level settings and the platform domain
([FR-TEN-1](project/prd.md#61-tenancy-and-access)).

| Property | Meaning |
|---|---|
| `slug` | Short name, for example `acme` |
| `mode` | `live` or `test`. A test tenant's mail never leaves the deployment: it goes to the simulator, or to identities on the same deployment ([FR-OUT-12](project/prd.md#65-outbound)). Its keys start with `pmk_test_` |
| `address_suffix` | Appended to usernames on the platform domain, `"." + slug` by default. `bookings` in tenant `acme` becomes `bookings.acme@agents.example`. Only the default tenant made by `pmail setup` has an empty suffix |
| `policy` | Caps, quarantine thresholds, retention, triage rules, search settings and more. See [Configuration › Tenant policy](reference/configuration.md#tenant-policy) |
| `status` | `active`, `suspended`, `erasing` or `erased` |
| `partner_id` | The partner whose key created the tenant, or `null`. It never changes |

While a tenant is **suspended**, every send is refused (`403 tenant_suspended`) and inbound mail is
answered with a temporary failure (a 4xx reply, so senders retry) for up to five days, then refused permanently
(`550 5.2.1`) ([FR-TEN-3](project/prd.md#61-tenancy-and-access)).

Reference: [REST API › Tenants](reference/api.md#tenants).

## Partners

A **partner** is an integrator that runs its own customers as tenants of a shared deployment, for
example Pylota with its car-rental operators on Pylota Mail Cloud. The deployment's operator creates the
partner and gives it a **partner key**. With it the partner creates tenants and manages them: their
identities, domains, keys, webhooks and mail. It reaches only the tenants its own keys created, never
another customer's ([FR-KEY-4](project/prd.md#61-tenancy-and-access)). Its tenants get the partner's
billing mode, which only the operator can change. A partner's own webhook endpoints receive the events
of its tenants and nobody else's. The operator bounds a partner: at most `max_tenants` tenants (25 by
default), limits it can lower but not raise, and suspension, which stops the partner's keys and its
tenants' keys at once while their mail keeps arriving.

Reference: [REST API › Partners](reference/api.md#partners).

## Identities

An **identity** is one agent's mailbox: its addresses, threads, messages, attachments, search index,
contacts and send history. Each identity lives in its own Durable Object, so one mailbox never
contends with another and can be deleted in one step.

| Property | Meaning |
|---|---|
| `username`, `display_name` | `bookings`, "Acme Car Hire". The display name appears in `From` |
| `owner` | The accountable human (name and email). **Required before the identity can send** (`409 identity_owner_required`) |
| `purpose`, `metadata`, `signature` | Free tags, your own key-value data, and the signature appended to sends |
| `client_id` | Your own unique name for the identity, such as `acme:bookings`. A repeated create with the same `client_id` returns the existing identity |
| `send_policy` | Per-identity daily cap, auto-reply setting and `require_known_recipient` |
| `status` | `active` or `paused`. A paused identity still receives and stores mail, and refuses every send with `409 identity_paused`. `pause_reason` is `manual`, `abuse_threshold` or `tenant_suspended`; while the tenant is suspended, sends get `403 tenant_suspended` instead |

Deleting an identity runs an identity-scope erasure and **tombstones its addresses permanently**:
they can never be given to another identity ([FR-IDN-4](project/prd.md#62-identities-and-addresses)).

An identity can also have a **signing key** (Ed25519), created on first use and sealed inside the
Worker, which never exports it. With it the identity signs **agent assertions**: short-lived tokens
that tell another service which agent it is dealing with, checked against the identity's published key
set. A paused identity cannot sign, and its key set is withdrawn. Keys rotate with an overlap (7 days
by default), and a deleted identity's key IDs are tombstoned like its addresses. Guide:
[Using it from an agent › Agent assertions](guides/agents.md#agent-assertions).

Reference: [REST API › Identities](reference/api.md#identities) · Design:
[Identities, addresses and domains](project/design/identity-domains.md),
[Agent signing keys](project/design/agent-keys.md).

## Addresses

An identity has one or more **addresses** over time. Exactly one is the `primary`; the others are
`alias`es.

- On the platform domain: `{username}{tenant suffix}@{platform domain}`, for example
  `bookings.acme@agents.example`.
- On a tenant's own domain: `{local part}@{domain}`, for example `bookings@acme.example.com`.
- The username and suffix together can be at most 40 characters, which leaves room in the 64-character
  local part for a thread token ([A12](project/edge-cases.md)).

Each address has a status:

```text
    domain healthy or degraded          another address promoted,        retire_at reached
 pending ─────────────────────────▶ active ──── or retire called ────▶ retiring ─────────────▶ retired
                                      ▲                                    │
                                      └──────── promote it again ──────────┘
                                                  (rollback)
```

| Status | Receives mail | Sends |
|---|---|---|
| `pending` | No. Waiting for its domain to be `healthy` or `degraded` | No (`domain_not_ready`) |
| `active` | Yes | Yes |
| `retiring` | Yes, into the same identity | Only on threads that already use it ([G7](project/edge-cases.md)) |
| `retired` | No: `550 5.1.6` | No |

**Changing domain** is a promotion: add an address on the new domain, wait for it to become active,
then promote it. New threads send from the new address. Existing threads keep replying from the
address the other party wrote to, until it retires ([C3](project/edge-cases.md)). The old primary
becomes a retiring alias for a grace period (90 days by default), except the identity's **platform
address**, which stays an `active` alias for good: sends fall back to it when a domain fails, so it can
never be retired (`409 address_in_use`). Promoting the old address again rolls the change back. See
[Custom domains](guides/custom-domains.md).

Unknown, deleted and erased addresses are refused with `550 5.1.1`, so nobody can tell an erased
address from one that never existed ([A6](project/edge-cases.md)). On a domain that receives through
Amazon SES, such mail is accepted by SES and then dropped without a bounce
([Custom domains › How SES domains differ](guides/custom-domains.md#how-ses-domains-differ)).

Reference: [REST API › Addresses](reference/api.md#addresses).

## Domains

A **domain** is where addresses live and what mail is sent as. The platform domain must be on
Cloudflare; a tenant's own domains can be on any DNS host.

A tenant adds a domain with one of six **connection methods**, which says what the tenant changes at
their DNS host: `cloudflare_zone` (a zone already in the deployment's Cloudflare account), `nameservers`
(a new domain used only for mail), `dns_records` (records at any DNS host), `send_only` (their existing
mailbox forwards to the agent), `smtp_relay` (the agent sends through their own provider) and
`delegated_subdomain` (Cloudflare Enterprise). The method fixes the domain's kind, how its mail arrives
and how it is sent. [Custom domains](guides/custom-domains.md#choose-how-to-connect-your-domain) explains
which to choose.

| Kind | What it is | Inbound | Outbound |
|---|---|---|---|
| `platform` | The deployment's shared mail domain, a zone apex chosen at setup. Visible to every key with `tenant_id: null` | Catch-all to the Worker | Cloudflare Email Sending |
| `zone` | A tenant's domain whose DNS is a zone in the same Cloudflare account (`cloudflare_zone`, `nameservers`) | Apex: catch-all. Subdomain: one routing rule per address, at most 200 | Cloudflare Email Sending |
| `delegated` | A subdomain delegated to its own zone in the deployment's account (`delegated_subdomain`) | Catch-all | Cloudflare Email Sending |
| `external` | A tenant's domain whose DNS is elsewhere (`dns_records`, `send_only`, `smtp_relay`) | Amazon SES, or the domain's own mail system forwarding to the identity's platform address | Amazon SES with Easy DKIM, or the tenant's own SMTP relay |

DNS records are always read from the provider APIs when you ask for them, never copied from
templates ([FR-DOM-3](project/prd.md#63-domains)). Each domain has a health state, checked every
15 minutes and after every change, with two independent DNS-over-HTTPS resolvers. A state changes
only after two consecutive agreeing results.

```text
pending ─▶ verifying ─▶ healthy ⇄ degraded ─▶ failing ─▶ suspended
                           ▲                     │
                           └──── recovered ──────┘
```

- `healthy` or `degraded`: the domain sends normally, and addresses on it can be promoted.
- `failing`: an authentication record is broken. Pylota Mail **never sends as a broken domain**.
  Sends fall back to the identity's platform address, keeping the display name and the thread, and
  each such message is flagged `sent_via_fallback` ([FR-DOM-6](project/prd.md#63-domains)).
- `suspended`: failing for 14 days, or an ownership signal changed (nameservers moved, the ownership
  TXT record disappeared, the registration changed). Ownership must be proved again.
- "Recovered" is not a state: it is the `domain.recovered` event sent when a domain returns to
  `healthy`.

Reference: [REST API › Domains](reference/api.md#domains) · Guide:
[Custom domains](guides/custom-domains.md).

## Threads and messages

A **thread** is a conversation in one identity's mailbox. An inbound message joins a thread by, in
order ([FR-THR-1](project/prd.md#67-threading)):

1. a valid **thread token** in the recipient address. Outbound messages carry one in their
   `Reply-To` sub-address, for example `bookings.acme+t03k.9f2mq7xa@agents.example`, except from domains
   whose inbound mail arrives by forwarding (`send_only`, and `smtp_relay` with `inbound: forward`):
   their own mail system may drop sub-addresses, so those messages have no `Reply-To` and replies thread
   by headers. The token is an HMAC, so a forged one is ignored ([A2](project/edge-cases.md));
2. `In-Reply-To` or `References` matching a stored message;
3. otherwise it starts a new thread. **The subject alone never joins a thread.**

A **message** has a `direction` and a `status`:

| Direction | Statuses |
|---|---|
| `inbound` | `received` (visible), `quarantined` (held for review), `throttled` (over the per-sender limit, hidden), `hidden` (from a blocked or suppressed sender, kept for audit) |
| `outbound` | `queued`, `submitted`, `delivered`, `deferred`, `bounced`, `complained`, `rejected`, `failed`, `uncertain`, `suppressed`, `canceled`. See [Outbound status](reference/api.md#outbound-status) |

What an inbound message carries:

| Field | Meaning |
|---|---|
| `extracted_text` | The new content, with quoted history and signatures removed. Returned by default, and what an agent should read first |
| `text`, `html` | The full plain text (derived from HTML when the mail is HTML-only) and sanitised HTML. Returned on request (`include=quoted`, `include=html`). The service never renders HTML |
| `trust` | The authentication verdict (`pass`, `fail`, `softfail`, `none`, `unaligned` or `unverified`) with SPF, DKIM, DMARC and ARC results, `known_sender`, `spam_score`, `automated`, `quarantined` and flags such as `display_name_spoof`, `lookalike_domain`, `reply_to_mismatch` and `hidden_text` |
| `kind` | `normal`, `automated`, `dsn`, `list`, `calendar` or `mdn`. Automated mail is marked so agents never auto-reply to it |
| `attachments` | Metadata, `text_status` for extracted text, and `risk` for unsafe files |
| `refs` | Exact references found in the mail: plates, PCNs, invoice and order numbers, amounts, phone numbers and your own patterns |
| `triage` | See [Triage](#triage) |
| `delivered_to`, `is_primary_recipient` | Which of the tenant's identities the copy was for, when one message reached several identities ([A9](project/edge-cases.md)) |

Everything in a message is **untrusted content**: show it to a model as data, never as instructions.

Reference: [Message object](reference/api.md#message-object) · Design:
[Threading](project/design/threading.md), [Inbound pipeline](project/design/inbound.md).

## Triage

**Triage** runs on every inbound, non-quarantined message after it is stored. It produces a
`category`, a `needs_reply` score from 0 to 1, an `urgency` from 0 to 3, a `summary` of at most 280
characters, the `language`, and `risk_flags` such as `payment_change_request` or
`prompt_injection_suspected`. Deterministic rules run first and can skip the model. Triage is
advisory: it never sends, deletes or releases anything ([FR-TRI-3](project/prd.md#69-triage)).

Guide: [Triage](guides/triage.md).

## Search modes

| Mode | How it works | Use it for |
|---|---|---|
| `keyword` | Full-text search (SQLite FTS5, BM25) plus exact reference matching, inside the mailbox | Exact phrases, operators, references such as `ref:AB12CDE` |
| `semantic` | The query is embedded and matched against message chunks in Vectorize | Finding mail by meaning when the words differ |
| `hybrid` (default) | Both, fused by reciprocal rank and reranked | Most searches |
| `agentic` | A bounded loop that plans searches, reads the results, refines and answers. Every citation is checked by code | Questions ("did the insurer accept the claim?") |

All four return the same result shape, with a `why` list per hit and trust metadata. Keyword search
is consistent with the mailbox: a message is searchable in the same transaction that stores it.

Guide: [Search](guides/search.md).

## Events and webhooks

Every state change appends an **event** in the same transaction as the change, so an event is emitted
exactly when something happens. Events are delivered to your **webhook endpoints** with Standard
Webhooks signatures, at least once, retried for about 72 hours.

```text
state change ──▶ outbox (same transaction) ──▶ pm-webhooks queue ──▶ signed POST ──▶ your endpoint
                                                     │                                 │
                                                     └─── retry 30 s … 19 h ◀── non-2xx ┘
```

Payloads are thin: IDs, a summary, verdicts and a little extracted text. Fetch the rest from the API.
Mailbox events carry a per-identity `sequence` for ordering.

Reference: [Webhook events](reference/events.md) · Guide:
[Receiving, webhooks and quarantine](guides/receiving.md).

## API keys and permissions

An **API key** has a level, a mode and a list of permissions:

| Level | Reaches |
|---|---|
| `platform` | Every tenant |
| `partner` | The tenants its partner's keys created, and the partner's own webhooks. It can never sign as an identity or reach the deployment's operations |
| `tenant` | Its own tenant: all its identities, domains and webhooks |
| `identity` | Its own identity. It can also read the tenant's domains and webhooks if it holds the matching `:read` permission |

- A key can never create, read, rotate or revoke a key wider than itself (`403 key_scope_exceeded`).
- Scope always comes from the key, never from the request body. A resource outside the key's scope
  returns `404`, exactly as if it did not exist.
- Keys look like `pmk_live_<lookup>_<secret>` or `pmk_test_…`. A key's mode follows its tenant.
- The secret is shown once, stored as a keyed hash, and can expire or be rotated with an overlap.

The permissions are listed in [REST API › Permissions](reference/api.md#permissions). Guide:
[Security › Keys and permissions](guides/security.md#keys-and-permissions).

## Idempotency and uncertain sends

Send, reply, reply-all and forward require an **`Idempotency-Key`** header. The same key with the same
body returns the original result (`deduplicated: true`), so a retry never sends a second email. The
same key with a different body is refused (`409 idempotency_conflict`). A key is 1–255 printable ASCII
characters, and keys are kept for 30 days.

When the transport's answer is lost (a timeout, or a connection that drops after the request was
written), nobody can know whether the email left. The message becomes **`uncertain`**, and Pylota Mail
**never resends it automatically**. It tries to reconcile the send from provider events for 30
minutes. Otherwise a person decides with `resolve`.

```text
POST …/messages ──▶ queued ──▶ transport ─┬─ accepted ─────────▶ submitted ─▶ delivered / bounced / …
 (Idempotency-Key)                        ├─ refused ──────────▶ rejected or failed
                                          └─ no answer ────────▶ uncertain ─┬─ provider event ▶ reconciled
                                                                            └─ resolve sent | not_sent
```

Guide: [Sending › Safe retries](guides/sending.md#safe-retries).

## Quarantine

**Quarantine** holds inbound mail that should not reach an agent: mail that failed authentication,
scored above the spam threshold, carries a risky attachment, or is an unsolicited one-time code.
Quarantined mail is stored but hidden from every key without `quarantine:review`. A person with that
permission releases it in the console; a key with it can release it too where the deployment allows
(`PM_QUARANTINE_KEY_RELEASE=on`, the self-hosting default) or the tenant's policy does
(`quarantine.key_release`). Lists and search leave quarantined, `hidden` and `throttled` mail out
by default; it appears only when a request asks for it explicitly and the key holds
`quarantine:review`. Released mail is then triaged like any other.

Guide: [Receiving › Quarantine](guides/receiving.md#quarantine).

## Suppressions

A **suppression** stops mail to one address for one tenant. Hard bounces, spam complaints,
unsubscribes, the provider's own list and manual entries create them. A send skips suppressed
recipients and delivers to the rest. A send where every recipient is suppressed ends `suppressed`.
Suppressions are stored as a keyed hash and a masked hint, and outlive erasure, because they record a
person's objection to being contacted ([I7](project/edge-cases.md)).

Guide: [Sending › Bounces, complaints and suppressions](guides/sending.md#bounces-complaints-and-suppressions).

## Erasure and legal holds

An **erasure request** deletes data at one of five scopes (message, thread, counterparty, identity or
tenant) from every store together: mailbox rows, the keyword index, references, vectors, raw mail and
attachments. It returns a **receipt** that counts what was deleted in each store and records probe
searches that came back empty.

A **legal hold** on a thread stops retention and erasure from deleting it. Erasure skips held threads
and lists them in the receipt.

Guide: [Privacy, retention and erasure](guides/privacy.md).
