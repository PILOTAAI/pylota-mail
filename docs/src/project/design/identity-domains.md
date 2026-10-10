# Identities, addresses and domains

Binding for implementation. This page defines the lifecycles of identities and addresses, username
validation, the domain kinds and their onboarding, the `DomainMonitor` health state machine and domain
fallback. The connection methods that keep a domain's DNS outside Cloudflare (`dns_records`,
`send_only`, `smtp_relay`), and the `nameservers` and `delegated_subdomain` methods, are specified in
[Domains on any DNS host](domain-connections.md); this page links to it where they differ.

| | |
|---|---|
| Requirements | FR-IDN-1 … FR-IDN-4, FR-ADR-1 … FR-ADR-7, FR-DOM-1 … FR-DOM-6, FR-DOM-13, FR-DOM-14 (FR-DOM-7 … FR-DOM-12 in [Domains on any DNS host](domain-connections.md)), FR-TEN-3 |
| Edge cases | [A1](../edge-cases.md), [A3–A5](../edge-cases.md), [A11–A14](../edge-cases.md), [C3](../edge-cases.md), [D2](../edge-cases.md), [G7](../edge-cases.md), [H1–H17](../edge-cases.md); N1–N34 in [Domains on any DNS host](domain-connections.md) |
| Code | `crates/worker/src/handlers/{identities.rs, addresses.rs, domains.rs}`, `db/{identities.rs, addresses.rs, domains.rs}`, `crons/{retire.rs, domain_cleanup.rs}`, `domains/{mod.rs, cloudflare_api.rs, ses_api.rs, records.rs, monitor.rs, fallback.rs, provider_objects.rs}`; `crates/core/src/{address.rs, dns.rs, domain_fsm.rs}` |
| ADR | [0003 Addressing with catch-all and a directory](../adr/0003-addressing.md), [0005 State machines](../adr/0005-state-machines.md), [0010 Cloud in the operator's existing Cloudflare account](../adr/0010-cloud-in-the-existing-cloudflare-account.md) |

Cloudflare API paths and behaviour on this page were read on 2026-10-09 from the Cloudflare API
reference and the Email Service documentation, and re-read on 2026-10-10 for Email Routing's DNS methods
and locked records; SES paths from the SES v2 API reference the same days. Items the documentation does not
confirm are marked "verify at build time" with the spike that settles them.

## Identities

### Lifecycle

| State | Event | Guard | Action | Next |
|---|---|---|---|---|
| – | `POST …/identities` | Valid body; username free; `client_id` new | `inboxes` hold; insert identity, addresses and the mailbox `init` intent (D1 batch); `MailboxRequest::Init`, which emits `identity.created` | `active` |
| – | `POST …/identities` with a known `client_id` | Same `client_fingerprint` | Return `200` with the existing identity; call `Init` again (idempotent, repairs a lost first call) | unchanged |
| – | `POST …/identities` with a known `client_id` | Different fingerprint | `409 client_id_conflict` | – |
| `active` | `PATCH status: paused` | `identities:write` | `pause_reason = 'manual'`; `identity.paused` | `paused` |
| `active` | Abuse threshold ([Outbound](outbound.md#abuse-auto-pause-fr-dlv-3)) | – | `pause_reason = 'abuse_threshold'`; `identity.paused` with `metrics` | `paused` |
| `active` | Tenant suspended | – | `pause_reason = 'tenant_suspended'`; `identity.paused` | `paused` |
| `paused` | `PATCH status: active` | reason `manual`: `identities:write`; reason `abuse_threshold`: platform, partner or tenant key, audit-logged, and only a platform key on a tenant a partner's key created ([J17](../edge-cases.md)); reason `tenant_suspended`: refused (`409 identity_paused`) | `pause_reason = NULL`; `identity.resumed` | `active` |
| `paused` (`tenant_suspended`) | Tenant resumed | – | `identity.resumed` | `active` |
| `active`, `paused` | `DELETE` | `identities:write` and `erasure:manage` | Tombstone and remove every address; create the identity-scope erasure ([Privacy](privacy.md)) | `deleting` |
| `deleting` | Erasure completed with no holds left | – | `identity.deleted`, once, from the erasure job's outbox with `identity_id` set ([Privacy § 6.5](privacy.md#65-identity-scope-fr-idn-4)) | `deleted` |
| `deleting`, `deleted` | `DELETE` again | `identities:write` and `erasure:manage` | None: `200` with the existing identity-scope erasure request (the same `era_` ID) | unchanged |
| `deleting`, `deleted` | `PATCH`, or any other write by identity ID | – | `404 identity_not_found`, nothing changes. The legal-hold routes are the exception: they stay usable on a `deleting` identity ([Privacy § 6.5](privacy.md#65-identity-scope-fr-idn-4)) | unchanged |
| any | `GET /v1/identities/{identity_id}` | `identities:read` | Returns the identity with its status; a `deleted` identity shows the fields its erasure scrubbed | unchanged |

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
  `postmaster@{PM_PLATFORM_DOMAIN}`), `send_policy.daily_cap` = 50,000 and
  `send_policy.require_known_recipient` = `false` (it writes to people who have never been written to); plus one `active` primary
  address on the platform domain. Setup writes both rows with `mailbox_do_id = ''`, and the every-minute
  cron mints the mailbox and sends `MailboxRequest::Init`, as the [monitor hook](#create) does for
  domains. At most one row has `is_system = 1` (a partial unique index).
- **Exempt from username validation.** Its local part may be a reserved name (`no-reply` is), because
  only setup writes its addresses, at creation and when `PM_SYSTEM_FROM` changes, and setup writes them
  through its internal path (the D1 query API), never the public routes, so the reserved-name and
  role-name steps of [Username validation](#username-validation) never run for it. Setup still checks
  that the local part is ASCII, at most 64 octets, with a valid address syntax.
- **Not listed to tenants.** List endpoints (`GET /v1/identities`, `GET /v1/tenants/{t}/identities`,
  `mail_list_identities`, the console) never return it, and a tenant or identity key that names it gets
  `404 identity_not_found`. Only a platform key reads or changes it, by ID. It is not counted against
  `inboxes`.
- **Mail sent to it** is stored in its mailbox like any identity's (bounces and replies to sign-in mail),
  readable only with a platform key. Its mailbox stores bodies with links and codes redacted, is never
  indexed or triaged, and is outside every tenant fan-out, export and tenant webhook
  ([Inbound › The system identity's mailbox](inbound.md#the-system-identitys-mailbox), [A15](../edge-cases.md)).
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
- **Changing `PM_SYSTEM_FROM`.** A re-run of setup inserts the new address as an `active` alias on the
  platform domain through its internal path, in one D1 query API batch as at creation (no reserved-name
  or role-name check, so `noreply` is accepted), then promotes it through the API with the bootstrap
  platform key; the old address retires as usual. This is the one exception to the rule that every
  identity keeps exactly one platform-domain address for life ([Format](#format)): only setup's internal
  write creates a second platform-domain address, for the system identity only, while the public
  `POST …/addresses` never does (and would refuse a reserved name with `400 address_reserved`).
  Promoting it makes the previous primary `retiring` with the usual grace, as on any other domain,
  instead of an `active` alias. The promoted address is the system identity's platform address from then
  on. Every other identity's platform address still cannot be retired or deleted.
- **Without the console** (`PM_CONSOLE=off`) it still exists and still sends invitations, because
  `PM_SYSTEM_FROM` and `PM_CONSOLE_HOST` are top-level settings, not console settings
  ([Rust workspace §6.1](rust-workspace.md#61-errors-and-configuration)).

### Create

`POST /v1/tenants/{tenant_id}/identities`:

1. Validate the body: `username` ([Username validation](#username-validation)), `display_name` (1–78
   characters, Unicode allowed, no CR or LF), `owner.email` (RFC 5321), `signature.html` (sanitised with
   the inbound policy before storage), `metadata` (≤ 16 keys, ≤ 512 bytes per value). For any key but a
   platform key, `send_policy.daily_cap` may not exceed the tenant's effective
   `identity_daily_send_cap` (`403 scope_denied`, `details.field = "send_policy.daily_cap"`); the same
   check runs on `PATCH /v1/identities/{identity_id}`
   ([Configuration › Who may change a field](../../reference/configuration.md#who-may-change-a-field)).
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
   `pending`. Each address is checked against `addresses_address` (`409 address_taken`), against
   `address_tombstones` ([Tombstones](#tombstones-a5)), and against `users.email`: an address that is
   a console user's sign-in address is refused with `409 address_taken` too, because every key that reads
   the mailbox could then read that person's sign-in codes. The same check runs when `POST …/addresses`
   adds an address ([Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud),
   [W45](../edge-cases.md)).
5. `mailbox_do_id = objects.new_object_id(Mailbox)`.
6. **`inboxes` hold.** `QuotaRequest::Hold { feature: Inboxes, units: 1, ref: <new idn_ ID>, gates: [StorageGb] }`
   to the tenant's `TenantQuota` ([Plans, metering and billing › What the Worker meters](billing.md#what-the-worker-meters)).
   `Denied` → `402 billing_limit` (`details.feature: "inboxes"`), and nothing is written. Until M22 the
   M5 stub grants every hold, as in billing mode `disabled`, so M6 wires this step and M22 changes only
   the answer.
7. One D1 `batch`: `INSERT INTO identities …`, `INSERT INTO addresses …` (one or two rows),
   `INSERT INTO audit_log …` (`identity.create`), and the `rpc_intents` row of the mailbox's `init`,
   whose body is the `InitMailbox` with the `identity.created` payload built from these rows
   ([Design conventions § 9](index.md#9-durable-object-calls-after-a-d1-change)). A failed batch settles
   the hold with `consume: 0`; a committed one with `consume: 1`.
8. `MailboxRequest::Init(InitMailbox)`, which writes the owner into `meta` and emits `identity.created`
   once; on success the intent row is deleted. If the call fails, the identity still exists: the request
   returns `201`, and the every-minute cron re-sends the intent until the mailbox accepts it
   ([J21](../edge-cases.md)). A replay with the same `client_id` also calls `Init` again, which is
   harmless.
9. `201` with the Identity object.

### Updates, pause and tenant suspension

`PATCH /v1/identities/{id}` updates D1 and, in the same batch, writes an `rpc_intents` row for the event:
`identity.updated` (`changed` = field names), `identity.paused` or `identity.resumed`. After the commit it
sends `MailboxRequest::EmitEvent` with the intent's derived `event_id`; a failed call is re-sent by the
every-minute cron, and the outbox stores the event once ([Design conventions § 9](index.md#9-durable-object-calls-after-a-d1-change),
[J21](../edge-cases.md)).

Suspending a tenant (`PATCH /v1/tenants/{id}` with `status: suspended`) sets `tenants.suspended_at` and
`suspended_by` (`platform` or `partner`, from the calling key's level) and, in the same D1 batch, pauses
every `active` identity with `pause_reason = 'tenant_suspended'` and writes one `identity.paused` intent
per identity it paused (`INSERT INTO rpc_intents … SELECT … FROM identities`); resuming reverses only those
identities, with one `identity.resumed` intent each. Each identity then gets its event through its
mailbox. Who suspended is kept ([J17](../edge-cases.md)):

- A partner key cannot resume a tenant whose `suspended_by` is `platform` (`403 scope_denied`,
  `details.field = "status"`).
- `status: "suspended"` on a tenant that is already suspended changes nothing, whoever sends it, except
  that a platform key's suspension replaces a partner's: `suspended_by` becomes `platform` and
  `suspended_at` is kept. A partner's suspension never replaces a platform's, so a partner cannot turn a
  platform suspension into its own and lift it. No identity is paused twice and no event is repeated.

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
job deletes those literal routing rules, asks `SesControl` (the single writer of the retired-address rules,
[Domains on any DNS host § 4.6](domain-connections.md#46-retired-and-unknown-recipients)) to remove those
addresses from their `pm-retired-{n}` rules (so an erased address is dropped like an unknown one instead of
bouncing with `5.1.6`), wipes the mailbox and sets
`deleted`, which frees the username (`identities_username` excludes deleted rows)
([Privacy › Identity scope](privacy.md#65-identity-scope-fr-idn-4)).

## Username validation

`core::address::validate_username(input, domain_class, max_len, tenant_suffix, existing_usernames) -> Result<String, AddressError>`
runs these steps in order (`domain_class` selects the reserved set below: `Platform` for a username of
the default tenant, `Tenant` for any other username and for a local part on a tenant domain; `max_len` is
24 for a username and 40 for an alias local part on a tenant domain, `POST …/addresses`) ([A1](../edge-cases.md), [A3](../edge-cases.md), [A4](../edge-cases.md),
[A12](../edge-cases.md), FR-ADR-6, FR-ADR-7):

| # | Step | Error |
|---|---|---|
| 1 | `fold(input)` (below) equals the fold of a name reserved on this domain class | `400 address_reserved` |
| 2 | Input contains a non-ASCII character and is mixed-script (its resolved script set is empty), or contains a strong right-to-left character | `400 address_reserved` |
| 3 | Input contains any other non-ASCII character (SMTPUTF8 local parts cannot be routed by Email Routing) | `400 address_unsupported` |
| 4 | Lower-case (ASCII). Must match `^[a-z0-9][a-z0-9._-]{0,N}$` with `N = max_len − 1` (`{0,23}` for a username, `{0,39}` for an alias local part), must not contain `..`, must not end in `.` | `400 address_invalid` |
| 5 | Exact match of a name or pattern reserved on this domain class | `400 address_reserved` |
| 6 | `len(username) + len(tenant_suffix) > 40` (room for a thread token in 64 octets) | `400 local_part_too_long` |
| 7 | Another non-deleted identity in the tenant has the same username, or a different username with the same fold | `409 username_taken` |

Display names are Unicode and never refused for script reasons (FR-ADR-7).

Request validation of `username` and `local_part` runs through this function, never through a schema
pattern: `openapi.yaml` leaves both request fields unconstrained and documents the stored form, so a
non-ASCII or confusable input gets `address_unsupported` or `address_reserved` from steps 1–3, not a
generic `400 invalid_request`. Every route that writes a username or an address runs it, for every
identity. The only writes that skip it are setup's writes of the system identity's username and
addresses, through the D1 query API rather than a route ([The system identity](#the-system-identity)),
which check ASCII, length and address syntax only.

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
`owner`. `forward()` only reaches verified Email Routing destinations, so the message is instead relayed
as a new send of the system identity, through the normal submit path with its suppressions, caps and
idempotency, rate-limited per domain and per sender, with a hop header that refuses loops; the original
is attached only when it passed authentication and has no risky attachment, otherwise its headers alone
([Inbound › Role mail relay](inbound.md#role-mail-relay), [D14](../edge-cases.md)). Nothing is stored in a
tenant mailbox. A tenant without an owner falls back to `PM_SECURITY_CONTACT`, else `550 5.1.1`
([Inbound › Steps](inbound.md#steps)). Mail for `PM_SECURITY_CONTACT` (an email address, bare or
`mailto:`) is relayed the same way, and never with `forward()`: `forward()` reaches only verified Email
Routing destination addresses
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
| Tenant `zone`, `delegated` or `external` | `{local_part}@{domain}`, for example `bookings@mail.acmecarhire.example` | `local_part` validated as a username for a tenant domain, with a maximum of 40 characters |

Addresses are stored lower case with an A-label domain; dots are significant ([A1](../edge-cases.md)).
At most 20 addresses per identity in any state, and one `pending` address per identity and domain.

Every identity keeps exactly one platform-domain address for its whole life (the system identity, whose
address setup may change, is the one exception: [The system identity](#the-system-identity)). It is the
**fallback address** ([Fallback behaviour](#fallback-behaviour), FR-DOM-6), so it is never retired automatically,
cannot be retired or deleted through the API (`409 address_in_use`), and on promotion away from it
becomes an `active` alias rather than `retiring`.

### Lifecycle

| State | Event | Guard | Action | Next |
|---|---|---|---|---|
| – | `POST …/addresses` | Domain of this tenant, not `removing`/`removed`; ≤ 20 addresses; address free and not tombstoned | Delete an older `pending` address of this identity on the same domain (and its literal rule) ([A11](../edge-cases.md)); insert `role = 'alias'`; route it; `identity.address_added` | `active` if routable now, else `pending` |
| `pending` | Domain reaches `healthy`/`degraded` and the address is routed | – | `identity.address_activated` | `active` |
| `pending` | Literal rule creation fails ([H6](../edge-cases.md)) | – | Stays `pending`; retried by the domain's monitor (1, 5, 15, 60 minutes, then hourly); issue `routing_rule_failed` on the domain's health | `pending` |
| `pending` | `DELETE …/addresses/{id}` | Never received mail | Delete the row and its rule | – |
| `active` alias | `POST …/promote` | Domain `healthy` or `degraded` (else `409 domain_not_ready`) | In one batch: this address becomes `primary`; the previous primary becomes an alias, `retiring` with `retire_at = now + retire_previous_after_days` (default 90, range 0–365; 0 means `retired` now), except the platform address, which becomes an `active` alias (the system identity's previous platform address retires instead, [The system identity](#the-system-identity)). When the promoted address is itself the platform address, this is a **rollback** as in the next row: the current primary becomes an `active` alias, not `retiring` ([A14](../edge-cases.md)); `identity.address_promoted` with `previous_primary` | `active` primary |
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

`POST /v1/tenants/{tenant_id}/domains` with `domains:write`. Common checks, in this order:

1. The name is a valid DNS name, lower case, A-label.
2. **Name taken.** A non-`removed` row of **this** tenant with that name: `409 domain_exists` with
   `details.domain_id`. A non-`removed` row of another tenant, an onboarding row of another tenant
   (below), or a refusal from the provider checks of the method (a zone of that name that this tenant did
   not create, or a provider object it did not create, [No adoption](#no-adoption-of-provider-objects)):
   `409 domain_exists` with one **uniform body** whose only detail is the claim record (below). The body is
   the same whatever the holder's state, kind or tenant, so the answer reveals nothing about another
   tenant ([H14](../edge-cases.md)).
3. **Unverified cap** (tenant and partner keys): a tenant may hold at most 5 domains that have never been
   verified (non-`removed` rows with `ownership_verified_at IS NULL`, plus its onboarding rows). The 6th
   gets `422 unverified_domain_limit` with `details.limit = 5`
   ([Limits](../../reference/limits.md#domains-and-addresses), [H14](../edge-cases.md)).

A `removed` row is never reused. Adding a name again creates a new row with a new ID and a new
`DomainMonitor`; the `removed` row stays with its old tenant, so that tenant's retired addresses keep
pointing at a row of their own tenant, and the address directory still refuses their addresses to anyone
else (`addresses_address` is unique across all rows, [A5](../edge-cases.md), [H13](../edge-cases.md)).
`domains.name` is unique among non-`removed` rows only ([Data model](data-model.md#1-d1-control-plane)).

**Onboarding journal.** Before its first provider call, the request inserts a `domain_onboarding` row
(`name` unique, the tenant, the ID the domain row will get) with `INSERT … ON CONFLICT (name) DO NOTHING`
and reads it back: a row of another tenant is the `409 domain_exists` above; a row of this tenant (a
retried request) is reused. Each provider object the request creates is appended to the row's
`objects_json` as soon as the create call returns (an `UPDATE`, before the next call), in the shape of
[`provider_objects_json`](#provider-objects). Every onboarding step is **idempotent**: it reads first (for
example lists rules or sending subdomains by name) and creates only what is missing, and an object it finds
is reused only when the journal or the domain's `provider_objects_json` lists it, so a failed request can
be repeated. A failed provider call returns `502 upstream_error` with `details.step`. The D1 batch that
inserts the domain row copies `objects_json` into `domains.provider_objects_json` and deletes the
journal row. A journal row that no request completes is cleaned up within the hour
([Cleanup after a failed add](#cleanup-after-a-failed-add)).

**Claim record and eviction (S18).** The uniform `409 domain_exists` body carries
`details.claim = { "type": "TXT", "name": "_pylota-mail.{name}", "value": "pm-claim={token}" }`, where
`token` is the first 26 characters of the lower-case base32 of
`SHA-256("pylota-mail claim|" ‖ PM_API_HOST ‖ "|" ‖ tenant_id ‖ "|" ‖ name)`. The token binds the claim to
the requesting tenant and deployment; it needs no key, because only someone who controls the name's DNS can
publish it. A requester that controls the DNS publishes that TXT value and repeats the request with
`"claim": true`. The Worker then queries `_pylota-mail.{name}` on both DoH resolvers:

- Both show `pm-claim={token}`, and the holder is another tenant's domain that has never been verified
  (`ownership_verified_at IS NULL`, state `pending` or `verifying`): the holder is **evicted**. Its row
  moves to `removing` with `state_reason = 'evicted'`, its `pending` addresses are deleted, a
  `domain_remove` job starts with `reason: evicted`, and an `audit_log` row (`domain.evict`) names both
  tenants. The request answers `409 domain_claim_pending` with `Retry-After: 60`; once the removal
  finishes, the same request succeeds. The evicted tenant gets `domain.removed` with
  `reason: "evicted"`.
- Otherwise (the TXT is not seen on both resolvers, the holder has been verified, or there is no holder row
  but a zone or provider object this tenant did not create): the same uniform `409 domain_exists`.

A verified holder is never evicted: if its ownership signals change, it is suspended and re-proved as
in [H4](../edge-cases.md). The `pm-claim=` value never counts as an ownership record.

The request names a `method`. When it is absent, the old `kind` is mapped (`zone` → `cloudflare_zone`,
`external` → `send_only`), and `kind: zone` with `"create_zone": true` is the old spelling of
`nameservers`. Each method has its own onboarding:

| `method` | Onboarding | The deployment needs (refusal without it) |
|---|---|---|
| `cloudflare_zone` | [Kind `zone`](#kind-zone) | `PM_CF_API_TOKEN` (`422 cf_token_required`) |
| `nameservers` | [Creating a zone](#creating-a-zone), then [Kind `zone`](#kind-zone) at the apex | `PM_CF_API_TOKEN` (`422 cf_token_required`) that can create zones (when Cloudflare refuses the create for the token's scope: `422 transport_unavailable`, `details.reason = "zone_creation_not_allowed"`); for a tenant or partner key, also the policy `domains.allow_create_zone: true` (the same refusal). Pylota Mail Cloud keeps the policy off and scopes its token to named zones, so the method is not offered there ([ADR 0010](../adr/0010-cloud-in-the-existing-cloudflare-account.md)) |
| `delegated_subdomain` | [Domains on any DNS host §3.3](domain-connections.md#33-delegated_subdomain) | `PM_CF_API_TOKEN` (`422 cf_token_required`) and `PM_CF_SUBDOMAIN_SETUP=on` (`422 transport_unavailable`, `subdomain_setup_disabled`) |
| `dns_records` | [§4.3](domain-connections.md#43-dns_records) | SES with receiving (`422 transport_unavailable`, `ses_not_configured` or `ses_receiving_not_configured`) |
| `send_only` | [Kind `external`](#kind-external) and [§4.4](domain-connections.md#44-send_only) | SES (`422 transport_unavailable`, `ses_not_configured`) |
| `smtp_relay` | [§5](domain-connections.md#5-smtp_relay-the-customers-own-sending-provider) | Relay credentials that pass a one-off connection (`400 smtp_port_not_allowed`, `422 smtp_tls_required`, `422 smtp_auth_failed`); with `inbound: ses`, SES with receiving |

A method that needs an SES identity (`dns_records`, `send_only`, `smtp_relay` with `inbound: ses`) is
refused with `422 transport_unavailable`, `details.reason = "ses_identity_limit"`, once the region holds
10,000 identities (the count of [Domains on any DNS host §4.3](domain-connections.md#43-dns_records)).

**Mail domains per zone ([H15](../edge-cases.md)).** A Cloudflare zone holds at most 30 mail domains,
routing and sending together, apex included (Email Service [subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/),
read 2026-10-10). For `cloudflare_zone` (and for a created zone once it is active), before enabling
routing or sending, the Worker counts the zone's mail domains: the entries of
`GET /zones/{zone_id}/email/sending/subdomains`, plus this deployment's non-`removed` routing domains in
the zone that are not among them. At 30 the request gets `422 zone_domain_limit` with `details.limit = 30`,
before anything is created. A Cloudflare refusal of the routing or sending create that the Worker cannot
classify is re-checked the same way, so a limit reached by mail domains outside this deployment also
answers `422 zone_domain_limit` rather than `502 upstream_error`. Cloudflare's error code for the limit is
not documented (searched 2026-10-10); spike S9 records it.

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

#### Zone permission

`cloudflare_zone`, `nameservers` and `delegated_subdomain` work inside the deployment's own Cloudflare
account, which holds every tenant's zones and the zones of the deployment's own hosts. A tenant or
partner key may therefore use only zones its tenant is entitled to ([H8](../edge-cases.md)). Platform
keys skip this check. Two sources grant a zone to a tenant:

- **Claimed zones.** `zone_claims` ([Data model](data-model.md#1-d1-control-plane)) records each zone
  this deployment created for a tenant (`nameservers`, `delegated_subdomain`). The row is inserted as a
  **pending claim** (`state = 'pending'`, `zone_id` not yet known) before `POST /zones`
  ([Creating a zone](#creating-a-zone) step 2), and becomes `active` with the zone ID in the D1 batch that
  inserts the domain row. `zone_name` is the primary key, so a name is claimed by one tenant at most, and a
  pending claim already blocks every other tenant. The claim is deleted by the `delete_zone` step of
  [Domain removal](#domain-removal), when the zone expires (`zone_expired`, [Creating a zone](#creating-a-zone)
  step 6), and by [the cleanup of a failed add](#cleanup-after-a-failed-add).
- **Listed zones.** The tenant's policy `domains.cloudflare_zones`, an array of zone names that only a
  platform key can write ([Configuration › Who may change a field](../../reference/configuration.md#who-may-change-a-field)),
  for zones of the account that an operator assigns to the tenant. A policy write that drops a zone from
  the list while the tenant still has non-`removed` `cloudflare_zone` domains in it that no claim grants is
  refused with `409 domain_in_use`, `details.reason = "zone_has_domains"` and `details.domain_ids`: the
  operator removes those domains first, so moving a zone to another tenant never leaves the first tenant's
  domains in it ([H13](../edge-cases.md)).

The check runs in two places, both before anything is written, and refuses with `403 scope_denied`,
`details.reason = "zone_not_allowed"`:

1. **By name, before any Cloudflare call.** Let the *deployment zones* be the registrable domains (public
   suffix list) of `PM_PLATFORM_DOMAIN`, `PM_API_HOST` and `PM_CONSOLE_HOST`. The name is refused when it
   equals or is under a deployment zone, or equals or is under a zone another tenant claimed (pending
   claims included). For `cloudflare_zone`
   (and with it `replace_mx`, which deletes MX records only inside that zone), the name must also equal or
   be under a zone this tenant claimed or a zone in its `domains.cloudflare_zones`. A listed zone grants
   names strictly under it: its apex, and `replace_mx` there, stay platform-only, so listing an operator's
   zone (for example `pylota.io`, to allow `notify.pylota.io`) never hands over that zone's own mail.
   `nameservers` and `delegated_subdomain` create their own zone and need no grant, only the two
   refusals; they never take over a zone that already exists
   ([Creating a zone](#creating-a-zone) step 2).
2. **On the zone found** ([Kind `zone`](#kind-zone) step 1, which takes the most specific zone of the
   account containing the name). The found zone must be claimed by this tenant (`zone_claims.zone_id`
   with its `tenant_id`), or listed in its `domains.cloudflare_zones` by name and claimed by no other
   tenant. A zone claimed by another tenant is refused even when the policy lists it, so a listed parent
   zone never reaches a more specific zone another tenant owns.

Both refusals have the same body, whether or not a zone of that name exists in the account, so the
answer does not reveal other tenants' zones. `pmail domains add --local-token` runs with the operator's
own Cloudflare token and inserts the row itself; it is a platform operation and not checked.

#### No adoption of provider objects

The deployment's Cloudflare account and AWS account also hold objects that this deployment did not create
for the tenant: the operator's own zones, sending domains, routing setups and SES identities, and those of
another deployment in the same account. Onboarding therefore never takes one over (FR-DOM-13,
[H10](../edge-cases.md)):

| Object found for the name before onboarding creates it | Tenant or partner key | Platform key |
|---|---|---|
| A zone of that name in the account (`nameservers`, `delegated_subdomain`) | `409 domain_exists`, unless `zone_claims` holds that zone ID for this tenant | The same: a zone that exists is used through `cloudflare_zone`, never "created" |
| An Email Sending domain for the name (`GET /zones/{zone_id}/email/sending/subdomains` lists it) | `409 domain_exists` | Used, and recorded as adopted (`created: false`) |
| Email Routing already enabled for the name (the routing MX records are already at the name) | `409 domain_exists` | Used, and recorded as adopted |
| A catch-all rule at the apex whose action is not the Worker | `409 domain_exists` | Replaced, and recorded as adopted (removal disables it, but never deletes another rule) |
| An SES identity for the name (`AlreadyExistsException`) whose tags do not name this deployment and this domain | `409 domain_exists` | The same: an SES identity is never shared |

An object counts as this request's own when the onboarding journal or the domain's
`provider_objects_json` lists its provider ID, or, for an SES identity, when its tags are
`pylota-mail:api-host = {PM_API_HOST}` and `pylota-mail:domain-id = {domain id}`: every SES identity this
deployment creates carries both tags (`CreateEmailIdentity` accepts `Tags`; `GetEmailIdentity` returns
them, SES v2 API reference read 2026-10-10). The refusals use the uniform `409 domain_exists` body of
[Adding a domain](#adding-a-domain), so they reveal nothing about the operator's objects.

#### Provider objects

`domains.provider_objects_json` lists every provider object onboarding created or adopted for the domain,
by provider ID. Removal and cleanup act on these objects only, and never on an object that is not listed or
is listed with `created: false` (except disabling an adopted catch-all that points at the Worker):

```json
{ "zone":        { "id": "023e…", "created": true },
  "routing":     { "name": "agents.example", "created": true, "record_ids": ["372e…", "9a7f…", "b1c0…"] },
  "catch_all":   { "created": true },
  "sending":     { "tag": "c3f1…", "created": true },
  "dns_records": ["4c2d…"],
  "ses_identity": { "name": "agents.example", "region": "eu-west-2", "created": true,
                    "dkim_record_ids": ["7d1e…", "7d1f…", "7d20…"] } }
```

- `zone`: the zone `POST /zones` created (`nameservers`, `delegated_subdomain`); absent for
  `cloudflare_zone`.
- `routing`: Email Routing for the name; `created: true` when this onboarding's
  `POST …/email/routing/dns` turned it on; `record_ids` are the DNS record IDs of the routing MX, SPF and
  DKIM records Cloudflare added at the name, read back by name after the call
  (`GET /zones/{zone_id}/dns_records?name.exact=…`).
- `catch_all`: present when onboarding set the apex catch-all to the Worker.
- `sending`: the Email Sending domain's `tag`.
- `dns_records`: records the Worker created through the DNS records API (the ownership TXT).
- `ses_identity`: the SES identity, and the DNS record IDs of its three DKIM CNAMEs when the Worker
  published them (the J5 failover identity of a Cloudflare-method domain).

The event subscription stays in its own column, `event_subscription_id`.

#### Kind `zone`

The `cloudflare_zone` method. Needs `PM_CF_API_TOKEN` (`422 cf_token_required` without it, as above) and
`PM_CF_ACCOUNT_ID`, which setup writes.

1. **Find the zone.** List zones by name for the account, trying the domain and then each parent label
   up to the registrable domain (`GET /zones?name={name}`; verify the query parameters at build time).
   Not found: `404 domain_not_found`. The `nameservers` method creates the zone instead
   ([Creating a zone](#creating-a-zone)). For a tenant or partner key, the found zone then passes the
   second [zone permission](#zone-permission) check, or the request gets `403 scope_denied`
   (`zone_not_allowed`) before anything is changed. The zone's `name_servers` (from the same response, or
   `GET /zones/{zone_id}`) become `expected_ns_json`, the baseline of the weekly NS check
   ([Schedule](#schedule)). Then the [mail domains per zone](#adding-a-domain) count runs.
2. **Existing mail at an apex ([H5](../edge-cases.md)).** Query MX at the apex on both DoH resolvers. If
   it has MX records other than the hosts Email Routing expects (taken from step 6, never hard-coded) and
   the request lacks `"replace_mx": true`, refuse with `409 existing_mx` and a fix saying that existing
   mail would stop. With `replace_mx`,
   delete those MX records through the DNS records API before enabling routing. The deleted records are
   written to the `audit_log` row of the domain create; they are not restored on removal.
3. **SPF preflight ([H2](../edge-cases.md)).** If the apex already publishes SPF, count the DNS lookups
   of the record Email Routing will need merged with the existing one
   ([SPF lookup count](#spf-lookup-count)). More than 10, or more than 2 void lookups: refuse with
   `400 spf_lookup_limit`, `details.lookups`, and a fix naming the includes to flatten.
4. **Ownership record.** Generate `ownership_token` (16 random bytes, Crockford base32) and create TXT
   `_pylota-mail.{domain}` = `pm-verify={token}` through the DNS records API; its record ID joins
   `dns_records` in the journal.
5. **Receiving** (when `receiving`):
   - Read first: `GET /zones/{zone_id}/dns_records?name.exact={domain}&type=MX`. Routing MX records
     (the hosts the routing API lists) already at the name mean Email Routing is on for it: refused or
     adopted as in [No adoption](#no-adoption-of-provider-objects).
   - Otherwise `POST /zones/{zone_id}/email/routing/dns` with `{ "name": "{domain}" }` ("Enables Email
     Routing for the zone and adds and locks the required MX and SPF DNS records", API reference read
     2026-10-10), then read the records Cloudflare added at the name back by name and store their IDs in
     `routing.record_ids`. For a subdomain the reference does not confirm that this call enables routing on
     the subdomain only and leaves the apex's MX records alone; S9 verifies both.
   - `PATCH /zones/{zone_id}/email/routing` with `{ "support_subaddress": true }`, so `user+token@`
     matches `user@` and the `+token` stays in `message.to`.
   - Apex: read `GET /zones/{zone_id}/email/routing/rules/catch_all` first (an enabled catch-all with
     another action is refused or adopted as in [No adoption](#no-adoption-of-provider-objects)), then
     `PUT /zones/{zone_id}/email/routing/rules/catch_all` with
     `{ "actions": [{ "type": "worker", "value": ["pylota-mail"] }], "matchers": [{ "type": "all" }], "enabled": true, "name": "pylota-mail" }`.
   - Subdomain: literal rules are created per address ([Routing an address](#routing-an-address)).
6. **Sending** (when `sending`): read `GET /zones/{zone_id}/email/sending/subdomains` first; an entry for
   the name that the journal does not list is refused or adopted as in
   [No adoption](#no-adoption-of-provider-objects). Otherwise
   `POST /zones/{zone_id}/email/sending/subdomains` with `{ "name": "{domain}" }` (the response holds `tag`, `dkim_selector` and `return_path_domain`; whether
   an apex can be onboarded through this endpoint is verified by S9), then
   `PATCH /zones/{zone_id}/email/sending/subdomains/{tag}` with
   `{ "drop_suppressed_recipients": false, "preview_enabled": false }`
   ([Outbound › G4](outbound.md#provider-suppressions-and-resending-g4); Email preview keeps a copy of
   each sent message for about seven days and is on by default for new sending domains,
   [Privacy](privacy.md#3-jurisdiction-and-residency)). Both fields are in the Cloudflare API reference
   for this endpoint (read 2026-10-09).

   **SES identity for the failover** (optional; only when `sending`, the SES transport is configured, and
   the domain is a tenant domain, never the platform domain). This prepares the Email Sending failover of
   [J5](../edge-cases.md), so that [`PATCH` to `ses`](#changing-the-transport-j5) works later without any
   DNS change: create the SES identity as in step 2 of [Kind `external`](#kind-external)
   (`CreateEmailIdentity` with the two ownership tags, through the SES token bucket of
   [Domains on any DNS host §4.8](domain-connections.md#48-ses-api-rate-one-request-per-second)), publish
   its three Easy DKIM CNAMEs `{token}._domainkey.{domain}` → `{token}.{SigningHostedZone}` through the DNS
   records API (their IDs go into `ses_identity.dkim_record_ids`), and set `ses_identity` = the domain and
   `ses_region` = `PM_SES_REGION`. On `AlreadyExistsException`, `GetEmailIdentity` is reused only when its
   tags name this deployment and this domain; any other existing identity is never touched, and the step is
   skipped as below (the domain is still created; the failover is unavailable and `GET …/health` says
   why). The CNAMEs join `records_json` with `purpose: "dkim"` and `required: false`. No custom MAIL FROM is set up: during a
   failover SES uses its own MAIL FROM domain, so SPF does not align but Easy DKIM does, and DMARC passes
   on DKIM. This step never refuses the domain: when the token bucket answers `Busy`, or an SES call fails,
   the domain is created without it and its monitor runs the step again in the background (a background
   caller, at most once an hour); when the region already holds 10,000 identities it is skipped. Until it
   has run, a `PATCH` to `ses` gets `422 transport_unavailable`. A domain added before SES was configured
   has no SES identity, and neither has one inserted by `pmail domains add --local-token`, because the
   Worker has no Cloudflare token to publish the CNAMEs with.
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
   then the domain would send blind: no bounces, complaints, suppressions or abuse auto-pause, and no
   reconciliation of uncertain sends. So **while `delivery_events` is `manual`, sends from the domain go
   out from the identity's platform address**, as in [Fallback behaviour](#fallback-behaviour): the
   platform domain has its own subscription, so every event of those sends is seen
   ([H17](../edge-cases.md)). The operator alert `delivery_events_manual:{domain_id}` (ticket) fires
   while it lasts ([Observability](observability.md#53-alert-list)), and `pmail doctor` fails
   `sending.event_subscriptions` with that command as the fix. Once the subscription ID is recorded, new
   threads send from the domain at once. The
   same applies to a `nameservers` domain, whose step 7 runs in the monitor once the zone is active. If
   S9 also shows that the Worker cannot delete a subscription, domain removal keeps going and `pmail
   doctor` lists the left-over subscription with the `wrangler queues subscription delete` command. Tests:
   `it::domains::s9_manual_delivery_events` (`cloudflare_zone`) and
   `it::domains::s9_manual_delivery_events_nameservers`.

   `delivery_events` is derived, not stored: `active` when the domain sends through Cloudflare and has an
   `event_subscription_id`, or sends through SES or SMTP (their events arrive through SNS or DSNs);
   `manual` when it sends through Cloudflare without one; `none` when `sending` is false.
8. **Read the records back (FR-DOM-3).** `GET /zones/{zone_id}/email/routing/dns` and
   `GET /zones/{zone_id}/email/sending/subdomains/{tag}/dns`; normalise each to
   `{ type, name, value, priority, purpose, required }` with `purpose` one of `mx`, `spf`, `dkim`,
   `return_path`, `dmarc`, `ownership`, `ns`; add the ownership TXT; store as `records_json`. These are
   the records shown to users. They are never copied from documentation or templates.
9. Insert the row (`state = 'pending'`, `monitor_do_id`, `expected_ns_json`, `provider_objects_json`
   from the journal) and delete the journal row in one D1 batch, call `DomainRequest::Init`, which starts
   verification at once, and emit `domain.created`.

#### Creating a zone

This is the `nameservers` method (old spelling: `kind: zone` with `"create_zone": true`), for a domain
used only for mail ([Domains on any DNS host §3.2](domain-connections.md#32-nameservers)). Platform keys
may always use it; tenant and partner keys only when the tenant's policy has `domains.allow_create_zone: true` (see
[Adding a domain](#adding-a-domain)).

1. **Dedicated-domain check ([N21](../edge-cases.md)).** Before creating anything, query both DoH
   resolvers for `A`, `AAAA` and `MX` at the name and for `CNAME`/`A` at `www.{name}`. If any exist and
   the request lacks `"confirm_dedicated": true`, refuse with `409 domain_not_dedicated`;
   `details.records` lists what was found, and the fix says the website or mail on the domain would stop.
   The same queries ask for `DS` at the name: a DS record at the parent means DNSSEC is on at the
   registrar, and Cloudflare "cannot provide authoritative DNS resolution" for such a domain until it is
   turned off, so the domain would stay pending or answer `SERVFAIL` ([cannot add domain](https://developers.cloudflare.com/dns/zone-setups/troubleshooting/cannot-add-domain/),
   read 2026-10-10). The request is not refused: the domain gets the issue `ds_record_present` (fail), whose
   fix says to remove the DS record at the registrar before changing the nameservers (and to turn DNSSEC
   on in Cloudflare after activation). The monitor repeats the DS query on each check while the domain is
   `pending` and clears the issue when the DS record is gone ([H7](../edge-cases.md)).
2. **No existing zone, and a pending claim (C1).** List the account's zones by name
   (`GET /zones?name={domain}&account.id={account_id}`, any status). A zone of that name is refused with the
   uniform `409 domain_exists`, unless `zone_claims` holds that zone ID for this tenant (a retry of this
   tenant's own add, which continues at step 4). An unclaimed zone that already exists is never adopted
   ([No adoption](#no-adoption-of-provider-objects), [H10](../edge-cases.md)). Then insert the pending claim:
   `INSERT INTO zone_claims (zone_name, zone_id, tenant_id, domain_id, state, created_at) VALUES (?1, NULL,
   ?2, ?3, 'pending', ?4) ON CONFLICT (zone_name) DO NOTHING`, and read the row back: a row of another
   tenant is the same `409 domain_exists`.
3. **Create the zone:** `POST /zones` with `{ "account": { "id": "{account_id}" }, "name": "{domain}", "type": "full" }`.
   Its `id` is appended to the journal at once (`zone`, `created: true`). Cloudflare error `1105` becomes
   `429 upstream_rate_limited` with `Retry-After` and `details.retry_after` of 10800 seconds
   ([N22](../edge-cases.md)); a zone hold becomes `409 zone_hold`; a refusal for the token's scope (`403`)
   becomes `422 transport_unavailable` with `zone_creation_not_allowed`. Any other failure, and a lost
   response, is resolved by listing the zones by name again, never by the error code: a zone whose
   `created_on` is not earlier than the pending claim's `created_at` was created by this request and is
   recorded; an older zone, or the "already exists" error that third-party clients report as code `1061`
   (Cloudflare's API reference documents no code for it, searched 2026-10-10), is refused with the uniform
   `409 domain_exists` and the pending claim is deleted. Verify the `created_on` field of the zone object at
   build time.
4. The zone is created in a pending state and the response's `name_servers` are returned in `records` as
   `NS` records (`purpose: "ns"`) to set at the registrar. `expected_ns_json` is set to `name_servers`.
   The D1 batch that inserts the domain row also sets its `zone_claims` row to `active` with the zone ID,
   so no other tenant can use the zone through `cloudflare_zone` ([Zone permission](#zone-permission)).
   The first [zone permission](#zone-permission) check ran before step 1.
5. **Onboarding once the zone is active (C23).** The monitor polls the zone (`GET /zones/{zone_id}`,
   `status = "active"`; verify the field at build time) on each check while the domain is `pending`, and
   then runs steps 1 (the mail domains count only) and 2–8 of [Kind `zone`](#kind-zone) at the apex
   (catch-all), as a background caller. `confirm_dedicated` stands in for `replace_mx` at step 2, because
   the user has already accepted that existing mail stops. Each object it creates is written to
   `provider_objects_json` as soon as the call returns, so a re-run creates nothing twice. A step that
   fails leaves the domain `pending`:
   - a provider failure (`429`, `5xx`, a network error) records the issue `onboarding_failed` with
     `details.step`, and the step runs again on the next check;
   - a refusal the user must fix (`spf_lookup_limit` from the SPF preflight, `zone_domain_limit`) records
     that issue with its fix, reminders continue, and the step runs again on each check, so fixing the DNS
     lets onboarding finish on its own.

   The domain moves to `verifying` only when every step has succeeded. Its 14-day unverified expiry counts
   from the zone's activation ([State machine](#state-machine)), so an onboarding that never finishes ends
   with `domain.removed` (`reason: "unverified_expired"`) instead of staying `pending` for ever.
6. **Expiry ([N23](../edge-cases.md)).** Cloudflare deletes a Free-plan zone that is not activated within
   28 days. The monitor sends a final `domain.reminder` at day 21. If the zone disappears, the domain
   moves to `removed` with `state_reason = zone_expired`, its `zone_claims` row is deleted, and
   `domain.removed` carries `reason: "zone_expired"`; the user can add it again.

#### Kind `external`

The `send_only` method. `dns_records` and `smtp_relay` are `external` too; their onboarding is in
[Domains on any DNS host §4.3](domain-connections.md#43-dns_records) and
[§5](domain-connections.md#5-smtp_relay-the-customers-own-sending-provider). Needs the SES transport
(`PM_SES_REGION` and both SES secrets); without it `422 transport_unavailable`,
`details.reason = "ses_not_configured"`.

1. **Ownership record** as above; the user publishes it.
2. **SES identity:** `POST /v2/email/identities` with `{ "EmailIdentity": "{domain}", "ConfigurationSetName": "pylota-mail", "Tags": [{ "Key": "pylota-mail:api-host", "Value": "{PM_API_HOST}" }, { "Key": "pylota-mail:domain-id", "Value": "{domain id}" }] }`
   (SigV4). `AlreadyExistsException` → `GET /v2/email/identities/{domain}`, reused only when its `Tags`
   name this deployment and this domain; otherwise `409 domain_exists`
   ([No adoption](#no-adoption-of-provider-objects)). The response's
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

From then on the platform domain is monitored like any other domain, with the differences of the
platform domain's health rules under [State machine](#state-machine). Setup writes its
`expected_ns_json` from the zone's `name_servers` (`GET /zones/{zone_id}`), so the weekly NS check has a
baseline from the start.
Without `PM_CF_API_TOKEN` in the Worker, `GET …/records` for it returns the stored `records_json` (read
from the API by setup) checked against DNS.

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
- **How the weekly results enter the two-cycle rule (C22).** The weekly alarm runs a full check that
  includes the NS and RDAP rows. NS: once a weekly NS result is not `ok` on a resolver, every following
  check queries NS again on both resolvers until both are `ok`, so the confirming check 5 minutes later
  sees a fresh NS answer. RDAP: a change becomes an issue only once confirmed by two RDAP queries an hour
  apart (below); from then on `registration_changed` is part of every check's outcome on both resolvers
  until a re-prove re-records the fingerprint, so the next two agreeing cycles apply it.
- **Baselines.** `expected_ns_json` is written when the domain row is inserted (the zone's
  `name_servers` for `cloudflare_zone`, `nameservers` and `platform`; the delegated name servers for
  `delegated_subdomain`). `rdap_fingerprint` is written by the first RDAP query that succeeds after the
  domain first reaches `healthy` or `degraded` (it is compared from the next one on), and again when a
  suspended domain is re-proved.

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
| SES DKIM (three CNAMEs) | `transport = ses` or `inbound = ses`; informational on a Cloudflare-transport domain with `ses_identity` (below) | Each CNAME points to `{token}.{SigningHostedZone}`, and SES `GetEmailIdentity` reports `DkimAttributes.Status = SUCCESS` (once a day) | `dkim_missing` (fail); `ses_dkim_failed` (`FAILED`, fail) |
| DMARC (`_dmarc.{domain}`, else the organisational domain) | `sending` | Exactly one valid `v=DMARC1` record with `p=quarantine` or `p=reject`, and alignment possible ([H3](../edge-cases.md)) | `dmarc_missing` (degraded); `dmarc_policy_none` (degraded); `dmarc_multiple` (degraded); `dmarc_alignment_impossible` (fail) |
| Ownership TXT (`_pylota-mail.{domain}`) | all except platform | Contains `pm-verify={ownership_token}` | `ownership_record_missing` (ownership) |
| NS (weekly) | zone and platform | The NS set equals `expected_ns_json` | `nameservers_changed` (ownership) |
| RDAP (weekly) | zone, delegated and external | Fingerprint equals `rdap_fingerprint` | `registration_changed` (ownership) |

**The failover identity while `transport = cloudflare`.** On a `zone` or `delegated` domain that has
`ses_identity` (the optional step of [Kind `zone`](#kind-zone)) and still sends through Cloudflare, the
three SES DKIM CNAMEs and the daily `GetEmailIdentity` check run, but only for information: each record's
result is shown in `GET …/records` and `GET …/health`, and they add no issue to the outcome, so they never
change the domain's state. After a `PATCH` to `ses`, the rows for `transport = ses` replace those for
`transport = cloudflare` (return path and sending DKIM): the SES DKIM CNAMEs and the SES identity check
count with their levels; the receiving, DMARC, ownership, NS and RDAP rows are unchanged; and the MAIL FROM
row of [Domains on any DNS host § 6](domain-connections.md#6-health-checks-per-method) does not apply,
because the failover identity has no custom MAIL FROM (`mail_from_domain` stays `null`), so failing over
never makes the domain `degraded`.

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
   **Both resolvers failing for 6 hours (C8).** `meta.both_error_since` is set by the first cycle in which
   *both* resolvers return `error` and cleared by any cycle in which either does not. Once it is 6 hours
   old, the monitor re-queries each failing name on both resolvers with DNSSEC validation off (`cd=1`;
   both default resolvers document the parameter: Cloudflare's [DoH JSON API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)
   and Google's JSON API, read 2026-10-10). A name that then answers is `dnssec_bogus` (fail: a broken
   signature chain, or a DS record left at the registrar after a nameserver move); a name that still fails
   is `dns_unresolvable` (fail). From then on each cycle's per-resolver outcome is `fail` with that issue
   instead of `error`, so the two resolvers agree, the usual two-cycle rule moves the domain to `failing`,
   sends fall back, and `domain.failing` names the issue. The fix for `dnssec_bogus` says to remove the
   stale DS record at the registrar or re-sign the zone. A healthy-looking domain therefore never keeps
   sending for ever while nothing can resolve it.
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
| `pending` | Check | Zone became active, or still active with onboarding unfinished | Run onboarding steps 2–8 ([Creating a zone](#creating-a-zone) step 5); a failed or refused step records its issue and stays `pending` | `verifying` once every step succeeded, else `pending` |
| `pending`, `verifying` | Check | Never verified (`ownership_verified_at IS NULL`), and 14 days since the row was created, or since the zone became active for `nameservers` and `delegated_subdomain` ([H14](../edge-cases.md)) | `state_reason = unverified_expired`; delete its `pending` addresses; create a `domain_remove` job (`reason: unverified_expired`) | `removing` |
| `pending`, `verifying` | Eviction by a proved claim of another tenant ([Adding a domain](#adding-a-domain)) | Never verified | `state_reason = evicted`; delete its `pending` addresses; create a `domain_remove` job (`reason: evicted`); `audit_log` `domain.evict` | `removing` |
| `verifying` | Agreed `pass` ×2 | – | `ownership_verified_at = now`; `domain.verified`; activate the domain's `pending` addresses that are routed | `healthy` |
| `verifying` | Agreed `degraded` ×2 | – | `ownership_verified_at = now`; `domain.degraded`; activate addresses | `degraded` |
| `verifying` | Agreed `fail` or `ownership_changed` | – | Record issues; reminders | `verifying` |
| `healthy` | Agreed `degraded` ×2 | – | `domain.degraded` with `issues` | `degraded` |
| `healthy`, `degraded` | Agreed `fail` ×2 | – | `failing_since = now`; `domain.failing` with `issues` and `fallback_active` | `failing` |
| `degraded` | Agreed `pass` ×2 | – | `domain.recovered` (`from_state: degraded`) | `healthy` |
| `failing` | Agreed `pass` ×2 | – | `failing_since = NULL`; `domain.recovered` (`from_state: failing`) | `healthy` |
| `failing` | Agreed `degraded` ×2 | – | `failing_since = NULL`; `domain.degraded`; sending from the domain resumes | `degraded` |
| `failing` | `now − failing_since ≥ 14 days` | Not the platform domain | New `ownership_token`; `domain.suspended` (`reason: failing_14_days`) | `suspended` |
| `healthy`, `degraded`, `failing` | Agreed `ownership_changed` ×2 | Not the platform domain | New `ownership_token`; `domain.suspended` with `reason` = `nameservers_changed`, `ownership_record_missing` or `registration_changed` | `suspended` |
| `healthy`, `degraded` | Agreed `ownership_changed` ×2 | The platform domain ([H9](../edge-cases.md)) | Counted as `fail`: `failing_since = now`; `domain.failing`; the `platform_domain_failing` page | `failing` |
| `suspended` | `POST …/reprove` | – | New `ownership_token`; `records_json` updated; check now | `suspended` |
| `failing` | `POST …/reprove` | The platform domain, platform key | Re-read the zone (`GET /zones/{zone_id}`); when it is active in the account, `expected_ns_json` = its `name_servers`; check now | `failing` |
| `suspended` | Check | The new ownership TXT is seen on both resolvers in two consecutive cycles | `expected_ns_json` and `rdap_fingerprint` re-recorded, `ownership_verified_at = now` | `verifying` |
| any except `removing`, `removed` | `DELETE …/domains/{id}` | Not the platform domain (`403 scope_denied`); no `active` or `retiring` address on the domain (else `409 domain_in_use`) | Store the `pending` addresses' `(zone_id, routing_rule_id)` pairs in the job's `params_json`, then delete those addresses; create a `domain_remove` job (`reason: requested`) | `removing` |
| `removing` | Job completed | – | `domain.removed` with the job's `reason` (`requested`, `evicted` or `unverified_expired`) | `removed` |
| `removing` | Job `failed` (10 attempts on one step, [Domain removal](#domain-removal)) | – | Alert `domain_remove_failed:{domain_id}`; the job is restarted once a day, or at once by `DELETE` | `removing` |
| `removing` | `DELETE …/domains/{id}`, or the daily restart | The domain's `domain_remove` job is `failed` | A new `domain_remove` job with the same `reason`, resuming at the first step not `done` ([H12](../edge-cases.md)); `202` | `removing` |

Every transition updates `domains.state`, `state_reason` (the first issue code) and `state_changed_at` in
D1 and appends the event to the monitor's outbox in the object's transaction (the D1 update runs after
commit and is retried by the alarm until it succeeds). Address activation runs on each transition into
`healthy` or `degraded`.

**Reminders.** While a domain is `pending`, `verifying`, `degraded`, `failing` or `suspended`,
`domain.reminder` is emitted at 24 hours, 72 hours and 7 days in that state (`hours_in_state`), tracked in
`meta.reminders_sent_json` and reset on every state change. A `pending` zone created by `nameservers`
also gets a final reminder at day 21 ([Creating a zone](#creating-a-zone), step 6). A domain that has never
been verified also gets a reminder at day 12, two days before its unverified expiry.

**The platform domain's health ([H9](../edge-cases.md)).** The platform domain carries every system mail
and every fallback send, so its states are handled differently:

- It is **never suspended**: neither `failing` for 14 days nor an ownership change moves it to
  `suspended`. An agreed ownership-level outcome (only NS applies to it: it has no ownership TXT and no
  RDAP check) counts as `fail`. It has no re-prove by TXT: `POST …/reprove` on it (platform key) re-reads its
  zone from the Cloudflare API and re-records `expected_ns_json` when the zone is active in the account
  (without `PM_CF_API_TOKEN`: `422 cf_token_required`, and re-running `pmail setup`, whose upsert
  writes `expected_ns_json`, does the same).
- Entering `failing` raises the operator alert `platform_domain_failing` with severity **page**, not a
  ticket ([Observability](observability.md#53-alert-list)), and so do the issues `dns_unresolvable` and
  `dnssec_bogus` on it.
- While it is `failing`, sends from it fail with `domain_failing_no_fallback` as before
  ([Outbound › From address and fallback](outbound.md#from-address-and-fallback)); the Notifier keeps
  system mail and retries it ([Notifications § 7](notifications.md#7-when-system-mail-cannot-be-sent)).
- It can never be removed through the API (`DELETE` answers `403 scope_denied`).

**Health response.** `GET /v1/domains/{id}/health` returns the state, the reason, `since`, `issues`
(`code`, `record`, `fix`; the fix quotes the exact name and value from `records_json`), the last checks
per resolver, and `fallback_active`.

### Fallback behaviour

- `fallback_active = (state ∈ {failing, suspended} OR (transport = cloudflare AND sending AND
  delivery_events = manual)) AND policy.domain_fallback`, never for the platform domain. The service never
  sends as a domain whose authentication records are broken (`failing`) or whose ownership signals changed
  (`suspended`) (FR-DOM-5). A Cloudflare-transport domain without an event subscription would send with no
  bounce, complaint or suppression handling, so it uses the platform address until its subscription exists
  ([Kind `zone`](#kind-zone) step 7, [H17](../edge-cases.md)). A pause is not a fallback case: while the
  platform check reports `ses_sending_paused`
  ([Health checks per method](domain-connections.md#6-health-checks-per-method)), and while the domain or
  its tenant is sending-paused ([G12](../edge-cases.md)), queued sends are held, never moved to the shared
  platform domain, whose reputation every tenant shares
  ([Outbound › From address and fallback](outbound.md#from-address-and-fallback), [N10](../edge-cases.md)).
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
(`422 transport_unavailable` otherwise). It also needs the identity to be able to sign now (C21): the
handler calls `GetEmailIdentity` (a request-path caller of the SES token bucket) and requires
`VerifiedForSendingStatus = true` and `DkimAttributes.Status = SUCCESS`; otherwise
`422 transport_unavailable` with `details.reason = "ses_identity_not_verified"` and `details.dkim_status`,
and the transport does not change. The CNAMEs existing in DNS is not enough: SES may not have seen them
yet, and a switch to an unverified identity would make every send fail. A `cloudflare_zone`,
`nameservers` or `delegated_subdomain` domain gets all three during onboarding when SES is configured (the optional step of
[Kind `zone`](#kind-zone)), so `PATCH` to `ses` works for any such domain that has `ses_identity`. Only the methods that put the domain on Cloudflare
(`cloudflare_zone`, `nameservers`, `delegated_subdomain`) can switch; any other method, and the platform
domain, gets `422 transport_unavailable` with `details.reason = "method_not_supported"`. An `smtp_relay`
domain changes its relay with `PATCH` and `smtp` instead (tenant, partner or platform key with `domains:write`);
the new values are kept pending until a probe passes
([§5.3](domain-connections.md#53-proving-alignment-the-probe)). A transport change updates `domains.transport`,
writes an `audit_log` row (`domain.transport`), and asks the monitor for a check at once, because DKIM
alignment differs per transport. The outbound consumer reads the transport at transport time, so queued
mail moves with it.

### Domain removal

The `domain_remove` job (`JobRunner`, steps journaled in `steps`) undoes onboarding. It acts only on the
objects in the domain's [`provider_objects_json`](#provider-objects) (and its `event_subscription_id`,
its address rows and the rule IDs in the job's `params_json`), never on an object found by name, so it
cannot delete an object this deployment did not create for this tenant (FR-DOM-13). Objects recorded with
`created: false` are left in place. Each step is idempotent:

1. `delete_rules`: delete every literal rule of the domain's addresses, including retired ones and the
   `pending` addresses whose pairs `DELETE` stored in `params_json`
   (`DELETE /zones/{zone_id}/email/routing/rules/{rule_id}`).
2. `disable_catch_all` (apex, when `catch_all` is recorded): `PUT …/rules/catch_all` with
   `"enabled": false`.
3. `disable_routing` (when `routing.created` is `true`). `DELETE /zones/{zone_id}/email/routing/dns` takes
   only the zone ID and disables Email Routing for the **whole zone** ("Disable your Email Routing zone.
   Also removes additional MX records previously required for Email Routing to work", API reference read
   2026-10-10), so it is never used for one name while other mail domains still route in the zone
   ([H11](../edge-cases.md)):
   - **The zone's last routing domain, at its apex**: when this domain is the zone apex and no other
     non-`removed` domain of this deployment with `inbound = routing` remains in the zone (the platform
     domain counts), call the zone-wide `DELETE`.
   - **Every other case** (a subdomain, or an apex while other routing domains remain): remove this name's
     routing only. `PATCH /zones/{zone_id}/email/routing/dns` with `{ "name": "{domain}" }` ("Unlock MX
     records previously locked by Email Routing", API reference read 2026-10-10), then
     `DELETE /zones/{zone_id}/dns_records/{id}` for each ID in `routing.record_ids`. Email Routing stays on
     for the zone and for every other name in it. That the unlock covers a subdomain's records, and that
     deleting them stops routing for that name only and frees its place among the zone's 30 mail domains,
     is not documented; spike S9 verifies it. If S9 shows the subdomain stays configured, its routing is
     left with no rules (Cloudflare then refuses its mail at SMTP time) and `pmail doctor` lists it under
     `routing.leftover_subdomains` with the dashboard step (Email Routing › Settings › Subdomains).
   - A zone this deployment created (`zone.created`) skips this step: `delete_zone` removes everything.
4. `disable_sending` (when `sending.created`): `DELETE /zones/{zone_id}/email/sending/subdomains/{tag}`
   (this also removes its DNS records, which stay locked for as long as the sending domain exists: Email
   Service [locked DNS records](https://developers.cloudflare.com/email-service/configuration/domains/),
   read 2026-10-10; routing still active elsewhere is unaffected). First, Cloudflare's suppressions scoped to
   this sending domain, which hold clear recipient addresses, are deleted: every page of
   `GET /accounts/{account_id}/email/sending/suppressions?scope_type=sending_domain&scope_value={domain}`,
   then `DELETE …/suppressions/{suppression_id}` for each entry that is not `read_only` (Cloudflare's own
   `policy` entries cannot be deleted; [Manage suppressions](https://developers.cloudflare.com/email-service/configuration/suppressions/),
   read 2026-10-10). Our hashed `suppressions` rows are unaffected ([Privacy § 2](privacy.md#2-data-inventory),
   [I12](../edge-cases.md)).
5. `delete_subscription`: delete the event subscription by `event_subscription_id`.
6. `delete_ses_identity` (when `ses_identity.created`): `DELETE /v2/email/identities/{domain}`; then
   `DELETE /zones/{zone_id}/dns_records/{id}` for each of `ses_identity.dkim_record_ids`.
7. `prune_retired_rules` (`inbound = ses`): ask `SesControl` to remove the domain's retired addresses from
   their `pm-retired-{n}` rules ([Domains on any DNS host § 4.6](domain-connections.md#46-retired-and-unknown-recipients),
   the single writer of those rules) and wait until it has cleared `addresses.ses_bounce_rule` for them.
   With the SES identity gone, SES no longer accepts mail for the domain, so the rule entries only use
   capacity.
8. `delete_ownership_record` (zone, delegated): `DELETE /zones/{zone_id}/dns_records/{id}` for the
   ownership TXT in `dns_records`.
9. `delete_zone` (when `zone.created`): `DELETE /zones/{zone_id}`, only when `zone_claims` holds that zone
   ID for this domain's tenant and this domain; then delete the `zone_claims` row. A zone found through
   `cloudflare_zone` belongs to the account owner and is never deleted.
10. `finish`: `UPDATE domains SET state = 'removed', smtp_sealed = NULL, smtp_pending_sealed = NULL,
    updated_at = ?`; send `DomainRequest::Retire` to the domain's monitor, which deletes its alarms and
    all its storage (`deleteAlarm`, then `deleteAll`), writes only `meta.retired`, and from then on answers
    every request with `Retired` before any owner check (so a late call never raises
    `rpc_owner_mismatch`);
    emit `domain.removed` with the job's `reason`. The row keeps its `monitor_do_id`, so an old monitor ID
    is never reused for a new row ([Adding a domain](#adding-a-domain)).

**Absence is read back, not inferred (C10).** Cloudflare's API reference documents no error code for an
object or zone that no longer exists (searched 2026-10-10), so a Cloudflare `404`, or another `4xx`
except `429`, is never counted as done by its code. The step reads the object back instead (the rule, the
sending domain or the record by ID or by listing): absent is done; present means the delete failed and is
retried. The same `4xx` on any zone-bound step also lists the account's zones by name
(`GET /zones?name={zone_name}&account.id={account_id}`): no zone of that name, or one with another ID,
means **the zone is gone** (deleted, or moved out of the account), and every remaining zone-bound step
(1–4, the CNAME part of 6, 8 and 9) is marked done with `skipped: zone_gone`; steps 5, the SES part of 6,
7 and 10 still run. For SES, `NotFoundException` is the documented not-found error (SES v2 API reference,
read 2026-10-10) and counts as done.

**Retries and restart (C3).** The job uses the JobRunner's one policy
([Privacy § 4](privacy.md#4-jobrunner)): a failed step retries after 30 s, doubling up to 1 hour, and
after 10 failed attempts on one step the job is `failed`. The domain stays `removing`, nothing sends from
it, and the alert `domain_remove_failed:{domain_id}` (ticket) fires. A failed job is restarted mechanically:
the `*/15` cron, once per UTC day (the run whose UTC hour is 04 and minute below 15), starts a new
`domain_remove` job for every `removing` domain whose last job is `failed`, resuming at the first step
not `done`; `DELETE /v1/domains/{domain_id}` on such a domain does the same at once and answers `202`.
Tenant erasure's `remove_domains` runs the same steps inline, under the erasure job's own retries
([Privacy § 6.6](privacy.md#66-tenant-scope)).

Retired address rows stay, attached to the `removed` row of their own tenant, so their addresses are
never reassigned.

### Cleanup after a failed add

A request that fails after creating provider objects leaves its `domain_onboarding` row
([Adding a domain](#adding-a-domain)) and, for `nameservers` and `delegated_subdomain`, its pending
`zone_claims` row. A retry of the same add reuses them. The `*/15` cron, in the run whose minute is below
15 (`crons/domain_cleanup.rs`), takes the journal rows not updated for an hour and, for each, undoes
exactly the objects in its `objects_json` with the removal steps above (the SES calls as a background
caller of the token bucket), then deletes the journal row and its pending claim in one D1 batch
([H16](../edge-cases.md)). A pending claim with no zone ID whose zone may exist (a lost `POST /zones`
response) is not deleted by name: `pmail doctor` lists a zone of that name created after the claim under
`domains.orphans`, with the dashboard step to delete it.

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

**Zones, not the account.** The Worker's token lists the zones it may touch by name ("specific zone" in
the token's zone resources, [Create a token via the API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/),
read 2026-10-10): the platform domain's zone and every zone that tenants may use with `cloudflare_zone`
(each zone that some tenant's `domains.cloudflare_zones` lists). The operator adds a zone to the token
before listing it in a tenant's policy. Only a deployment that offers `nameservers` or
`delegated_subdomain` needs **All zones** of the account for its zone permissions, because those methods
create zones that no list can name in advance; Cloudflare does not state whether a zone-scoped grant can
create a zone (verify at build time), and the Worker answers a refused create with
`422 transport_unavailable` (`zone_creation_not_allowed`). On Pylota Mail Cloud, which runs in Pylota's
existing Cloudflare account, `domains.allow_create_zone` is off and the token lists two zones only,
`pylotamail.com` and `pylota.io` (for Pylota's `notify.` and `reminders.` subdomains)
([ADR 0010](../adr/0010-cloud-in-the-existing-cloudflare-account.md)).

What the Worker does with each permission marked for it in that table, and which methods need it:

| Permission (dashboard name) | Scope | Needed by | The Worker uses it for |
|---|---|---|---|
| Zone · Read | The listed zones | `cloudflare_zone`; with All zones, `nameservers` and `delegated_subdomain` | Finding zones ([Kind `zone`](#kind-zone) step 1), reading a new zone's status ([Creating a zone](#creating-a-zone)), and the zone-gone check of [removal](#domain-removal) |
| Zone · Edit | All zones | `nameservers`, `delegated_subdomain` only | Creating a zone, and deleting it on [removal](#domain-removal) (`delete_zone`, only for a zone in `zone_claims`) |
| Zone Settings · Edit | The listed zones | `cloudflare_zone` (and the zone-creating methods) | Enabling routing, setting sub-addressing and reading the routing DNS records (steps 5 and 8); unlocking a name's routing records and the zone-wide disable of `disable_routing` on removal |
| Email Routing Rules · Edit | The listed zones | as above | The catch-all rule on an apex and the literal rules per address on a subdomain ([Routing an address](#routing-an-address)) |
| DNS · Edit | The listed zones | as above | The ownership TXT, MX removal for `replace_mx` (steps 2 and 4), the SES DKIM CNAMEs of the failover identity (step 6), and deleting the recorded routing records on removal |
| Email Sending · Edit | The account | as above | Sending onboarding and its DNS records (step 6) and the suppression list (G4). It is named in the Email Service docs but not on the permissions page; its scope is verified at build time |
| Queues · Edit | The account | as above, when sending | Listing queues and creating a domain's event subscription to `pm-delivery-events` (step 7). Cloudflare documents no narrower scope for event subscriptions (verify at build time) |
| Vectorize · Edit, Workers AI · Read and Edit | The account | Only if spike S6 fails | The REST fallbacks |

**What scoping does not stop.** A Worker bug, or a stolen `PM_CF_API_TOKEN`, can still change DNS and mail
settings in every listed zone, including an operator zone listed for one tenant's subdomains (on Cloud,
`pylota.io`), and can edit the account's queues and Email Sending settings. The design limits what its own
code does there: the [zone permission](#zone-permission) checks (H8) keep tenants to their grants, a listed
zone's apex stays platform-only, and removal and cleanup delete only the provider IDs this deployment
recorded for the domain ([Provider objects](#provider-objects)). Email Sending's daily quota is per
account (Cloudflare does not tell the Worker its value), so on an account shared with other senders the
quota is shared too; `PM_DAILY_SEND_QUOTA` and the `provider_quota` alerts watch it
([G3](../edge-cases.md)).

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
| `it::intents::j21_init_retried` | With the `do.call` fault armed for the first `Init`, `POST /v1/tenants` and `POST …/identities` still answer `201`; a call to the new `TenantQuota` or mailbox in the meantime gets `503 unavailable`; one every-minute cron run initialises both, deletes the two `rpc_intents` rows and emits exactly one `identity.created`; a second run sends nothing ([J21](../edge-cases.md), [Design conventions § 9](index.md#9-durable-object-calls-after-a-d1-change)) |
| `it::intents::j21_identity_event_retried` | With the `do.call` fault armed, an identity `PATCH`, a pause, a resume and a tenant suspension commit and answer as usual; cron runs then emit each `identity.updated`, `identity.paused` and `identity.resumed` exactly once, with the event ID derived from its intent, in `occurred_at` order per identity; a duplicate re-send leaves one outbox row; an intent for an erased mailbox is deleted ([J21](../edge-cases.md)) |
| `it::identities::deleting_and_deleted_routes` | On a `deleting` and on a `deleted` identity: `GET` returns it with its status; `PATCH` gets `404 identity_not_found` and changes nothing; a second `DELETE` returns `200` with the same `era_` ID and starts no job; the hold routes still work on the `deleting` one (FR-IDN-4) |
| `it::identities::a5_tombstone_blocks_reuse` | A deleted identity's address cannot be created by any tenant ([A5](../edge-cases.md)) |
| `it::identities::a13_delete_then_reply_rejected` | After delete, mail to its addresses gets `550 5.1.1` ([A13](../edge-cases.md), FR-IDN-4) |
| `it::addresses::a11_newer_pending_replaces` | A second pending address on a domain replaces the first ([A11](../edge-cases.md)) |
| `it::addresses::promote_retire_rollback` | Promote, retire after grace, rollback by promoting the retiring address, events emitted (FR-ADR-2–4) |
| `it::addresses::a14_platform_address_kept` | Promoting away keeps the platform address `active`; retiring or deleting it is refused with `409 address_in_use`; promoting it again rolls back: it is `primary` and the custom address is an `active` alias with `retire_at = NULL` ([A14](../edge-cases.md), FR-ADR-2, FR-DOM-6) |
| `core::address::a4_role_names_by_domain` | `support`, `sales`, `info`, `marketing` are refused on the platform domain and allowed on a tenant domain; `postmaster` and `abuse` are refused on both ([A4](../edge-cases.md), FR-ADR-6) |
| `it::domains::transport_patch` | With SES configured, a `cloudflare_zone` domain is onboarded with `ses_identity`, `ses_region` and its three DKIM CNAMEs (created through the Cloudflare API fake, `required: false`); while it sends through Cloudflare, a missing CNAME or a `FAILED` SES DKIM status changes no state; a platform key switches it to `ses` and back; a tenant key gets `403 scope_denied`; a domain without an SES identity gives `422 transport_unavailable`; with the SES fake reporting `VerifiedForSendingStatus = false` or DKIM `PENDING` while all three CNAMEs resolve, the switch gets `422 transport_unavailable` (`ses_identity_not_verified`) and the transport is unchanged ([J5](../edge-cases.md)) |
| `it::domains::remove_deletes_ses_identity` | Removing a `cloudflare_zone` domain that onboarding gave a failover SES identity runs `delete_ses_identity`: the SES fake no longer has the identity and the Cloudflare DNS fake no longer has its three DKIM CNAMEs; an SES `NotFoundException` counts as done; a Cloudflare `404` counts as done only when the read-back no longer finds the record, and is retried while it does; an identity whose tags name another domain is never deleted; tenant erasure's `remove_domains` does the same for every such domain of the tenant ([Domain removal](#domain-removal), [Privacy §6.6](privacy.md#66-tenant-scope)) |
| `it::addresses::retirement_cron` | `retire_at` reached → `retired`, `identity.address_retired`, inbound `550 5.1.6` (FR-ADR-3) |
| `it::addresses::c3_reply_from_retiring` | Replies from the retiring address the counterparty used ([C3](../edge-cases.md)) |
| `it::domains::h1_failing_fallback` | DNS fake removes DKIM; after two agreeing checks `failing`; sends fall back with thread continuity; restore → `recovered`; pinned threads stay ([H1](../edge-cases.md), FR-DOM-5, FR-DOM-6) |
| `core::dns::h2_spf_lookup_count` | Lookup and void-lookup counting; preflight refusal ([H2](../edge-cases.md)) |
| `core::dns::h3_strict_alignment` | `adkim=s`/`aspf=s` against Cloudflare and SES signing domains ([H3](../edge-cases.md)) |
| `it::domains::h4_ownership_change` | NS move, ownership TXT removed, RDAP change → `suspended`; reprove → `verifying` ([H4](../edge-cases.md)). A `cloudflare_zone` domain has `expected_ns_json` from its zone at insert; a weekly NS mismatch is re-queried on the confirming check 5 minutes later and suspends after two agreeing cycles; one RDAP change is not an issue until a second query an hour later confirms it, after which it is in every check's outcome until reprove |
| `it::domains::h5_existing_mx` | Apex with existing MX refused without `replace_mx` ([H5](../edge-cases.md)) |
| `it::domains::h8_zone_permission` | With the Cloudflare fake holding a zone claimed by tenant B, a zone listed in tenant A's `domains.cloudflare_zones`, an unlisted zone, and the zone of `PM_PLATFORM_DOMAIN`: a tenant key and a partner key of tenant A get `403 scope_denied` (`zone_not_allowed`, the same body for an existing and a missing zone) for `cloudflare_zone` on B's zone (also when A's policy lists it, and for a name under a listed parent zone that resolves to B's zone), on the unlisted zone, and with `replace_mx` on any of them, and for `nameservers` or `delegated_subdomain` under the platform zone or B's zone; nothing is written and no MX record is deleted; the listed zone and a zone created for A by `nameservers` are accepted; the `zone_claims` row is written with the domain and deleted by `delete_zone` and by `zone_expired`; a platform key may use every zone; a partner key cannot set `domains.cloudflare_zones` (`403 scope_denied`); with `domains.cloudflare_zones: ["pylota.io"]` listed, a tenant key adds `notify.pylota.io`, but adding the `pylota.io` apex, or `replace_mx` there, gets `403 scope_denied` (`zone_not_allowed`) ([H8](../edge-cases.md)) |
| `it::domains::h6_rule_failure` | Literal rule creation fails → address stays `pending` with `routing_rule_failed`, retried, activated only with its rule ([H6](../edge-cases.md)) |
| `core::domain_fsm::h7_resolver_disagreement` | One resolver erroring or disagreeing never changes state; two consecutive agreeing cycles do ([H7](../edge-cases.md), FR-DOM-4) |
| `it::domains::h7_dns_unresolvable` | With the DoH fake answering `SERVFAIL` on both resolvers: no change for 6 hours (fake clock); then the names that answer with `cd=1` give `dnssec_bogus` and those that do not give `dns_unresolvable`, both resolvers agree on `fail`, and two cycles later the domain is `failing` and sends fall back. A `nameservers` domain whose parent publishes a DS record shows `ds_record_present` while `pending`, cleared once the DS record is gone ([H7](../edge-cases.md)) |
| `core::domain_fsm::transition_table` | Every row of the state machine table, including 14 days in `failing`, the 14-day unverified expiry, eviction, the platform domain's rows (never `suspended`) and reminders at 24 h, 72 h, 7 days and day 12 |
| `it::domains::h9_platform_domain_failing` | With the DNS fake removing the platform domain's sending DKIM: two agreeing cycles make it `failing`, the `platform_domain_failing` alert is raised with severity page, and 14 days later (fake clock) it is still `failing`, not `suspended`; an NS change counts as `fail`, never `suspended`; `POST …/reprove` with a platform key re-records `expected_ns_json` from the zone fake, and two passing cycles recover it; `DELETE` on it is `403 scope_denied` ([H9](../edge-cases.md)) |
| `it::domains::h10_no_adoption` | Against the Cloudflare and SES fakes: `nameservers` and `delegated_subdomain` for a name that is already a zone in the account (an operator zone, and one whose create answers the "already exists" error) get the uniform `409 domain_exists` and write no `zone_claims` row, delete no MX record and point no catch-all at the Worker; a retry by the tenant whose pending claim holds the zone continues; a tenant key's `cloudflare_zone` add on a name that already has an Email Sending domain, routing MX records, a foreign catch-all or an SES identity tagged for another deployment gets the same `409`; a platform key's add uses the existing sending domain and records it with `created: false`, and its removal leaves it in place ([H10](../edge-cases.md), FR-DOM-13) |
| `it::domains::h11_remove_keeps_zone_routing` | A zone with an apex domain and two subdomain domains: removing one subdomain unlocks and deletes only that name's recorded routing records and never calls the zone-wide `DELETE …/email/routing/dns`; mail to the apex and the other subdomain still reaches the Worker; removing the apex while a subdomain remains also stays per name; removing the last routing domain, at the apex, calls the zone-wide disable once. A zone deleted out of band (the fake's zone list no longer has it) marks every zone-bound step `skipped: zone_gone` and the job completes ([H11](../edge-cases.md)) |
| `it::domains::h12_remove_failed_restart` | A Cloudflare fake failing `disable_sending` 10 times: the job is `failed` after the JobRunner backoff, the domain stays `removing`, `domain_remove_failed` fires; the daily `*/15` run restarts it and, once the fake recovers, it resumes at `disable_sending` (earlier steps are not re-run) and the domain is `removed`; `DELETE` on the `removing` domain with a failed job answers `202` and restarts it at once ([H12](../edge-cases.md)) |
| `it::domains::h13_readd_new_row` | Tenant A's domain removed with a retired address; tenant B adds the same name: a new row ID and a new `monitor_do_id`; the old monitor answers `Retired` and has no alarm; A's retired address still belongs to A's `removed` row and cannot be created by B (`409 address_taken`); A's tenant erasure and B's domain both work. A platform key removing a zone from A's `domains.cloudflare_zones` while A has a domain in it gets `409 domain_in_use` (`zone_has_domains`, `details.domain_ids`) ([H13](../edge-cases.md)) |
| `it::domains::h14_unverified_claims` | Tenant A adds `victim.example` and never verifies; tenant B's add gets `409 domain_exists` whose body equals the one for a verified holder and for a missing zone except for B's claim token; with B's `pm-claim` TXT on both resolvers and `claim: true`, A's domain moves to `removing` (`evicted`), B gets `409 domain_claim_pending`, then `201` once removal finishes, and A receives `domain.removed` with `reason: evicted`; a verified holder is never evicted; an unverified domain is removed 14 days after creation (`unverified_expired`) with a reminder on day 12; a tenant key's 6th unverified domain gets `422 unverified_domain_limit` ([H14](../edge-cases.md), FR-DOM-14) |
| `it::domains::h15_zone_domain_limit` | A zone fake with 30 mail domains: a `cloudflare_zone` add in it gets `422 zone_domain_limit` (`details.limit = 30`) before any create; a fake that refuses the sending create with an unknown error while the count is 30 also gives `422 zone_domain_limit`, not `502` ([H15](../edge-cases.md)) |
| `it::domains::h16_failed_add_cleanup` | An add whose event-subscription step fails after the sending domain, the ownership TXT and the failover SES identity were created: no domain row; an hour later (fake clock) the cleanup run deletes exactly those three objects and the journal row; a `nameservers` add that failed after its pending claim deletes the claim; the SES identity count used by `ses_identities_90pct` included the journal's identity while it existed ([H16](../edge-cases.md)) |
| `it::domains::h17_manual_events_fallback` | A `cloudflare_zone` domain created with `delivery_events: "manual"` (the S9 fallback): sends from it leave from the identity's platform address with `sent_via_fallback`, `delivery_events_manual` fires; once `pmail domains subscribe` records the subscription, the next new thread sends from the domain and the alert resolves ([H17](../edge-cases.md)) |
| `it::send::g7_domain_states` | Retiring, pending and failing domain behaviour at send time ([G7](../edge-cases.md)) |
| `it::domains::onboarding_idempotent` | Adding a `cloudflare_zone` domain (apex and subdomain) succeeds, and re-running a failed add against the recorded Cloudflare API fake creates nothing twice (FR-DOM-2, FR-DOM-3, FR-OPS-1; build plan M13) |
| `it::domains::onboarding_idempotent_created_zones` | The same for `nameservers` and `delegated_subdomain`: a failed add, and onboarding steps 2–8 run by the monitor once the zone is active, re-run without creating anything twice. In the monitor, a `503` from the sending create leaves the domain `pending` with `onboarding_failed` (`details.step`) and the next check finishes it; an SPF preflight refusal leaves it `pending` with `spf_lookup_limit` until the DNS fake's SPF is fixed; it reaches `verifying` only after every step (build plan M23) |
| `it::domains::records_from_api` | Records in responses equal the fake provider's API answers, never templates (FR-DOM-3) |
| `it::domains::s9_manual_delivery_events` | With the Cloudflare fake answering `403` to the subscription create, a `cloudflare_zone` domain is created with `event_subscription_id = NULL`, `delivery_events: "manual"` and `details.action = "run pmail domains subscribe {domain}"`; a `503` answer fails the create with `502 upstream_error`; once the subscription ID is recorded, `delivery_events` is `active` and a delivery event updates the recipient (spike S9 fallback, FR-DOM-3; build plan M13) |
| `it::domains::s9_manual_delivery_events_nameservers` | The same fallback for a `nameservers` domain, whose step 7 runs in the monitor once the zone is active: the `403` leaves `delivery_events: "manual"` with the same `details.action` (build plan M23) |
| `it::domains::cron_mints_missing_monitor` | A row with `monitor_do_id = ''` (platform, or inserted by `pmail domains add --local-token`) gets one `DomainMonitor`, `Init`, and `domain.created` when it has a `tenant_id`; two overlapping cron runs mint one ID |
| `it::domains::cf_token_required_by_method` | Without `PM_CF_API_TOKEN`: adding a `cloudflare_zone` domain, and creating an address that needs a literal rule, → `422 cf_token_required` (build plan M13) |
| `it::domains::cf_token_required_other_methods` | Without `PM_CF_API_TOKEN`: `nameservers` and `delegated_subdomain` → `422 cf_token_required`; `dns_records`, `send_only` and `smtp_relay` are unaffected (build plan M23) |
