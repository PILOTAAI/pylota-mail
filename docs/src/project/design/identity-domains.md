# Identities, addresses and domains

Binding for implementation. This page defines the lifecycles of identities and addresses, username
validation, the domain kinds and their onboarding, the `DomainMonitor` health state machine and domain
fallback. The connection methods that keep a domain's DNS outside Cloudflare (`dns_records`,
`send_only`, `smtp_relay`), and the `nameservers` and `delegated_subdomain` methods, are specified in
[Domains on any DNS host](domain-connections.md); this page links to it where they differ.

| | |
|---|---|
| Requirements | FR-IDN-1 … FR-IDN-4, FR-ADR-1 … FR-ADR-7, FR-DOM-1 … FR-DOM-6 (FR-DOM-7 … FR-DOM-12 in [Domains on any DNS host](domain-connections.md)), FR-TEN-3 |
| Edge cases | [A1](../edge-cases.md), [A3–A5](../edge-cases.md), [A11–A14](../edge-cases.md), [C3](../edge-cases.md), [D2](../edge-cases.md), [G7](../edge-cases.md), [H1–H7](../edge-cases.md); N1–N30 in [Domains on any DNS host](domain-connections.md) |
| Code | `crates/worker/src/handlers/{identities.rs, addresses.rs, domains.rs}`, `db/{identities.rs, addresses.rs, domains.rs}`, `crons/retire.rs`, `domains/{mod.rs, cloudflare_api.rs, ses_api.rs, records.rs, monitor.rs, fallback.rs}`; `crates/core/src/{address.rs, dns.rs, domain_fsm.rs}` |
| ADR | [0003 Addressing with catch-all and a directory](../adr/0003-addressing.md), [0005 State machines](../adr/0005-state-machines.md) |

Cloudflare API paths and behaviour on this page were read on 2026-10-09 from the Cloudflare API
reference and the Email Service documentation; SES paths from the SES v2 API reference the same day.
Items the documentation does not confirm are marked "verify at build time" with the spike that settles them.

## Identities

### Lifecycle

| State | Event | Guard | Action | Next |
|---|---|---|---|---|
| – | `POST …/identities` | Valid body; username free; `client_id` new | Insert identity and addresses (D1 batch); `MailboxRequest::Init`; `identity.created` | `active` |
| – | `POST …/identities` with a known `client_id` | Same `client_fingerprint` | Return `200` with the existing identity; call `Init` again (idempotent, repairs a lost first call) | unchanged |
| – | `POST …/identities` with a known `client_id` | Different fingerprint | `409 client_id_conflict` | – |
| `active` | `PATCH status: paused` | `identities:write` | `pause_reason = 'manual'`; `identity.paused` | `paused` |
| `active` | Abuse threshold ([Outbound](outbound.md#abuse-auto-pause-fr-dlv-3)) | – | `pause_reason = 'abuse_threshold'`; `identity.paused` with `metrics` | `paused` |
| `active` | Tenant suspended | – | `pause_reason = 'tenant_suspended'`; `identity.paused` | `paused` |
| `paused` | `PATCH status: active` | reason `manual`: `identities:write`; reason `abuse_threshold`: platform or tenant key, audit-logged; reason `tenant_suspended`: refused (`409 identity_paused`) | `pause_reason = NULL`; `identity.resumed` | `active` |
| `paused` (`tenant_suspended`) | Tenant resumed | – | `identity.resumed` | `active` |
| `active`, `paused` | `DELETE` | `identities:write` and `erasure:manage` | Tombstone and remove every address; create the identity-scope erasure ([Privacy](privacy.md)) | `deleting` |
| `deleting` | Erasure completed with no holds left | – | `identity.deleted`, once, from the erasure job's outbox with `identity_id` set ([Privacy § 6.5](privacy.md#65-identity-scope-fr-idn-4)) | `deleted` |

A paused identity still receives and stores mail (FR-IDN-3). Every send needs an accountable human
(`owner_name` and `owner_email`, FR-IDN-2); the check is in the send policy pipeline.

### The system identity

The deployment's own mail (console sign-in links and codes, invitations, and the other mail the designs
send from `PM_SYSTEM_FROM`) goes out through one reserved identity, the **system identity**, through the
normal outbound pipeline.

- **Created by setup** ([CLI and setup §6.3](cli.md#63-steps), step 22) on the default tenant, at the
  address of `PM_SYSTEM_FROM` (default `Pylota Mail <no-reply@{PM_PLATFORM_DOMAIN}>`): an `identities`
  row with `is_system = 1`, `username` = the address's local part, `display_name` = its display name,
  `owner_name = 'Operator'` and `owner_email` = setup's `--owner-email` (else
  `postmaster@{PM_PLATFORM_DOMAIN}`), and `send_policy.daily_cap` = 50,000; plus one `active` primary
  address on the platform domain. Setup writes both rows with `mailbox_do_id = ''`, and the every-minute
  cron mints the mailbox and sends `MailboxRequest::Init`, as the [monitor hook](#create) does for
  domains. At most one row has `is_system = 1` (a partial unique index).
- **Exempt from username validation.** Its local part may be a reserved name (`no-reply` is), because
  only setup writes it. It must still be ASCII, at most 64 octets, with a valid address syntax.
- **Not listed to tenants.** List endpoints (`GET /v1/identities`, `GET /v1/tenants/{t}/identities`,
  `mail_list_identities`, the console) never return it, and a tenant or identity key that names it gets
  `404 identity_not_found`. Only a platform key reads or changes it, by ID. It is not counted against
  `inboxes`.
- **Mail sent to it** is stored in its mailbox like any identity's (bounces and replies to sign-in mail),
  readable only with a platform key.
- **Exempt from the tenant daily cap and from abuse auto-pause.** Its sends are not counted against the
  default tenant's `tenant_daily_send_cap`; its own `send_policy.daily_cap` (50,000) still applies
  ([Outbound › Policy pipeline](outbound.md#policy-pipeline), step 18). The delivery consumer records its
  outcomes but never pauses it ([Outbound › Abuse auto-pause](outbound.md#abuse-auto-pause-fr-dlv-3)):
  one person's bounce must not stop everyone's sign-in mail. When a notification send through it is still
  refused (`429 daily_cap_reached`, `409 identity_paused` after a manual pause, or `409 domain_not_ready`),
  the Notifier keeps the item, retries it and raises `system_mail_blocked`
  ([Notifications § 7](notifications.md#7-when-system-mail-cannot-be-sent)).
- **Fixed retention.** Its mailbox keeps messages 30 days and raw MIME 7 days, whatever the default
  tenant's `retention` policy says: the tenant retention job uses these cutoffs for the identity with
  `is_system = 1` ([Privacy §5.2](privacy.md#52-steps-of-a-tenant-retention-job)). Deleting a person also
  erases the system mail sent to them ([Privacy §6.9](privacy.md#69-people-console-accounts)).
- **Changing `PM_SYSTEM_FROM`.** A re-run of setup adds the new address to the system identity and
  promotes it; the old address retires as usual.
- **Without the console** (`PM_CONSOLE=off`) it still exists and still sends invitations, because
  `PM_SYSTEM_FROM` and `PM_CONSOLE_HOST` are top-level settings, not console settings
  ([Rust workspace §6.1](rust-workspace.md#61-errors-and-configuration)).

### Create

`POST /v1/tenants/{tenant_id}/identities`:

1. Validate the body: `username` ([Username validation](#username-validation)), `display_name` (1–78
   characters, Unicode allowed, no CR or LF), `owner.email` (RFC 5321), `signature.html` (sanitised with
   the inbound policy before storage), `metadata` (≤ 16 keys, ≤ 512 bytes per value).
2. **`client_id`** (FR-IDN-1): `client_fingerprint = hex(sha256(canonical_json(body)))` (canonical JSON as
   in [Outbound](outbound.md#idempotency-fingerprint)).
   `SELECT id, client_fingerprint FROM identities WHERE tenant_id = ?1 AND client_id = ?2` decides
   between create, replay and `409 client_id_conflict`.
3. **Domain.** Without `domain_id` the primary address is on the platform domain. With `domain_id` it
   must name a domain of this tenant in state `healthy` or `degraded`, else `409 domain_not_ready`.
4. **Addresses.** The identity always gets its **platform address**
   `{username}{tenant.address_suffix}@{PM_PLATFORM_DOMAIN}` (FR-DOM-1), `role = 'primary'` without
   `domain_id`, else `role = 'alias'`. With `domain_id` it also gets `{username}@{domain}` as the
   primary, `active` when the domain can route it ([Routing an address](#routing-an-address)), else
   `pending`. Each address is checked against `addresses_address` (`409 address_taken`) and against
   `address_tombstones` ([Tombstones](#tombstones-a5)).
5. `mailbox_do_id = objects.new_object_id(Mailbox)`.
6. One D1 `batch`: `INSERT INTO identities …`, `INSERT INTO addresses …` (one or two rows),
   `INSERT INTO audit_log …` (`identity.create`).
7. `MailboxRequest::Init { tenant_id, identity_id, created_at }`, which writes the owner into `meta` and
   emits `identity.created` once. If it fails, the request returns `503 unavailable`; the client retries
   with the same `client_id`, and the replay path calls `Init` again.
8. `201` with the Identity object.

### Updates, pause and tenant suspension

`PATCH /v1/identities/{id}` updates D1, then sends `MailboxRequest::EmitEvent` with `identity.updated`
(`changed` = field names), `identity.paused` or `identity.resumed`. Suspending a tenant
(`PATCH /v1/tenants/{id}` with `status: suspended`) sets `tenants.suspended_at` and, in the same D1
batch, pauses every `active` identity with `pause_reason = 'tenant_suspended'`; resuming reverses only
those. Each identity then gets its event.

### Delete (FR-IDN-4, A13)

One D1 batch:

```sql
INSERT OR IGNORE INTO address_tombstones (address_hash, identity_id, reason)
  SELECT ?2 /* computed per row in Rust: HMAC-SHA256(PM_HASH_KEY, address) */, identity_id, 'deleted'
  FROM addresses WHERE identity_id = ?1;     -- executed once per address with its hash
DELETE FROM addresses WHERE identity_id = ?1;
UPDATE identities SET status = 'deleting', updated_at = ?3 WHERE id = ?1;
INSERT INTO jobs …; INSERT INTO erasure_requests …;     -- scope identity, see Privacy and erasure
```

Mail to any of its addresses is refused with `550 5.1.1` from the moment the directory cache expires
(≤ 60 seconds), including replies to in-flight threads ([A13](../edge-cases.md)). The address rows are
gone by the time the erasure job runs, so the batch stores the deleted rows' `(zone_id, routing_rule_id)`
pairs, and the `ses_bounce_rule` of each retired address on an SES domain, in the job's `params_json`. The
job deletes those literal routing rules, removes those addresses from their `pm-retired-{n}` rules (so an
erased address is dropped like an unknown one instead of bouncing with `5.1.6`), wipes the mailbox and sets
`deleted`, which frees the username (`identities_username` excludes deleted rows)
([Privacy › Identity scope](privacy.md#65-identity-scope-fr-idn-4)).

## Username validation

`core::address::validate_username(input, domain_class, tenant_suffix, existing_usernames) -> Result<String, AddressError>`
runs these steps in order (`domain_class` selects the reserved set below: `Platform` for a username of
the default tenant, `Tenant` for any other username and for a local part on a tenant domain) ([A1](../edge-cases.md), [A3](../edge-cases.md), [A4](../edge-cases.md),
[A12](../edge-cases.md), FR-ADR-6, FR-ADR-7):

| # | Step | Error |
|---|---|---|
| 1 | `fold(input)` (below) equals the fold of a name reserved on this domain class | `400 address_reserved` |
| 2 | Input contains a non-ASCII character and is mixed-script (its resolved script set is empty), or contains a strong right-to-left character | `400 address_reserved` |
| 3 | Input contains any other non-ASCII character (SMTPUTF8 local parts cannot be routed by Email Routing) | `400 address_unsupported` |
| 4 | Lower-case (ASCII). Must match `^[a-z0-9][a-z0-9._-]{0,23}$`, must not contain `..`, must not end in `.` | `400 address_invalid` |
| 5 | Exact match of a name or pattern reserved on this domain class | `400 address_reserved` |
| 6 | `len(username) + len(tenant_suffix) > 40` (room for a thread token in 64 octets) | `400 local_part_too_long` |
| 7 | Another non-deleted identity in the tenant has the same username, or a different username with the same fold | `409 username_taken` |

Display names are Unicode and never refused for script reasons (FR-ADR-7).

**Reserved names** (FR-ADR-6):

| Set | Names | Platform domain | Tenant domain |
|---|---|---|---|
| RFC 2142 role names | `info`, `marketing`, `sales`, `support`, `noc`, `security`, `hostmaster`, `usenet`, `news`, `webmaster`, `www`, `uucp`, `ftp` | reserved | allowed |
| RFC 2142 operational names that must reach a person | `postmaster`, `abuse` | reserved | reserved |
| Service and mail-system names | `noreply`, `no-reply`, `donotreply`, `do-not-reply`, `mailer-daemon`, `mailerdaemon`, `mail-daemon`, `bounce`, `bounces`, `root`, `admin`, `administrator`, `sysadmin`, `system`, `daemon`, `nobody`, `null`, `devnull`, `listserv`, `majordomo`, `unsubscribe`, `dmarc`, `journal` (the hidden journal address of [Outbound](outbound.md#message-id-of-outbound-mail-spike-s7)) | reserved | reserved |
| Patterns | a prefix `owner-`, a suffix `-request` (RFC 3834 responders skip these), a prefix `pm-` (reserved for the service) | reserved | reserved |

The shared platform domain is one namespace for every tenant, so a role name there would let one
tenant's agent receive mail meant for the operator; on a tenant's own domain the tenant decides who
answers `support@` or `sales@`. The platform set applies to local parts that stand alone on the
platform domain: the usernames of the default tenant, whose suffix is empty, so its platform addresses
are `{username}@{PM_PLATFORM_DOMAIN}`. Every other tenant's platform addresses carry its suffix
(`support.acme@agents.example` is not the role address `support@`), so its usernames, and aliases on
tenant domains (`POST …/addresses`), are checked against the tenant set.

**Role mail on a tenant domain.** Mail to `postmaster@` or `abuse@` a tenant domain that reaches the
Worker (a catch-all apex) goes to the tenant's owner contact: the email of the member with role
`owner`. `forward()` only reaches verified Email Routing destinations, so the `email()` handler instead
sends the owner a new message from `postmaster@{PM_PLATFORM_DOMAIN}` through Email Sending, with the
original attached as `message/rfc822` (its headers only when it is over 4 MiB), and accepts the original.
Nothing is stored in a mailbox. A tenant without an owner falls back to `PM_SECURITY_CONTACT`, else
`550 5.1.1` ([Inbound › Steps](inbound.md#steps)). Mail for `PM_SECURITY_CONTACT` (an email address,
bare or `mailto:`) is sent the same way, as a new message, and never with `forward()`: `forward()`
reaches only verified Email Routing destination addresses
([email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/),
read 2026-10-09), and setup registers none.

### Confusable detection

`fold(s)` implements the UTS #39 skeleton (version 18.0.0, read 2026-10-09) closely enough to compare
identifiers with ASCII reserved names, and is reused for look-alike domains and display names
([D2](../edge-cases.md)):

1. Apply Unicode full case folding (for ASCII input: lower-casing).
2. `internalSkeleton`, per UTS #39: (a) NFD; (b) remove every `Default_Ignorable_Code_Point`;
   (c) replace each character by its prototype from `confusables.txt`; (d) NFD again.
3. Lower-case the result and repeat step 2 until it no longer changes (at most 3 rounds), because
   prototypes can be upper case (for example a digit zero maps to a capital O).

The bidirectional wrapper of the full `skeleton` is omitted: step 2 of validation already refuses any
input with a strong right-to-left character. Two strings are confusable when their folds are equal; the
mapping handles multi-character prototypes (for example `m` maps to `rn`, so `rnailer-daemon` and
`mailer-daemon` fold to the same string).

**Data.** `cargo xtask gen-unicode` generates Rust tables from the pinned files `confusables.txt`
(UTS #39 18.0.0), `DerivedCoreProperties.txt` (`Default_Ignorable_Code_Point`) and
`ScriptExtensions.txt`/`Scripts.txt`, checked into `crates/core/data/`. To bound the bundle, the
confusable table keeps only entries whose prototype is entirely ASCII; inputs that would need other
entries are non-ASCII and are refused at step 3 anyway.

**Mixed script.** The resolved script set is the intersection over all characters of their augmented
`Script_Extensions` sets, with `Common` and `Inherited` counting as all scripts (UTS #39 §5.1). An empty
set means mixed-script.

## Addresses

### Format

| Domain | Address | Notes |
|---|---|---|
| Platform | `{name}{tenant.address_suffix}@{PM_PLATFORM_DOMAIN}`, for example `bookings.acme@agents.example` | `{name}` is validated as a username. Only the default tenant (made by setup) has an empty suffix |
| Tenant `zone`, `delegated` or `external` | `{local_part}@{domain}`, for example `bookings@mail.acmecarhire.example` | `local_part` validated as a username |

Addresses are stored lower case with an A-label domain; dots are significant ([A1](../edge-cases.md)).
At most 20 addresses per identity in any state, and one `pending` address per identity and domain.

Every identity keeps exactly one platform-domain address for its whole life. It is the **fallback
address** ([Fallback behaviour](#fallback-behaviour), FR-DOM-6), so it is never retired automatically,
cannot be retired or deleted through the API (`409 address_in_use`), and on promotion away from it
becomes an `active` alias rather than `retiring`.

### Lifecycle

| State | Event | Guard | Action | Next |
|---|---|---|---|---|
| – | `POST …/addresses` | Domain of this tenant, not `removing`/`removed`; ≤ 20 addresses; address free and not tombstoned | Delete an older `pending` address of this identity on the same domain (and its literal rule) ([A11](../edge-cases.md)); insert `role = 'alias'`; route it; `identity.address_added` | `active` if routable now, else `pending` |
| `pending` | Domain reaches `healthy`/`degraded` and the address is routed | – | `identity.address_activated` | `active` |
| `pending` | Literal rule creation fails ([H6](../edge-cases.md)) | – | Stays `pending`; retried by the domain's monitor (1, 5, 15, 60 minutes, then hourly); issue `routing_rule_failed` on the domain's health | `pending` |
| `pending` | `DELETE …/addresses/{id}` | Never received mail | Delete the row and its rule | – |
| `active` alias | `POST …/promote` | Domain `healthy` or `degraded` (else `409 domain_not_ready`) | In one batch: this address becomes `primary`; the previous primary becomes an alias, `retiring` with `retire_at = now + retire_previous_after_days` (default 90, range 0–365; 0 means `retired` now), except the platform address, which becomes an `active` alias. When the promoted address is itself the platform address, this is a **rollback** as in the next row: the current primary becomes an `active` alias, not `retiring` ([A14](../edge-cases.md)); `identity.address_promoted` with `previous_primary` | `active` primary |
| `retiring` alias | `POST …/promote` (**rollback**, FR-ADR-4) | Domain `healthy` or `degraded` | This address becomes `primary`, `retire_at = NULL`; the current primary becomes an `active` alias (the change is undone, not mirrored); `identity.address_promoted` | `active` primary |
| `active` alias | `POST …/retire` | Not the primary (`409 address_is_primary`); not the platform address (`409 address_in_use`) | `after_days > 0`: `retiring`, `retire_at = now + after_days`; `0`: `retired` now with `identity.address_retired` | `retiring` / `retired` |
| `retiring` | `POST …/retire` | – | `retire_at` updated (`0` retires now) | `retiring` / `retired` |
| `retiring` | `retire_at` reached ([Retirement](#retirement)) | – | `retired_at = now`; `identity.address_retired` | `retired` |
| `retired` | – | – | Terminal. The row is kept forever so the address is never reassigned; inbound gets `550 5.1.6` (FR-ADR-3) | – |
| any | Identity deleted | – | Tombstoned and row removed | – |

A retiring address keeps receiving mail into the same identity, and replies on threads where the
counterparty wrote to it are sent from it until it retires ([C3](../edge-cases.md),
[Threading](threading.md#5-which-address-a-reply-is-sent-from-c3-fr-out-5)). New threads send from the
primary (FR-ADR-2).

### Routing an address

| Domain `routing_mode` | Routable when |
|---|---|
| `catch_all` (platform domain, zone apex, `delegated`, and `inbound = ses`) | Immediately: the catch-all (or, for `inbound = ses`, the receipt rule `pm-deliver`, which has no recipient condition) sends every address to the Worker |
| `literal` (zone subdomain) | A literal rule exists. Created synchronously in the request: `POST /zones/{zone_id}/email/routing/rules` with `{ "matchers": [{ "type": "literal", "field": "to", "value": "{address}" }], "actions": [{ "type": "worker", "value": ["pylota-mail"] }], "enabled": true, "name": "pylota-mail {adr_id}", "priority": 0 }`; the returned rule ID is stored in `routing_rule_id`. A matcher value is at most 90 characters, so a longer address is refused with `400 address_invalid`. At most 200 rules per domain; the 201st address is refused with `409 domain_in_use` and `details.reason = "routing_rule_limit"`. That the `worker` action's `value` is the Worker's script name is not stated in the reference; verify at build time (S9) |
| `forward` (`inbound = forward`) | Immediately (mail arrives at the identity's platform address, forwarded by the domain's own mail system) |

### Retirement

The every-minute cron (`crons/retire.rs`):

```sql
SELECT id, identity_id, tenant_id FROM addresses
WHERE status = 'retiring' AND retire_at <= ?1 ORDER BY retire_at LIMIT 100;

UPDATE addresses SET status = 'retired', retired_at = ?1, updated_at = ?1
WHERE id = ?2 AND status = 'retiring' AND retire_at <= ?1;     -- per row; skip if changes = 0
```

For each changed row it sends `EmitEvent identity.address_retired` to the identity's mailbox. The
directory cache in `email()` expires within 60 seconds, after which inbound gets `550 5.1.6`. Literal
routing rules of retired addresses are kept, so that the Worker (not Cloudflare) answers and can return
`5.1.6`; when a domain reaches 190 rules, the oldest retired addresses' rules are deleted (those
addresses then get Cloudflare's own unknown-recipient rejection).

### Tombstones (A5)

`address_tombstones` holds `hex(HMAC-SHA256(PM_HASH_KEY, address))`, never the clear address. Creating an
address whose hash is tombstoned is allowed only when `identity_id` equals the tombstone's `identity_id`
and that identity is `active` or `paused`; otherwise `409 address_taken`, across all tenants
([A5](../edge-cases.md), FR-ADR-5). Tombstones are written when an identity is deleted or erased, so in
practice a tombstoned address is never reused.

## Domains

### Kinds

A domain's **connection method** (`method`), chosen when it is added, fixes its `kind`, `inbound` and
`transport` (FR-DOM-7, [Domains on any DNS host §2](domain-connections.md#2-inbound-source-and-outbound-transport-are-separate-choices)).
The kinds are `platform`, `zone`, `delegated` and `external`:

| Kind | `method` | `is_apex` | `routing_mode` | `inbound` | `transport` | `reply_token` | Inbound | Outbound |
|---|---|---|---|---|---|---|---|---|
| `platform` (one per deployment, `tenant_id = NULL`) | `platform` (written by setup) | 1 (required) | `catch_all` | `routing` | `cloudflare` | `subaddress` | Catch-all to the Worker | Email Sending |
| `zone`, apex | `cloudflare_zone`, `nameservers` | 1 | `catch_all` | `routing` | `cloudflare` | `subaddress` | Catch-all to the Worker | Email Sending |
| `zone`, subdomain | `cloudflare_zone` | 0 | `literal` | `routing` | `cloudflare` | `subaddress` | One literal rule per address (≤ 200) | Email Sending |
| `delegated` | `delegated_subdomain` | 1 (the apex of its child zone) | `catch_all` | `routing` | `cloudflare` | `subaddress` | Catch-all to the Worker on the child zone | Email Sending |
| `external` | `dns_records` | 0 or 1 | `catch_all` | `ses` | `ses` | `subaddress` | SES receipt rule `pm-deliver` → S3 → SNS push and SQS backstop → Worker | SES with Easy DKIM and a custom MAIL FROM |
| `external` | `send_only` | 0 or 1 | `forward` | `forward` | `ses` | `none` | The domain's own mail system forwards to the identity's platform address | SES with Easy DKIM and a custom MAIL FROM |
| `external` | `smtp_relay` | 0 or 1 | `forward`; `catch_all` with `inbound: ses` | `forward` or `ses` | `smtp` | `none`; `subaddress` with `inbound: ses` | As `send_only`, or as `dns_records` | The customer's own SMTP relay, after a passing alignment probe |

`reply_token = 'subaddress'` on `inbound = ses` depends on spike S11 showing that `user+tag@` reaches the
Worker; if it does not, those domains use `none`. The `dns_records`, `send_only`, `smtp_relay`,
`nameservers` and `delegated_subdomain` rows are specified in
[Domains on any DNS host](domain-connections.md); this page keeps the shared steps.

The platform domain must be a zone apex because catch-all rules exist only on the apex. A zone holds at
most 30 mail domains (routing and sending together, apex included)
([limits](https://developers.cloudflare.com/email-service/platform/limits/), read 2026-10-09).

### Adding a domain

`POST /v1/tenants/{tenant_id}/domains` with `domains:write`. Common checks: the name is a valid DNS name,
lower case, A-label; `409 domain_exists` if a row with that name exists and is not `removed` (a `removed`
row is reused: same ID, new tenant, state `pending`). Every onboarding step is **idempotent**: it reads
first (for example lists rules or sending subdomains by name) and creates only what is missing, so a
failed request can be repeated. A failed provider call returns `502 upstream_error` with
`details.step`, and no D1 row is written until every step has succeeded.

The request names a `method`. When it is absent, the old `kind` is mapped (`zone` → `cloudflare_zone`,
`external` → `send_only`), and `kind: zone` with `"create_zone": true` is the old spelling of
`nameservers`. Each method has its own onboarding:

| `method` | Onboarding | The deployment needs (refusal without it) |
|---|---|---|
| `cloudflare_zone` | [Kind `zone`](#kind-zone) | `PM_CF_API_TOKEN` (`422 cf_token_required`) |
| `nameservers` | [Creating a zone](#creating-a-zone), then [Kind `zone`](#kind-zone) at the apex | `PM_CF_API_TOKEN` that can create zones (`422 cf_token_required`); for a tenant key, the policy `domains.allow_create_zone: true` (`422 transport_unavailable`, `details.reason = "zone_creation_not_allowed"`) |
| `delegated_subdomain` | [Domains on any DNS host §3.3](domain-connections.md#33-delegated_subdomain) | `PM_CF_API_TOKEN` (`422 cf_token_required`) and `PM_CF_SUBDOMAIN_SETUP=on` (`422 transport_unavailable`, `subdomain_setup_disabled`) |
| `dns_records` | [§4.3](domain-connections.md#43-dns_records) | SES with receiving (`422 transport_unavailable`, `ses_not_configured` or `ses_receiving_not_configured`) |
| `send_only` | [Kind `external`](#kind-external) and [§4.4](domain-connections.md#44-send_only) | SES (`422 transport_unavailable`, `ses_not_configured`) |
| `smtp_relay` | [§5](domain-connections.md#5-smtp_relay-the-customers-own-sending-provider) | Relay credentials that pass a one-off connection (`400 smtp_port_not_allowed`, `422 smtp_tls_required`, `422 smtp_auth_failed`); with `inbound: ses`, SES with receiving |

A method that needs an SES identity (`dns_records`, `send_only`, `smtp_relay` with `inbound: ses`) is
refused with `422 transport_unavailable`, `details.reason = "ses_identity_limit"`, once the region holds
10,000 identities.

**The Cloudflare token.** `PM_CF_API_TOKEN` must be set on the Worker for `cloudflare_zone`,
`nameservers` and `delegated_subdomain`; without it, creating such a domain returns
`422 cf_token_required`. `dns_records`, `send_only` and `smtp_relay` make no Cloudflare call. The one
exception is an apex `cloudflare_zone` domain (catch-all, no literal rules):
`pmail domains add --local-token` can onboard it with the operator's local `CLOUDFLARE_API_TOKEN` and
insert the row itself
([CLI and setup §18.1](cli.md#181-domains-add-without-pm_cf_api_token)), and the Worker's cron completes
the row as for [the platform domain](#the-platform-domain). A subdomain, `nameservers` and
`delegated_subdomain` cannot be added that way, because the Worker has to keep calling Cloudflare over the
domain's life: literal rules per address, onboarding once a new zone is active, delegation checks.
Creating an address that needs a literal rule without the token also returns `422 cf_token_required`.

**Records (FR-DOM-3)** come from the provider at request time for every method: Cloudflare's routing and
sending DNS endpoints for zones (including `nameservers` and `delegated_subdomain` once active), the
`name_servers` returned when a zone is created, and SES `GetEmailIdentity` (DKIM tokens,
`SigningHostedZone`, MAIL FROM status) for `dns_records`, `send_only` and `smtp_relay` with
`inbound: ses`. The Worker composes only its own values: the ownership TXT, the `pm-bounce` MAIL FROM
records and the SES endpoint hosts of `ses_region`
([§4.1](domain-connections.md#41-what-each-method-asks-the-customer-to-publish)). `GET …/records`
re-reads them; they are never copied from documentation or templates.

#### Kind `zone`

The `cloudflare_zone` method. Needs `PM_CF_API_TOKEN` (`422 cf_token_required` without it, as above) and
`PM_CF_ACCOUNT_ID`, which setup writes.

1. **Find the zone.** List zones by name for the account, trying the domain and then each parent label
   up to the registrable domain (`GET /zones?name={name}`; verify the query parameters at build time).
   Not found: `404 domain_not_found`. The `nameservers` method creates the zone instead
   ([Creating a zone](#creating-a-zone)).
2. **Existing mail at an apex ([H5](../edge-cases.md)).** Query MX at the apex on both DoH resolvers. If
   it has MX records other than the hosts Email Routing expects (taken from step 6, never hard-coded) and
   the request lacks `"replace_mx": true`, refuse with `409 existing_mx` and a fix saying that existing
   mail would stop. With `replace_mx`,
   delete those MX records through the DNS records API before enabling routing.
3. **SPF preflight ([H2](../edge-cases.md)).** If the apex already publishes SPF, count the DNS lookups
   of the record Email Routing will need merged with the existing one
   ([SPF lookup count](#spf-lookup-count)). More than 10, or more than 2 void lookups: refuse with
   `400 spf_lookup_limit`, `details.lookups`, and a fix naming the includes to flatten.
4. **Ownership record.** Generate `ownership_token` (16 random bytes, Crockford base32) and create TXT
   `_pylota-mail.{domain}` = `pm-verify={token}` through the DNS records API.
5. **Receiving** (when `receiving`):
   - `POST /zones/{zone_id}/email/routing/dns` with `{ "name": "{domain}" }` ("Add and lock the necessary
     MX and SPF records"). For a subdomain the reference does not confirm this call enables routing on
     the subdomain; S9 verifies it.
   - `PATCH /zones/{zone_id}/email/routing` with `{ "support_subaddress": true }`, so `user+token@`
     matches `user@` and the `+token` stays in `message.to`.
   - Apex: `PUT /zones/{zone_id}/email/routing/rules/catch_all` with
     `{ "actions": [{ "type": "worker", "value": ["pylota-mail"] }], "matchers": [{ "type": "all" }], "enabled": true, "name": "pylota-mail" }`.
   - Subdomain: literal rules are created per address ([Routing an address](#routing-an-address)).
6. **Sending** (when `sending`): `POST /zones/{zone_id}/email/sending/subdomains` with
   `{ "name": "{domain}" }` (the response holds `tag`, `dkim_selector` and `return_path_domain`; whether
   an apex can be onboarded through this endpoint is verified by S9), then
   `PATCH /zones/{zone_id}/email/sending/subdomains/{tag}` with
   `{ "drop_suppressed_recipients": false, "preview_enabled": false }`
   ([Outbound › G4](outbound.md#provider-suppressions-and-resending-g4); Email preview keeps a copy of
   each sent message for about seven days and is on by default for new sending domains,
   [Privacy](privacy.md#3-jurisdiction-and-residency)). Both fields are in the Cloudflare API reference
   for this endpoint (read 2026-10-09).
7. **Event subscription** (when `sending`): find the queue ID of `pm-delivery-events` by listing the
   account's queues, then `POST /accounts/{account_id}/event_subscriptions/subscriptions` with:

   ```json
   { "name": "pylota-mail {domain}", "enabled": true,
     "source": { "type": "email.sending", "zone_id": "{zone_id}", "domain": "{domain}" },
     "destination": { "type": "queues.queue", "queue_id": "{queue_id}" },
     "events": ["message.delivered", "message.deferred", "message.bounced",
                "message.failed", "message.rejected", "message.complained"] }
   ```

   The returned ID is stored in `event_subscription_id`. The `email.sending` source shape is from
   Wrangler's source, not yet the API reference; S9 verifies it.

   **Spike S9 fallback: manual delivery events.** When the subscription cannot be created at runtime
   (the create call answers `401`, `403`, `404`, `405` or `501`: the API or the token cannot do it), the
   domain is still created. The row is inserted with `event_subscription_id = NULL`, and the domain
   object reports `delivery_events: "manual"` and `details.action = "run pmail domains subscribe
   {domain}"` in the `201` response and in every later read, next to its records. `429` and `5xx` answers
   are not this case: the create request fails with `502 upstream_error` as for any other onboarding
   call, and is safe to retry. Delivery events for the domain start only once
   `pmail domains subscribe {domain}` has run ([CLI and setup §18.4](cli.md#184-domains-subscribe)): it
   creates the subscription with the operator's local `CLOUDFLARE_API_TOKEN` and records its ID. Until
   then sends work, delivery statuses stay at `sent` (the transport's acceptance), uncertain sends are not
   reconciled, and `pmail doctor` fails `sending.event_subscriptions` with that command as the fix. The
   same applies to a `nameservers` domain, whose step 7 runs in the monitor once the zone is active. If
   S9 also shows that the Worker cannot delete a subscription, domain removal keeps going and `pmail
   doctor` lists the left-over subscription with the `wrangler queues subscription delete` command. Test:
   `it::domains::s9_manual_delivery_events`.

   `delivery_events` is derived, not stored: `active` when the domain sends through Cloudflare and has an
   `event_subscription_id`, or sends through SES or SMTP (their events arrive through SNS or DSNs);
   `manual` when it sends through Cloudflare without one; `none` when `sending` is false.
8. **Read the records back (FR-DOM-3).** `GET /zones/{zone_id}/email/routing/dns` and
   `GET /zones/{zone_id}/email/sending/subdomains/{tag}/dns`; normalise each to
   `{ type, name, value, priority, purpose, required }` with `purpose` one of `mx`, `spf`, `dkim`,
   `return_path`, `dmarc`, `ownership`, `ns`; add the ownership TXT; store as `records_json`. These are
   the records shown to users. They are never copied from documentation or templates.
9. Insert the row (`state = 'pending'`, `monitor_do_id`), call `DomainRequest::Init`, which starts
   verification at once, and emit `domain.created`.

#### Creating a zone

This is the `nameservers` method (old spelling: `kind: zone` with `"create_zone": true`), for a domain
used only for mail ([Domains on any DNS host §3.2](domain-connections.md#32-nameservers)). Platform keys
may always use it; tenant keys only when their policy has `domains.allow_create_zone: true` (see
[Adding a domain](#adding-a-domain)).

1. **Dedicated-domain check ([N21](../edge-cases.md)).** Before creating anything, query both DoH
   resolvers for `A`, `AAAA` and `MX` at the name and for `CNAME`/`A` at `www.{name}`. If any exist and
   the request lacks `"confirm_dedicated": true`, refuse with `409 domain_not_dedicated`;
   `details.records` lists what was found, and the fix says the website or mail on the domain would stop.
2. **Create the zone:** `POST /zones` with `{ "account": { "id": "{account_id}" }, "name": "{domain}", "type": "full" }`.
   Cloudflare error `1105` becomes `429 upstream_rate_limited` with `Retry-After` and
   `details.retry_after` of 10800 seconds ([N22](../edge-cases.md)); a zone hold becomes `409 zone_hold`.
3. The zone is created in a pending state and the response's `name_servers` are returned in `records` as
   `NS` records (`purpose: "ns"`) to set at the registrar. `expected_ns_json` is set to `name_servers`.
4. Steps 2–8 of [Kind `zone`](#kind-zone) run once the zone is active: the monitor polls the zone
   (`GET /zones/{zone_id}`, `status = "active"`; verify the field at build time) on each check while the
   domain is `pending`, and runs onboarding then, at the apex (catch-all). `confirm_dedicated` stands in
   for `replace_mx` at step 2, because the user has already accepted that existing mail stops.
5. **Expiry ([N23](../edge-cases.md)).** Cloudflare deletes a Free-plan zone that is not activated within
   28 days. The monitor sends a final `domain.reminder` at day 21. If the zone disappears, the domain
   moves to `removed` with `state_reason = zone_expired` and `domain.removed` carries
   `reason: "zone_expired"`; the user can add it again.

#### Kind `external`

The `send_only` method. `dns_records` and `smtp_relay` are `external` too; their onboarding is in
[Domains on any DNS host §4.3](domain-connections.md#43-dns_records) and
[§5](domain-connections.md#5-smtp_relay-the-customers-own-sending-provider). Needs the SES transport
(`PM_SES_REGION` and both SES secrets); without it `422 transport_unavailable`,
`details.reason = "ses_not_configured"`.

1. **Ownership record** as above; the user publishes it.
2. **SES identity:** `POST /v2/email/identities` with `{ "EmailIdentity": "{domain}", "ConfigurationSetName": "pylota-mail" }`
   (SigV4). `AlreadyExistsException` → `GET /v2/email/identities/{domain}`. The response's
   `DkimAttributes.Tokens` (three) and `SigningHostedZone` give three CNAME records
   `{token}._domainkey.{domain}` → `{token}.{SigningHostedZone}` (built from the returned zone, which
   differs by region). `ses_identity` = the domain.
3. **Custom MAIL FROM** `pm-bounce.{domain}`, as in step 5 of
   [§4.3](domain-connections.md#43-dns_records).
4. **Records** = the three DKIM CNAMEs, the MAIL FROM MX and TXT at `pm-bounce.{domain}`, and the
   ownership TXT. There is no routing record: the user configures their mail system to forward each
   address to the identity's platform address, shown per address in the domain response.
5. Insert the row (`kind = 'external'`, `method = 'send_only'`, `inbound = 'forward'`,
   `transport = 'ses'`, `routing_mode = 'forward'`, `reply_token = 'none'`, `ses_region`,
   `mail_from_domain`) and start monitoring, as above.

Each address on such a domain carries `forwarding`, which stays `unverified` until a forwarding test
(`POST …/addresses/{address_id}/test-forwarding`) or a real forwarded message arrives
([§4.4](domain-connections.md#44-send_only)).

For a domain with `inbound = forward` (`send_only`, and `smtp_relay` with `inbound: forward`), inbound
mail arrives with the platform address as envelope recipient. When a
`To`/`Cc` address of the message belongs to the same identity on that domain, the inbound
pipeline treats the message as delivered to that address (`delivered_to` = the external address,
`is_bcc = 0`), so replies are sent from it.

#### The platform domain

`pmail setup` onboards the platform domain with the operator's local token (steps 4–8 of kind `zone`,
apex) and inserts its row (`kind = 'platform'`, `method = 'platform'`, `tenant_id = NULL`,
`state = 'pending'`) through the D1 query API
([CLI and setup §6.6](cli.md#66-the-platform-domain-row)). Only the Worker can mint a `DomainMonitor`
ID (IDs are bound to the jurisdiction), so setup writes the row with `monitor_do_id = ''`.

**Monitor hook.** The every-minute cron (`* * * * *`) completes such rows:

```sql
SELECT id, kind FROM domains WHERE monitor_do_id = '' LIMIT 20;

-- per row, after minting a DomainMonitor ID in PM_JURISDICTION:
UPDATE domains SET monitor_do_id = ?1, updated_at = ?2 WHERE id = ?3 AND monitor_do_id = '';
```

Only when the `UPDATE` changed the row does the cron send `DomainRequest::Init`, which starts
verification, and emit `domain.created` for a row with a `tenant_id`. An overlapping run that lost the
update discards its unused ID. The same hook completes the rows that `pmail domains add --local-token`
inserts ([CLI and setup §18.1](cli.md#181-domains-add-without-pm_cf_api_token)). Setup polls the
platform row's `monitor_do_id` for up to 2 minutes and reports `monitor: started`, or a warning naming
the cron.

From then on the platform domain is monitored like any other domain. Without `PM_CF_API_TOKEN` in the
Worker, `GET …/records` for it returns the stored `records_json` (read from the API by setup) checked
against DNS.

### SPF lookup count

`core::dns::count_spf_lookups(record, resolve) -> SpfCount` (RFC 7208 §4.6.4): each `include`, `a`, `mx`,
`ptr`, `exists` and the `redirect` modifier counts one lookup, recursively through `include` and
`redirect` targets fetched by DoH (depth ≤ 10, each target fetched once); `all`, `ip4`, `ip6` and `exp`
count none. A lookup that returns no records is a void lookup. More than 10 lookups or more than 2 void
lookups is a `permerror`.

## Domain health

`DomainMonitor` (one Durable Object per domain) runs verification and health checks as an alarm-driven
state machine (FR-DOM-4, FR-DOM-5, [ADR 0005](../adr/0005-state-machines.md)). `core::domain_fsm` holds
the pure transition function; the object does I/O and persistence.

### Schedule

- A full check every **15 minutes** (`alarm:check`), and immediately after `Init`, a `verify` request
  (rate-limited to one a minute), a `reprove`, an address change on the domain, or a sending error
  `sender_domain_unavailable` from a transport.
- **Ownership** (NS and RDAP) weekly (`alarm:ownership`), and on `reprove` ([H4](../edge-cases.md)).
- After a check whose agreed outcome would change the state, the confirming check runs after **5
  minutes** instead of 15. After a resolver error or disagreement, the next check runs after **2
  minutes**.

### What each check verifies

Each check queries every expected record on **both** DoH resolvers (`PM_DOH_RESOLVERS`). Expected values
come from `records_json` (re-read from the provider APIs once a day and on `GET …/records`). For each
record the result is `ok`, `missing`, `mismatch` or `unexpected`, and its issue code has a level:

| Record | Applies to | `ok` when | Issue codes (level) |
|---|---|---|---|
| MX at the domain | `receiving` with `inbound = routing` (zone, delegated, platform) | The set of MX hosts equals the routing API's | `mx_missing` (fail); `mx_unexpected`: an extra, non-Cloudflare MX host (degraded) |
| SPF at the domain | `receiving` with `inbound = routing` | Exactly one `v=spf1` TXT, containing the routing API's include, ≤ 10 lookups | `spf_missing` (degraded); `spf_multiple` (degraded); `spf_too_many_lookups` ([H2](../edge-cases.md), degraded) |
| Routing DKIM (`cf2024-1._domainkey.{domain}`, per the routing API) | `receiving` with `inbound = routing` | TXT equals the API's | `routing_dkim_missing` (degraded) |
| Return path (`cf-bounce.{domain}` MX and SPF TXT, per the sending API) | `sending` with `transport = cloudflare` | Records equal the API's | `return_path_missing` (fail) |
| Sending DKIM (`{dkim_selector}._domainkey.{domain}`, from the sending API) | `sending` with `transport = cloudflare` | TXT `p=` equals the API's | `dkim_missing`, `dkim_mismatch` (fail) |
| SES DKIM (three CNAMEs) | `transport = ses` or `inbound = ses` | Each CNAME points to `{token}.{SigningHostedZone}`, and SES `GetEmailIdentity` reports `DkimAttributes.Status = SUCCESS` (once a day) | `dkim_missing` (fail); `ses_dkim_failed` (`FAILED`, fail) |
| DMARC (`_dmarc.{domain}`, else the organisational domain) | `sending` | Exactly one valid `v=DMARC1` record with `p=quarantine` or `p=reject`, and alignment possible ([H3](../edge-cases.md)) | `dmarc_missing` (degraded); `dmarc_policy_none` (degraded); `dmarc_multiple` (degraded); `dmarc_alignment_impossible` (fail) |
| Ownership TXT (`_pylota-mail.{domain}`) | all except platform | Contains `pm-verify={ownership_token}` | `ownership_record_missing` (ownership) |
| NS (weekly) | zone and platform | The NS set equals `expected_ns_json` | `nameservers_changed` (ownership) |
| RDAP (weekly) | zone, delegated and external | Fingerprint equals `rdap_fingerprint` | `registration_changed` (ownership) |

The checks that depend on the connection method (SES inbound MX, SES identity, MAIL FROM, the SES
account, the alignment probe, SMTP login, parent delegation and doubled names) are in
[Domains on any DNS host › Health checks per method](domain-connections.md#6-health-checks-per-method).
They use the same levels, the same two-resolver agreement and the same state machine.

**Alignment ([H3](../edge-cases.md)).** `core::dns::check_alignment(dmarc, transport_dkim_domain, return_path_domain)`:
DKIM aligns when the transport's DKIM `d=` equals the domain (`adkim=s`) or shares its organisational
domain (`adkim=r`); SPF aligns by the same rule over the return-path domain and `aspf`. Cloudflare signs
with `d=` the sending domain and uses `cf-bounce.{domain}` as return path, so `aspf=s` alone never
aligns but DKIM does; SES Easy DKIM signs with `d=` the domain. "Alignment impossible" means neither can
align under the record's tags while `p` is `quarantine` or `reject`. For `transport = smtp` the relay signs, so
alignment is proved by the alignment probe instead
([§5.3](domain-connections.md#53-proving-alignment-the-probe)).

**RDAP.** The registry is found from the IANA bootstrap file `https://data.iana.org/rdap/dns.json`
(longest label match, right to left; cached for 24 hours) and queried at `{base}domain/{registrable domain}`.
`rdap_fingerprint = hex(sha256(registrar entity handle ‖ registrant entity handle or "" ‖ registration eventDate))`
(RFC 9083 roles `registrar` and `registrant`, event `registration`). Requests follow [Security § 9.3](security.md#93-other-outbound-destinations) (HTTPS, at most one
redirect to another bootstrap-listed host, 256 KB, 10 s). An RDAP error or timeout is ignored for that
week. A change must be seen on two RDAP queries an hour apart: the first stores `meta.rdap_pending`
(`{fingerprint, seen_at}`) and sets `alarm:ownership` to an hour later; the second confirms it (the same
fingerprint) or clears it.

### Outcome per resolver and agreement

1. Per resolver: if any query failed (timeout, HTTP error, `SERVFAIL`, `REFUSED`) → `error`. Otherwise:
   any ownership-level issue → `ownership_changed`; else any fail-level issue → `fail`; else any
   degraded-level issue → `degraded`; else `pass`.
2. Each resolver's result is stored in `checks` (`resolver`, `results_json`, `outcome`); rows beyond the
   last 500 are deleted.
3. **Agreement ([H7](../edge-cases.md)).** If either resolver's outcome is `error`, or the two outcomes
   differ, the cycle has **no agreed outcome**: nothing changes, and the next check runs in 2 minutes.
   One resolver's failure or lie can therefore never change the state.
4. **Two consecutive agreeing cycles.** `meta.candidate` and `meta.candidate_count` track the agreed
   outcome that would change the state. The same outcome again increments the count; a different one
   resets it; an outcome that matches the current state clears it. The transition happens when the
   count reaches 2.

### State machine

States: `pending`, `verifying`, `healthy`, `degraded`, `failing`, `suspended`, `removing`, `removed`.
"Recovered" is not a state: it is the event `domain.recovered` on a return to `healthy`.

| State | Event | Guard | Action | Next |
|---|---|---|---|---|
| `pending` | `Init` | Zone active (or kind `external`) | First check now | `verifying` |
| `pending` | Check | Method `nameservers` or `delegated_subdomain`, and the zone still pending | Reminders | `pending` |
| `pending` | Check | The pending zone no longer exists (Cloudflare deletes it after 28 days, [N23](../edge-cases.md)) | `state_reason = zone_expired`; `domain.removed` (`reason: zone_expired`) | `removed` |
| `pending` | Check | Zone became active | Run onboarding steps 2–8 | `verifying` |
| `verifying` | Agreed `pass` ×2 | – | `ownership_verified_at = now`; `domain.verified`; activate the domain's `pending` addresses that are routed | `healthy` |
| `verifying` | Agreed `degraded` ×2 | – | `ownership_verified_at = now`; `domain.degraded`; activate addresses | `degraded` |
| `verifying` | Agreed `fail` or `ownership_changed` | – | Record issues; reminders | `verifying` |
| `healthy` | Agreed `degraded` ×2 | – | `domain.degraded` with `issues` | `degraded` |
| `healthy`, `degraded` | Agreed `fail` ×2 | – | `failing_since = now`; `domain.failing` with `issues` and `fallback_active` | `failing` |
| `degraded` | Agreed `pass` ×2 | – | `domain.recovered` (`from_state: degraded`) | `healthy` |
| `failing` | Agreed `pass` ×2 | – | `failing_since = NULL`; `domain.recovered` (`from_state: failing`) | `healthy` |
| `failing` | Agreed `degraded` ×2 | – | `failing_since = NULL`; `domain.degraded`; sending from the domain resumes | `degraded` |
| `failing` | `now − failing_since ≥ 14 days` | – | New `ownership_token`; `domain.suspended` (`reason: failing_14_days`) | `suspended` |
| `healthy`, `degraded`, `failing` | Agreed `ownership_changed` ×2 | – | New `ownership_token`; `domain.suspended` with `reason` = `nameservers_changed`, `ownership_record_missing` or `registration_changed` | `suspended` |
| `suspended` | `POST …/reprove` | – | New `ownership_token`; `records_json` updated; check now | `suspended` |
| `suspended` | Check | The new ownership TXT is seen on both resolvers in two consecutive cycles | `expected_ns_json` and `rdap_fingerprint` re-recorded, `ownership_verified_at = now` | `verifying` |
| any except `removing`, `removed` | `DELETE …/domains/{id}` | No `active` or `retiring` address on the domain (else `409 domain_in_use`) | Delete its `pending` addresses; create a `domain_remove` job | `removing` |
| `removing` | Job completed | – | `domain.removed` (`reason: requested`) | `removed` |

Every transition updates `domains.state`, `state_reason` (the first issue code) and `state_changed_at` in
D1 and appends the event to the monitor's outbox in the object's transaction (the D1 update runs after
commit and is retried by the alarm until it succeeds). Address activation runs on each transition into
`healthy` or `degraded`.

**Reminders.** While a domain is `pending`, `verifying`, `degraded`, `failing` or `suspended`,
`domain.reminder` is emitted at 24 hours, 72 hours and 7 days in that state (`hours_in_state`), tracked in
`meta.reminders_sent_json` and reset on every state change. A `pending` zone created by `nameservers`
also gets a final reminder at day 21 ([Creating a zone](#creating-a-zone), step 5).

**Health response.** `GET /v1/domains/{id}/health` returns the state, the reason, `since`, `issues`
(`code`, `record`, `fix`; the fix quotes the exact name and value from `records_json`), the last checks
per resolver, and `fallback_active`.

### Fallback behaviour

- `fallback_active = (state ∈ {failing, suspended} OR (transport = ses AND SES sending is paused for the
  account)) AND policy.domain_fallback`. The service never sends as a domain whose authentication records
  are broken (`failing`) or whose ownership signals changed (`suspended`) (FR-DOM-5). SES sending is
  paused when the platform check reports `ses_sending_paused`
  ([Health checks per method](domain-connections.md#6-health-checks-per-method)).
- Fallback works the same for every connection method. An `smtp_relay` domain whose alignment probe
  fails twice becomes `failing` like any other
  ([§5.3](domain-connections.md#53-proving-alignment-the-probe)). The platform address always sends
  through Email Sending on the platform domain.
- While active, sends from the domain go out from the identity's **platform address**, with the same
  display name, a `Reply-To` carrying the thread token on the platform address, the flag
  `sent_via_fallback`, and `fallback_pinned = 1` on the thread
  ([Outbound](outbound.md#from-address-and-fallback), FR-DOM-6, [H1](../edge-cases.md)). With
  `domain_fallback = false` they fail with `domain_failing_no_fallback`.
- Inbound mail to the domain is still accepted while it is `failing` or `suspended`.
- **Recovery.** On `domain.recovered`, new threads send from the domain again. Threads that used fallback
  stay pinned to the platform address until they have been quiet for 72 hours
  ([Threading](threading.md#51-fallback-pinned-threads)), so a conversation does not change From address
  mid-way.
- A `retiring` address's domain may fail too; sends fall back the same way ([G7](../edge-cases.md)).
- The platform domain has no fallback.

### Changing the transport (J5)

`PATCH /v1/domains/{domain_id}` with `{ "transport": "ses" | "cloudflare" }` is the Email Sending
failover ([J5](../edge-cases.md)). Only platform keys may call it (`403 scope_denied` otherwise). It
needs `ses_identity` set, SES configured and the SES DKIM records in `records_json` for `ses`
(`422 transport_unavailable` otherwise). Only the methods that put the domain on Cloudflare
(`cloudflare_zone`, `nameservers`, `delegated_subdomain`) can switch; any other method, and the platform
domain, gets `422 transport_unavailable` with `details.reason = "method_not_supported"`. An `smtp_relay`
domain changes its relay with `PATCH` and `smtp` instead (tenant or platform key with `domains:write`);
the new values are kept pending until a probe passes
([§5.3](domain-connections.md#53-proving-alignment-the-probe)). A transport change updates `domains.transport`,
writes an `audit_log` row (`domain.transport`), and asks the monitor for a check at once, because DKIM
alignment differs per transport. The outbound consumer reads the transport at transport time, so queued
mail moves with it.

### Domain removal

The `domain_remove` job (`JobRunner`, steps journaled in `steps`) undoes onboarding, each step
idempotent:

1. `delete_rules`: delete every literal rule of the domain's addresses (`DELETE /zones/{zone_id}/email/routing/rules/{rule_id}`),
   including retired ones.
2. `disable_catch_all` (apex): `PUT …/rules/catch_all` with `"enabled": false`.
3. `disable_routing`: `DELETE /zones/{zone_id}/email/routing/dns` for the domain's name.
4. `disable_sending`: `DELETE /zones/{zone_id}/email/sending/subdomains/{tag}` (this also removes its DNS
   records; routing still active elsewhere is unaffected).
5. `delete_subscription`: delete the event subscription by `event_subscription_id`.
6. `delete_ses_identity` (when `ses_identity` is set): `DELETE /v2/email/identities/{domain}`.
7. `prune_retired_rules` (`inbound = ses`): remove the domain's retired addresses from their
   `pm-retired-{n}` rules (read, merge, write, as in
   [Domains on any DNS host § 4.6](domain-connections.md#46-retired-and-unknown-recipients)) and clear
   `addresses.ses_bounce_rule`. With the SES identity gone, SES no longer accepts mail for the domain, so
   the rule entries only use capacity.
8. `delete_ownership_record` (zone, delegated): delete the `_pylota-mail` TXT.
9. `delete_zone` (`nameservers`, `delegated_subdomain`): `DELETE /zones/{zone_id}`, because this
   deployment created the zone for a domain used only for mail. A zone found through `cloudflare_zone`
   belongs to the account owner and is never deleted.
10. `finish`: `UPDATE domains SET state = 'removed', smtp_sealed = NULL, smtp_pending_sealed = NULL,
    updated_at = ?` and emit `domain.removed` (`reason: requested`).

A provider `404` on a delete counts as done only when it carries the provider's own "not found" error
code; any other `404` is retried. Failed steps retry with backoff (1, 5, 15, 60 minutes, then hourly).
Retired address rows stay, so their addresses are never reassigned.

## Cloudflare API token permissions

Two Cloudflare tokens exist, and their permissions are listed once, in one table:
[Deploy to Cloudflare › Create a Cloudflare API token](../../self-hosting.md#2-create-a-cloudflare-api-token).
That table names each permission as the dashboard shows it (for example Zone · Edit, which the API tab of
Cloudflare's permissions reference calls Zone Write) and marks which token needs it.

- The operator's own token, `CLOUDFLARE_API_TOKEN`, is used only by the CLI
  ([CLI reference › Commands that use your Cloudflare token](../../reference/cli.md#commands-that-use-your-cloudflare-token)):
  `pmail setup` onboards the platform domain with it ([The platform domain](#the-platform-domain)), and
  `pmail domains add --local-token` an apex `cloudflare_zone` domain
  ([CLI and setup §18.1](cli.md#181-domains-add-without-pm_cf_api_token)).
- The Worker's token, the secret `PM_CF_API_TOKEN`, is what this design calls during a domain's life. It
  is needed for `cloudflare_zone`, `nameservers` and `delegated_subdomain` domains
  ([Adding a domain](#adding-a-domain)); a deployment whose tenants use only `dns_records`, `send_only` or
  `smtp_relay` can leave it unset.

What the Worker does with each permission marked for it in that table:

| Permission (dashboard name) | The Worker uses it for |
|---|---|
| Zone · Read | Finding zones ([Kind `zone`](#kind-zone) step 1) and reading a new zone's status ([Creating a zone](#creating-a-zone)) |
| Zone · Edit | Creating a zone for `nameservers` and `delegated_subdomain`, and deleting it on [removal](#domain-removal) (`delete_zone`). Whether a zone-scoped grant can create new zones is not stated; verify at build time |
| Zone Settings · Edit | Enabling routing, setting sub-addressing and reading the routing DNS records (steps 5 and 8); `disable_routing` on removal |
| Email Routing Rules · Edit | The catch-all rule on an apex and the literal rules per address on a subdomain ([Routing an address](#routing-an-address)) |
| DNS · Edit | The ownership TXT, and MX removal for `replace_mx` (steps 2 and 4) |
| Email Sending · Edit | Sending onboarding and its DNS records (step 6) and the suppression list (G4). It is named in the Email Service docs but not on the permissions page; its scope is verified at build time |
| Queues · Edit | Listing queues and creating a domain's event subscription to `pm-delivery-events` (step 7) |
| Vectorize · Edit, Workers AI · Read and Edit | Only the REST fallbacks, if spike S6 fails |

Neither token needs an Email Routing Addresses permission, because nothing registers a destination
address (role mail, under [Username validation](#username-validation), is sent as new messages, never
forwarded).

## Tests

| Test | Covers |
|---|---|
| `core::address::a1_case_and_dots` | Case-insensitive match, dots significant ([A1](../edge-cases.md)) |
| `core::address::a3_smtputf8_refused` | Non-ASCII local parts → `address_unsupported`; Unicode display names allowed ([A3](../edge-cases.md), FR-ADR-7) |
| `core::address::a4_reserved_and_confusable` | Every reserved name and pattern; `rnailer-daemon`, `p0stmaster`, Cyrillic `а` in `аbuse`, mixed scripts → `address_reserved` ([A4](../edge-cases.md), FR-ADR-6) |
| `core::address::a12_local_part_budget` | Username plus suffix over 40 → `local_part_too_long` ([A12](../edge-cases.md)) |
| `core::address::skeleton_vectors` | Fold vectors from UTS #39 test data for ASCII-prototype entries |
| `it::identities::client_id_idempotent` | Replay returns `200` and the same identity; a changed body returns `client_id_conflict` (FR-IDN-1) |
| `it::identities::a5_tombstone_blocks_reuse` | A deleted identity's address cannot be created by any tenant ([A5](../edge-cases.md)) |
| `it::identities::a13_delete_then_reply_rejected` | After delete, mail to its addresses gets `550 5.1.1` ([A13](../edge-cases.md), FR-IDN-4) |
| `it::addresses::a11_newer_pending_replaces` | A second pending address on a domain replaces the first ([A11](../edge-cases.md)) |
| `it::addresses::promote_retire_rollback` | Promote, retire after grace, rollback by promoting the retiring address, events emitted (FR-ADR-2–4) |
| `it::addresses::a14_platform_address_kept` | Promoting away keeps the platform address `active`; retiring or deleting it is refused with `409 address_in_use`; promoting it again rolls back: it is `primary` and the custom address is an `active` alias with `retire_at = NULL` ([A14](../edge-cases.md), FR-ADR-2, FR-DOM-6) |
| `core::address::a4_role_names_by_domain` | `support`, `sales`, `info`, `marketing` are refused on the platform domain and allowed on a tenant domain; `postmaster` and `abuse` are refused on both ([A4](../edge-cases.md), FR-ADR-6) |
| `it::domains::transport_patch` | Platform key switches a domain to `ses` and back; a tenant key gets `403 scope_denied`; no SES identity gives `422 transport_unavailable` ([J5](../edge-cases.md)) |
| `it::addresses::retirement_cron` | `retire_at` reached → `retired`, `identity.address_retired`, inbound `550 5.1.6` (FR-ADR-3) |
| `it::addresses::c3_reply_from_retiring` | Replies from the retiring address the counterparty used ([C3](../edge-cases.md)) |
| `it::domains::h1_failing_fallback` | DNS fake removes DKIM; after two agreeing checks `failing`; sends fall back with thread continuity; restore → `recovered`; pinned threads stay ([H1](../edge-cases.md), FR-DOM-5, FR-DOM-6) |
| `core::dns::h2_spf_lookup_count` | Lookup and void-lookup counting; preflight refusal ([H2](../edge-cases.md)) |
| `core::dns::h3_strict_alignment` | `adkim=s`/`aspf=s` against Cloudflare and SES signing domains ([H3](../edge-cases.md)) |
| `it::domains::h4_ownership_change` | NS move, ownership TXT removed, RDAP change → `suspended`; reprove → `verifying` ([H4](../edge-cases.md)) |
| `it::domains::h5_existing_mx` | Apex with existing MX refused without `replace_mx` ([H5](../edge-cases.md)) |
| `it::domains::h6_rule_failure` | Literal rule creation fails → address stays `pending` with `routing_rule_failed`, retried, activated only with its rule ([H6](../edge-cases.md)) |
| `core::domain_fsm::h7_resolver_disagreement` | One resolver erroring or disagreeing never changes state; two consecutive agreeing cycles do ([H7](../edge-cases.md), FR-DOM-4) |
| `core::domain_fsm::transition_table` | Every row of the state machine table, including 14 days in `failing` and reminders at 24 h, 72 h and 7 days |
| `it::send::g7_domain_states` | Retiring, pending and failing domain behaviour at send time ([G7](../edge-cases.md)) |
| `it::domains::onboarding_idempotent` | Adding a tenant domain with each Cloudflare method succeeds, and re-running a failed add against the recorded Cloudflare API fake creates nothing twice (FR-DOM-2, FR-DOM-3, FR-OPS-1) |
| `it::domains::records_from_api` | Records in responses equal the fake provider's API answers, never templates (FR-DOM-3) |
| `it::domains::s9_manual_delivery_events` | With the Cloudflare fake answering `403` to the subscription create, `cloudflare_zone` and `nameservers` domains are created with `event_subscription_id = NULL`, `delivery_events: "manual"` and `details.action = "run pmail domains subscribe {domain}"`; a `503` answer fails the create with `502 upstream_error`; once the subscription ID is recorded, `delivery_events` is `active` and a delivery event updates the recipient (spike S9 fallback, FR-DOM-3) |
| `it::domains::cron_mints_missing_monitor` | A row with `monitor_do_id = ''` (platform, or inserted by `pmail domains add --local-token`) gets one `DomainMonitor`, `Init`, and `domain.created` when it has a `tenant_id`; two overlapping cron runs mint one ID |
| `it::domains::cf_token_required_by_method` | Without `PM_CF_API_TOKEN`: `cloudflare_zone`, `nameservers` and `delegated_subdomain` → `422 cf_token_required`; `dns_records`, `send_only` and `smtp_relay` are unaffected |
