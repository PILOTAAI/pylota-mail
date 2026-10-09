# REST API

The machine-readable contract is [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1). A running deployment also
serves it at `/openapi.json`, generated from the Rust types. This page is the readable version. If the
two ever disagree, the OpenAPI file is the contract and this page has a bug.

## Basics

| | |
|---|---|
| Base URL | `https://<your-api-host>/v1`, for example `https://mail.example.com/v1` |
| Auth | `Authorization: Bearer pmk_live_…` (or `pmk_test_…`) |
| Format | JSON (`application/json; charset=utf-8`). Times are RFC 3339 UTC. Sizes are bytes |
| Request ID | Every response carries a `Request-Id` header (`req_…`), also echoed in errors |
| Versioning | Breaking changes get a new prefix (`/v2`). Additive changes (new fields, new event types, new enum values) can happen within `/v1`, so clients must ignore unknown fields and handle unknown enum values |

### Pagination

List endpoints take `limit` (default 25, max 100) and `cursor`. They return:

```json
{ "data": [ ... ], "next_cursor": "c_01J9..." }
```

`next_cursor` is `null` on the last page. Cursors are opaque and expire after 24 hours.

### Idempotency

- **Required** on `POST …/messages`, `…/reply`, `…/reply-all` and `…/forward`. A missing key returns
  `400 idempotency_key_required`. The one exception is a dry run (`?dry_run=true`), where the key is
  optional and never recorded ([Sending](#sending)).
- **Optional** on every other `POST`.
- The header is `Idempotency-Key: <1–255 printable ASCII characters>`. Keys are kept for 30 days, scoped
  per identity for mail and per tenant for everything else.
- The same key with the same request returns the original response, with `"deduplicated": true` in
  mail responses and the header `Idempotent-Replayed: true`.
- The same key with a different request returns `409 idempotency_conflict`.
- The same key while the first request is still running returns `409 request_in_progress` with
  `retryable: true`.

See [Sending and safe retries](../guides/sending.md#safe-retries).

### Rate limits

| Bucket | Default | Scope |
|---|---|---|
| All requests | 600 per minute | per API key |
| Search (`keyword`, `semantic`, `hybrid`) | 120 per minute | per API key |
| Agentic search | 20 per minute | per API key, plus a daily tenant cap |
| Send (accepted into queue) | 120 per minute | per identity, plus daily caps from policy |

Responses include `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. A `429` includes
`Retry-After` (seconds) and `error.code = rate_limited`.

### Permissions

A key holds a list of permissions. Every endpoint below names the one it needs.

| Permission | Allows |
|---|---|
| `tenants:manage` | Create, update and suspend tenants (platform keys only) |
| `identities:read`, `identities:write` | Read, and create, update, pause or delete identities and addresses, and test forwarding |
| `domains:read`, `domains:write` | Read, and add, update, verify, probe or remove domains |
| `messages:read` | Threads, messages, raw MIME, deliveries |
| `messages:send` | Send, reply, reply-all, forward, cancel |
| `messages:write` | Labels, read state, re-run triage, resolve uncertain sends |
| `attachments:read` | Attachment bytes and extracted text |
| `search:read` | Keyword, semantic, hybrid search, contacts, related, wait |
| `search:agentic` | Agentic search |
| `quarantine:review` | See and release quarantined mail |
| `webhooks:read` | Read webhook endpoints and their deliveries |
| `webhooks:manage` | Create, change, test, rotate and delete webhook endpoints, and replay. Includes `webhooks:read` |
| `keys:manage` | API keys within the caller's scope |
| `erasure:manage` | Erasure requests, legal holds, exports |
| `suppressions:manage` | Suppressions and allow or block lists |
| `usage:read` | Plan, allowances and usage figures (also granted implicitly to every key for its own workspace's `GET /v1/usage`) |
| `audit:read` | Audit log |
| `members:manage` | Console members and invitations (tenant and platform keys) |
| `platform:ops` | Platform operations: signing-key rotation, the dead-letter queue, maintenance jobs, waitlist invitations (platform keys only) |

Key levels limit which resources a key can reach, whatever its permissions:

- A **platform** key reaches every tenant.
- A **tenant** key reaches its own tenant.
- An **identity** key reaches its own identity. It also reaches the tenant's domains read-only with
  `domains:read`, and the tenant's webhook endpoints and deliveries read-only with `webhooks:read`.

A route or field that needs a higher key level than the caller's returns `403 scope_denied`.

### The console and billing routes

These routes are served by the same Worker but are not part of the developer API. None takes an API key:
they use session cookies, OAuth state, or Stripe, SNS and link signatures instead.

| Route | What it is | In `openapi.yaml` | Design |
|---|---|---|---|
| `/console/*`: the server-rendered console, including `/console/sign-in…` (link and code), `/console/sign-up`, `/console/waitlist`, `/console/workspaces/new`, `/console/oauth/{provider}/start`, `/console/oauth/{provider}/callback`, `/console/settings/security`, `/console/plan/return` and `/console/connect` | Console pages, sign-up and sign-in (session cookies) | No | [Console design](../project/design/console.md), [Cloud sign-up and sign-in](../project/design/cloud-signup.md) |
| `/billing/stripe/webhook` | Stripe events (Stripe signature) | No | [Billing design](../project/design/billing.md) |
| `POST /hooks/ses`, `POST /hooks/ses/inbound` | Amazon SES delivery events and inbound mail, through SNS (SNS signature) | Yes | [Signed links and provider hooks](#signed-links-and-provider-hooks) |
| `GET /v1/links/{token}` | Signed downloads (link signature) | Yes | [Signed links and provider hooks](#get-v1linkstoken) |

**Two hosts.** `PM_CONSOLE_HOST` names the console's host and defaults to `PM_API_HOST`, so a deployment
can keep one hostname. When the two differ, console paths answer only on `PM_CONSOLE_HOST`, and API paths
(REST, MCP, `/hooks/*`, `/billing/stripe/webhook`, `/health`, `/v1/links/*`) only on `PM_API_HOST`; anything else returns `404`. No
cookie is set or read on the API host ([Cloud sign-up › Hostnames](../project/design/cloud-signup.md#2-hostnames)).

### Errors

Every error looks like this:

```json
{
  "error": {
    "code": "idempotency_conflict",
    "message": "This Idempotency-Key was used with a different request body.",
    "retryable": false,
    "fix": "Use a new Idempotency-Key for a different message, or resend the original body.",
    "request_id": "req_01J9Z4…",
    "details": { "original_message_id": "msg_01J9Z3…" }
  }
}
```

The code catalogue is in [Errors](errors.md).

---

## Meta

### `GET /health`

No auth. Returns `{ "status": "ok", "version": "1.0.0", "commit": "abc1234", "env": "production" }`.
`env` is `PM_ENV`. With an invalid configuration it returns `503 unavailable`.

### `GET /openapi.json`

No auth. The OpenAPI 3.1 document for this deployment.

### `GET /v1/me`

Any key. Describes the calling key.

```json
{
  "key_id": "key_01J9…", "name": "pylota-api", "level": "tenant", "mode": "live",
  "tenant_id": "ten_01J9…", "identity_id": null,
  "permissions": ["identities:read", "messages:send", "search:read"],
  "expires_at": null
}
```

---

## Tenants

Platform keys with `tenants:manage`. A tenant key can `GET` its own tenant.

### `POST /v1/tenants`

```json
{
  "slug": "acme",
  "name": "Acme Car Hire",
  "mode": "live",
  "timezone": "Europe/London",
  "address_suffix": ".acme",
  "policy": { "identity_daily_send_cap": 500 },
  "owner": { "email": "sam@acmecarhire.example", "name": "Sam Patel" },
  "billing": { "mode": "exempt" }
}
```

- `address_suffix` defaults to `"." + slug`. Only one tenant (the default tenant made by `pmail setup`)
  can have an empty suffix.
- `policy` is merged over the defaults. See [Configuration › Tenant policy](configuration.md#tenant-policy).
- `owner` (optional) creates the workspace's console owner and emails them a sign-in link. Without it, a
  platform key can add an owner later with an invitation and an ownership transfer in the console.
- `billing.mode` defaults to `metered` on a deployment with billing on (plan `free`) and to `disabled`
  otherwise.

Returns `201` with a [Tenant](#tenant-object).

### `GET /v1/tenants` · `GET /v1/tenants/{tenant_id}`

List (filters: `status`, `mode`) and get.

### `PATCH /v1/tenants/{tenant_id}`

Updatable: `name`, `timezone`, `policy` (deep merge; `null` resets a field to its default), and `status`
(`active` | `suspended`). Suspension behaviour: FR-TEN-3.

#### Tenant object

```json
{
  "id": "ten_01J9…", "slug": "acme", "name": "Acme Car Hire", "mode": "live", "status": "active",
  "address_suffix": ".acme", "timezone": "Europe/London",
  "policy": { "...": "full effective policy" },
  "created_at": "2026-10-09T10:00:00Z", "updated_at": "2026-10-09T10:00:00Z"
}
```

Tenants are deleted through an erasure request with `scope: "tenant"`.

---

## Identities

### `POST /v1/tenants/{tenant_id}/identities` — `identities:write`

```json
{
  "username": "bookings",
  "display_name": "Acme Car Hire",
  "purpose": "bookings",
  "owner": { "name": "Sam Patel", "email": "sam@acmecarhire.example" },
  "signature": { "text": "Acme Car Hire · 0113 496 0000" },
  "domain_id": "dom_01J9…",
  "client_id": "acme:bookings",
  "metadata": { "operator_id": "op_123" }
}
```

- `username`: `^[a-z0-9][a-z0-9._-]{0,23}$`. Reserved and confusable names are refused (`address_reserved`).
  `postmaster`, `abuse`, `noreply` and similar are reserved everywhere; the other RFC 2142 role names
  (`support`, `sales`, `info`, `marketing` and the rest) only where they would stand alone on the shared
  platform domain, that is, for the default tenant, whose suffix is empty
  ([Identities and domains](../project/design/identity-domains.md#username-validation)).
- The primary address is `{username}{tenant.address_suffix}@{platform domain}`, or
  `{username}@{domain}` when `domain_id` names a healthy tenant domain. The full local part must be at
  most 64 characters with room for a thread token: the combined username and suffix can be at most 40.
- `client_id` makes the create idempotent: the same `client_id` with the same body returns `200` and
  the existing identity, and with a different body returns `409 client_id_conflict`.
- `owner` is required before the identity can send (`identity_owner_required`).
- When the plan's `inboxes` allowance is spent, the request fails with `402 billing_limit`
  (`details.feature: "inboxes"`). A primary address that needs a literal routing rule while
  `PM_CF_API_TOKEN` is not set fails with `422 cf_token_required`.

Returns `201` with an [Identity](#identity-object).

### `GET /v1/tenants/{tenant_id}/identities` — `identities:read`

Filters: `status`, `purpose`, `client_id`.

### `GET /v1/identities` — `identities:read`

Identities the key can reach. Platform keys can filter by `tenant_id`.

### `GET /v1/identities/lookup?address=bookings@acme.example.com` — `identities:read`

Resolves any active or retiring address to its identity. Returns `404 identity_not_found` for unknown,
retired or out-of-scope addresses.

### `GET /v1/identities/{identity_id}` — `identities:read`

### `PATCH /v1/identities/{identity_id}` — `identities:write`

Updatable: `display_name`, `purpose`, `owner`, `signature`, `metadata`, `send_policy`, and `status`
(`active` | `paused`). Setting `status: "active"` on an identity paused for `abuse_threshold` needs a
platform or tenant key and is audit-logged.

### `DELETE /v1/identities/{identity_id}` — `identities:write` and `erasure:manage`

Returns `202` with an [Erasure request](#erasure-request-object) of scope `identity`. The identity's
addresses are tombstoned and can never be assigned to another identity.

#### Identity object

```json
{
  "id": "idn_01J9Z3K8V4…", "tenant_id": "ten_01J9…",
  "username": "bookings", "display_name": "Acme Car Hire", "purpose": "bookings",
  "status": "active", "pause_reason": null,
  "primary_address": "bookings.acme@agents.example",
  "addresses": [ { "...": "Address objects" } ],
  "owner": { "name": "Sam Patel", "email": "sam@acmecarhire.example" },
  "signature": { "text": "…", "html": null },
  "send_policy": { "daily_cap": 500, "auto_reply": "allowed", "require_known_recipient": false },
  "metadata": { "operator_id": "op_123" },
  "client_id": "acme:bookings",
  "created_at": "…", "updated_at": "…"
}
```

---

## Addresses

### `GET /v1/identities/{identity_id}/addresses` — `identities:read`

### `POST /v1/identities/{identity_id}/addresses` — `identities:write`

```json
{ "local_part": "bookings", "domain_id": "dom_01JA…" }
```

Creates an `alias`. `local_part` follows the username rules for a tenant domain: role names such as
`support@` are allowed, `postmaster` and `abuse` are not. The status is `pending` until the domain is
healthy, then `active`. Only one pending
address per identity and domain is allowed; a newer request replaces an older pending one
([A11](../project/edge-cases.md)).

### `POST /v1/identities/{identity_id}/addresses/{address_id}/promote` — `identities:write`

```json
{ "retire_previous_after_days": 90 }
```

Makes the address `primary`. The previous primary becomes an `alias` with status `retiring`, and its
`retire_at` is set (default 90 days, range 0–365), with one exception: when the previous primary is the
identity's **platform address**, it becomes an `active` alias instead. The platform address is the
fallback address for domain failures (FR-DOM-6), so it is never retired. Promoting a `retiring` address
(or the platform address) back cancels the change: this is how you roll back. Fails with
`409 domain_not_ready` unless the domain is `healthy` or `degraded`. Emits `identity.address_promoted`.

### `POST /v1/identities/{identity_id}/addresses/{address_id}/retire` — `identities:write`

```json
{ "after_days": 0 }
```

Moves an alias to `retiring` (or straight to `retired` when `after_days` is 0). The primary cannot be
retired (`409 address_is_primary`), and neither can the identity's platform address
(`409 address_in_use`). Emits `identity.address_retired` when the address becomes `retired`.

### `DELETE /v1/identities/{identity_id}/addresses/{address_id}` — `identities:write`

Only for `pending` addresses that never received mail. Otherwise `409 address_in_use` (retire it
instead). The platform address can never be deleted.

### `POST /v1/identities/{identity_id}/addresses/{address_id}/test-forwarding` — `identities:write`

No body. For an address on a domain with `inbound: forward` (method `send_only`, or `smtp_relay` with
`inbound: forward`), where the customer's own mailbox forwards mail to the identity's platform address.
Any other address returns `422 transport_unavailable` with `details.reason: "method_not_supported"`.

It sends a short message to the address, from `mailer-daemon@{platform domain}` with the subject
"Pylota Mail forwarding check" and a one-time token. If the token reaches the identity's platform address
within 10 minutes, the address's `forwarding` becomes `ok`; otherwise `failed`
([N12](../project/edge-cases.md)). The check is never stored as a message and does not count as a plan
send. Returns `202` with the [Address](#address-object); read the address again for the result. No
webhook event is sent.

#### Address object

```json
{
  "id": "adr_01J9…", "identity_id": "idn_01J9…", "address": "bookings@brightwell.example",
  "local_part": "bookings", "domain_id": "dom_01JA…",
  "role": "primary", "status": "active",
  "retire_at": null, "retired_at": null,
  "forwarding": "ok", "forwarding_checked_at": "2026-10-09T10:20:00Z",
  "created_at": "…"
}
```

- `forwarding` is `null` when the address's domain does not use `inbound: forward`. Otherwise it is
  `unverified` (no forwarding test and no forwarded message has arrived yet), `ok` (the last test passed,
  or mail arrived through forwarding) or `failed` (the last test timed out).
- `forwarding_checked_at` is when `forwarding` last changed, or `null`.

---

## Domains

### `POST /v1/tenants/{tenant_id}/domains` — `domains:write`

```json
{ "name": "agents.brightwell.example", "method": "dns_records", "receiving": true, "sending": true, "replace_mx": false }
```

The **connection method** says what the customer changes at their DNS host. It fixes the domain's `kind`,
`inbound` (how mail reaches identities) and `transport` (how mail is sent) (FR-DOM-7). The full model is in
[Domains on any DNS host](../project/design/domain-connections.md#2-inbound-source-and-outbound-transport-are-separate-choices).

| `method` | The customer changes | `kind` | `inbound` | `transport` |
|---|---|---|---|---|
| `cloudflare_zone` | Nothing: the zone is in this Cloudflare account and the Worker writes the records | `zone` | `routing` | `cloudflare` |
| `nameservers` | Two NS records at the registrar, for a domain used only for mail | `zone` | `routing` | `cloudflare` |
| `dns_records` | One MX, three DKIM CNAMEs, a MAIL FROM MX and TXT, and the ownership TXT, at any DNS host | `external` | `ses` | `ses` |
| `send_only` | Three DKIM CNAMEs, a MAIL FROM MX and TXT, and the ownership TXT; their own mailbox forwards to the agent | `external` | `forward` | `ses` |
| `smtp_relay` | The ownership TXT, plus what their own mail provider already needs | `external` | `forward` or `ses` | `smtp` |
| `delegated_subdomain` | NS records for one subdomain, for example `agents.brightwell.example` | `delegated` | `routing` | `cloudflare` |

| Field | Applies to | Meaning |
|---|---|---|
| `name` | all | The domain, for example `agents.brightwell.example` |
| `method` | all | One of the six methods. Required for new clients. When it is absent, the old `kind` is mapped: `zone` → `cloudflare_zone`, `external` → `send_only`. `"kind": "zone"` with `"create_zone": true` is the old spelling of `nameservers` |
| `receiving`, `sending` | all | Default `true` |
| `replace_mx` | `cloudflare_zone` (apex), `dns_records` | Default `false`. A name that already has MX records, none of them the expected host, is refused with `409 existing_mx` unless this is `true` ([H5](../project/edge-cases.md)). On a zone apex, enabling routing replaces the existing mail provider. On `dns_records` it means "I will replace these": health reports `mx_unexpected` until the old records are gone |
| `confirm_dedicated` | `nameservers` | Default `false`. Confirms that a website or mail on the name may stop (below) |
| `inbound` | `smtp_relay` (required) | `forward` (the customer's mailbox forwards) or `ses` (they also publish the SES MX and DKIM records) |
| `smtp` | `smtp_relay` (required) | `host` (a DNS name, not an IP literal), `port` (`465` or `587`), `username`, `password` and `probe_from` (an address the relay accepts as sender; default `postmaster@{name}`). The credentials are sealed under `PM_MASTER_KEY` and never returned, logged or exported |

What each method checks before the domain is created:

- **`cloudflare_zone`, `nameservers` and `delegated_subdomain`** need `PM_CF_API_TOKEN` on the Worker;
  without it the request fails with `422 cf_token_required`. For an apex `cloudflare_zone`,
  `pmail domains add` with your local Cloudflare token works instead (catch-all, no literal rules).
- **`nameservers`** creates the zone in this account. Platform keys may always use it; tenant keys only
  when the tenant's policy has `domains.allow_create_zone: true` (otherwise `422 transport_unavailable`,
  `details.reason: "zone_creation_not_allowed"`). Moving the nameservers hands the whole domain to this
  deployment, so when the name has A, AAAA or MX records, or `www` has a CNAME or A record, the request
  needs `"confirm_dedicated": true`; otherwise it fails with `409 domain_not_dedicated` and
  `details.records` lists what was found ([N21](../project/edge-cases.md)). The response's `records` are
  the zone's nameservers, as `NS` records to set at the registrar. Cloudflare deletes a zone that is not
  activated within 28 days; the domain then becomes `removed` with `state_reason: "zone_expired"`
  ([N23](../project/edge-cases.md)).
- **`delegated_subdomain`** is off unless `PM_CF_SUBDOMAIN_SETUP=on` (otherwise
  `422 transport_unavailable`, `details.reason: "subdomain_setup_disabled"`), and needs a Cloudflare
  Enterprise account. The response's `records` are `NS` records for the subdomain, to add at the parent's
  DNS host.
- For both zone-creating methods, a Cloudflare zone hold returns `409 zone_hold`
  ([N24](../project/edge-cases.md)), and Cloudflare error 1105 (too many attempts to add a domain) returns
  `429 upstream_rate_limited` with `Retry-After: 10800` and `details.retry_after: 10800`
  ([N22](../project/edge-cases.md)).
- **`dns_records` and `send_only`** need the SES transport (`PM_SES_*`); without it they fail with
  `422 transport_unavailable`, `details.reason: "ses_not_configured"`. `dns_records`, and `smtp_relay` with
  `inbound: ses`, also need SES receiving (`PM_SES_INBOUND_TOPIC_ARN`, bucket and queue), otherwise
  `details.reason: "ses_receiving_not_configured"`. Every method that needs an SES identity (`dns_records`,
  `send_only`, `smtp_relay` with `inbound: ses`) fails with `details.reason: "ses_identity_limit"` once the
  SES region holds 10,000 identities.
- **`smtp_relay`**: a `port` other than `465` or `587` (port `25` included) returns
  `400 smtp_port_not_allowed`. Before it stores anything, the Worker connects to the relay once (EHLO,
  STARTTLS, AUTH, QUIT). No STARTTLS on 587 (or no TLS on 465) returns `422 smtp_tls_required`, and the
  credentials are not sent; a `535` answer to AUTH returns `422 smtp_auth_failed`; a connection that
  cannot be made returns `502 upstream_error`. The domain sends only after an alignment
  [probe](#post-v1domainsdomain_idprobe--domainswrite) passes.

Also:

- A name already registered in this deployment returns `409 domain_exists`.
- When the plan's `custom_domains` allowance is spent, the request fails with `402 billing_limit`
  (`details.feature: "custom_domains"`).
- An apex whose merged SPF record would need more than 10 DNS lookups (or more than 2 void lookups) is
  refused with `400 spf_lookup_limit`; `details.lookups` gives the count and `fix` names the includes to
  flatten ([H2](../project/edge-cases.md)).

Returns `201` with a [Domain](#domain-object) in `pending` state. Its `records` are read from the
provider APIs at that moment.

### `GET /v1/tenants/{tenant_id}/domains` · `GET /v1/domains/{domain_id}` — `domains:read`

The platform domain is visible to every key, with `tenant_id: null`.

### `GET /v1/domains/{domain_id}/records` — `domains:read`

Re-reads the expected records from the provider APIs and checks each against DNS:

```json
{
  "data": [
    { "type": "TXT", "name": "_pylota-mail.mail.acmecarhire.example", "host": "_pylota-mail.mail",
      "value": "pm-verify=8f2k…", "purpose": "ownership", "required": true, "status": "ok",
      "observed": ["pm-verify=8f2k…"] },
    { "type": "TXT", "name": "cf-bounce._domainkey.mail.acmecarhire.example", "host": "cf-bounce._domainkey.mail",
      "value": "v=DKIM1; …", "purpose": "dkim", "required": true, "status": "missing", "observed": [] }
  ],
  "checked_at": "2026-10-09T10:05:00Z"
}
```

- `name` is fully qualified. `host` is the same name relative to the registrable domain (from the Public
  Suffix List), because DNS hosts differ in which of the two they ask for ([N17](../project/edge-cases.md)).
- `purpose` is `ownership`, `mx`, `dkim`, `return_path`, `spf`, `dmarc` or `ns`.
- `status` is one of `ok`, `missing`, `mismatch` or `unexpected`, where `unexpected` means an extra record
  that conflicts (for example a second SPF record).

### `PATCH /v1/domains/{domain_id}` — `domains:write`

The body has `transport`, `smtp` or both. Returns `200` with the domain. Audit-logged.

**`transport`**, platform keys only (`403 scope_denied` for others):

```json
{ "transport": "ses" }
```

Switches the transport that sends as a domain on Cloudflare: `cloudflare` or `ses`. This is the Email
Sending failover of [J5](../project/edge-cases.md). `ses` needs the SES transport configured
(`422 transport_unavailable`, `details.reason: "ses_not_configured"`) and a verified SES identity for the
domain. A transport the domain's method cannot use returns `422 transport_unavailable` with
`details.reason: "method_not_supported"`: `dns_records` and `send_only` domains send only through `ses`,
`smtp_relay` domains only through `smtp`, and the platform domain only through `cloudflare`. The change
applies to sends that reach the transport after it and starts a health check at once (alignment differs
per transport).

**`smtp`**, tenant or platform keys, `smtp_relay` domains only (otherwise `method_not_supported`):

```json
{ "smtp": { "host": "smtp.provider.example", "port": 587, "username": "agents@brightwell.example",
            "password": "…", "probe_from": "agents@brightwell.example" } }
```

Rotates the relay credentials or changes the relay. It takes the fields of `smtp` on domain create, with
the same port rule and connection test (`400 smtp_port_not_allowed`, `422 smtp_tls_required`,
`422 smtp_auth_failed`, `502 upstream_error`). The new values are kept pending until an alignment probe
with them passes; until then sends keep using the current values, which the domain's `smtp` still shows.
The probe result arrives as a domain health change.

### `POST /v1/domains/{domain_id}/probe` — `domains:write`

No body. Runs the alignment probe now, for a domain whose transport is `smtp` (otherwise
`422 transport_unavailable`, `details.reason: "method_not_supported"`). At most once a minute per domain
(`429 rate_limited`). Returns `202`:

```json
{ "probe_id": "prb_01JA…" }
```

The probe sends a message `From: {probe_from}` through the relay to an address on the platform domain. It
passes when the `From` header arrives unchanged and DMARC for the domain passes on Pylota Mail's own
check. The result arrives as a domain health change within 15 minutes: in the domain's `probe`, and on
failure as the issue `smtp_unaligned`, `smtp_from_rewritten` or `smtp_probe_timeout`
([Domains on any DNS host › The probe](../project/design/domain-connections.md#53-proving-alignment-the-probe)).
A probe also runs before the domain's first send and every day after.

### `POST /v1/domains/{domain_id}/verify` — `domains:write`

Runs a check now (rate-limited to one a minute per domain) and returns the domain.

### `GET /v1/domains/{domain_id}/health` — `domains:read`

```json
{
  "state": "failing", "reason": "dkim_missing", "since": "…",
  "issues": [ { "code": "dkim_missing", "record": "cf-bounce._domainkey…", "fix": "Add TXT … with value …" } ],
  "checks": [ { "at": "…", "resolver": "cloudflare-doh", "outcome": "fail" } ],
  "fallback_active": true
}
```

The issue codes and their levels are listed in
[Identities and domains › What each check verifies](../project/design/identity-domains.md#what-each-check-verifies)
and, for each connection method, in
[Domains on any DNS host › Health checks per method](../project/design/domain-connections.md#6-health-checks-per-method).

### `POST /v1/domains/{domain_id}/reprove` — `domains:write`

Issues a new ownership TXT value for a `suspended` domain. Returns the domain with the new record.

### `DELETE /v1/domains/{domain_id}` — `domains:write`

Fails with `409 domain_in_use` while any address on it is `active` or `retiring`. Otherwise it starts
removal: routing rules, sending onboarding and the event subscription are deleted, and for a domain with
an SES identity, the SES identity and the domain's addresses in the retired-address receipt rules
(`pm-retired-{n}`). Returns `202`. `domain.removed` follows with `reason: "requested"`.

#### Domain object

```json
{
  "id": "dom_01JA…", "tenant_id": "ten_01J9…", "name": "agents.brightwell.example",
  "method": "dns_records", "kind": "external", "inbound": "ses", "transport": "ses",
  "is_apex": false, "routing_mode": "catch_all", "reply_token": "subaddress",
  "receiving": true, "sending": true,
  "ses_region": "eu-west-2", "mail_from_domain": "pm-bounce.agents.brightwell.example",
  "smtp": null, "probe": null,
  "state": "healthy", "state_reason": null, "state_changed_at": "…",
  "records": [ "...as in /records..." ], "created_at": "…"
}
```

| Field | Values |
|---|---|
| `method` | One of the six methods, or `platform` for the platform domain |
| `kind` | `platform`, `zone`, `delegated` or `external` |
| `inbound` | `routing` (Cloudflare Email Routing), `ses`, `forward` (the customer's mailbox forwards) or `none` |
| `transport` | `cloudflare`, `ses` or `smtp` |
| `routing_mode` | `catch_all`, `literal` (one routing rule per address, on a zone subdomain) or `forward` |
| `ses_region` | The SES region when `inbound` or `transport` is `ses`, otherwise `null` |
| `mail_from_domain` | `pm-bounce.{name}` when SES sends for the domain, otherwise `null`. The local part `pm-bounce` is reserved on such domains |
| `smtp` | `smtp_relay` only, otherwise `null`: `{ "host", "port", "username", "probe_from" }`. Never the password |
| `probe` | `smtp` transport only, otherwise `null`: `{ "last_at", "result" }`. `result` is `pass` or the issue code of the failure (`smtp_unaligned`, `smtp_from_rewritten`, `smtp_probe_timeout`, `smtp_auth_failed`, `smtp_tls_required`); both are `null` before the first probe |
| `state_reason` | The first issue code, or `zone_expired` on a `nameservers` domain whose zone Cloudflare deleted |

---

## Threads and messages

### `GET /v1/identities/{identity_id}/threads` — `messages:read`

Filters: `label`, `category`, `needs_reply_gte` (0–1; the search operator `is:needs_reply` uses 0.5),
`is_unread`, `direction` (of the last message), `after`, `before`, `archived` (default `false`). Sorted
by `last_at` descending.

```json
{
  "data": [{
    "id": "thr_01J9…", "subject": "Booking BK-2291 — change of dates",
    "participants": [ { "address": "jo@example.net", "name": "Jo Rivera" } ],
    "message_count": 4, "unread_count": 1,
    "first_at": "…", "last_at": "…", "last_inbound_at": "…", "last_direction": "inbound",
    "snippet": "Could we move the pick-up to Friday…",
    "labels": ["booking"], "category": "customer_request", "needs_reply": 0.92, "urgency": 2,
    "hold": null
  }],
  "next_cursor": null
}
```

### `GET /v1/identities/{identity_id}/threads/{thread_id}` — `messages:read`

Query: `messages_limit` (default 20, max 100), `cursor`, and `include` (comma list: `quoted`, `html`, `headers`).

Returns the thread summary plus `messages` (oldest first within the page). By default each message
carries `extracted_text` (quotes stripped) rather than the full `text`.

### `PATCH /v1/identities/{identity_id}/threads/{thread_id}` — `messages:write`

```json
{ "labels_add": ["claims"], "labels_remove": [], "read": true, "archived": false }
```

### `POST /v1/identities/{identity_id}/threads/{thread_id}/hold` — `erasure:manage`

```json
{ "reason": "PCN dispute WM12345678", "until": "2027-10-09T00:00:00Z" }
```

`DELETE …/hold` removes it. Both are audit-logged.

### `GET /v1/identities/{identity_id}/messages` — `messages:read`

Filters: `thread_id`, `direction`, `status`, `label`, `after`, `before`. Sorted newest first.

### `GET /v1/identities/{identity_id}/messages/{message_id}` — `messages:read`

`include` takes `html`, `headers` and `quoted`.

#### Message object

```json
{
  "id": "msg_01J9…", "thread_id": "thr_01J9…", "identity_id": "idn_01J9…",
  "direction": "inbound", "status": "received",
  "from": { "address": "accounts@brightwell.example", "name": "Brightwell Leeds" },
  "to": [ { "address": "maintenance.acme@agents.example", "name": "" } ],
  "cc": [], "bcc": [], "reply_to": [],
  "delivered_to": "maintenance.acme@agents.example", "is_primary_recipient": true,
  "subject": "Invoice 88213 – AB12 CDE",
  "sent_at": "2026-09-14T08:12:00Z", "received_at": "2026-09-14T08:12:03Z",
  "extracted_text": "Please find attached invoice 88213 for brake pads and discs…",
  "text": null,
  "html": null,
  "attachments": [
    { "id": "att_01J9…", "filename": "INV-88213.pdf", "content_type": "application/pdf",
      "size": 48213, "disposition": "attachment", "text_status": "ready", "pages": 2, "risk": null }
  ],
  "labels": ["invoice"],
  "kind": "normal",
  "trust": {
    "verdict": "pass", "spf": "pass", "dkim": "pass", "dmarc": "pass", "arc": "none",
    "known_sender": true, "quarantined": false, "spam_score": 0.02,
    "automated": false, "flags": []
  },
  "triage": {
    "status": "done", "category": "billing", "needs_reply": 0.15, "urgency": 1,
    "summary": "Brightwell invoice 88213 for AB12 CDE brake work, £412.80 inc VAT.",
    "language": "en", "risk_flags": [], "model": "@cf/openai/gpt-oss-20b", "version": 3
  },
  "refs": [ { "kind": "uk_plate", "value": "AB12CDE" }, { "kind": "invoice", "value": "88213" } ],
  "rfc_message_id": "CAF8a…@mail.brightwell.example",
  "in_reply_to": null,
  "deliveries": null,
  "flags": [],
  "metadata": {}
}
```

- `text` is the full plain text. It is included with `include=quoted`.
- `html` is sanitised HTML. It is included with `include=html` and is never rendered by the service.
- `trust.flags` can hold `hidden_text`, `display_name_spoof`, `lookalike_domain`, `reply_to_mismatch`
  and `thread_join_unverified`.
- `triage.status` is `pending`, `done`, `skipped` or `failed`. `triage.reason` is present only for
  `skipped` (`allowance`, `policy_disabled`, `not_eligible`) and `failed` (`invalid_output`,
  `model_unavailable`, `input_unavailable`) ([Triage design](../project/design/triage.md)). For example,
  mail that arrives after the workspace's `triage` allowance is spent is still stored, and its triage is
  skipped with reason `allowance`; the built-in rules' risk flags are kept and the model does not run
  ([M7](../project/edge-cases.md)):
  `{ "status": "skipped", "reason": "allowance", "category": null, "needs_reply": null, "urgency": null, "summary": null, "language": null, "risk_flags": ["unknown_sender"], "model": null, "version": 3 }`.
- `deliveries` is set on outbound messages:
  `[{ "address", "field", "status", "smtp_code", "bounce_type", "updated_at" }]`.
- Message-level `flags` include `sent_via_fallback`, `parse_degraded`, `encrypted`,
  `message_id_conflict`, `reprocessed`, `reconciled`, `bcc`, `loopback` (delivered inside the deployment
  for a test tenant, [L3](../project/edge-cases.md)) and `body_truncated` (a stored body was cut at its
  storage cap; the full message is in the raw MIME).
- `is_primary_recipient` is `true` on exactly one copy when one message reached several identities of
  the tenant ([A9](../project/edge-cases.md)).

All text fields (subject, display names, filenames, bodies) are **untrusted content**. Show them to a
model inside a clearly delimited block, never as instructions.

### `GET /v1/identities/{identity_id}/messages/{message_id}/raw` — `messages:read`

`message/rfc822` bytes, available for `raw_days` (default 90). Then `410 raw_expired`.

### `PATCH /v1/identities/{identity_id}/messages/{message_id}` — `messages:write`

`labels_add`, `labels_remove`, `read`.

### `GET /v1/identities/{identity_id}/messages/{message_id}/attachments/{attachment_id}` — `attachments:read`

Returns the bytes with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox`. Attachments with a `risk` need `quarantine:review`.

### `GET /v1/identities/{identity_id}/messages/{message_id}/attachments/{attachment_id}/text` — `attachments:read`

Query: `pages=1-3` (default: all, capped at 200 KB of text).

```json
{ "status": "ready", "pages": [ { "page": 1, "text": "INVOICE 88213 …" } ], "total_pages": 2, "truncated": false }
```

`status` is one of `pending`, `ready`, `unavailable` (extraction failed or unsupported type) or
`skipped` (by policy or risk).

### `POST /v1/identities/{identity_id}/messages/{message_id}/triage` — `messages:write`

Re-runs triage. Returns `202`. A `message.triaged` event follows.

### `POST /v1/identities/{identity_id}/messages/{message_id}/release` — `quarantine:review`

```json
{ "reason": "Known supplier, DKIM key rotated" }
```

Moves a quarantined message to `received`, emits `message.released` and runs triage. Audit-logged. When
`PM_QUARANTINE_KEY_RELEASE` is `off` (Pylota Mail Cloud), every API key gets `403 permission_denied` and
the release has to be done by a person in the console (FR-CON-6).

### `DELETE /v1/identities/{identity_id}/messages/{message_id}` — `erasure:manage`

Returns `202` with an erasure request of scope `message`.

---

## Sending

All four endpoints need `messages:send` and an `Idempotency-Key`. They return `202 Accepted` with the
[Message object](#message-object) (`direction: "outbound"`, `status: "queued"`) plus `"deduplicated": false`.

When the plan's `sends` allowance is spent, send, reply, reply-all and forward fail with
`402 billing_limit` (`details.feature: "sends"`). Nothing is stored; after an upgrade or a top-up, retry
with the **same** `Idempotency-Key`.

**Dry run.** Add `?dry_run=true` to send, reply, reply-all or forward to run every check (permissions,
policy, recipients, suppressions and lists, size) without sending or storing anything, taking quota or
locking the thread. The `Idempotency-Key` header is optional on a dry run and is never recorded. It
returns `200`:

```json
{ "would_send": true,
  "recipients": [ { "address": "jo@example.net", "field": "to", "status": "queued" },
                  { "address": "old@example.org", "field": "cc", "status": "suppressed", "reason": "hard_bounce" } ] }
```

or the error a real send would get, plus `422 all_recipients_suppressed` and `422 recipient_blocked`,
which only a dry run returns. A `200` always has `would_send: true`; each recipient's `status` is
`queued` or `suppressed` (with `reason`: the suppression reason, or `send_block`, `not_on_allowlist` or
`unknown_recipient`).

### `POST /v1/identities/{identity_id}/messages`

```json
{
  "to": [ { "address": "jo@example.net", "name": "Jo Rivera" } ],
  "cc": [], "bcc": [],
  "subject": "Your booking BK-2291 is confirmed",
  "text": "Hi Jo, your Golf is booked for Friday 10:00…",
  "html": "<p>Hi Jo, your Golf is booked for <b>Friday 10:00</b>…</p>",
  "attachments": [
    { "filename": "BK-2291.pdf", "content_type": "application/pdf",
      "content_base64": "JVBERi0xLjcK…", "disposition": "attachment" }
  ],
  "kind": "transactional",
  "thread_id": null,
  "from_address": null,
  "labels": ["booking"],
  "headers": { "X-Booking-Ref": "BK-2291" },
  "metadata": { "booking_id": "bk_2291" }
}
```

- Recipients can be strings (`"jo@example.net"`) or objects. At most `policy.max_recipients` (default 10,
  hard maximum 49) across `to`, `cc` and `bcc`. Duplicates are removed.
- At least one of `text` and `html` is required. Text is derived from HTML when it is missing. The
  identity's signature and the tenant's AI-disclosure footer are appended according to policy.
- `kind`:
  - `transactional` (the default);
  - `marketing`, which needs an `unsubscribe` object (`{ "url": "https://…", "mailto": "…" }`) and the
    tenant's consent attestation (`"consent": { "basis": "opt_in", "recorded_at": "…" }`);
  - `auto_reply`, which sets `Auto-Submitted: auto-replied`. It is only allowed in reply to a
    non-automated message.
- `thread_id` continues an existing thread without quoting. References are set from the thread.
- `from_address` must be an `active` address of the identity, or a `retiring` one on a thread that
  already uses it (G7; with `thread_id`). Otherwise `400 invalid_request` with
  `details.errors[0].path = "from_address"`. The default is the primary.
- `headers` accepts only `X-` headers, plus the allow-listed `Importance`, `Priority`, `Sensitivity`,
  `Keywords`, `Comments` and `Organization`. Everything else is set by the service.
- Attachments: `content_base64`, `disposition` (`attachment` or `inline`) and `content_id` (for inline).
  The total encoded message must fit the transport limit (5 MiB with Cloudflare) or the request fails with
  `413 message_too_large`. When the tenant enables `large_attachments: "link"`, oversized attachments
  become expiring signed links instead.

### `POST /v1/identities/{identity_id}/messages/{message_id}/reply`

```json
{ "text": "Friday works. See you at 10.", "html": null, "attachments": [], "kind": "transactional" }
```

Replies to the sender of `message_id` (or its `Reply-To`, under the rules in
[Sending](../guides/sending.md#who-a-reply-goes-to)). The subject gets one `Re:` prefix. The `From` is
the address the counterparty wrote to. `In-Reply-To` and `References` are set.

### `POST /v1/identities/{identity_id}/messages/{message_id}/reply-all`

As `reply`, to the sender plus every `To`/`Cc` recipient except this identity's own addresses. BCC
recipients of the original are never included ([A10](../project/edge-cases.md)).

### `POST /v1/identities/{identity_id}/messages/{message_id}/forward`

```json
{ "to": ["claims@insurer.example"], "text": "Forwarding the photos for claim 7781.", "include_attachments": true }
```

### `POST /v1/identities/{identity_id}/messages/{message_id}/cancel` — `messages:send`

Only while the message is `queued`. Returns the message with `status: "canceled"`. Otherwise
`409 not_cancelable`.

### `POST /v1/identities/{identity_id}/messages/{message_id}/resolve` — `messages:write`

For `uncertain` messages only (otherwise `409 not_uncertain`). The body is `{ "outcome": "sent" }` or
`{ "outcome": "not_sent" }`. `sent` moves the message and its uncertain deliveries to `submitted` and
emits `message.sent` (with `provider_message_id: null`); later delivery events still apply. `not_sent`
marks the message `failed` with reason `resolved_not_sent`, after which you may send again with a
**new** Idempotency-Key. Audit-logged.

### Outbound status

| Status | Meaning | Terminal |
|---|---|---|
| `queued` | Accepted, waiting for the transport | no |
| `submitted` | The transport accepted it. `provider_message_id` is set | no |
| `delivered` | Every recipient is delivered | yes |
| `deferred` | At least one recipient has a temporary failure and the provider is still retrying | no |
| `bounced` | At least one recipient bounced and none remains in flight | yes |
| `complained` | A recipient reported spam (can follow `delivered`) | yes |
| `rejected` | The transport refused it before sending (validation, policy) | yes |
| `failed` | It could not be sent (quota exhausted after retries, or resolved as not sent) | yes |
| `uncertain` | The outcome is unknown. It is **never resent automatically** | until resolved |
| `suppressed` | Every recipient is suppressed. Nothing was sent | yes |
| `canceled` | Cancelled while queued | yes |

The message status is a roll-up. Per-recipient status is in `deliveries`.

---

## Search

### `POST /v1/identities/{identity_id}/search` — `search:read` (`search:agentic` for `mode: "agentic"`)

```json
{
  "q": "from:@brightwell.example ref:AB12CDE has:attachment newer_than:45d",
  "mode": "hybrid",
  "filters": { "direction": "inbound", "labels": [], "after": null, "before": null },
  "group_by": "message",
  "limit": 10,
  "snippet_chars": 240,
  "facets": true,
  "include_quarantined": false,
  "cursor": null
}
```

The operators, modes and ranking are explained in [Search](../guides/search.md).

```json
{
  "query": { "parsed": "from:@brightwell.example ref:AB12CDE has:attachment newer_than:45d", "mode": "hybrid" },
  "hits": [{
    "message_id": "msg_01J…", "thread_id": "thr_01J…", "identity_id": "idn_01J…",
    "date": "2026-09-14T08:12:00Z", "direction": "inbound",
    "from": { "name": "Brightwell Leeds", "address": "accounts@brightwell.example" },
    "subject": "Invoice 88213 – AB12 CDE",
    "snippet": "…brake pads and discs, total £412.80 inc VAT…",
    "score": 0.913,
    "why": ["ref:AB12CDE (attachment p.1)", "from:brightwell.example", "type:pdf"],
    "attachment_hits": [ { "attachment_id": "att_…", "filename": "INV-88213.pdf", "page": 1 } ],
    "trust": { "verdict": "pass", "known_sender": true, "quarantined": false }
  }],
  "facets": {
    "sender": { "accounts@brightwell.example": 3 }, "sender_domain": { "brightwell.example": 3 },
    "month": { "2026-09": 2, "2026-08": 1 },
    "label": { "invoice": 3 }, "attachment_type": { "pdf": 3 }, "category": { "billing": 3 }
  },
  "next_cursor": null, "truncated": false, "semantic_coverage": 0.998, "degraded": false,
  "as_of": "2026-10-09T10:12:00Z"
}
```

With `group_by: "thread"`, `hits` has one row per thread. Each row has `thread_id`, `subject`,
`participants`, `message_count`, `last_at`, the best `snippet` and `why`, and `top_message_id`.

`facets` has six keys: `sender` (the from address), `sender_domain`, `month` (in the tenant's time zone),
`label`, `attachment_type` and `category`. Each lists the top 10 values by count (`month`: the 24 most
recent months). Facets are computed on the first page only: they are `null` on later pages and when the
request sets `facets: false`.

#### Agentic mode

```json
{ "q": "Did the insurer accept the Golf claim after we sent the photos?", "mode": "agentic",
  "budget": { "max_steps": 6, "max_seconds": 8 }, "stream": false }
```

```json
{
  "status": "answered",
  "answer": {
    "text": "Yes. Admiral accepted claim 7781 on 2 October, after the photos sent on 28 September [msg_01JA…][msg_01JB…].",
    "sentences": [ { "text": "Yes. Admiral accepted claim 7781 on 2 October…", "citations": ["msg_01JA…", "msg_01JB…"] } ],
    "confidence": 0.86
  },
  "evidence": [ { "...": "search hits, as above, with quotes": [ "we are pleased to confirm claim 7781 has been accepted" ] } ],
  "trace": [
    { "step": 1, "action": "search", "q": "claim Golf photos", "mode": "hybrid", "hits": 7, "ms": 412 },
    { "step": 2, "action": "read_thread", "thread_id": "thr_01JA…", "ms": 38 },
    { "step": 3, "action": "answer", "removed_sentences": 0 }
  ],
  "degraded": false,
  "usage": { "steps": 3, "ms": 2810, "model": "@cf/qwen/qwen3.8-27b" }
}
```

- `status` is one of `answered`, `insufficient_evidence`, `budget_exhausted` (evidence returned, no
  answer or a partial one) or `degraded` (hybrid results only, no answer).
- When tenant policy turns agentic search off, `mode: "agentic"` fails with `422 agentic_disabled`, on
  this endpoint and on tenant search.
- With `stream: true` and `Accept: text/event-stream`, the response is a server-sent event stream:
  `event: step` (each trace entry), `event: evidence` (hits as they are found), `event: answer` and
  `event: done`. A keep-alive comment is sent every 10 seconds.

### `POST /v1/tenants/{tenant_id}/search` — tenant or platform key, `search:read`

The same body, plus an optional `identity_ids` filter. Runs across every identity of the tenant (up to
100; more returns `422 scope_too_large`). Hits carry `identity_id`, and facet counts are summed across
identities. `mode: "agentic"` with agentic search off returns `422 agentic_disabled`.

The response adds two fields, always present: `partial` and `failed_identities` ([F15](../project/edge-cases.md)).
Each identity's mailbox has 900 ms from the start of the fan-out to answer. One that errors or misses the
deadline is listed in `failed_identities`, `partial` is `true`, and its late result is discarded. When
every identity answered, they are `false` and `[]`.

```json
{ "query": { "...": "as above" }, "hits": [ "..." ], "facets": { "...": "summed" },
  "next_cursor": null, "truncated": false, "semantic_coverage": 0.994, "degraded": false,
  "as_of": "2026-10-09T10:12:00Z", "partial": true, "failed_identities": ["idn_01JA…"] }
```

### `GET /v1/identities/{identity_id}/messages/{message_id}/related` — `search:read`

Query: `limit` (default 10, max 50). Returns semantically similar messages from other threads, as search hits.

### `GET /v1/identities/{identity_id}/contacts` — `search:read`

Query: `q` (name, address or domain prefix), `limit`, `cursor`.

```json
{ "data": [ { "address": "claims@admiral.example", "name": "Admiral Claims", "domain": "admiral.example",
  "first_seen_at": "…", "last_seen_at": "…", "inbound_count": 6, "outbound_count": 4,
  "last_thread_id": "thr_01JA…" } ], "next_cursor": null }
```

### `GET /v1/identities/{identity_id}/wait` — `search:read`

Long-polls until a matching message arrives after the request started (or after `since`).

Query parameters:

- `from`: an address or `@domain`;
- `subject_contains`;
- `thread_id`;
- `kind`: `any`, `reply` or `verification`;
- `since`;
- `timeout`: seconds, default 30, max 60.

```json
{ "message": { "...": "Message object or null on timeout" },
  "verification": { "code": "481 207", "link": "https://service.example/verify?t=…", "sender_domain": "service.example" },
  "timed_out": false }
```

A verification code or link is released only when `from` names the expected sender domain and the
message passed authentication (`verdict: pass`). See [E4](../project/edge-cases.md).

---

## Quarantine

### `GET /v1/identities/{identity_id}/quarantine` — `quarantine:review`

Quarantined messages, newest first, with `quarantine_reason`.

Releasing a message is `POST …/messages/{message_id}/release` (above).

---

## Webhooks

The event types and payloads are in [Webhook events](events.md).

Reads (`GET`) need `webhooks:read`; every other webhook route needs `webhooks:manage`, which includes
`webhooks:read`.

### `POST /v1/webhooks` (platform key) · `POST /v1/tenants/{tenant_id}/webhooks` — `webhooks:manage`

```json
{ "url": "https://api.example.com/webhooks/mail", "events": ["message.received", "message.bounced"],
  "identity_ids": null, "description": "Production API" }
```

Returns `201` with the endpoint and `"secret": "whsec_…"`. **The secret is shown only once.**
`events: ["*"]` subscribes to everything, including event types added later. A tenant, and the platform,
can have at most 20 endpoints; on both routes, the 21st returns `422 webhook_limit_reached`.

### `GET /v1/webhooks` · `GET /v1/tenants/{tenant_id}/webhooks` · `GET|PATCH|DELETE /v1/webhooks/{webhook_id}`

`GET` needs `webhooks:read`; `PATCH` and `DELETE` need `webhooks:manage`.

`PATCH` accepts `url`, `events`, `identity_ids`, `description` and `enabled`.

### `POST /v1/webhooks/{webhook_id}/rotate-secret`

`{ "overlap_hours": 24 }` (0–168). Returns the new secret once. During the overlap, deliveries carry
both signatures.

### `POST /v1/webhooks/{webhook_id}/test`

Sends a `webhook.test` event straight away and returns the delivery attempt.

### `GET /v1/webhooks/{webhook_id}/deliveries` — `webhooks:read`

Filters: `status` (`succeeded`, `failed`, `dead`), `event_type`, `after`.

### `POST /v1/webhooks/{webhook_id}/replay`

```json
{ "event_ids": ["evt_01J…"] }
```

or

```json
{ "since": "2026-10-08T00:00:00Z", "until": "2026-10-09T00:00:00Z", "status": "dead" }
```

Events older than 30 days cannot be replayed. Returns `202` with `{ "queued": 42 }`.

---

## Suppressions and lists — `suppressions:manage`

### `GET /v1/tenants/{tenant_id}/suppressions`

Query: `address` (exact lookup), `reason`. Items show `address_hint` (masked), `reason`, `created_at`
and `expires_at`.

### `POST /v1/tenants/{tenant_id}/suppressions`

`{ "address": "jo@example.net", "reason": "manual", "note": "Asked not to be contacted" }`

### `DELETE /v1/tenants/{tenant_id}/suppressions/{address}`

Removes a `manual`, `unsubscribe`, `hard_bounce` or `provider` suppression. Removing a `complaint`
suppression needs `"confirm_complaint_removal": true` in the body and is audit-logged.

### `GET|PUT|DELETE /v1/tenants/{tenant_id}/lists/{direction}/{kind}/{entry}`

`direction` is `receive` or `send`, `kind` is `allow` or `block`, and `entry` is `user@example.com` or
`@example.com`. `GET /v1/tenants/{tenant_id}/lists/{direction}/{kind}` lists the entries.

- **Receive-block**: mail is stored hidden and never shown to agents.
- **Receive-allow**: mail skips spam quarantine. It does not skip authentication quarantine.
- **Send-block**: refused per recipient.
- **Send-allow**: with `policy.send_allowlist_only`, only listed recipients are allowed.

---

## API keys — `keys:manage`

### `POST /v1/keys`

```json
{ "name": "bookings-agent", "level": "identity", "tenant_id": "ten_01J9…", "identity_id": "idn_01J9…",
  "permissions": ["messages:read", "messages:send", "search:read", "attachments:read"],
  "expires_at": "2027-10-09T00:00:00Z" }
```

The new key's level, tenant, identity and permissions must all lie within the caller's own, otherwise
`403 key_scope_exceeded`. A tenant key's `mode` follows its tenant. Returns `201` with
`"secret": "pmk_live_…"`, shown only once.

### `GET /v1/keys` · `GET /v1/keys/{key_id}` · `DELETE /v1/keys/{key_id}`

`DELETE` revokes the key immediately.

### `POST /v1/keys/{key_id}/rotate`

`{ "overlap_hours": 24 }` (0–168). Returns a new secret. The old one keeps working until the overlap ends.

---

## Privacy — `erasure:manage`

### `POST /v1/erasure-requests`

```json
{ "tenant_id": "ten_01J9…", "scope": "counterparty", "counterparty_address": "jo@example.net",
  "reason": "Data subject request DSR-1182" }
```

| `scope` | Also needs | Deletes |
|---|---|---|
| `message` | `identity_id`, `message_id` | One message, its attachments, text, index rows, vectors, raw copies |
| `thread` | `identity_id`, `thread_id` | Every message in the thread |
| `counterparty` | `counterparty_address` | Every message to or from that address, in every identity of the tenant |
| `identity` | `identity_id` | The whole mailbox. Its addresses are tombstoned |
| `tenant` | none | Everything in the tenant. Then the tenant is marked `erased` |

Held threads are skipped and listed in the receipt (FR-PRV-4). The request's `status` is `queued`,
`running`, `completed`, `completed_with_holds` (finished, but at least one held thread was skipped) or
`failed`. Returns `202` with:

#### Erasure request object

```json
{
  "id": "era_01J9…", "tenant_id": "ten_01J9…", "scope": "counterparty", "status": "completed",
  "created_at": "…", "completed_at": "…",
  "receipt": {
    "messages_deleted": 14, "attachments_deleted": 9, "r2_objects_deleted": 38,
    "fts_rows_deleted": 14, "refs_deleted": 51, "vectors_deleted": 63,
    "events_deleted": 31, "identities_affected": ["idn_01J9…", "idn_01JA…"],
    "held": [ { "thread_id": "thr_01JA…", "reason": "PCN dispute WM12345678" } ],
    "probe": { "keyword_hits": 0, "semantic_hits": 0 }
  }
}
```

`GET /v1/erasure-requests/{erasure_id}` and `GET /v1/erasure-requests` (filters: `tenant_id`, `status`). An
`erasure.completed` event is emitted.

### `POST /v1/exports` · `GET /v1/exports/{export_id}`

```json
{ "tenant_id": "ten_01J9…", "scope": "counterparty", "counterparty_address": "jo@example.net" }
```

`scope` is `counterparty` (with `counterparty_address`: every message to or from it across the tenant's
identities) or `identity` (with `identity_id`: the whole mailbox). Returns `202` with the export
(`status: "queued"`).

```json
{ "id": "exp_01JA4…", "tenant_id": "ten_01J9…", "scope": "counterparty", "status": "completed",
  "size": 1843321, "created_at": "…", "expires_at": "…",
  "download_url": "https://mail.example.com/v1/links/bDE6Mz…" }
```

`status` is `queued`, `running`, `completed`, `failed` or `expired`. The finished export has
`download_url`: a [signed link](#get-v1linkstoken) valid until `expires_at` (7 days) to a ZIP holding
one `.eml` per message plus `messages.json`. The link is minted again on each `GET`. An
`export.completed` event is emitted.

---

## Usage and audit

### `GET /v1/usage` — any key (its own workspace); `usage:read` for other workspaces

The workspace's plan and the state of every allowance in the current period. Agents read it to know their
limits before they hit `402 billing_limit`. Platform keys pass `tenant_id`.

```json
{
  "billing": "metered",
  "plan": { "plan_id": "developer", "status": "active", "current_period_end": "2026-11-01T00:00:00Z",
            "cancel_at_period_end": false },
  "features": [
    { "feature": "inboxes",        "granted": 10,    "used": 4,    "remaining": 6,    "unlimited": false, "resets_at": null },
    { "feature": "sends",          "granted": 12000, "used": 8312, "remaining": 3688, "unlimited": false, "resets_at": "2026-11-01T00:00:00Z" },
    { "feature": "triage",         "granted": 10000, "used": 2210, "remaining": 7790, "unlimited": false, "resets_at": "2026-11-01T00:00:00Z" },
    { "feature": "custom_domains", "granted": 5,     "used": 1,    "remaining": 4,    "unlimited": false, "resets_at": null },
    { "feature": "storage_gb",     "granted": 10,    "used": 2,    "remaining": 8,    "unlimited": false, "resets_at": null },
    { "feature": "seats",          "granted": 2,     "used": 2,    "remaining": 0,    "unlimited": false, "resets_at": null }
  ],
  "topups": { "inboxes": 0, "sends": 2, "triage": 0 },
  "plans": [ { "plan_id": "free", "name": "Free", "price": 0, "currency": "gbp", "interval": "month",
               "included": { "inboxes": 5, "sends": 1000, "triage": 500, "custom_domains": 0, "storage_gb": 1, "seats": 1 },
               "topups": false, "support": "github_issues" } ]
}
```

- `billing` is `metered`, `exempt` (no limits) or `disabled` (self-hosted without billing; `features` show
  counts with `granted: null`, `unlimited: true`, plus any operator quota from tenant policy).
- `used` for `storage_gb` is measured, rounded up, and refreshed at least hourly.
- `granted` includes top-ups. `plans` is the whole catalog from `PM_PLAN_CATALOG`.

### `GET /v1/usage/daily` — `usage:read`, platform or tenant key

Query: `tenant_id` (platform keys), `from`, `to` (dates, at most 92 days apart).

```json
{ "data": [ { "day": "2026-10-08", "inbound": 312, "outbound": 128, "sends": 141, "triage": 298,
  "search": 940, "agentic": 41, "ai_neurons": 18233, "storage_bytes": 2147483648 } ] }
```

### `GET /v1/plans` — no auth

The plan catalog, as in `plans` above. Returns `{ "billing_enabled": false, "data": [] }` on a deployment
without billing.

### `GET /v1/tenants/{tenant_id}/billing` · `PATCH /v1/tenants/{tenant_id}/billing` — platform key, `tenants:manage`

Read or change a workspace's billing account. `PATCH` accepts `mode` (`metered`, `exempt`, `disabled`) and,
for workspaces without a Stripe subscription, `plan_id` (a complimentary plan). Plans paid through Stripe
change only through Stripe (`409 plan_managed_by_stripe`). Audit-logged. Both return:

```json
{ "tenant_id": "ten_01J9…", "mode": "metered",
  "plan": { "plan_id": "developer", "status": "active", "current_period_end": "2026-11-01T00:00:00Z",
            "cancel_at_period_end": false },
  "topups": { "inboxes": 0, "sends": 2, "triage": 0 } }
```

### `GET /v1/audit-events` — `audit:read`

Filters: `tenant_id`, `actor_key_id`, `action`, `target_id`, `after`, `before`. Newest first.

```json
{ "data": [ { "id": "aud_01JA…", "tenant_id": "ten_01J9…", "actor_key_id": "key_01J9…",
  "action": "quarantine.release", "target_type": "message", "target_id": "msg_01JA…",
  "details": {}, "request_id": "req_01JA…", "created_at": "…" } ], "next_cursor": null }
```

Audit rows cover administrative actions: keys, tenants, identity status, quarantine releases, holds,
suppression removals, erasure, resolve, members, billing, and platform operations. **Sends are not
audit rows**: each send is recorded by its message, its events (`message.sent` and the delivery events)
and its per-recipient delivery log. To review what a key sent, list the outbound messages of the
identities it reaches for the period; request logs also carry the key ID for 7 days.

---

## Members

Console users of a workspace. The console is the main way to manage them; these endpoints let an
integrator provision people (for example, the owner of each customer workspace).

### `GET /v1/tenants/{tenant_id}/members` — `members:manage`

Not paginated: a workspace's members and pending invitations are bounded by its seats.

```json
{ "data": [ { "user_id": "usr_01JA…", "email": "sam@acmecarhire.example", "name": "Sam Patel",
  "role": "owner", "created_at": "…" } ], "invitations": [ { "id": "inv_01JA…", "email": "kim@acmecarhire.example",
  "role": "member", "expires_at": "…" } ], "seats": { "granted": 2, "used": 2 } }
```

### `POST /v1/tenants/{tenant_id}/invitations` — `members:manage`

`{ "email": "kim@acmecarhire.example", "role": "member" }`. Sends an invitation email from the deployment's
platform identity. A pending invitation uses a seat; with no seat left the request fails with
`402 billing_limit` (`details.feature: "seats"`). Roles: `admin`, `member`, `viewer`. The owner is set at
workspace creation (`owner` in `POST /v1/tenants`) or by an ownership transfer in the console. Returns
`201` with the invitation (`id`, `email`, `role`, `expires_at`).

### `DELETE /v1/tenants/{tenant_id}/invitations/{invitation_id}` · `DELETE /v1/tenants/{tenant_id}/members/{user_id}` — `members:manage`

Revokes an invitation, or removes a member and ends their sessions. Returns `204`. The owner cannot be
removed (`409 owner_required`).

---

## Platform operations

Platform keys with `platform:ops`. Every call is audit-logged.

### `POST /v1/platform/keys/{purpose}/rotate`

`purpose` is one of:

| `purpose` | Signs | Previous key verifies for |
|---|---|---|
| `thread` | Thread tokens | 90 days |
| `link` | Download links, console sign-in, invitation and session tokens, and OAuth state hashes | 7 days |
| `cursor` | Search cursors (the cursor lifetime) | 24 hours |

Generates a new key inside the Worker and makes it current. No body. Returns `200`:

```json
{ "purpose": "thread", "kid": "4", "created_at": "2026-10-09T10:00:00Z",
  "previous": { "kid": "3", "verify_until": "2027-01-07T10:00:00Z", "revoked": false } }
```

**`?revoke_previous=true`** deletes the previous key in the same D1 batch, so what it signed stops
verifying at once: thread tokens fall back to header threading; open links, console sign-in tokens,
invitations, sessions and OAuth flows under it fail; open search cursors fail with `400 invalid_request`.
The response then has `previous.verify_until` equal to the rotation time and `previous.revoked: true`.
Without it, a leaked key keeps verifying for its window. After a suspected leak, rotate with
`revoke_previous=true`, then rotate `PM_MASTER_KEY`. The audit action is `signing_key.rotate`, with
`details.revoke_previous`.

Key material is never returned, by this or any other endpoint. See
[Configuration › Thread and link keys](configuration.md#thread-and-link-keys).

### `GET /v1/platform/dlq`

Dead-letter items, oldest first. Filters: `queue` (`pm-inbound`, `pm-outbound`, `pm-delivery-events`,
`pm-webhooks`, `pm-index`), `status` (`open`, the default, or `redriven`), `tenant_id`, `cursor`,
`limit`.

```json
{ "data": [ { "id": "dlq_01JA…", "queue": "pm-inbound", "kind": "message", "tenant_id": "ten_01J9…",
  "first_seen_at": "…", "redriven_at": null, "redrive_count": 0 } ], "next_cursor": null }
```

The stored body is not returned: it is a pointer, and inbound pointers carry envelope addresses. Items
are kept for 14 days.

### `POST /v1/platform/dlq/{dlq_id}/redrive`

Publishes the stored body back to its source queue and returns the item with `redriven_at` set and
`redrive_count` incremented. Every consumer is idempotent, so a redrive is safe to repeat.
`Idempotency-Key` is optional.

### `POST /v1/platform/jobs` · `GET /v1/platform/jobs/{job_id}`

Starts a maintenance job ([J3](../project/edge-cases.md)):

```json
{ "kind": "reparse", "tenant_id": "ten_01J9…", "identity_ids": null,
  "after": "2026-09-01T00:00:00Z", "before": null }
```

| `kind` | Does |
|---|---|
| `reparse` | Re-parses messages from raw MIME with the deployed parser and re-emits their events with `reprocessed: true`. Messages past `raw_days` are skipped and counted |
| `reembed` | Re-chunks and re-embeds messages into Vectorize, for example after a model change |
| `reindex` | Rebuilds the keyword index (FTS5 and references) of each mailbox |

`tenant_id` is required; `identity_ids` (default: every identity of the tenant), `after` and `before`
narrow it. Returns `202` with the job:

```json
{ "id": "job_01JA…", "kind": "reparse", "tenant_id": "ten_01J9…", "status": "queued",
  "created_at": "…", "completed_at": null, "result": null }
```

`status` is `queued`, `running`, `completed`, `failed` or `canceled`; `result` holds counts once it
ends. `Idempotency-Key` is optional. `GET /v1/platform/jobs/{job_id}` returns jobs started through this
endpoint; erasure and export jobs are read through their own requests.

### `POST /v1/platform/waitlist/invite`

```json
{ "count": 50, "plan": null }
```

Invites the oldest confirmed, not yet invited entries of the sign-up waitlist
([Cloud sign-up › The waitlist](../project/design/cloud-signup.md#61-before-launch-the-waitlist)). `count`
is 1–500. `plan` (optional) invites only entries whose plan of interest is that plan. Each invited person
gets a sign-up link valid for 7 days. The audit action is `waitlist.invite`. `Idempotency-Key` is
optional. The CLI equivalent is `pmail waitlist invite --count N [--plan P]`. Returns `200` with the
number invited and the number of confirmed entries still waiting:

```json
{ "invited": 50, "waiting": 262 }
```

---

## Signed links and provider hooks

These routes need no API key.

### `GET /v1/links/{token}`

Serves a signed link: a large attachment replaced by a link in an outbound message, or an export ZIP.
The token carries the signing key's kid and an expiry, and is checked in constant time
([Security design](../project/design/security.md#73-signed-links)). The response is the file with
`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`
and `Cache-Control: private, no-store`. `Content-Type` is `application/zip` for an export; for an
attachment it is the sniffed type when it is on the safe list of
[Security § 8.5](../project/design/security.md#85-serving-attachments-and-raw-mime), otherwise
`application/octet-stream`. A bad, expired or unknown link, or a deleted target, returns
`404 attachment_not_found` or `404 export_not_found`.

### `POST /hooks/ses`

The Amazon SES **delivery event** endpoint, subscribed to the SNS topic `PM_SES_SNS_TOPIC_ARN`. A
subscription confirmation for that topic is confirmed; a notification becomes delivery events for the
matching messages and returns `200`. An internal failure returns `500`, so SNS retries (it retries `5xx`
and `429`) ([Outbound design](../project/design/outbound.md#amazon-ses)).

### `POST /hooks/ses/inbound`

The Amazon SES **inbound mail** endpoint, for domains with `inbound: ses`. It is subscribed to the SNS
topic `PM_SES_INBOUND_TOPIC_ARN`. A notification names the S3 object SES stored and its recipients; each
recipient is queued once for the inbound pipeline, then the endpoint returns `200`. Duplicates are dropped
by the `ses_ingest` ledger, so each object and recipient is ingested exactly once (FR-DOM-9). The SQS
queue `PM_SES_INBOUND_QUEUE_URL` is a backstop subscribed to the same topic: the every-minute cron feeds
its messages to the same handler. Mail to an unknown address on the domain is dropped without a bounce
([Domains on any DNS host › Inbound through SES](../project/design/domain-connections.md#45-inbound-through-ses)).
An internal failure returns `500`, so SNS retries.

**Verification, on both endpoints.** Only SNS messages that pass every check are accepted:

- `SignatureVersion` is `2` (SHA256withRSA) and the signature verifies. Version `1` is refused; setup sets
  `SignatureVersion=2` on both topics.
- `SigningCertURL` is `https` on the host `sns.{PM_SES_REGION}.amazonaws.com`.
- `TopicArn` equals that endpoint's topic.
- `Timestamp` is within one hour (14 days for messages the backstop reads from SQS).

Anything else gets `403 invalid_signature`.

---

## Well-known

| Path | Content |
|---|---|
| `/.well-known/security.txt` | Security contact (from `PM_SECURITY_CONTACT`) |
| `/.well-known/jwks/{identity_id}.json` | P1: public signing keys of an identity |
