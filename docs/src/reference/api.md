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
- **Optional** on every other `POST`, except six that ignore the header and never record it
  (`x-idempotency: none` in [`openapi.yaml`](openapi.yaml)): the two search endpoints
  (`POST /v1/identities/{identity_id}/search` and `POST /v1/tenants/{tenant_id}/search`), which return
  mail and change nothing, so their results are never stored; the two signing endpoints
  ([`…/assertions`](#post-v1identitiesidentity_idassertions--tenant-or-identity-key-identitiessign) and
  [`…/http-signatures`](#post-v1identitiesidentity_idhttp-signatures--tenant-or-identity-key-identitiessign)),
  because each call signs anew and a replay record would have to store what was signed; and the two
  Amazon SNS endpoints, `POST /hooks/ses` and `POST /hooks/ses/inbound`, which SNS calls without the
  header.
- The header is `Idempotency-Key: <1–255 printable ASCII characters>`. Keys are kept for 30 days. For
  mail they are scoped per identity. For everything else they are scoped per calling API key and per
  tenant (or, for a request that names no tenant, per partner for a partner key and per deployment for a
  platform key), so another key, even of the same tenant, never receives this key's replay.
- The same key with the same request returns the original response, with `"deduplicated": true` in
  mail responses and the header `Idempotent-Replayed: true`.
- A response that carried a one-time secret (`POST /v1/keys`, `POST /v1/keys/{key_id}/rotate`,
  `POST /v1/webhooks`, `POST /v1/tenants/{tenant_id}/webhooks`,
  `POST /v1/webhooks/{webhook_id}/rotate-secret`) is stored without it: a replay returns the same body
  without `secret` and with `"secret_replayed": false`. A secret is shown once, in the first response;
  if it was lost, rotate or revoke ([J19](../project/edge-cases.md)).
- No stored response holds mail content. A response that carries a message or a thread
  (`…/release`, `…/cancel`, `…/resolve`, `…/threads/{thread_id}/hold`) is stored as a reference, and a
  replay reads the resource again with the calling key's visibility (a resource erased since replays its
  `404`). Records belong to the identity they name, so identity and tenant erasure delete them
  ([Data model](../project/design/data-model.md#1-d1-control-plane)).
- The same key with a different request returns `409 idempotency_conflict`.
- The same key while the first request is still running returns `409 request_in_progress` with
  `retryable: true`.

See [Sending and safe retries](../guides/sending.md#safe-retries).

### Rate limits

| Bucket | Default | Scope |
|---|---|---|
| All requests | 600 per minute | per API key |
| Search (`keyword`, `semantic`, `hybrid`, related messages, contacts) | 120 per minute | per API key |
| Agentic search | 20 per minute | per API key, plus a daily tenant cap |
| Send (accepted into queue) | 120 per minute | per identity, plus daily caps from policy |
| Signing (agent assertions and HTTP signatures together, binding `RL_SIGN`) | 600 per minute | per identity |
| Tenant creation and invitations by partner keys (binding `RL_PARTNER`) | 10 per minute, together | per partner, across all its keys |

Every authenticated response includes `RateLimit-Limit`, the limit of the bucket that applied, per period.
A `429 rate_limited` also includes `Retry-After` and `RateLimit-Reset`, both the seconds to the end of the
bucket's current period (other `429` codes, such as `daily_cap_reached`, set `Retry-After` to their own
wait). There is no `RateLimit-Remaining`: Cloudflare's rate-limiting
binding answers only allow or deny, so the service cannot tell how many requests are left.

### Permissions

A key holds a list of permissions. Every endpoint below names the one it needs.

| Permission | Allows |
|---|---|
| `tenants:manage` | Create, update and suspend tenants, and their billing accounts. Platform keys, for every tenant; partner keys, for the tenants their partner's keys created, without changing billing ([Partners](#partners)) |
| `identities:read`, `identities:write` | Read, and create, update, pause or delete identities and addresses, and test forwarding; read, and create, rotate or revoke [identity signing keys](#identity-keys-and-signatures). Deleting an identity also needs `erasure:manage`, because it starts an identity-scope erasure |
| `identities:sign` | Mint agent assertions and Web Bot Auth HTTP signatures as an identity. Tenant and identity keys (an identity key only for its own identity); platform and partner keys cannot hold it |
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
| `keys:manage` | API keys within the caller's scope. A partner key manages only tenant and identity keys of its own tenants |
| `erasure:manage` | Erasure requests, legal holds, exports |
| `suppressions:manage` | Suppressions and allow or block lists |
| `usage:read` | Plan, allowances and usage figures. Every tenant and identity key holds it implicitly for its own workspace, without listing it. Platform and partner keys must hold it explicitly and pass `tenant_id` |
| `audit:read` | Audit log |
| `members:read` | List console members and pending invitations (tenant, partner and platform keys; every console role holds it) |
| `members:manage` | Invite, revoke, change roles and remove console members (tenant, partner and platform keys). Includes `members:read` |
| `partners:manage` | Create, list, read, update and delete partners, the integrators whose partner keys create tenants ([Partners](#partners)). Platform keys only |
| `platform:ops` | Platform operations: signing-key rotation, the dead-letter queue, maintenance jobs, waitlist invitations (platform keys only) |

Key levels limit which resources a key can reach, whatever its permissions. From widest to narrowest:

- A **platform** key reaches every tenant.
- A **partner** key reaches the tenants created with its partner's keys, and its partner's webhook
  endpoints ([Partners](#partners)). It uses `tenant_id` and resource IDs exactly as a platform key does.
  A tenant created by another partner, or by no partner, answers it as a missing one does.
- A **tenant** key reaches its own tenant.
- An **identity** key reaches its own identity. It also reaches the tenant's domains read-only with
  `domains:read`, and the tenant's webhook endpoints and deliveries read-only with `webhooks:read`.

A route or field that needs a higher key level than the caller's returns `403 scope_denied`: for example
an identity key on tenant search, or a partner key on `PATCH /v1/tenants/{tenant_id}/billing` of one of
its own tenants. Wherever this page allows "tenant or platform keys" or says what a platform key passes
(`tenant_id`, filters), a partner key is allowed and passes the same, for its own tenants only.

Some permissions can be held only at some levels. [`POST /v1/keys`](#post-v1keys) refuses a key that
lists one its level cannot hold with `400 invalid_request` and
`details.reason = "permission_not_allowed_for_level"`:

| Permissions | Key levels that can hold them |
|---|---|
| `platform:ops`, `partners:manage` | platform |
| `tenants:manage` | platform, partner |
| `members:read`, `members:manage`, `suppressions:manage`, `audit:read`, `usage:read` | platform, partner, tenant (an identity key holds `usage:read` implicitly for its own workspace, but cannot list it) |
| `identities:sign` | tenant, identity |
| Every other permission | platform, partner, tenant, identity |

There are no wildcard permissions and no implicit full set: every key, platform and partner keys included,
holds the permissions listed when it was created, plus the implicit `usage:read` of tenant and identity keys. A
`POST /v1/keys` without `permissions`, or with an empty list, returns `400 invalid_request`.

### The console and billing routes

These routes are served by the same Worker but are not part of the developer API. None takes an API key:
they use session cookies, OAuth state, unsubscribe tokens, or Stripe, SNS and link signatures instead.

| Route | What it is | In `openapi.yaml` | Design |
|---|---|---|---|
| `/console/*`: the server-rendered console, including `/console/sign-in…` (link and code), `/console/sign-up`, `/console/waitlist`, `/console/workspaces/new`, `/console/oauth/{provider}/start`, `/console/oauth/{provider}/callback`, `/console/settings/security`, `/console/settings/notifications`, `/console/plan/return` and `/console/connect` | Console pages, sign-up and sign-in (session cookies) | No | [Console design](../project/design/console.md), [Cloud sign-up and sign-in](../project/design/cloud-signup.md) |
| `GET /console/notifications/unsubscribe?t={token}`, `POST /console/notifications/unsubscribe?t={token}` | Unsubscribe from a kind of notification email. `GET` shows a confirmation page with a one-click form; `POST` is the RFC 8058 one-click unsubscribe and turns that kind off for that person and workspace. The token `t` is the only authority: no session, no CSRF token or `Origin` check, served even with `PM_CONSOLE=off`. An expired or foreign token changes nothing | No | [Notifications](../project/design/notifications.md#5-the-emails) |
| `/billing/stripe/webhook` | Stripe events (Stripe signature) | No | [Billing design](../project/design/billing.md) |
| `POST /hooks/ses`, `POST /hooks/ses/inbound` | Amazon SES delivery events and inbound mail, through SNS (SNS signature) | Yes | [Signed links and provider hooks](#signed-links-and-provider-hooks) |
| `GET /v1/links/{token}` | Signed downloads (link signature) | Yes | [Signed links and provider hooks](#get-v1linkstoken) |

**Two hosts.** `PM_CONSOLE_HOST` names the console's host and defaults to `PM_API_HOST`, so a deployment
can keep one hostname. When the two differ, console paths (`/console/*`, the unsubscribe pair included)
answer only on `PM_CONSOLE_HOST`, and the API host `PM_API_HOST` serves exactly:

- the REST API, `/v1/*`;
- MCP, `/mcp`;
- `/openapi.json` and `/health`;
- `/.well-known/*` (the security contact, identity JWK Sets and the Web Bot Auth key directory);
- signed links, `/v1/links/*`;
- the provider hooks, `/hooks/*`, and `/billing/stripe/webhook`.

Anything else returns `404`. No cookie is set or read on the API host
([Cloud sign-up › Hostnames](../project/design/cloud-signup.md#2-hostnames)).

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

Any key. Describes the calling key. For a partner key, `level` is `partner`, `partner_id` names its
partner, and `tenant_id` and `identity_id` are `null`.

```json
{
  "key_id": "key_01J9…", "name": "pylota-api", "level": "tenant", "mode": "live",
  "partner_id": null, "tenant_id": "ten_01J9…", "identity_id": null,
  "permissions": ["identities:read", "messages:send", "search:read"],
  "expires_at": null
}
```

---

## Tenants

Keys with `tenants:manage`: a platform key reaches every tenant, and a partner key the tenants its
partner's keys created ([Partners](#partners)). A tenant key can `GET /v1/tenants/{tenant_id}` for its
own tenant; it cannot list tenants or change them.

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
  can have an empty suffix. Every tenant shares the platform domain, so a suffix must not pass for
  someone else ([D12](../project/edge-cases.md)). Its fold (the confusable fold of
  [Identities › Username validation](../project/design/identity-domains.md#username-validation), without the
  dot) is refused with `400 address_reserved` (`details.field = "address_suffix"`) when it equals the fold
  of a reserved username, or of a name in the compiled list `core::address::RESERVED_SUFFIXES`: `pylota`,
  `pylotamail`, `stripe`, `paypal`, `google`, `gmail`, `microsoft`, `outlook`, `apple`, `icloud`, `amazon`,
  `aws`, `cloudflare`, `github`, `hmrc`, `gov`, `govuk`, `dvla`, `police`, `bank`, `visa`, `mastercard`,
  `amex`, `billing`, `payments` and `admin`. A suffix whose fold equals another tenant's (`.acrne` beside
  `.acme`) gets `409 suffix_taken`, enforced by the unique `tenants.suffix_fold`.
- `policy` is merged over the defaults. See [Configuration › Tenant policy](configuration.md#tenant-policy).
- `owner` (optional) creates the workspace's console owner and emails them a sign-in link. Without it, a
  platform or partner key can add an owner later with an invitation and an ownership transfer in the
  console.
- `billing.mode` defaults to `metered` on a deployment with billing on (plan `free`) and to `disabled`
  otherwise.
- **With a partner key**, the new tenant's `partner_id` is the key's partner, for good, and its billing
  mode is the partner's `default_billing_mode`. `billing` is platform-only: a partner key that sends it
  gets `403 scope_denied`. The audit row `tenant.create` records the `partner_id`.
  - `policy` is checked field by field, for the fields sent: a platform-only field, or a lower-only
    field above its ceiling, gets `403 scope_denied` with `details.field`
    ([Configuration › Who may change a field](configuration.md#who-may-change-a-field)). A partner key may
    set `quarantine.key_release` here, at creation.
  - A partner has at most `max_tenants` tenants that are not `erased` (default 25): the next creation
    gets `403 partner_tenant_limit` with `details.max_tenants`. Creations count in `RL_PARTNER` (10 a
    minute per partner, shared with invitations; [Rate limits](#rate-limits)).

Returns `201` with a [Tenant](#tenant-object).

### `GET /v1/tenants` · `GET /v1/tenants/{tenant_id}`

List (filters: `status`, `mode`, `partner_id`; platform and partner keys) and get. A partner key lists
only its own tenants, and keeps reading one while it is `erasing` and after it is `erased`. An unknown
`partner_id`, or for a partner key any partner but its own, returns `404 partner_not_found`.

### `PATCH /v1/tenants/{tenant_id}`

Updatable: `name`, `timezone`, `policy` (deep merge; `null` resets a field to its default), and `status`
(`active` | `suspended`). Suspension behaviour: FR-TEN-3. `partner_id` and `mode` never change. A tenant
key cannot call this route (`403 permission_denied`: it can never hold `tenants:manage`).

- **A partner key** updates only its own tenants, `policy.quarantine.key_release` included. Each policy
  field sent is checked by its class: platform-only fields get `403 scope_denied`, and a lower-only field
  may be set at most to min(deployment default, platform ceiling), otherwise `403 scope_denied` with
  `details.field` ([Configuration › Who may change a field](configuration.md#who-may-change-a-field)), so
  one partner cannot spend the shared sending reputation or AI budget.
- **Operator enforcement stays.** `suspended_by` records who suspended the tenant; a partner key that sets
  `status: "active"` on a tenant a platform key suspended gets `403 scope_denied`
  (`details.field: "status"`). A value a platform key sets on a lower-only field becomes that field's
  ceiling for partner keys ([J17](../project/edge-cases.md)).
- **Erasing and erased tenants.** Once a tenant is `erasing` or `erased`, only the erasure job changes its
  status: a platform key gets `409 tenant_erased`, and any other key gets `404 tenant_not_found` here and
  on every other write to the tenant ([I8](../project/edge-cases.md)).
- **Automatic sending pause.** `sending_paused_at` is set when the tenant's complaint or bounce rate
  reaches the provider's review level ([G12](../project/edge-cases.md)). `"sending_paused": false` lifts
  it, audit-logged; only a platform key may send it (`403 scope_denied`, `details.field:
  "sending_paused"`), and no key can set a pause by hand.

#### Tenant object

```json
{
  "id": "ten_01J9…", "slug": "acme", "name": "Acme Car Hire", "mode": "live", "status": "active",
  "suspended_by": null, "partner_id": null, "address_suffix": ".acme", "timezone": "Europe/London",
  "policy": { "...": "full effective policy" }, "sending_paused_at": null,
  "created_at": "2026-10-09T10:00:00Z", "updated_at": "2026-10-09T10:00:00Z"
}
```

`partner_id` is the partner whose key created the tenant, or `null`; it never changes, also after the
tenant is erased and the partner deleted. `suspended_by` is `platform` or `partner` while the tenant is
suspended, otherwise `null`. Tenants are deleted through an erasure request with `scope: "tenant"`.

---

## Partners

A **partner** is an integrator that creates tenants for its own customers on a shared deployment and
manages them with **partner keys**. On Pylota Mail Cloud, Pylota is a partner: each car-rental operator
is a tenant created with Pylota's partner key, billed `exempt`, and no Pylota key reaches another Cloud
customer ([FR-KEY-4](../project/prd.md#61-tenancy-and-access)). The routes in this section need a
platform key with `partners:manage`, which a partner key can never hold.

### `POST /v1/partners`

```json
{ "name": "Pylota", "default_billing_mode": "exempt", "max_tenants": 25, "ramp_exempt": false }
```

`default_billing_mode` is `exempt` or `metered` (the default). `max_tenants` (default 25) is the most
tenants that are not erased the partner may have. `ramp_exempt` (default `false`) lets its new tenants
skip the new-workspace send ramp, which they otherwise follow whatever their billing mode
([Cloud sign-up › New-workspace send ramp](../project/design/cloud-signup.md#101-new-workspace-send-ramp)).
Returns `201` with a [Partner](#partner-object). Audit-logged (`partner.create`).

### `GET /v1/partners` · `GET /v1/partners/{partner_id}`

List (filter: `status`) and get. An unknown ID returns `404 partner_not_found`; a deleted partner is
returned with `status: "deleted"` and an empty `name`.

### `PATCH /v1/partners/{partner_id}`

Updatable: `name`, `status` (`active` | `suspended`), `default_billing_mode`, `max_tenants` and
`ramp_exempt`. A deleted partner returns `404 partner_not_found`. Audit-logged (`partner.update`).

- Suspending a partner contains it at once: every one of its keys, and every tenant and identity key of
  its tenants, gets `403 partner_suspended` on every route, so nothing can send for those tenants. Their
  status does not change and their inbound mail is still stored. Deliveries to the partner's endpoints
  and to its tenants' endpoints are held, and resume when the partner is `active` again
  ([J13](../project/edge-cases.md)).
- Lowering `max_tenants` below the current count refuses new tenants and changes no existing one.
- A new `default_billing_mode` applies to tenants created afterwards. Existing tenants keep their mode,
  which only a platform key changes ([`PATCH /v1/tenants/{tenant_id}/billing`](#get-v1tenantstenant_idbilling--patch-v1tenantstenant_idbilling--tenantsmanage-platform-key-to-change)).

### `DELETE /v1/partners/{partner_id}`

Returns `204`. While any tenant with this `partner_id` is not `erased` (it is `active`, `suspended` or
`erasing`), it returns `409 partner_has_tenants` with `details.tenants`, how many, and changes nothing:
erase those tenants first (`POST /v1/erasure-requests` with `scope: "tenant"`). Deletion is soft: the
partner stays with `status: "deleted"` and an empty `name`; its partner keys are revoked and deleted, and
its partner webhook endpoints deleted with their deliveries. Its erased tenants keep their `partner_id`.
Audit-logged (`partner.delete`).

#### Partner object

```json
{ "id": "ptn_01JA…", "name": "Pylota", "status": "active", "default_billing_mode": "exempt",
  "max_tenants": 25, "ramp_exempt": false,
  "created_at": "2026-10-10T09:00:00Z", "updated_at": "2026-10-10T09:00:00Z" }
```

A partner holds nothing but its name and these settings. `status` is `active`, `suspended` or `deleted`.

### Partner keys

Only a platform key mints a partner key, with [`POST /v1/keys`](#post-v1keys), `level: "partner"` and
the `partner_id`; only a platform key rotates or revokes one:

```json
{ "name": "pylota-backend", "level": "partner", "partner_id": "ptn_01JA…",
  "permissions": ["tenants:manage", "keys:manage", "webhooks:manage", "quarantine:review", "usage:read",
                  "identities:read", "identities:write", "domains:read", "domains:write", "messages:read",
                  "messages:send", "messages:write", "attachments:read", "search:read", "members:manage"] }
```

A partner key acts only on the tenants its partner's keys created, with `tenant_id` or a resource ID,
exactly as a platform key does:

| Permission | What a partner key can do with it |
|---|---|
| `tenants:manage` | Create tenants (each gets the partner's `partner_id` and `default_billing_mode`; at most `max_tenants`), list, read, update and suspend its own, and read their billing accounts. It never changes a billing account or sends `billing` (`403 scope_denied`), raises a lower-only policy field above its ceiling, sets a platform-only one, or lifts a platform suspension |
| `keys:manage` | Mint, list, rotate and revoke tenant and identity keys of its own tenants. Never a partner or platform key (`403 key_scope_exceeded`) |
| `webhooks:manage`, `webhooks:read` | Partner endpoints (`POST /v1/webhooks` makes one, with `scope: "partner"`), which receive only its own tenants' events, and its tenants' endpoints ([Webhooks](#webhooks)) |
| `quarantine:review` | See and release its tenants' quarantined mail; release by key follows the tenant's `quarantine.key_release` ([Release](#post-v1identitiesidentity_idmessagesmessage_idrelease--quarantinereview)) |
| `usage:read` | Read one of its tenants' usage, with `tenant_id` |
| Every other tenant-level permission | The same as a platform key, on its own tenants: identities and their addresses and signing keys (not `identities:sign`), domains, mail, search, erasure (a `tenant` scope included), suppressions and lists, audit, members |

A partner key can never hold `platform:ops`, `partners:manage` or `identities:sign`, and never reaches
`/v1/platform/*`, `/v1/partners/*`, the platform's webhook endpoints, or any partner or platform key, its
own included (`GET /v1/me` describes it). A tenant created by another partner, or by no partner, and
everything in it, answers `404 …_not_found` exactly as a missing ID does. A suspended partner's keys,
and its tenants' keys, get `403 partner_suspended`. Partner keys are `live`, act on both the `live` and
`test` tenants of their partner, and count against the same [rate-limit buckets](#rate-limits) as
platform keys, keyed by their own key ID, and against `RL_PARTNER`, keyed by the partner, for tenant
creation and invitations.

Whatever the number of its keys, one partner is bounded by `max_tenants` (25 by default) times each
tenant's caps: with the default `tenant_daily_send_cap` of 5,000, at most 125,000 messages a day, and
1,250 while its new tenants are on the send ramp. Only a platform key raises `max_tenants`, a ceiling or
`ramp_exempt` ([Security › Partner keys](../project/design/security.md#partner-keys)).

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

- `username`: stored lower case as `^[a-z0-9][a-z0-9._-]{0,23}$`. The request value is checked by the
  username rules, not by a schema pattern, so each failure has its own code: a reserved or confusable name
  gets `address_reserved`, any other non-ASCII character `address_unsupported`, and anything else that
  does not lower-case to the stored form `address_invalid`.
  `postmaster`, `abuse`, `noreply` and similar are reserved everywhere; the other RFC 2142 role names
  (`support`, `sales`, `info`, `marketing` and the rest) only where they would stand alone on the shared
  platform domain, that is, for the default tenant, whose suffix is empty
  ([Identities and domains](../project/design/identity-domains.md#username-validation)).
- The primary address is `{username}{tenant.address_suffix}@{platform domain}`, or
  `{username}@{domain}` when `domain_id` names a tenant domain that is `healthy` or `degraded`. The full local part must be at
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

Identities the key can reach. Filters: `status` (`active`, `paused`, `deleting` or `deleted`), `purpose`,
and for platform and partner keys `tenant_id`; `status` and `purpose` work as on the tenant's list above. The system
identity that sends `PM_SYSTEM_FROM` mail is never listed.

### `GET /v1/identities/lookup?address=bookings@acme.example.com` — `identities:read`

Resolves any active or retiring address to its identity. Returns `404 identity_not_found` for unknown,
retired or out-of-scope addresses.

### `GET /v1/identities/{identity_id}` — `identities:read`

### `PATCH /v1/identities/{identity_id}` — `identities:write`

Updatable: `display_name`, `purpose`, `owner`, `signature`, `metadata`, `send_policy`, and `status`
(`active` | `paused`). Setting `status: "active"` on an identity paused for `abuse_threshold` needs a
platform, partner or tenant key and is audit-logged; on a tenant a partner's key created it needs a
platform key (`403 scope_denied`, [J17](../project/edge-cases.md)). A `send_policy.daily_cap` above the
tenant's effective `identity_daily_send_cap` needs a platform key (`403 scope_denied` with
`details.field: "send_policy.daily_cap"`); the same applies at creation.

### `DELETE /v1/identities/{identity_id}` — `identities:write` and `erasure:manage`

Returns `202` with an [Erasure request](#erasure-request-object) of scope `identity`. The identity's
addresses are tombstoned and can never be assigned to another identity. Its
[signing keys](#identity-keys-and-signatures) are deleted and their key IDs tombstoned, so a deleted key ID
is never published again ([O7](../project/edge-cases.md)). While the identity is `deleting` or `deleted`,
signing and its JWK Set return `404 identity_not_found`.

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
  "send_policy": { "daily_cap": 500, "auto_reply": "allowed", "require_known_recipient": true },
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

Creates an `alias`. `local_part` follows the username rules for a tenant domain, with a maximum of 40
characters instead of 24 (stored as `^[a-z0-9][a-z0-9._-]{0,39}$`, with the same error codes): role names
such as `support@` are allowed, `postmaster` and `abuse` are not. The status is `pending` until the domain is
`healthy` or `degraded`, then `active`. Only one pending
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

## Identity keys and signatures

An identity can prove who it is outside email: with an **agent assertion**, a short-lived JWT signed by
the identity's own Ed25519 key that any service can check against the identity's JWK Set, and with a
**signed HTTP request** (Web Bot Auth), whose headers let a website tell which agent made the request. The
design is in [Agent signing keys](../project/design/agent-keys.md); the integrator's view is in
[Agents › Agent assertions](../guides/agents.md#agent-assertions).

- Each identity has at most one `active` key, which signs and is published, plus `retiring` keys during
  an overlap after a rotation. A key is created on the identity's first signing request, or with
  `POST …/keys`. Private keys are generated, sealed and used inside the Worker; no endpoint returns them.
- Key management (`…/keys`, rotate, revoke) stays available while the identity is paused, so a suspected
  leak can be handled before it resumes. Signing does not: suspended tenant → `403 tenant_suspended`
  (checked first, as on sends); paused identity → `409 identity_paused`. The JWK Set of either answers
  `404 identity_not_found` until the identity resumes ([O1](../project/edge-cases.md)). A `deleting` or `deleted` identity gets
  `404 identity_not_found` on every route here.
- Creating, rotating and revoking keys is audit-logged (`identity_key.create`, `identity_key.rotate`,
  `identity_key.revoke`) and emits `identity.key_created`, `identity.key_rotated` or
  `identity.key_revoked` ([Webhook events](events.md#identities-and-addresses)).
- Signing needs `identities:sign`, which platform and partner keys cannot hold. Both signing endpoints count against
  the signing rate limit (600 a minute per identity, `429 rate_limited` over it), ignore
  `Idempotency-Key`, and store nothing but a daily count (`assertions` and `http_signatures` in
  [`GET /v1/usage/daily`](#get-v1usagedaily--usageread-platform-partner-or-tenant-key)). Signing is not metered
  against any plan allowance.

### `GET /v1/identities/{identity_id}/keys` — `identities:read`

Every key the identity has, `retired` ones included, newest first. Filter: `status` (`active`,
`retiring` or `retired`). Paginated.

```json
{
  "data": [
    { "kid": "zMkUmAQOlq9JtFPzTK1XINZdWd7gmhXxgA8Ph7cNKHo", "identity_id": "idn_01J9Z3K8V4…",
      "status": "active", "alg": "EdDSA",
      "public_jwk": { "kty": "OKP", "crv": "Ed25519", "x": "NjwMjIq2mTA1VpuDzRvkMIfQ0sCSHWavo0KT_4FcKO0",
                      "kid": "zMkUmAQOlq9JtFPzTK1XINZdWd7gmhXxgA8Ph7cNKHo", "alg": "EdDSA", "use": "sig" },
      "created_at": "2026-10-09T09:00:00Z", "verify_until": null, "retired_at": null },
    { "kid": "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", "identity_id": "idn_01J9Z3K8V4…",
      "status": "retiring", "alg": "EdDSA",
      "public_jwk": { "kty": "OKP", "crv": "Ed25519", "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
                      "kid": "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", "alg": "EdDSA", "use": "sig" },
      "created_at": "2026-10-02T09:00:00Z", "verify_until": "2026-10-16T09:00:00Z", "retired_at": null }
  ],
  "next_cursor": null
}
```

### `POST /v1/identities/{identity_id}/keys` — `identities:write`

No body (an empty `{}` is accepted). Creates the identity's first key and returns it with `201` when it
has no `active` key; otherwise returns the existing active key with `200` and changes nothing. A created
key emits `identity.key_created`, as does a key created lazily by a signing request; the `200` case emits
nothing. A thumbprint found among the key tombstones is never reused: a new seed is drawn instead.
`Idempotency-Key` is optional.

### `POST /v1/identities/{identity_id}/keys/rotate` — `identities:write`

No body. Makes a new key `active` at once and moves the previous active key to `retiring`, with
`verify_until` set to now plus `PM_IDENTITY_KEY_OVERLAP_DAYS` (default 7 days). The retiring key stays
in the JWK Set and no longer signs, so an assertion signed just before the rotation still verifies until
then ([O2](../project/edge-cases.md)). With no active key, it creates the first one and `previous` is
`null`. Emits `identity.key_rotated`. Returns `200`:

```json
{
  "key": { "kid": "zMkUmAQOlq9JtFPzTK1XINZdWd7gmhXxgA8Ph7cNKHo", "status": "active",
           "created_at": "2026-10-09T09:00:00Z", "verify_until": null, "retired_at": null,
           "...": "the rest of the Identity key object" },
  "previous": { "kid": "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", "status": "retiring",
                "created_at": "2026-10-02T09:00:00Z", "verify_until": "2026-10-16T09:00:00Z",
                "retired_at": null, "...": "the rest of the Identity key object" }
}
```

### `POST /v1/identities/{identity_id}/keys/{kid}/revoke` — `identities:write`

No body. Moves the key straight to `retired`, whatever its state, for a suspected compromise. It is gone
from the next JWK Set response, and verifiers cache the set for at most 5 minutes
([O3](../project/edge-cases.md)). Returns `200` with the key (`status: "retired"`, `retired_at` set) and
emits `identity.key_revoked`. A key that is already `retired` is returned unchanged with `200`, and no
event is emitted. An unknown `kid` returns `404 key_not_found`. The row is kept until the identity is
deleted, so its thumbprint is never reused.

#### Identity key object

```json
{
  "kid": "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", "identity_id": "idn_01J9Z3K8V4…",
  "status": "retiring", "alg": "EdDSA",
  "public_jwk": { "kty": "OKP", "crv": "Ed25519", "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
                  "kid": "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", "alg": "EdDSA", "use": "sig" },
  "created_at": "2026-10-02T09:00:00Z", "verify_until": "2026-10-16T09:00:00Z", "retired_at": null
}
```

| Field | Meaning |
|---|---|
| `kid` | The key ID: the base64url RFC 7638 thumbprint of the public JWK (43 characters). It is also the JWS `kid` of every assertion the key signs |
| `status` | `active` (signs and is published; at most one), `retiring` (published, does not sign, until `verify_until`) or `retired` (not published) |
| `alg` | Always `EdDSA` (Ed25519) |
| `public_jwk` | The public key exactly as published in the identity's JWK Set |
| `verify_until` | Set when the key becomes `retiring`: the rotation time plus `PM_IDENTITY_KEY_OVERLAP_DAYS`. Until then the key stays in the JWK Set, unless it is revoked. `null` while `active` |
| `retired_at` | When the key became `retired`, or `null` |

### `POST /v1/identities/{identity_id}/assertions` — tenant or identity key, `identities:sign`

Mints an agent assertion: a JWT signed with the identity's active key. Each call mints a new token, so
`Idempotency-Key` is ignored and never recorded.

```json
{ "audience": "https://portal.supplier.example",
  "expires_in": 300,
  "nonce": "b3f1c2d47a9e",
  "ext": { "booking_ref": "BK-2291" } }
```

| Field | Rules |
|---|---|
| `audience` | Required. 1–256 characters of printable ASCII: a URL or an identifier the verifier expects. Becomes `aud` ([O4](../project/edge-cases.md)) |
| `expires_in` | 60–600 seconds, default 300 ([O5](../project/edge-cases.md)) |
| `nonce` | Optional, 1–128 characters of printable ASCII, copied into the token for the verifier's own challenge |
| `ext` | Optional object, at most 2 KB as JSON, placed under the `ext` claim. Its members cannot use a registered or Pylota claim name (`iss`, `sub`, `aud`, `iat`, `nbf`, `exp`, `jti`, `email`, `email_verified`, `name`, `org`, `accountable_human`, `ai_agent`, `nonce`, `ext`) ([O6](../project/edge-cases.md)) |

Returns `201`:

```json
{ "assertion": "eyJhbGciOiJFZERTQSIsInR5cCI6ImFnZW50LWFzc2VydGlvbitqd3QiLCJraWQiOiJ6TWtVbUFRT2xx…",
  "kid": "zMkUmAQOlq9JtFPzTK1XINZdWd7gmhXxgA8Ph7cNKHo",
  "expires_at": "2026-10-09T12:05:00Z",
  "jwks_uri": "https://mail.example.com/.well-known/jwks/idn_01J9Z3K8V4QW7X2M5N6P8R0T1Y.json" }
```

The token's header is `{"alg":"EdDSA","typ":"agent-assertion+jwt","kid":"<thumbprint>"}`. Its claims:

```json
{ "iss": "https://mail.example.com", "sub": "idn_01J9Z3K8V4QW7X2M5N6P8R0T1Y",
  "aud": "https://portal.supplier.example", "iat": 1791547200, "nbf": 1791547200, "exp": 1791547500,
  "jti": "01M4G8HMG0Z6G25EVAN36PQG0H", "email": "bookings.acme@agents.example", "email_verified": true,
  "name": "Acme Car Hire", "org": "Acme Car Hire", "accountable_human": true, "ai_agent": true,
  "nonce": "b3f1c2d47a9e", "ext": { "booking_ref": "BK-2291" } }
```

- `iss` is `https://{PM_API_HOST}`, `sub` the identity ID, `jti` a new ULID, `email` the identity's
  primary address, `name` its display name and `org` the workspace name.
- `accountable_human` is `true` when the identity has an accountable owner. The owner's name and address
  are never in the token.
- The token is never stored or logged. A verifier checks it as in
  [Agents › Verifying an assertion](../guides/agents.md#verifying-an-assertion): `alg` and `typ`, an
  issuer it trusts, the key from `{iss}/.well-known/jwks/{sub}.json` (cached for at most 5 minutes), the
  signature, `aud`, `nbf` and `exp` with 60 seconds of skew, and `jti` against replays
  ([Agent signing keys § 4.3](../project/design/agent-keys.md#43-how-a-verifier-checks-it)).

Errors: `403 tenant_suspended` (checked first, before `409 identity_paused`), `400 invalid_request`
([O4–O6](../project/edge-cases.md)), `403 permission_denied`, `403 scope_denied`, `404 identity_not_found`,
`409 identity_paused` and `429 rate_limited`.

### `POST /v1/identities/{identity_id}/http-signatures` — tenant or identity key, `identities:sign`

Returns the headers that make an HTTP request a Web Bot Auth signed request (RFC 9421), signed with the
deployment's `web_bot_auth` key, with the identity's address in a signed `From` header. The Worker never
makes the request itself, and nothing is created or stored. `Idempotency-Key` is ignored and never
recorded.

```json
{ "url": "https://www.brightwell.example/fleet/availability?from=2026-10-12",
  "method": "GET",
  "expires_in": 60,
  "components": ["@authority", "signature-agent", "from"] }
```

| Field | Rules |
|---|---|
| `url` | Required, `https` only, at most 2,048 characters. An internationalised host is converted to its A-label for `@authority` ([O10](../project/edge-cases.md)) |
| `method` | Optional, an upper-case token. Signed only if `@method` is in `components`, and then required (`400 invalid_request` without it) |
| `expires_in` | 30–300 seconds, default 60. Too short an expiry fails in transit ([O11](../project/edge-cases.md)) |
| `components` | Optional. Always includes `@authority`, `signature-agent` and `from`; may add `@method`, `@path` and `@query`. Any other component, or one whose value is not ASCII, returns `400 invalid_request` |

Returns `200`:

```json
{ "headers": {
    "Signature-Agent": "\"https://mail.example.com\"",
    "From": "bookings.acme@agents.example",
    "Signature-Input": "sig1=(\"@authority\" \"signature-agent\" \"from\");created=1791547200;expires=1791547260;keyid=\"poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U\";alg=\"ed25519\";nonce=\"e8N7S2MF…\";tag=\"web-bot-auth\"",
    "Signature": "sig1=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:" },
  "expires_at": "2026-10-09T12:01:00Z" }
```

- `Signature-Agent` names the deployment's origin; its key directory is at
  [`/.well-known/http-message-signatures-directory`](#well-known).
- `From` is the identity's primary address (RFC 9110: whoever is responsible for the request).
- `keyid` is the deployment key's JWK thumbprint, `nonce` 64 random bytes (base64), and `tag` is
  `web-bot-auth`.

Signed HTTP requests are off unless the operator sets `PM_WEB_BOT_AUTH=on` (allowed once spike S13 has
passed) and the tenant opts in. While `PM_WEB_BOT_AUTH=off`, this returns `422 web_bot_auth_disabled`
([O9](../project/edge-cases.md)); while tenant policy `web_bot_auth.allowed` is `false`, the default,
`403 policy_denied` ([O13](../project/edge-cases.md);
[Configuration › Tenant policy](configuration.md#tenant-policy)). Other errors as for assertions,
`403 tenant_suspended` first among them. The
operator side is in [Self-hosting › Signed HTTP requests](../self-hosting.md#signed-http-requests-web-bot-auth).

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
  `pmail domains add --local-token` with your own Cloudflare token works instead (catch-all, no literal
  rules).
- **Zone permission** (tenant and partner keys): `cloudflare_zone`, and `replace_mx` with it, work only on
  a zone this deployment created for the tenant (with `nameservers` or `delegated_subdomain`) or one
  listed in the tenant's platform-only policy `domains.cloudflare_zones` (names strictly under a listed
  zone: its apex, and `replace_mx` there, stay platform-only). A zone created for another
  tenant, and any name under the zone of the platform domain, the API host or the console host, is
  refused, for `nameservers` and `delegated_subdomain` too: `403 scope_denied` with
  `details.reason: "zone_not_allowed"`, before anything is changed ([H8](../project/edge-cases.md)).
  Platform keys may use any zone.
- **`nameservers`** creates the zone in this account. Platform keys may always use it; tenant and partner
  keys only when the tenant's policy has `domains.allow_create_zone: true` (otherwise `422 transport_unavailable`,
  `details.reason: "zone_creation_not_allowed"`). Moving the nameservers hands the whole domain to this
  deployment, so when the name has A, AAAA or MX records, or `www` has a CNAME, A or AAAA record, the request
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

The body has `transport`, `smtp`, `sending_paused`, or several. Returns `200` with the domain.
Audit-logged.

**`sending_paused`**, platform keys only (`403 scope_denied` with `details.field: "sending_paused"` for
others): `false` lifts an automatic sending pause of a tenant domain (`sending_paused_at`,
[G12](../project/edge-cases.md)). A paused domain's sends get `409 sending_paused` and never fall back to
the platform domain.

**`transport`**, platform keys only (`403 scope_denied` for others):

```json
{ "transport": "ses" }
```

Switches the transport that sends as a domain on Cloudflare: `cloudflare` or `ses`. This is the Email
Sending failover of [J5](../project/edge-cases.md). `ses` needs the SES transport configured
(`422 transport_unavailable`, `details.reason: "ses_not_configured"`) and an SES identity for the domain
(`ses_region` set). A `cloudflare_zone`, `nameservers` or `delegated_subdomain` domain gets one, with its
three DKIM records, during onboarding when the SES transport is configured; without one the switch gets
`422 transport_unavailable`. A transport the domain's method cannot use returns
`422 transport_unavailable` with `details.reason: "method_not_supported"`: `dns_records` and `send_only`
domains send only through `ses`, `smtp_relay` domains only through `smtp`, and the platform domain only
through `cloudflare`. The change applies to sends that reach the transport after it and starts a health
check at once (alignment differs per transport). A switch that must call SES waits up to 5 seconds for
the deployment's SES control-plane budget (one call per second), then fails with
`429 upstream_rate_limited` and `Retry-After`.

**`smtp`**, tenant, partner or platform keys, `smtp_relay` domains only (otherwise `method_not_supported`):

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
(`pm-retired-{n}`). Returns `202`. `domain.removed` follows with `reason: "requested"`. A removal that
must call SES first waits up to 5 seconds for the deployment's SES control-plane budget, then fails with
`429 upstream_rate_limited` and `Retry-After`, as `PATCH` does.

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
  "delivery_events": "active", "details": null,
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
| `ses_region` | The region of the domain's SES identity: set when `inbound` or `transport` is `ses`, and on a `cloudflare_zone`, `nameservers` or `delegated_subdomain` domain that got an SES identity for the Email Sending failover ([J5](../project/edge-cases.md)) during onboarding; otherwise `null` |
| `mail_from_domain` | `pm-bounce.{name}` on a `dns_records` or `send_only` domain, whose mail SES sends; the local part `pm-bounce` is reserved on such domains. Otherwise `null`, including a Cloudflare-method domain sending through its J5 failover identity after a `PATCH` to `ses`: that identity has no custom MAIL FROM |
| `smtp` | `smtp_relay` only, otherwise `null`: `{ "host", "port", "username", "probe_from" }`. Never the password |
| `probe` | `smtp` transport only, otherwise `null`: `{ "last_at", "result" }`. `result` is `pass` or the issue code of the failure (`smtp_unaligned`, `smtp_from_rewritten`, `smtp_probe_timeout`, `smtp_auth_failed`, `smtp_tls_required`); both are `null` before the first probe |
| `state_reason` | The first issue code, or `zone_expired` on a `nameservers` domain whose zone Cloudflare deleted |
| `delivery_events` | `active` (provider delivery events reach the service), `manual` (a Cloudflare-transport domain created without an event subscription: run `pmail domains subscribe <domain>`; until then statuses stop at `submitted`), or `none` (`sending: false`). See [Identities and domains › Kind `zone`](../project/design/identity-domains.md#kind-zone) |
| `details` | `null`, or `{ "action": "run pmail domains subscribe <domain>" }` while `delivery_events` is `manual`: the operator step that remains |

---

## Threads and messages

### `GET /v1/identities/{identity_id}/threads` — `messages:read`

Filters: `label`, `category`, `needs_reply_gte` (0–1; the search operator `is:needs_reply` uses 0.5),
`is_unread`, `direction` (of the last message), `after`, `before`, `archived` (default `false`). Sorted
by `last_at` descending.

Threads are built from visible mail only: quarantined, hidden and throttled messages are never listed or
counted here, whatever the key's permissions. A key with `quarantine:review` reaches them through the
message list with an explicit `status` filter (below), or the [quarantine list](#quarantine)
(quarantined messages only).

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

`DELETE /v1/identities/{identity_id}/threads/{thread_id}/hold` (`erasure:manage`) removes it. Both are
audit-logged.

### `GET /v1/identities/{identity_id}/messages` — `messages:read`

Filters: `thread_id`, `direction`, `status`, `label`, `after`, `before`. Sorted newest first.

Quarantined, hidden and throttled messages are left out by default, whatever the key's permissions. They
are listed only when the request filters on that status explicitly (`status=quarantined`, `hidden` or
`throttled`) and the key holds `quarantine:review`. A key without it that sends such a filter gets
`200` with none of those messages, never `403`, as search treats `include_quarantined`
([Security design § 5.3](../project/design/security.md#53-cross-level-read-access)).

### `GET /v1/identities/{identity_id}/messages/{message_id}` — `messages:read`

`include` takes `html`, `headers` and `quoted`. A `quarantined`, `hidden` or `throttled` message is
returned only to a key that holds `quarantine:review`; any other key gets `404 message_not_found`, as for
a message that does not exist ([Security](../project/design/security.md)). The same rule applies to its
attachments, their extracted text, its raw MIME and re-running its triage. Reply, reply-all and forward
need `quarantine:review` for a quarantined message and never accept a hidden or throttled one.

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
    "language": "en", "risk_flags": [], "model": "@cf/openai/gpt-oss-20b", "version": 3, "run": 1
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
- `trust.flags` can hold `hidden_text`, `display_name_spoof`, `lookalike_domain`, `reply_to_mismatch`,
  `thread_join_unverified` (a thread join without a valid token: a failed token, or `In-Reply-To` or
  `References` from a sender who is not a participant, [C9](../project/edge-cases.md)) and
  `shared_domain_sender` (the sender is another workspace's address on the shared platform domain,
  [D12](../project/edge-cases.md)).
- `triage.status` is `pending`, `done`, `skipped` or `failed`. `triage.version` is the triage logic
  version that produced the record (it does not change on a re-run); `triage.run` counts completed runs
  (`0` for a record written at ingest). `triage.reason` is present only for
  `skipped` (`allowance`, `policy_disabled`, `not_eligible`, `ai_unavailable`) and `failed` (`invalid_output`,
  `model_unavailable`, `input_unavailable`) ([Triage design](../project/design/triage.md)). For example,
  mail that arrives after the workspace's `triage` allowance is spent is still stored, and its triage is
  skipped with reason `allowance`; the built-in rules' risk flags are kept and the model does not run
  ([W7](../project/edge-cases.md)):
  `{ "status": "skipped", "reason": "allowance", "category": null, "needs_reply": null, "urgency": null, "summary": null, "language": null, "risk_flags": ["unknown_sender"], "model": null, "version": 3, "run": 0 }`.
- `deliveries` is set on outbound messages:
  `[{ "address", "field", "status", "smtp_code", "enhanced_code", "bounce_type", "updated_at" }]`
  (`enhanced_code` is the RFC 3463 code, for example `5.1.1`, when the provider or relay gave one).
- Message-level `flags` include `sent_via_fallback`, `parse_degraded`, `encrypted`,
  `message_id_conflict`, `reprocessed`, `reconciled`, `bcc`, `loopback` (delivered inside the deployment
  for a test tenant, [L3](../project/edge-cases.md)), `body_truncated` (a stored body was cut at its
  storage cap; the full message is in the raw MIME), `sender_suppressed` (the sender is on the tenant's
  suppression list; the message is stored as usual, [D7](../project/edge-cases.md)), `body_redacted`
  (links and codes replaced in a system-identity message, [A15](../project/edge-cases.md)) and
  `dsn_untrusted` (a delivery report that changed no delivery, [D11](../project/edge-cases.md)).
- `headers` (with `include=headers`) is `null` once the raw MIME it is read from is gone (past
  `retention.raw_days`).
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
`Content-Security-Policy: sandbox`. The message's visibility is checked first: an attachment of a
`quarantined`, `hidden` or `throttled` message is `404 message_not_found` without `quarantine:review`.
Then attachments with a `risk` need `quarantine:review` too (`403 permission_denied`).

### `GET /v1/identities/{identity_id}/messages/{message_id}/attachments/{attachment_id}/text` — `attachments:read`

Query: `pages=1-3` (default: all, capped at 200 KB of text).

```json
{ "status": "ready", "pages": [ { "page": 1, "text": "INVOICE 88213 …" } ], "total_pages": 2, "truncated": false }
```

`status` is one of `pending`, `ready`, `unavailable` (extraction failed or unsupported type) or
`skipped` (by policy or risk).

### `POST /v1/identities/{identity_id}/messages/{message_id}/triage` — `messages:write`

Re-runs triage (FR-TRI-5). Returns `202` with no body. A `message.triaged` event follows, and the record
then has the same `version` and a `run` one higher. A message that ingest never triages (quarantined,
hidden, throttled, a delivery report or read receipt, or a system-identity message) gets
`409 triage_not_eligible` with `details.reason` (`quarantined` or `not_eligible`): release a quarantined
message instead, which triages it. Outbound messages get `400 invalid_request`.

### `POST /v1/identities/{identity_id}/messages/{message_id}/release` — `quarantine:review`

```json
{ "reason": "Known supplier, DKIM key rotated" }
```

Moves a quarantined message to `received`, emits `message.released` and runs triage. Audit-logged
(`quarantine.release`, with the key). When `PM_QUARANTINE_KEY_RELEASE` is `off` (Pylota Mail Cloud),
every API key gets `403 permission_denied` and the release has to be done by a person in the console
(FR-CON-6), unless the message's tenant has `policy.quarantine.key_release: true`: then any key with
`quarantine:review` that reaches the message may release it, its partner key included. Only a platform
key, or the partner key of the tenant's own partner, can set that policy
([Configuration › Tenant policy](configuration.md#tenant-policy)).

### `DELETE /v1/identities/{identity_id}/messages/{message_id}` — `erasure:manage`

Returns `202` with an erasure request of scope `message`. If the message's thread is under a legal hold,
it returns `423 legal_hold` and creates nothing (an erasure request of a wider scope skips held threads
instead).

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
    tenant's consent attestation (`"consent": { "basis": "opt_in", "recorded_at": "…" }`), else
    `400 marketing_requirements_missing`. It also needs a sending domain whose transport is `ses` or
    `smtp` (FR-OUT-15): Cloudflare Email Service is for transactional mail only, so a marketing send from
    the platform domain or from a `cloudflare`-transport domain gets `422 transport_unavailable` with
    `details.reason: "marketing_needs_ses"`. The check runs again before transport; a message whose domain
    has changed transport or fallen back to the platform domain by then ends `rejected` with reason
    `marketing_needs_ses`;
  - `auto_reply`, which sets `Auto-Submitted: auto-replied`. It is only allowed in reply to a
    non-automated message.
- **Known recipients** (FR-OUT-13, [E2](../project/edge-cases.md)). By default
  (`send_policy.require_known_recipient: true`) a recipient the identity has never sent to, that no
  send-allow entry names, and that is not the authenticated sender being answered, is not an error: its
  delivery is `suppressed` with `policy: unknown_recipient`. Mail received from an address does not make
  it known. Set `require_known_recipient: false` on an identity that sends to new people by design.
- **Loops and pauses.** Any send whose hop count would reach 10 gets `409 loop_detected`
  (`details.hop`), whatever its `kind` ([N13](../project/edge-cases.md)). A tenant or sending domain whose
  sending was paused automatically gets `409 sending_paused` (`details.scope`: `tenant` or `domain`,
  [G12](../project/edge-cases.md)).
- `thread_id` continues an existing thread without quoting. References are set from the thread.
- `from_address` must be an `active` address of the identity, or a `retiring` one on a thread that
  already uses it (G7; with `thread_id`). Otherwise `400 invalid_request` with
  `details.errors[0].path = "from_address"`. The default is the primary.
- `headers` accepts only `X-` names matching `^X-[A-Za-z0-9_-]+$` (at most 100 bytes), plus the
  allow-listed `Importance`, `Priority`, `Sensitivity`, `Keywords`, `Comments` and `Organization`. Names
  are matched case-insensitively, as Cloudflare matches them: `importance` is accepted and sent as
  `Importance`, `x-booking-ref` as given, and the reserved `X-Pylota-*` and `X-AI-Generated` are refused in
  any case. Any other name gets `400 header_not_allowed`; two names that differ only in case get
  `400 invalid_request`. `Importance` takes `high`, `normal` or `low`,
  `Priority` `normal`, `non-urgent` or `urgent`, and `Sensitivity` `personal`, `private` or
  `company-confidential`; another value gets `400 invalid_request`. These checks run when the request
  arrives, so a bad header never becomes a later `rejected`. Everything else is set by the service.
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

Only while the message is `queued`, no transport attempt is in progress, and no recipient has been sent
to yet. Returns the message with `status: "canceled"`. Otherwise
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
| `rejected` | The transport refused it, at submission or, for some recipients, when the recipient's server rejected it after submission (validation, policy, a definitive recipient-server rejection) | yes |
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
    "sentences": [ { "text": "Yes. Admiral accepted claim 7781 on 2 October…", "citations": ["msg_01JA…", "msg_01JB…"],
                     "citation_trust": "authenticated" } ],
    "confidence": 0.86,
    "untrusted": true
  },
  "evidence": [ { "...": "search hits, as above, with quotes and steering_suspected",
                  "quotes": [ "we are pleased to confirm claim 7781 has been accepted" ], "steering_suspected": false } ],
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
- The answer is model-written text derived from mail (FR-SRCH-13, [F17](../project/edge-cases.md)):
  `answer.untrusted` is always `true`. Each sentence's `citation_trust` is `authenticated` (every cited
  message is outbound or passed authentication) or `partly_authenticated`; a sentence that cites a
  `steering_suspected` message, or no authenticated message, is removed before the response. Treat the
  answer as data to check against `evidence`, never as an instruction.
- Search requests ignore `Idempotency-Key` and are never stored ([Idempotency](#idempotency)). The tenant's
  daily agentic budget counts a request once, after it is validated.
- When tenant policy turns agentic search off, `mode: "agentic"` fails with `422 agentic_disabled`, on
  this endpoint and on tenant search.
- With `stream: true` and `Accept: text/event-stream`, the response is a server-sent event stream:
  `event: step` (each trace entry), `event: evidence` (hits as they are found), `event: answer` and
  `event: done`. A keep-alive comment is sent after every 10 seconds of silence.

### `POST /v1/tenants/{tenant_id}/search` — tenant, partner or platform key, `search:read`

The same body, plus an optional `identity_ids` filter. Runs across every identity of the tenant (up to
100; more returns `422 scope_too_large`), never the deployment's system identity. A partner key reaches
only tenants whose `partner_id` is its partner. Hits carry `identity_id`, and facet counts are summed across
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
message passed authentication (`verdict: pass`). See [E4](../project/edge-cases.md). The handler polls
the mailbox every second and keeps the sender domain registered for unsolicited-OTP detection while it
waits; the full behaviour is in [Inbound › The `wait` handler](../project/design/inbound.md#the-wait-handler-e4).

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

### `POST /v1/webhooks` (platform or partner key) · `POST /v1/tenants/{tenant_id}/webhooks` — `webhooks:manage`

```json
{ "url": "https://api.example.com/webhooks/mail", "events": ["message.received", "message.bounced"],
  "identity_ids": null, "description": "Production API" }
```

Returns `201` with the endpoint and `"secret": "whsec_…"`. **The secret is shown only once**: an
idempotent replay returns the body with `"secret_replayed": false` instead ([Idempotency](#idempotency)).
`events: ["*"]` subscribes to everything, including event types added later. An endpoint's `scope` says
whose events it receives:

| `scope` | Created by | Receives |
|---|---|---|
| `platform` | `POST /v1/webhooks` with a platform key | Every tenant's events |
| `partner` | `POST /v1/webhooks` with a partner key (`partner_id` is set) | Only the events of tenants whose `partner_id` is its partner's |
| `tenant` | `POST /v1/tenants/{tenant_id}/webhooks` | Its tenant's events |

A tenant, a partner and the platform can each have at most 20 endpoints; on both routes, the 21st returns
`422 webhook_limit_reached`. `webhook.disabled` about an endpoint of a partner (a partner endpoint, or a
tenant endpoint of one of its tenants) goes to that partner's other endpoints and to platform endpoints,
never to tenant endpoints ([Webhook events](events.md#privacy-platform-and-webhooks)). While a partner
is suspended, deliveries to its endpoints and its tenants' endpoints are held, and they are delivered
within a minute of its reactivation. Events of the deployment's system identity go to platform endpoints
only.

An endpoint is a way to read mail, so `webhooks:manage` alone is not enough for mail events
([J29](../project/edge-cases.md)): creating an endpoint, changing its `url` or `events`, or replaying to it
needs `messages:read` as well when its `events` include `"*"`, any `message.*` type or
`verification.received`, and `quarantine:review` as well when they include `"*"` or
`message.quarantined`. Otherwise `403 permission_denied` with `details.required`.

### `GET /v1/webhooks` · `GET /v1/tenants/{tenant_id}/webhooks` · `GET|PATCH|DELETE /v1/webhooks/{webhook_id}`

`GET` needs `webhooks:read`; `PATCH` and `DELETE` need `webhooks:manage`. `GET /v1/webhooks` lists the
platform endpoints for a platform key, the partner's endpoints for a partner key, and the tenant's
endpoints for a tenant or identity key. A partner key reaches its partner's endpoints and its tenants'
endpoints by ID; any other endpoint is `404 webhook_not_found` to it.

`PATCH` accepts `url`, `events`, `identity_ids`, `description` and `enabled`. A changed `url` disables the
endpoint with `disabled_reason: "url_changed"` until a test delivery to the new URL succeeds
(`POST …/test`), which re-enables it; `enabled: true` on such an endpoint gets `400 invalid_request`.

### `POST /v1/webhooks/{webhook_id}/rotate-secret`

`{ "overlap_hours": 24 }` (0–168). Returns the new secret once. During the overlap, deliveries carry
both signatures.

### `POST /v1/webhooks/{webhook_id}/test`

Sends a `webhook.test` event straight away and returns the delivery attempt. A `2xx` re-enables an
endpoint disabled with `url_changed`.

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

An event can be replayed for 30 days from its `occurred_at` (or `retention.events_days`, if shorter,
because its payload is gone after that). The window never starts from when a delivery went `dead`, and
older events are not queued. Returns `202` with `{ "queued": 42 }`.

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
- **Send-block**: a listed recipient is not sent to. The send is accepted and that recipient's delivery
  is `suppressed` with `policy: send_block`; a dry run reports `422 recipient_blocked`.
- **Send-allow**: with `policy.send_allowlist_only`, only listed recipients are sent to; the others are
  `suppressed` with `policy: not_on_allowlist`.

---

## API keys — `keys:manage`

### `POST /v1/keys`

```json
{ "name": "bookings-agent", "level": "identity", "tenant_id": "ten_01J9…", "identity_id": "idn_01J9…",
  "permissions": ["messages:read", "messages:send", "search:read", "attachments:read", "identities:sign"],
  "expires_at": "2027-10-09T00:00:00Z" }
```

The new key's level, tenant, identity and permissions must all lie within the caller's own, otherwise
`403 key_scope_exceeded`. A tenant key's `mode` follows its tenant; platform and partner keys are `live`.
Returns `201` with `"secret": "pmk_live_…"`, shown only once: an idempotent replay returns the body with
`"secret_replayed": false` instead ([Idempotency](#idempotency)).

- **Partner keys.** `level: "partner"` needs `partner_id` and no `tenant_id` or `identity_id`, and only
  a platform key may ask for it ([Partner keys](#partner-keys)); an unknown partner is
  `404 partner_not_found`. Other levels refuse `partner_id` (`400 invalid_request`). A partner key mints
  only `tenant` and `identity` keys of its own tenants: a `partner` or `platform` key, or another tenant,
  is `403 key_scope_exceeded`.

- `permissions` is required at every level, `platform` included. There is no implicit full set: a
  missing or empty list returns `400 invalid_request`.
- Each permission must be one the new key's level can hold ([Permissions](#permissions)), whoever the
  caller is, otherwise `400 invalid_request` with `details.reason = "permission_not_allowed_for_level"`: `platform:ops` and
  `partners:manage` only on platform keys; `tenants:manage` only on platform and partner keys;
  `members:read`, `members:manage`, `suppressions:manage`, `audit:read` and `usage:read` never on
  identity keys; `identities:sign` never on platform or partner keys.
- Both checks come before the scope check, so a refused permission is `400`, not `403`.

### `GET /v1/keys` · `GET /v1/keys/{key_id}` · `DELETE /v1/keys/{key_id}`

`DELETE` revokes the key immediately. A partner key lists and reaches only tenant and identity keys of
its own tenants; a partner or platform key ID, its own included, is `404 key_not_found` to it. Minting
and revoking are audit-logged (`key.create`, `key.revoke`).

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
| `identity` | `identity_id` | The whole mailbox and the identity's signing keys. Its addresses and key IDs are tombstoned |
| `tenant` | none | Everything in the tenant, every identity's signing keys included (their key IDs are tombstoned). Then the tenant is marked `erased` |

Held threads are skipped and listed in the receipt (FR-PRV-4): an erasure request is never refused
because of a hold (it never returns `423 legal_hold`). The request's `status` is `queued`, `running`,
`completed`, `completed_with_holds` (finished, but at least one held thread was skipped), `failed`, or
`canceled` (a tenant erasure superseded it). Returns `202` with the object below. A `tenant` request for
a tenant already `erasing` returns the existing request with `200` (same `era_` ID); for an `erased`
tenant it returns `409 tenant_erased` ([I8](../project/edge-cases.md)):

#### Erasure request object

```json
{
  "id": "era_01J9…", "tenant_id": "ten_01J9…", "scope": "counterparty", "status": "completed",
  "created_at": "…", "completed_at": "…", "created_by_key_id": "key_01J9…",
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
`erasure.completed` event is emitted. The partner key of an erased tenant's partner can still read the
tenant's erasure requests and their receipts.

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

`status` is `queued`, `running`, `completed`, `failed`, `canceled` (a tenant erasure superseded it) or
`expired`. The finished export has
`download_url`: a [signed link](#get-v1linkstoken) valid until `expires_at` (7 days) to a ZIP holding
one `.eml` per message plus `messages.json`. The link is minted again on each `GET`. An
`export.completed` event is emitted.

---

## Usage and audit

### `GET /v1/usage` — `usage:read` (implicit for tenant and identity keys on their own workspace)

The workspace's plan and the state of every allowance in the current period. Agents read it to know their
limits before they hit `402 billing_limit`. Every tenant and identity key holds `usage:read` implicitly
for its own workspace, so it can always call this. A platform or partner key must hold `usage:read`
explicitly and must pass `tenant_id` (a partner key, one of its own tenants); without `tenant_id` it gets
`400 invalid_request`. The MCP tool `mail_get_usage` is hidden from platform and partner keys.

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
  the real `used` with `granted: null`, `remaining: null` and `unlimited: true`).
- `used` for `storage_gb` is measured, rounded up, and refreshed at least hourly.
- `granted` includes top-ups. `plans` is the whole catalog from `PM_PLAN_CATALOG`.

### `GET /v1/usage/daily` — `usage:read`, platform, partner or tenant key

Query: `tenant_id` (platform and partner keys), `from`, `to` (dates, at most 92 days apart). A tenant key
holds `usage:read` implicitly for its own tenant; platform and partner keys need it explicitly.

```json
{ "data": [ { "day": "2026-10-08", "inbound": 312, "outbound": 128, "sends": 141, "triage": 298,
  "search": 940, "agentic": 41, "assertions": 57, "http_signatures": 0, "ai_neurons": 18233,
  "storage_bytes": 2147483648 } ] }
```

`assertions` and `http_signatures` count the agent assertions and HTTP signatures made that day. They
are counts only: signing is not metered against any plan allowance.

### `GET /v1/plans` — no auth

The plan catalog, as in `plans` above. Returns `{ "billing_enabled": false, "data": [] }` on a deployment
without billing.

### `GET /v1/tenants/{tenant_id}/billing` · `PATCH /v1/tenants/{tenant_id}/billing` — `tenants:manage`, platform key to change

Read or change a workspace's billing account. A partner key with `tenants:manage` may read the billing
account of its own tenants; `PATCH` is platform-only, so a partner key gets `403 scope_denied` on its own
tenant (only a platform key changes a partnered tenant's billing mode). `PATCH` accepts `mode` (`metered`, `exempt`, `disabled`) and,
for workspaces without a Stripe subscription, `plan_id` (a complimentary plan). Plans paid through Stripe
change only through Stripe (`409 plan_managed_by_stripe`). Audit-logged. Both return:

```json
{ "tenant_id": "ten_01J9…", "mode": "metered",
  "plan": { "plan_id": "developer", "status": "active", "current_period_end": "2026-11-01T00:00:00Z",
            "cancel_at_period_end": false },
  "topups": { "inboxes": 0, "sends": 2, "triage": 0 } }
```

### `GET /v1/audit-events` — `audit:read`

Filters: `tenant_id`, `actor_key_id`, `action`, `target_id`, `after`, `before`. Newest first. A partner
key reads the rows of its own tenants only; rows about a partner itself (`partner.*`, and the
`key.create` and `key.revoke` rows of partner keys, which have no `tenant_id`) are for platform keys.

```json
{ "data": [ { "id": "aud_01JA…", "tenant_id": "ten_01J9…", "actor_key_id": "key_01J9…",
  "actor_user_id": null, "action": "quarantine.release", "target_type": "message", "target_id": "msg_01JA…",
  "details": {}, "request_id": "req_01JA…", "created_at": "…" } ], "next_cursor": null }
```

Audit rows cover administrative actions: keys (`key.create`, `key.rotate`, `key.revoke`), partners
(`partner.create`, `partner.update`, `partner.delete`), tenants (`tenant.create`, with the `partner_id`
when a partner key created it), identity status, identity signing keys
(`identity_key.create`, `identity_key.rotate`, `identity_key.revoke`), quarantine releases, holds,
suppression removals, erasure, resolve, members, billing, and platform operations. **Sends are not
audit rows**: each send is recorded by its message, its events (`message.sent` and the delivery events)
and its per-recipient delivery log. To review what a key sent, list the outbound messages of the
identities it reaches for the period; request logs also carry the key ID for 7 days.

---

## Members

Console users of a workspace. The console is the main way to manage them; these endpoints let an
integrator provision people (for example, the owner of each customer workspace).

### `GET /v1/tenants/{tenant_id}/members` — `members:read`

Not paginated: a workspace's members and pending invitations are bounded by its seats.

```json
{ "data": [ { "user_id": "usr_01JA…", "email": "sam@acmecarhire.example", "name": "Sam Patel",
  "role": "owner", "last_login_at": "…", "created_at": "…" } ], "invitations": [ { "id": "inv_01JA…",
  "email": "kim@acmecarhire.example", "role": "member", "invited_by": "usr_01JA…", "expires_at": "…" } ],
  "seats": { "granted": 2, "used": 2 } }
```

### `POST /v1/tenants/{tenant_id}/invitations` — `members:manage`

`{ "email": "kim@acmecarhire.example", "role": "member" }`. Sends an invitation email from the deployment's
system identity (`PM_SYSTEM_FROM`), also when the console is off (`PM_CONSOLE=off`). A pending invitation uses a seat; with no seat left the request fails with
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
| `web_bot_auth` | Web Bot Auth HTTP signatures and the [key directory](#well-known). Its `kid` is the key's 43-character JWK thumbprint, not one character | 7 days, during which it stays in the key directory |

Generates a new key inside the Worker and makes it current. No body. Rotating `web_bot_auth` while
`PM_WEB_BOT_AUTH=off` returns `422 web_bot_auth_disabled` ([O9](../project/edge-cases.md)). Returns `200`:

```json
{ "purpose": "thread", "kid": "4", "created_at": "2026-10-09T10:00:00Z",
  "previous": { "kid": "3", "verify_until": "2027-01-07T10:00:00Z", "revoked": false } }
```

`previous` is `null` when the purpose had no key yet; the rotation then creates the first one.

**`?revoke_previous=true`** deletes the previous key in the same D1 batch, so what it signed stops
verifying at once: thread tokens fall back to header threading; open links, console sign-in tokens,
invitations, sessions and OAuth flows under it fail; open search cursors fail with `400 invalid_request`;
a previous `web_bot_auth` key leaves the key directory. The response then has `previous.verify_until`
equal to the rotation time and `previous.revoked: true`.
Without it, a leaked key keeps verifying for its window. After a suspected leak, rotate with
`revoke_previous=true`, then rotate `PM_MASTER_KEY`. The audit action is `signing_key.rotate` for every
purpose, `web_bot_auth` included, with `details.revoke_previous`.

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

Served on the API host, with no API key.

| Path | Content |
|---|---|
| `/.well-known/security.txt` | Security contact (from `PM_SECURITY_CONTACT`) |
| `/.well-known/jwks/{identity_id}.json` | The identity's JWK Set: its `active` and `retiring` signing keys, which verify its [agent assertions](#post-v1identitiesidentity_idassertions--tenant-or-identity-key-identitiessign). `Content-Type: application/jwk-set+json`, `Cache-Control: public, max-age=300`. An unknown, `deleting`, `deleted`, paused or suspended identity gets `404 identity_not_found` ([O1](../project/edge-cases.md)) |
| `/.well-known/http-message-signatures-directory` | The Web Bot Auth key directory: the deployment's `active` and `retiring` keys (at most three) as a JWK Set. `Content-Type: application/http-message-signatures-directory+json`, `Cache-Control: max-age=86400`. The response is signed once per listed key (`Signature-Input` and `Signature`, tag `http-message-signatures-directory`, component `("@authority";req)`), so a copy served elsewhere does not verify ([O12](../project/edge-cases.md)). `404 key_not_found` while `PM_WEB_BOT_AUTH=off` |

An identity's JWK Set during the overlap after a rotation (the first key is `active`, the second
`retiring`):

```json
{ "keys": [
  { "kty": "OKP", "crv": "Ed25519", "x": "NjwMjIq2mTA1VpuDzRvkMIfQ0sCSHWavo0KT_4FcKO0",
    "kid": "zMkUmAQOlq9JtFPzTK1XINZdWd7gmhXxgA8Ph7cNKHo", "alg": "EdDSA", "use": "sig" },
  { "kty": "OKP", "crv": "Ed25519", "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    "kid": "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", "alg": "EdDSA", "use": "sig" } ] }
```

Identity IDs are ULIDs, never derived from addresses, so the JWK Set path cannot be used to test
whether an address exists. Registering the key directory with Cloudflare's verified-bot programme is an
optional operator step ([Self-hosting › Signed HTTP requests](../self-hosting.md#signed-http-requests-web-bot-auth));
signatures verify for any Web Bot Auth verifier without it.
