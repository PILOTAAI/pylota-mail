# Console and workspaces

Binding design for the console at `/console`, and for the workspaces, members, roles, invitations, sign-in
and sessions behind it. It implements FR-CON-1 to FR-CON-7, FR-CON-16, NFR-CON-1, build plan milestone
M21, and the edge-case rows W9–W10, W15–W18, W40 and W43 in the [edge-case register](../edge-cases.md); and the console parts
of agent signing keys (FR-IDN-6, M25), of notifications (FR-CON-14, FR-CON-15, M26; rows O17–O19), of the
workspace policy page (FR-TEN-4, [Workspace policy](workspace-policy.md)) and of the service sign-up ledger
(FR-IDN-10, M27, [Service sign-up ledger](service-accounts.md)). The plan and usage
page and everything about money is in [Plans, metering and billing](billing.md). Self-serve sign-up,
Google and GitHub sign-in, two-step verification, the landing rules and the Overview (FR-CON-8 to
FR-CON-13) are in [Cloud sign-up, sign-in and first run](cloud-signup.md), which extends this design.

| | |
|---|---|
| Code | `crates/worker/src/console/{mod.rs, router.rs, session.rs, signin.rs, csrf.rs, layout.rs, pages/*.rs}` (`pages/notifications.rs` for the settings screen), `crates/worker/src/members/{mod.rs, invitations.rs, roles.rs}`, `handlers/members.rs`, `crates/worker/src/notify/unsubscribe.rs` |
| Tables | D1 `users`, `members`, `invitations`, `login_tokens`, `sessions` ([Data model](data-model.md#1-d1-control-plane)); `oauth_identities`, `oauth_states`, `pending_auth`, `waitlist` ([Cloud sign-up §11](cloud-signup.md#11-data-model)); `notification_prefs` ([Notifications §2](notifications.md#2-preferences)); `identity_keys` ([Agent signing keys §8](agent-keys.md#8-data-model)) |
| Configuration | `PM_CONSOLE`, `PM_SIGNUP`, `PM_NOTIFICATIONS` ([Configuration](../../reference/configuration.md#variables)); also `PM_CONSOLE_HOST` and `PM_SYSTEM_FROM`, which are top-level settings read with the console off; binding `RL_SIGNIN` ([Bindings](../../reference/configuration.md#bindings)) |
| Contracts | Members and invitations endpoints and the `members:read` and `members:manage` permissions ([REST API](../../reference/api.md#members)); `member.*` events ([Webhook events](../../reference/events.md#workspaces-members-and-billing)); `409 owner_required`, `402 billing_limit` ([Errors](../../reference/errors.md)) |
| Limits | [Limits › Console](../../reference/limits.md#console) |
| External facts verified on 2026-10-09 | The Fetch Standard's "append a request `Origin` header" algorithm (fetch.spec.whatwg.org) |

## What the console is

The console is for the people who run the agents. Agents keep using the REST API and MCP. The console
holds the views a person needs to check on them, and the actions that should need a person: keys,
domains, members, quarantine release and billing ([PRD §4](../prd.md#4-goals-and-non-goals)). It is not a
webmail client: it has no compose or reply form.

- **Same Worker.** `fetch` routes `/console` and `/console/*` to `console::router`. With `PM_CONSOLE=off`
  those routes are not registered and answer `404` with the standard envelope (FR-CON-7), except two
  pairs that mail links to: the invitation-accept pair ([Invitations](#invitations)) and the unsubscribe
  pair, `GET` and `POST /console/notifications/unsubscribe` ([Unsubscribe links](#unsubscribe-links)), so
  the `List-Unsubscribe` header of every notification works. The members API, invitation emails and
  notifications keep working.
- **Its own host, if configured.** The console is served on `PM_CONSOLE_HOST`, which defaults to
  `PM_API_HOST`. When the two differ, console paths answer only on the console host and API paths (REST
  `/v1/*` with signed links `/v1/links/*`, MCP `/mcp`, `/openapi.json`, `/health`, `/.well-known/*`,
  `/hooks/*` and `/billing/stripe/webhook`) only on the API host; anything else gets `404`, and no
  cookie is set or read on the API host ([Cloud sign-up §2](cloud-signup.md#2-hostnames)).
- **Rendered on the server in Rust** with `maud` templates (`layout.rs`, `pages/*.rs`). Pages are HTML and
  one stylesheet, `/console/assets/console.css`. There is no JavaScript, no web font, and no request to
  another origin (FR-CON-1). `maud` is pinned at `=0.27.0` in [Rust workspace](rust-workspace.md).
- **Forms only.** Every state change is a `POST` from a `<form>` with a CSRF token ([CSRF](#csrf)). A `GET`
  never changes state. Lists paginate with links that carry the API's `cursor`.
- **Same services as the API.** A console handler calls the same internal service functions as the REST
  handler for that action, with a session principal instead of an API key:

  ```rust
  pub enum Principal {
      Key(ResolvedKey),                                     // REST and MCP
      Session { user_id: String, tenant_id: String, role: Role, permissions: PermissionSet },
  }
  ```

  The permissions come from the member's role ([Roles](#roles)). For every level check a session acts as a
  **tenant-level** principal of its workspace (`level = tenant`, `tenant_id` the session's): it may do
  what a tenant key holding the same permissions may do (tenant search, `resume` of an abuse pause,
  tenant-scope erasure, `nameservers` when policy allows it), and never what needs a platform key. Unlike a
  key it is a person, so it may take the decisions reserved for people (release, loosening a guard field,
  approving a service sign-up) whatever `PM_QUARANTINE_KEY_RELEASE` says
  ([Workspace policy §3](workspace-policy.md#3-decisions-reserved-for-people)).
  Validation, error codes, idempotency, metering and audit are therefore identical to the API's.
- **Budget.** Server render time p95 ≤ 300 ms (NFR-CON-1). A page makes at most one D1 query for the
  session, then the same calls the API would make.

## Workspaces

A workspace is a tenant (FR-CON-2). Everything in it (identities, domains, keys, webhooks, plan) belongs
to that tenant, and its scope always comes from the session, never from a form field ([W18]).

- A workspace has exactly one owner and any number of members up to its seat limit. The unique partial
  index `members_one_owner` (`ON members(tenant_id) WHERE role = 'owner'`) makes a second owner
  impossible at the database level.
- A person (`users` row) can belong to several workspaces. The session's `tenant_id` is the active one;
  `/console/workspaces` lists the others and switches with a `POST`.
- Workspaces are created by `POST /v1/tenants` with `owner` (a platform key), which creates the `users`
  row if needed, adds the owner and emails a sign-in link. A self-hosted deployment creates its first owner
  on the default tenant with `pmail setup --owner-email` (FR-CON-7). Where `PM_SIGNUP` is `waitlist` or
  `open` (Pylota Mail Cloud), people also create their own workspace at `/console/workspaces/new`
  ([Cloud sign-up §6](cloud-signup.md#6-sign-up)).
- Test tenants are workspaces too. Their mail goes to the simulator as usual; the console marks them with a
  "Test" badge.
- There is no cross-workspace administration view in v1.0. Platform operators use platform keys and the
  CLI.

## Roles

Four roles, with these permissions in the console. The second table lists the API permissions that each
role's session principal holds, so the same checks run as for an API key.

| Action | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| Read inboxes, threads, messages and attachments; keyword, semantic and hybrid search | Yes | Yes | Yes | Yes |
| Agentic search | Yes | Yes | Yes | No |
| Labels, read state, re-run triage | Yes | Yes | Yes | No |
| See quarantined mail and release it (sensitive) | Yes | Yes | Yes | No |
| Create, pause and resume identities | Yes | Yes | No | No |
| See an identity's signing keys and its JWKS link | Yes | Yes | Yes | Yes |
| Create, rotate and revoke an identity's signing keys (sensitive) | Yes | Yes | No | No |
| See domains, their health and DNS records | Yes | Yes | Yes | Yes |
| Add, verify and remove domains (add and remove are sensitive) | Yes | Yes | No | No |
| Webhook endpoints: create, edit, rotate the secret, replay | Yes | Yes | No | No |
| API keys: list, create (sensitive), revoke | Yes | Yes | No | No |
| Erasure and legal holds (sensitive): message, thread, counterparty and identity scope | Yes | Yes | No | No |
| Delete the workspace (tenant-scope erasure, sensitive) | Yes | No | No | No |
| See members and pending invitations | Yes | Yes | Yes | Yes |
| Invite, revoke invitations, change roles, remove members (sensitive) | Yes | Yes, except anything that touches the owner | No | No |
| Transfer ownership to an admin (sensitive) | Yes | No | No | No |
| See plan and usage | Yes | Yes | Yes | Yes |
| Upgrade, buy top-ups, open the Customer Portal (sensitive) | Yes | No | No | No |
| See the audit log | Yes | Yes | No | No |
| See the workspace policy | Yes | Yes | Yes | Yes |
| Change the workspace policy (sensitive), within its ceilings ([Workspace policy](workspace-policy.md)) | Yes | Yes | No | No |
| See service sign-up requests and their decisions | Yes | Yes | Yes | No |
| Approve a service sign-up (sensitive); reject, close or delete one | Yes | Yes | No | No |
| Your own notification settings for this workspace | Yes | Yes | Yes | Yes |
| Leave the workspace | No: transfer ownership first | Yes | Yes | Yes |

| Role | Permission set of the session principal |
|---|---|
| `owner` | Every tenant-level permission: `identities:read`, `identities:write`, `identities:sign`, `domains:read`, `domains:write`, `messages:read`, `messages:send`, `messages:write`, `attachments:read`, `search:read`, `search:agentic`, `quarantine:review`, `webhooks:read`, `webhooks:manage`, `keys:manage`, `erasure:manage`, `tenants:erase`, `suppressions:manage`, `usage:read`, `audit:read`, `members:read`, `members:manage`, `policy:write`, `accounts:request`, `accounts:approve`; plus the console-only owner rights: billing, ownership transfer, deleting the workspace, and the workspace settings below |
| `admin` | The owner's tenant-level permissions (`identities:sign` included) except `tenants:erase`, without the console-only owner rights. Its `erasure:manage` covers every scope except `tenant`, which needs `tenants:erase` in the console's tenant-erasure route as in the API, so neither an admin nor a key an admin mints can delete the workspace ([W35](../edge-cases.md)) |
| `member` | `identities:read`, `domains:read`, `messages:read`, `messages:write`, `attachments:read`, `search:read`, `search:agentic`, `quarantine:review`, `usage:read`, `members:read`, `accounts:request` (the console offers it only the accounts list) |
| `viewer` | `identities:read`, `domains:read`, `messages:read`, `attachments:read`, `search:read`, `usage:read`, `members:read` |

Rules:

- **One owner.** The owner cannot leave, be removed, or have their role changed; each attempt returns
  `409 owner_required` ([W10]). Ownership moves only by a transfer to an existing admin
  ([Members](#members)).
- **Admins and the owner.** An admin can manage admins, members and viewers, but cannot change the owner
  or make anyone owner.
- **Keys from the console** are tenant-level or identity-level, never partner- or platform-level, and can never hold a
  permission the session lacks (FR-KEY-1). Owners and admins hold `identities:sign`, so they can create
  API keys that sign as an identity; members and viewers cannot. The level rules of
  [Security §4.6](security.md#46-creating-keys-fr-key-1) apply as in the API: an identity-level key never
  carries a tenant-only permission (`members:read`, `members:manage`, `suppressions:manage`,
  `audit:read`, `usage:read`), so the key form does not offer them for that level. Each key minted here
  records the person and their role (`api_keys.created_by_user_id` and `created_by_role`); only the owner's
  form offers `tenants:erase`, on tenant-level keys
  ([Security › Who minted a key](security.md#who-minted-a-key)).
- **Tenant policy** is changed by owners and admins on `/console/settings/policy`, which calls the same
  `policy::write` service as `PATCH /v1/tenants/{tenant_id}/policy` with the session as a person
  ([Workspace policy §6](workspace-policy.md#6-the-console-page)): free fields, lower-only fields up to their
  ceilings (the deployment's, the platform operator's and, for a partner's workspace, the partner's), and the
  guard fields. Platform-only fields and `quarantine.key_release` are shown read-only to every role; members
  and viewers see the whole policy read-only. Each save is a sensitive action, and a change that deletes mail
  (shorter retention) asks for a second, confirmed `POST`.
- **Workspace settings** (name, time zone, `require_two_factor`) are console-only owner rights, like
  billing: the settings form posts to a console handler that checks `role = owner` and updates exactly
  those three columns of `tenants`, with an audit row. It never calls `PATCH /v1/tenants/{tenant_id}`
  and never touches the fields that need a key with `tenants:manage` (`status`, `mode`, `slug`,
  `address_suffix`, billing); the policy has its own page, above.
- **Members list.** Every role can see members and pending invitations, through
  `GET /v1/tenants/{tenant_id}/members`, which needs `members:read` (included in `members:manage`).
- **Quarantine release** is possible for a signed-in person with the role above. On Pylota Mail Cloud
  (`PM_QUARANTINE_KEY_RELEASE=off`) no API key can release, except in a workspace whose policy has
  `quarantine.key_release: true`, which only a platform key or the workspace's partner key can set (so a
  partner such as Pylota can release from its own review screen); a self-hosted deployment can also allow
  keys with `quarantine:review` everywhere (`on`, its default) (FR-CON-6).
- **Every handler checks the role**, through the console's route table, which registers each route with its
  required permission exactly like the API's deny-by-default table
  ([Security](security.md#51-deny-by-default-router-table)). A viewer's `POST` to a write route gets `403`,
  and a resource ID from another workspace gets the same `404` as a missing one ([W18]).

## Sign-in

Sign-in is passwordless (FR-CON-3). One request sends one email with both a magic link and a six-digit
code; either signs the person in, once.

Two more ways are designed in [Cloud sign-up](cloud-signup.md#3-sign-in-methods):

- **Continue with Google or GitHub** (FR-CON-9), on when the deployment has that provider's client ID and
  secret. Only a verified email is accepted, and it links to an existing person with the same address
  ([Cloud sign-up §4](cloud-signup.md#4-google-and-github)).
- **Two-step verification** with an authenticator app (FR-CON-10), optional per person and required by a
  workspace that sets `require_two_factor`. It is asked for after any first factor, before the session is
  created ([Cloud sign-up §5](cloud-signup.md#5-two-step-verification)).

Every method ends in the same session creation ([Sessions](#sessions)), and the landing page is chosen by
[Cloud sign-up §7](cloud-signup.md#7-where-people-land).

| Limit | Value |
|---|---|
| Link or code requests | 3 per 10 minutes per address |
| Code verification attempts | 10 per code; the token is burned after 10 failures |
| Failed codes per address | 30 per UTC day across all of the address's tokens; then sign-in by code is locked for that address until the next UTC day, links keep working, and the person is told once ([W43](../edge-cases.md)) |
| Requests per client network | `RL_SIGNIN`: 10 per 60 seconds, keyed by `CF-Connecting-IP` (an IPv6 address by its /64 prefix), on `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-in/verify`, `/console/sign-up` and `/console/waitlist`, and `GET /console/oauth/{provider}/start` |
| Two-step verification codes | 5 attempts a minute per person; 10 failures in a row lock two-step sign-in for 15 minutes |
| Link and code lifetime | 10 minutes, single use (using one burns the other) |
| Session lifetime | 7 days rolling, 30 days absolute |
| Re-authentication for sensitive actions | Signed in within the last 10 minutes |

### Requesting a link or code

`POST /console/sign-in` with `email`:

1. Normalise the address (lower case, IDNA A-label domain) and validate it.
2. If `login_tokens` already has 3 rows for this address created in the last 10 minutes, answer the
   "too many requests, wait 10 minutes" page. The page is the same whether the address is known or not.
3. Insert a `login_tokens` row with `purpose = 'sign_in'`: a 32-byte random link token and a six-digit
   code from the platform RNG (uniform, by rejection sampling), stored only as `token_hash` and
   `code_hash`, keyed hashes under the
   current `link` signing key, whose kid goes in `key_kid` ([Keyed hashes](#keyed-hashes)), with
   `expires_at = now + 10 minutes`. The row is written for every address, known or not, so the limits
   behave the same.
4. Answer `200` with the "check your email" page, which holds the code form.
5. After the response (`wait_until`), send the email only if the address belongs to an `active` user
   (with or without a workspace: a person who signed up and has not created a workspace yet must be able
   to come back, [Cloud sign-up §7](cloud-signup.md#7-where-people-land)), or has a pending invitation,
   and only within the system-mail budgets ([Cloud sign-up §10.2](cloud-signup.md#102-system-mail-budgets)).
   Otherwise send nothing. The request form carries the form ticket of
   [Cloud sign-up §6.2](cloud-signup.md#62-after-launch-open-sign-up); a request without a valid one sends
   nothing.

The email goes through the normal outbound pipeline from the **system identity**
([Identities and domains › The system identity](identity-domains.md#the-system-identity)), whose address
is `PM_SYSTEM_FROM` (default `Pylota Mail <no-reply@{PM_PLATFORM_DOMAIN}>`) and whose tenant is the
default tenant (billing `disabled` or `exempt`, so it is never metered),
with `Idempotency-Key: signin:{login_token_id}`; tests use the simulator (build plan M21). It contains the
link `https://{PM_CONSOLE_HOST}/console/sign-in/link?t=<token>`, the code, and the request time. It never
says whether the address has an account.

Doing the lookup and the send after the response keeps the response identical in content and timing for
registered and unregistered addresses ([W15]).

### Using the link

`GET /console/sign-in/link?t=…` changes nothing. It shows a page with one **Sign in** button, which
`POST`s the token. Mail security scanners often open links in email; because the `GET` does not consume
the token, a scanner cannot burn it.

The `POST` hashes the token and looks for a row that is unexpired, unused and has fewer than 10 attempts.
What success does depends on the row's `purpose` ([Sign-up and waitlist tokens](#sign-up-and-waitlist-tokens)).
For `sign_in` it sets `used_at`, creates the `users` row if the address only had a pending invitation, and
sets `last_login_at`. When the person is enrolled in two-step verification it starts the pending step
([Cloud sign-up §5.1](cloud-signup.md#51-the-pending-step)) and creates no session; otherwise it creates a
session. Either way the person ends at the page chosen by
[Cloud sign-up §7](cloud-signup.md#7-where-people-land) (normally `/console`). Signing in never accepts an
invitation by itself ([Invitations](#invitations)).

### Using the code

`POST /console/sign-in/code` with `email` and `code` computes `HMAC(link key {key_kid}, email || code)`
for each unexpired, unused token of the address (at most three) and compares it in constant time with
that row's `code_hash`. A failure increments `attempts` on each of them; a token reaching 10 is burned.
Success continues as for the link.

Each token allows 10 attempts, and each address 30 failed codes per UTC day: before comparing, the
handler reads `SUM(attempts)` over the address's `login_tokens` rows created since 00:00 UTC (rows are
kept 24 hours after they expire, so the day is complete). At 30 it refuses every code for that address
until the next UTC day, with a page that says to use the link in the email instead, and compares nothing.
The failure that reaches 30 also sends the `account` email `sign_in_codes_locked` when the address
belongs to an active user (nothing is sent for an unknown address, so the lock reveals nothing)
([W43](../edge-cases.md)). Without this, one client network could try about 4,300 codes a day
(`RL_SIGNIN` × 3 tokens × 10 attempts) against one address. On top of the per-address limits, the
Workers rate-limiting binding `RL_SIGNIN` ([Configuration › Bindings](../../reference/configuration.md#bindings))
allows 10 requests per 60 seconds per client network, keyed by `CF-Connecting-IP` with an IPv6 address
counted by its /64 prefix, on `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`,
`/console/sign-in/verify`, `/console/sign-up` and `/console/waitlist`, and on
`GET /console/oauth/{provider}/start`, whose every hit writes an `oauth_states` row
([Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud)).

### Sign-up and waitlist tokens

Sign-up and the waitlist use the same `login_tokens` machinery, limits and email, with another
`purpose` ([Cloud sign-up §6](cloud-signup.md#6-sign-up)):

| `purpose` | Written by | Sent to an address with no account | Using the link or code |
|---|---|---|---|
| `sign_in` | `POST /console/sign-in`, and `/console/reauth` | Never (step 5 above) | Signs in |
| `sign_up` | `POST /console/sign-up`, with `plan`, the validated `next` (`next_path`) and `terms_version` = `PM_TERMS_VERSION` from the required checkbox | Yes, when `PM_SIGNUP=open`, or when the request carries a valid waitlist invite for that address ([Cloud sign-up §6.1](cloud-signup.md#61-before-launch-the-waitlist)); otherwise nothing is sent | Creates the `users` row, copying `terms_version` and setting `terms_accepted_at` to the token's `created_at`, then signs in and lands as [Cloud sign-up §7](cloud-signup.md#7-where-people-land) says, carrying `plan`. An address that already has an account is signed in and its accepted terms are updated |
| `waitlist` | `POST /console/waitlist`, with the plan of interest in `plan` | Yes (double opt-in) | Writes the `waitlist` row with `confirmed_at` = now; no account, no session |
| `oauth_link` | The Google or GitHub callback, when the verified address belongs to an existing person not yet linked to that provider identity ([Cloud sign-up §4](cloud-signup.md#4-google-and-github)) | Never: the address has an account | Only through `POST /console/sign-in/verify` with the matching `pending_auth` row: links the identity. The link in the email only opens that page |

The response of `POST /console/sign-up` and `POST /console/waitlist` is the same page whatever happens to
the address, as for sign-in ([W15]), and the send happens after the response. The link and code routes
(`/console/sign-in/link`, `/console/sign-in/code`) serve all three purposes.

### Keyed hashes

Link tokens, codes, invitation tokens, session cookies, pending-step cookies (`__Host-pm_pending`) and
OAuth `state` values (with their `__Host-pm_oauth` cookie values) are never stored. Each table keeps
`HMAC-SHA256(link key {kid}, value)`
and the `key_kid` it used, where the link key is the Worker-generated `signing_keys` key of purpose `link`
([Configuration › Thread and link keys](../../reference/configuration.md#thread-and-link-keys)). Tokens and
cookie values start with that one-character kid, so the Worker knows which key to hash with. For OAuth,
`oauth_states.state_hash` and `cookie_hash` are hashed this way, with `oauth_states.key_kid`
([Cloud sign-up §4](cloud-signup.md#4-google-and-github)).

After `POST /v1/platform/keys/link/rotate`, the old kid keeps verifying for 7 days. Codes and sign-in links
live 10 minutes, OAuth flows 10 minutes and invitations 7 days, so they are unaffected. A session whose
`key_kid` is not the current one is re-hashed under the current key on its next request (new `id_hash` and
`key_kid` in one `UPDATE`), so active sessions survive a rotation; a session idle for the whole 7 days ends,
as its rolling lifetime would. With `?revoke_previous=true` the old kid is deleted at once: every sign-in
token, invitation, OAuth flow and session hashed under it stops working, and people sign in again
([Security › Rotation procedures](security.md#62-rotation-procedures)).

`login_tokens` rows hold a clear address, so the daily maintenance deletes them 24 hours after they expire.

## Sessions

| Property | Value |
|---|---|
| Cookie | `__Host-pm_session=<value>; Path=/; Secure; HttpOnly; SameSite=Lax` ([W16]) |
| Value | The link key's kid, then 32 random bytes in base64url. Only `id_hash` and `key_kid` are stored ([Keyed hashes](#keyed-hashes)) |
| Lifetime | `expires_at = min(last_seen_at + 7 days, authenticated_at + 30 days)` |
| `last_seen_at` | Updated at most once a minute, which also moves `expires_at` |
| `csrf_secret` | 32 random bytes per session |
| `user_agent_hint` | Browser family only (for the "your sessions" list), never the full header |

The REST API and `/mcp` never read this cookie; they authenticate API keys only. The cookie is set by
`PM_CONSOLE_HOST`; when that differs from `PM_API_HOST`, no cookie is set or read on the API host.

Every console request loads the session, the user and the member row for the active workspace in one D1
query:

```sql
SELECT s.user_id, s.tenant_id, s.csrf_secret, s.authenticated_at, s.last_seen_at, u.email, m.role,
       u.totp_enabled_at, t.require_two_factor
FROM sessions s
JOIN users u ON u.id = s.user_id AND u.status = 'active'
LEFT JOIN members m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id
LEFT JOIN tenants t ON t.id = s.tenant_id
WHERE s.id_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2;
```

No row: redirect to `/console/sign-in`. A session whose active workspace has no member row (the person
was removed) is sent to the workspace picker, so a removed member can never act in that workspace, even
in a request that was already in flight. When `require_two_factor` is `1` and `totp_enabled_at` is
`NULL`, only enrolment, the workspace picker, `/console/settings` and sign-out answer, on every request,
and every other route redirects to enrolment ([Cloud sign-up §5](cloud-signup.md#5-two-step-verification)).
A session is created only by the last step of a sign-in, so no session ever exists for an enrolled
person who has not passed the second factor ([Cloud sign-up §5.1](cloud-signup.md#51-the-pending-step)).

**Sign-out** sets `revoked_at` and clears the cookie. **Sign out everywhere** (settings) revokes every
session of the user. Revoked and expired rows are deleted 30 days later.

### Re-authentication

Sensitive actions require a sign-in within the last 10 minutes and write an audit row (FR-CON-5):
creating keys, creating, rotating or revoking an identity's signing keys, inviting or removing members,
changing roles, transferring ownership, adding or removing domains, releasing quarantine, erasure and
legal holds, saving the workspace policy, approving a service sign-up, and billing (Checkout and the
Customer Portal). Confirming your address after a notification
bounce is audited but needs no recent sign-in, because the re-authentication code would go to the
suppressed address ([Notification settings](#notification-settings)).

If `authenticated_at` is older, the `POST` answers `303` to `/console/reauth?next=<path>`. That page sends a
code to the signed-in address (a new `login_tokens` row, counted in the same limits), and also asks for a
two-step verification code when the person is enrolled. A correct code creates a new session (new cookie, `authenticated_at = now`) and revokes the old one, then answers `303` to
`next`, which must be a path under `/console/`. The person submits the action again; the console never
replays a form on its own.

## CSRF

Three layers, all required ([W16]):

1. **Token.** Every form has a hidden `_csrf` field: `base64url(HMAC-SHA256(csrf_secret, "console-form"))`.
   A `POST` without it, or with a different value (constant-time comparison), gets `403`.
2. **Origin.** Every `POST` must carry an `Origin` header equal to `https://{PM_CONSOLE_HOST}` (which is
   `https://{PM_API_HOST}` by default). A missing header, `null`, or any other value gets `403`. The rule
   has no exception, also not in tests: the local harness serves the console over HTTPS with
   `PM_CONSOLE_HOST = "console.localhost:8799"`, so the browser's `Origin` is
   `https://console.localhost:8799` and matches ([Testing › What cargo xtask itest does](testing.md#61-what-cargo-xtask-itest-does)).
   Chromium is reported not to keep `__Host-` cookies set over plain `http://localhost`
   (httpwg/http-extensions issue 2605, seen 2026-10-10; not tested here), so the harness uses HTTPS
   rather than a relaxed rule.
3. **Cookie.** `SameSite=Lax`, so cross-site `POST`s carry no session at all.

The forms used before a session exists (sign-in, code, link, the pending step at
`/console/sign-in/verify`, invitation acceptance, sign-up, waitlist) are checked by `Origin` alone; they
cannot act as a signed-in person. The OAuth callback is a `GET` from
the provider and is bound to the browser by its `state` and `__Host-pm_oauth` cookie instead
([Cloud sign-up §4](cloud-signup.md#4-google-and-github)).

The unsubscribe pair (`GET` and `POST /console/notifications/unsubscribe`) is exempt from all three
layers: it needs no session, and its `POST` is checked by neither the CSRF token nor `Origin`, because a
mail provider sends the RFC 8058 one-click `POST` with neither ([W16](../edge-cases.md)). The token in
the URL is its only authority, and it can only turn one notification kind off for one person in one
workspace ([Unsubscribe links](#unsubscribe-links)).

Console pages are served with `Referrer-Policy: same-origin`, not the API's `no-referrer`. The Fetch
Standard sets the `Origin` header of a non-CORS `POST` to `null` when the page's referrer policy is
`no-referrer`, which would make every legitimate form submission fail the check above.

Other console response headers: `Content-Security-Policy: default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and
`Strict-Transport-Security: max-age=31536000`. There is no script source at all. `'unsafe-inline'` for
styles is there for sanitised mail, which uses inline styles and inherits the page's policy inside its
`srcdoc` frame.

## Showing untrusted mail

Mail content is untrusted ([Security](security.md#8-untrusted-content)). The console shows it so that it
cannot act ([W17]):

- The default view is text: `extracted_text`, or the full `text`, HTML-escaped.
- The HTML view puts the sanitised HTML (sanitised at ingest) in `<iframe sandbox srcdoc="…">`. The
  `sandbox` attribute has no tokens, so the frame runs no scripts, has no same-origin access, submits no
  forms, opens no pop-ups and cannot navigate the page.
- Remote images are not loaded: the policy allows images only from the console itself and `data:`. `cid:`
  images are embedded as `data:` URIs when the message is rendered: an inline part whose sniffed type is
  `image/png`, `image/jpeg`, `image/gif` or `image/webp`, at most 2 MiB each and 8 MiB per message, read
  through the same service as the API's attachment route. Others show a placeholder that links to the
  attachment route below. They are not fetched from a console URL, because the token-less sandboxed
  `srcdoc` frame has an opaque origin, so its requests may count as cross-site and carry no
  `SameSite=Lax` session cookie (RFC 6265bis draft §5.2.1, read 2026-10-10; not tested in a browser here).
  A **Load remote images** link re-renders that one message with `img-src https:` after a warning that
  the sender may learn the mail was opened.
- **Attachments** are downloaded from the console host, never the API host (the API needs a key and
  answers `Cross-Origin-Resource-Policy: same-origin`):
  `GET /console/inboxes/{idn}/messages/{msg}/attachments/{att}`, session-authenticated, with the
  `attachments:read` permission (every role), the workspace from the session and the same `404` for a
  foreign ID ([W18]). It calls the same service function as `GET …/attachments/{attachment_id}` and
  answers with the serving headers of [Security § 8.5](security.md#85-serving-attachments-and-raw-mime)
  (`Content-Disposition: attachment`, `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`,
  `Cache-Control: private, no-store`). A message in quarantine serves none of its attachments.
- Quarantined messages show the text view and the quarantine reason only. Risky attachments are never
  offered for preview.
- Display names, subjects and filenames are always escaped; links in text view are not made clickable.

## Invitations

Members are invited by email (FR-CON-4). The owner and admins can invite, from the console or with
`POST /v1/tenants/{id}/invitations` (`members:manage`).

1. Validate the address and the role (`admin`, `member` or `viewer`). An address that is already a member
   is refused with `400 invalid_request`, and so is an address this deployment hosts (path `email`;
   [Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud), [W45](../edge-cases.md)). The
   workspace's invitation budget comes next: at most 50 invitation emails (new and re-sent) per tenant per
   UTC day, counted by the system-mail budgets; past it the request gets `429 daily_cap_reached` with
   `details.cap: "invitations"` and `details.resets_at`, before anything is written
   ([Cloud sign-up §10.2](cloud-signup.md#102-system-mail-budgets), [W44](../edge-cases.md)).
2. If a pending invitation for the address exists (`invitations_pending` is unique per workspace and
   address), it is re-sent instead: new token, `expires_at` restarted, no new seat.
3. Take a `seats` hold in `TenantQuota` (`ref` = the new `inv_` ID). With no seat left the request fails
   with `402 billing_limit` and `details.feature: "seats"`, before anything is written ([W8],
   [Billing](billing.md#what-the-worker-meters)).
4. Insert the invitation (`token_hash` and `key_kid` as in [Keyed hashes](#keyed-hashes),
   `expires_at = now + 7 days`) with its audit row and `member.invited` event in one D1 batch, then settle
   the hold.
5. Email the link `https://{PM_CONSOLE_HOST}/console/invitations/accept?t=<token>` from the system
   identity, as for sign-in. The email says who invited the person: the inviter's name from
   `invitations.invited_by` (the signed-in user; `NULL` when an API key created the invitation, and then the
   workspace name alone). This works with `PM_CONSOLE=off` too: `PM_CONSOLE_HOST` and
   `PM_SYSTEM_FROM` are top-level settings, and with the console off the router still registers the two
   invitation routes (`GET` and `POST /console/invitations/accept`). Accepting there creates the user
   and the membership and shows "You are now a member of {workspace}"; no session is created, because
   the deployment has no console to sign in to.

A pending invitation counts as a seat until it is accepted, revoked or expires.

**Accepting** is always an explicit click, and it never creates a session that skips a factor
(FR-CON-16, [W40](../edge-cases.md)). The link was sent to the invited address, so it proves control of
that address, which is a first factor and nothing more:

- `GET /console/invitations/accept?t=…` changes nothing. It shows the workspace name and the role with an
  **Accept** button (a form `POST` of the token) and, where enabled, **Accept with Google** and **Accept
  with GitHub** ([Cloud sign-up §4](cloud-signup.md#4-google-and-github)).
- The `POST` checks the token (pending, unexpired). When the browser already has a session of the
  invited person, the invitation is accepted in that session. When it has a session of another person,
  the page says whose session it is and offers sign-out; nothing is accepted. Otherwise:
  - **No `users` row, or a person without two-step verification**: one D1 batch creates the `users` row if
    needed, inserts the `members` row with the invited role, marks the invitation `accepted` and creates
    a session with the new workspace active, as an email sign-in link would.
  - **A person enrolled in two-step verification**: nothing is accepted yet. The handler starts the
    pending step with `invitation_id` set ([Cloud sign-up §5.1](cloud-signup.md#51-the-pending-step));
    only when the second factor passes are the membership inserted, the invitation marked `accepted` and
    the session created, in one batch. An abandoned step leaves the invitation pending, so its link
    still works until `expires_at`.
- **Signing in never accepts.** A person who signs in another way with a pending invitation lands on
  `/console/invitations` when they have no workspace, or sees it in the workspace picker and as an
  Overview banner otherwise; each invitation there has its own **Accept** form
  (`POST /console/invitations/{invitation_id}/accept`, session and CSRF token, the invitation's address
  equal to the session's), which inserts the membership in the current session.

The seat taken by the invitation becomes the member's seat; `TenantQuota` does not change. Event
`member.joined`. With `PM_CONSOLE=off`, the `POST` creates the user and the membership and creates no
session in any case, so no second factor is involved.

**Revoking** (`DELETE /v1/tenants/{id}/invitations/{inv}` or the console) sets `revoked` and releases the
seat (`Adjust −1`). **Expiry**: the hourly roll-up sets `expired` on pending invitations past `expires_at`
and releases their seats; acceptance also checks `expires_at`, so a late click never works.

## Members

**Changing a role** (owner or admin, sensitive) updates `members.role` and emits `member.role_changed`.
It takes effect on the person's next request, because the role is read on every request. In the same D1
batch, every key of the workspace whose `created_by_user_id` is that person and that holds a permission
the new role lacks is revoked (`key.revoke`, `details.reason = "creator_role_changed"`); their other keys
get the new `created_by_role` ([W36](../edge-cases.md)).

**Removing a member** (owner or admin, sensitive; `DELETE /v1/tenants/{id}/members/{user_id}`) and
**leaving** run one D1 batch: delete the `members` row, delete the person's `notification_prefs` rows
for this workspace, revoke every session of that user whose active workspace is this one, revoke every
key of the workspace whose `created_by_user_id` is that user (a `key.revoke` audit row each,
`details.reason = "creator_removed"`, [W36](../edge-cases.md)), write the audit row and the
`member.removed` event. Then the seat is released with `Adjust −1`; if that call is
lost, the hourly reconciliation corrects the count. After the batch the handler calls
`NotifierRequest::MemberRemoved { user_id }` on the workspace's Notifier, which drops the person's
pending notifications in this workspace, so nothing more is sent to them about it ([O19](../edge-cases.md),
[Notifications §2](notifications.md#2-preferences)). The person's next request
redirects to sign-in ([W9]). The owner cannot be removed and cannot leave (`409 owner_required`, [W10]).

**Transferring ownership** (owner only, sensitive) to an existing admin. One D1 batch, in this order,
because the unique index on the owner is checked statement by statement:

```sql
-- ?1 tenant, ?2 current owner, ?3 target admin
UPDATE members SET role = 'admin'
WHERE tenant_id = ?1 AND user_id = ?2 AND role = 'owner'
  AND EXISTS (SELECT 1 FROM members WHERE tenant_id = ?1 AND user_id = ?3 AND role = 'admin');
UPDATE members SET role = 'owner'
WHERE tenant_id = ?1 AND user_id = ?3 AND role = 'admin'
  AND NOT EXISTS (SELECT 1 FROM members WHERE tenant_id = ?1 AND role = 'owner');
```

Both statements change one row, or neither does (the target is not an admin): then the request returns
`400 invalid_request` ("the new owner must be an admin of this workspace") and the workspace still has
its owner. The batch also writes the audit row
`member.ownership_transfer` and two `member.role_changed` events, and applies the role-change rule above to
the former owner, now an admin: their keys holding `tenants:erase` are revoked. Stripe's customer email does not change;
the new owner can update it in the Customer Portal. After the batch commits, the handler sends the
`account` email ([Account emails](#account-emails)).

## Identity signing keys

The identity page `/console/inboxes/{idn}` has a **Signing keys** section for the identity's agent
signing keys ([Agent signing keys](agent-keys.md)). It calls the same service functions as the API's
identity-key routes:

| Action | Who | Same as |
|---|---|---|
| List every key (kid, `status`, `created_at`, `verify_until`, `retired_at`) and show the JWKS link `https://{PM_API_HOST}/.well-known/jwks/{identity_id}.json` | All roles (`identities:read`) | `GET /v1/identities/{identity_id}/keys` |
| Create the first key | Owner, admin (`identities:write`); sensitive | `POST /v1/identities/{identity_id}/keys` |
| Rotate: a new active key, the previous one `retiring` until `verify_until` | Owner, admin; sensitive | `POST /v1/identities/{identity_id}/keys/rotate` |
| Revoke one key at once | Owner, admin; sensitive | `POST /v1/identities/{identity_id}/keys/{kid}/revoke` |

- Each change needs a recent sign-in ([Re-authentication](#re-authentication)), writes the audit row
  `identity_key.create`, `identity_key.rotate` or `identity_key.revoke` (the actions the API writes) and
  emits the matching `identity.key_*` event. A create that finds an active key, or a revoke of a key
  that is already `retired`, changes nothing and writes no audit row or event.
- Key management stays available while the identity is paused, so a suspected leak can be handled before
  it resumes; the page says that a paused identity's JWKS is withdrawn and that it cannot sign.
- The page shows public data only. No private key is ever displayed, and the console has no form that
  mints an assertion or a signed request: agents sign through the API and MCP.

## Notifications

People get email about their workspace: usage alerts, new mail in inboxes they follow, the daily list of
things that need a person, and `account` emails ([Notifications](notifications.md)). The console owns the
preferences, the unsubscribe links and the `account` emails its own handlers trigger.

### Notification settings

`/console/settings/notifications` sets the signed-in person's own preferences for the active workspace,
one `notification_prefs` row per kind ([Notifications §2](notifications.md#2-preferences)). Every role
can open it. Nobody can change another person's preferences, and there is no API for them: API keys are
not people.

| Kind | Choices on the page | Default (no row) |
|---|---|---|
| `usage` | `off` or `instant` | `instant` for owner and admin; `off` for member and viewer |
| `new_mail` | `off`, `instant`, `hourly` or `daily`; the inboxes to follow (every inbox, or chosen ones); the filter (`all`, or only messages triage marks `needs_reply`) | `off` |
| `needs_person` | `off` or `daily` | `daily` for owner and admin; `off` for member and viewer |
| `account` | Always on, shown read-only | On |

- **Saving** is a `POST` with the CSRF token; it is not a sensitive action. It upserts the row for
  `(user_id, tenant_id, kind)` with the user and workspace taken from the session, never from the form
  ([W18]). A mode the kind does not accept, or an inbox ID outside the workspace, is refused like any
  invalid or foreign value; the system identity is never offered. A kind with no row follows the default
  of the person's current role.
- **Bounce banner.** A hard bounce or complaint on a notification sets `paused_reason` on every
  preference of the person in every workspace ([O17](../edge-cases.md)). Every console page then shows a
  banner, and this page explains it with a **Confirm my address** button. Confirming needs the session
  but not a recent sign-in: re-authentication codes, like every message from the system identity, are
  not delivered to the suppressed address. One D1 batch clears `paused_reason` on all of the person's rows, removes the system
  identity's suppression of their address (the default tenant's `suppressions` row for it) and writes
  the audit row `user.notifications_resume`.
- **Cap notice.** When the person's daily cap (50) or the workspace's (200) has been reached, the page
  says so: further notifications that day go into the next daily digest ([O24](../edge-cases.md)).
- **When notifications are off.** With `PM_NOTIFICATIONS=off`, or while the workspace is suspended, the
  page says that only `account` emails are sent ([O26](../edge-cases.md)). With `PM_BILLING=off`, it says
  that no usage alerts are sent and hides the `usage` choice ([O23](../edge-cases.md)).

### Unsubscribe links

Every `usage`, `new_mail`, `needs_person` and `digest` email carries
`List-Unsubscribe: <https://{PM_CONSOLE_HOST}/console/notifications/unsubscribe?t={token}>` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). The token (a MAC under the current `link`
key with its kid, binding the person, the workspace and the kind, valid 90 days) is defined in
[Notifications §5](notifications.md#5-the-emails).

| Route | Does |
|---|---|
| `GET /console/notifications/unsubscribe?t=…` | Changes nothing. With a valid token it shows the workspace and the kind with one **Unsubscribe** button, a form that `POST`s to the same URL. A mail scanner that opens the link unsubscribes no one |
| `POST /console/notifications/unsubscribe?t=…` | Verifies the token and sets that kind to `off` for that person and workspace (an upsert of the `notification_prefs` row), then shows a confirmation page with a link to the settings page. A `digest` token performs three upserts, setting `usage`, `new_mail` and `needs_person` to `off`, because the digest has no row of its own: the `notification_prefs` kind `CHECK` stays those three kinds. This is the request a mail provider sends for a one-click unsubscribe |

- No session is needed and none is created. Both routes are exempt from the CSRF token and `Origin`
  check ([CSRF](#csrf)), and both are served even with `PM_CONSOLE=off`.
- An expired, altered or foreign token (another person's, another workspace's, or one whose `link` key
  has left its 7-day verify window after a rotation) changes nothing and gets the same page, linking to
  `/console/settings/notifications`, whichever check failed ([O18](../edge-cases.md)).
- It is not a sensitive action and writes no audit row: it only turns a notification off, as the person
  asked. `account` emails have no unsubscribe header.

### Account emails

`account` emails cannot be turned off ([Notifications §1](notifications.md#1-kinds)). The code that
performs one of these actions calls `NotifierRequest::Account { user_id, event }` after its D1 batch
commits, on the `Notifier` chosen by the one rule of [Notifications § 3](notifications.md#3-how-notifications-are-produced):
the person's last-used workspace (`users.last_tenant_id`); when that is unset or gone, the workspace
where the event happened; for an event in no workspace, the default tenant.

| Event (`AccountEvent`) | Called by | Sent to |
|---|---|---|
| `two_factor_disabled` | `/console/settings/security`, in `console/totp.rs` ([Cloud sign-up §5](cloud-signup.md#5-two-step-verification)) | The person |
| `sign_in_method_linked` | The pending step, in `console/pending.rs`, when the emailed code links a Google or GitHub identity to an existing person ([Cloud sign-up §5.1](cloud-signup.md#51-the-pending-step)) | The person |
| `ownership_transferred` | The ownership transfer in `members/mod.rs` ([Members](#members)) | The previous owner and the new owner |
| `payment_failed` | The billing webhook, in `billing/webhook.rs`, when the status becomes `past_due` ([Billing › Applying state](billing.md#applying-state)) | The owner |
| `sign_in_codes_locked` | The code route, in `console/signin.rs`, when an address reaches 30 failed codes in a UTC day ([Using the code](#using-the-code)) | The person, once per lock |

`account` emails are sent with `PM_NOTIFICATIONS=off`, to a suspended workspace, past the daily caps and
while a person's other preferences are paused.

## Screens

| Path | Screen | Who |
|---|---|---|
| `/console/sign-in` | Email form, plus "Continue with Google" and "Continue with GitHub" where enabled; then the "check your email" page with the code form | Anyone |
| `/console/sign-in/link` | Confirm sign-in from the email link | Anyone with a link |
| `/console/sign-in/verify` | The pending step: the second factor, or the code that confirms linking a Google or GitHub identity ([Cloud sign-up §5.1](cloud-signup.md#51-the-pending-step)) | Anyone with a `__Host-pm_pending` cookie |
| `/console/sign-up` | Sign-up with Google, GitHub or an email address, and the terms checkbox (`PM_SIGNUP=open`, or `?invite={token}` from a waitlist invite while `PM_SIGNUP=waitlist`; [Cloud sign-up §6](cloud-signup.md#6-sign-up)) | Anyone |
| `/console/waitlist` | Join the waitlist, with double opt-in (`PM_SIGNUP=waitlist`; [Cloud sign-up §6.1](cloud-signup.md#61-before-launch-the-waitlist)) | Anyone |
| `/console/oauth/{provider}/start`, `/console/oauth/{provider}/callback` | Redirects to and from Google or GitHub; no page of their own ([Cloud sign-up §4](cloud-signup.md#4-google-and-github)) | Anyone |
| `/console/invitations/accept` | Accept an invitation: the Accept button, or Accept with Google or GitHub | Anyone with a link |
| `/console/invitations` | The signed-in person's pending invitations, each with its own Accept form | Signed in |
| `/console/notifications/unsubscribe` | Confirm and apply a one-click unsubscribe from a notification kind ([Unsubscribe links](#unsubscribe-links)) | Anyone with a link; no session |
| `/console/reauth` | Confirm it is you, with a code (and a two-step code when enrolled) | Signed in |
| `/console/workspaces` | Workspace picker and switcher | Signed in |
| `/console/workspaces/new` | Create your workspace: name, address suffix, time zone ([Cloud sign-up §6.2](cloud-signup.md#62-after-launch-open-sign-up)) | Signed in, with no workspace or pending invitation, when sign-up is open or the person has a valid waitlist invite |
| `/console` | Overview, the workspace home: banners, the first-run checklist, "Needs a person", usage meters, inboxes and recent activity ([Cloud sign-up §8](cloud-signup.md#8-the-overview-the-screen-people-land-on)). M21 builds a plain home first (the workspace name, the frame and its navigation, and a link to each screen), which M24 replaces with the Overview | All roles (viewers without action buttons) |
| `/console/connect` | Connect your agent: the `claude mcp add` line, `.mcp.json`, a `curl` request and `pmail login`, with a key ID filled in, never a secret | Owner, admin |
| `/console/inboxes`, `/console/inboxes/{idn}` | Identities with their addresses and status; one identity's threads with triage, and its signing keys with the JWKS link ([Identity signing keys](#identity-signing-keys)) | All roles. Create, rotate and revoke signing keys: owner, admin |
| `/console/inboxes/{idn}/threads/{thr}` | A thread; each message in text view, HTML on request ([Showing untrusted mail](#showing-untrusted-mail)) | All roles |
| `/console/inboxes/{idn}/messages/{msg}/attachments/{att}` | Download one attachment, with the API's serving headers ([Showing untrusted mail](#showing-untrusted-mail)) | All roles |
| `/console/search` | Search one identity or the whole workspace, with facets; agentic answers with citations | All roles (agentic: not viewers) |
| `/console/quarantine` | Quarantined mail with reasons; release | Owner, admin, member |
| `/console/keys` | Keys with scope and last use; create (the secret is shown once); revoke | Owner, admin |
| `/console/domains`, `/console/domains/{dom}` | Domains, health and issues, DNS records read from the provider API; add, verify, remove | View: all roles. Change: owner, admin |
| `/console/webhooks` | Endpoints, recent deliveries, rotate secret, replay | Owner, admin |
| `/console/members` | Members, pending invitations, seats used; invite, resend, revoke, change role, remove, transfer ownership, leave | View: all roles. Change: owner, admin. Transfer: owner |
| `/console/plan` | Plan, a meter per allowance, upgrade, top-ups, manage billing ([Billing](billing.md#checkout)) | View: all roles. Buy: owner |
| `/console/plan/return` | Return from Stripe Checkout: confirms the plan once the webhook has applied it ([Cloud sign-up §9](cloud-signup.md#9-coming-back-from-checkout)) | Owner |
| `/console/audit` | Audit log with filters | Owner, admin |
| `/console/accounts` | Service sign-up requests: pending first, with inbox, service, sender domains, account identifier, purpose (escaped) and status; approve (re-authentication), reject, close, delete; a link to quarantined `account_unapproved` mail ([Service sign-up ledger §8](service-accounts.md#8-console)) | View: owner, admin, member. Change: owner, admin |
| `/console/settings/policy` | The workspace policy, grouped by area, each field with its limit or the reason it is read-only; the form for owners and admins, and the confirmation step for changes that delete mail ([Workspace policy §6](workspace-policy.md#6-the-console-page)) | View: all roles. Change: owner, admin |
| `/console/settings` | Your name and sessions; the terms version you accepted and when (`users.terms_version`, `terms_accepted_at`; "not recorded" for people who joined by invitation before sign-up opened); delete your account; workspace name, time zone and `require_two_factor` (owner only, through the console-only owner handler; never the platform-only tenant fields), and a link to the policy page | All roles |
| `/console/settings/security` | Two-step verification: enrol with a QR code, recovery codes, turn off (re-authentication needed); linked Google and GitHub identities with **Unlink** ([Cloud sign-up §4](cloud-signup.md#4-google-and-github), [§5](cloud-signup.md#5-two-step-verification)) | Signed in |
| `/console/settings/notifications` | Your notification preferences for the active workspace: kinds, modes, followed inboxes and the `needs_reply` filter; the bounce banner and **Confirm my address**; the daily-cap notice ([Notification settings](#notification-settings)) | All roles, each for themselves |

With `PM_BILLING=off`, `/console/plan` shows usage only, with no plans or buttons.

## Tables

The schema is in [Data model](data-model.md#1-d1-control-plane). How this design uses each table:

| Table | Use |
|---|---|
| `users` | One row per person, keyed by sign-in address. `status = 'disabled'` blocks sign-in. Created by `owner` on `POST /v1/tenants`, by `pmail setup --owner-email`, or when an invitation is accepted |
| `members` | Who is in which workspace, with which role. `members_one_owner` enforces one owner |
| `invitations` | Pending, accepted, revoked or expired invitations. `invitations_pending` allows one pending invitation per address and workspace. Expired and revoked rows are deleted 30 days after `expires_at`; an accepted row stays, and loses its address when that person deletes their account ([Privacy › People](privacy.md#69-people-console-accounts)) |
| `login_tokens` | One row per sign-in, re-authentication, sign-up or waitlist request (`purpose`), holding both the link and the code hashes and the attempt count, and for sign-up the plan, `next` and accepted terms version. Deleted 24 hours after expiry |
| `sessions` | Console sessions with their CSRF secret and the time of the last sign-in. Deleted 30 days after expiry or revocation |
| `oauth_identities`, `oauth_states`, `pending_auth`, `waitlist` | Google and GitHub links, OAuth flows in progress, sign-ins waiting for their second step, and the waitlist ([Cloud sign-up §11](cloud-signup.md#11-data-model)) |
| `notification_prefs` | One row per person, workspace and kind that has been saved or paused; a missing row means the default for the person's role. Written by the settings page and by unsubscribe; `paused_reason` is set by a notification bounce or complaint and cleared by **Confirm my address**. Deleted for that workspace when a member is removed or leaves, for every workspace when a person deletes their account, and with the workspace by tenant erasure |
| `identity_keys` | Read for the identity page's key list; written only through the identity-key service functions that the API uses |

Tokens, codes, cookie values and OAuth `state` values in these tables are always keyed hashes under a
`link` key, with its kid, never the value itself. Values the Worker must use again (TOTP secrets,
recovery-code hashes, PKCE verifiers) are sealed under `PM_MASTER_KEY` instead
([Security › Encryption envelope](security.md#72-encryption-envelope)).

## Audit and events

Every sensitive action writes an `audit_log` row in the same D1 batch as the change. For console actions
`actor_key_id` is `NULL`, `actor_user_id` holds the person (`usr_…`), and `details_json` holds
`"via": "console"`.

| Audit action | When | Webhook event |
|---|---|---|
| `member.invite`, `member.invite_resend` | Invitation created or re-sent | `member.invited` (`invitation_id`, masked `email_hint`, `role`) |
| `member.invite_revoke` | Invitation revoked | – |
| `member.join` | Invitation accepted | `member.joined` (`user_id`, `role`) |
| `member.role_change` | Role changed | `member.role_changed` (`user_id`, `from`, `to`) |
| `member.remove`, `member.leave` | Member removed, or left | `member.removed` (`user_id`) |
| `member.ownership_transfer` | Ownership transferred | Two `member.role_changed` events |
| `user.delete` | A person deleted their account ([Privacy › People](privacy.md#69-people-console-accounts)) | – |
| `user.two_factor_enable`, `user.two_factor_disable` | Two-step verification turned on or off ([Cloud sign-up §5](cloud-signup.md#5-two-step-verification)) | – |
| `user.oauth_unlink` | A person unlinked a Google or GitHub identity ([Cloud sign-up §4](cloud-signup.md#4-google-and-github)) | – |
| `user.notifications_resume` | A person confirmed their address after a notification bounce or complaint ([Notification settings](#notification-settings)); `tenant_id` is `NULL`, because it clears the pause in every workspace | – |
| `identity_key.create`, `identity_key.rotate`, `identity_key.revoke` | An identity's signing key created, rotated or revoked on the identity page (the API writes the same actions) | `identity.key_created`, `identity.key_rotated`, `identity.key_revoked` |
| `tenant.policy_update` | The policy page saved (the API writes the same action) | `tenant.policy_updated` |
| `account.approve`, `account.reject`, `account.close`, `account.delete` | A service sign-up decided, closed or deleted on the accounts page (the API writes the same actions) | `account.approved`, `account.rejected`, `account.closed` (delete of a live entry) |
| `waitlist.invite` | The operator invited a batch from the waitlist ([Cloud sign-up §6.1](cloud-signup.md#61-before-launch-the-waitlist)) | – |

The other sensitive actions use the same audit actions as the API (for example `key.create`,
`quarantine.release`), so the log reads the same whichever way the action was taken. Billing actions are
listed in [Billing](billing.md#events-and-errors).

`member.*` events have no owner Durable Object. They are written to `event_index` as platform events with
the workspace's `tenant_id` and delivered like `webhook.disabled`
([Webhooks › Platform events](webhooks.md#platform-events)).

## Open points

1. **`RL_SIGNIN`.** Closed: 10 requests per 60 seconds per client IP, keyed by `CF-Connecting-IP`
   ([Sign-in](#sign-in), [Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud)).
2. **System mail sender.** Closed: `PM_SYSTEM_FROM` is the address of the system identity that sends
   sign-in, invitation and notification mail ([Identities and domains › The system identity](identity-domains.md#the-system-identity)) ([Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud),
   [§12](cloud-signup.md#12-configuration)).
3. **Actor of console actions.** Closed: `audit_log.actor_user_id` records the person
   ([Data model](data-model.md#1-d1-control-plane)), and `message.released` carries `released_by_user_id`
   for a console release ([Webhook events](../../reference/events.md)).
4. **Key-based quarantine release** (FR-CON-6). Closed: `PM_QUARANTINE_KEY_RELEASE`
   ([Configuration](../../reference/configuration.md#variables)) is `on` by default for self-hosting, and
   Pylota Mail Cloud sets it to `off`, so only a signed-in person can release there, except in a workspace
   whose policy has `quarantine.key_release: true` (decided 2026-10-10). Only a platform key, or the
   partner key of the workspace's partner, can set that field; Pylota sets it on its operators'
   workspaces ([Configuration › Tenant policy](../../reference/configuration.md#tenant-policy)).
5. **Erasure of console data.** Closed: tenant erasure deletes the workspace's `members`, `invitations`
   and `sessions`, and deletes every person it leaves with no workspace; deleting a person removes their
   `oauth_identities` and any `waitlist` row ([Cloud sign-up §11](cloud-signup.md#11-data-model),
   [Privacy › Tenant scope](privacy.md#66-tenant-scope), [Privacy › People](privacy.md#69-people-console-accounts)).
6. **Sign-up on Pylota Mail Cloud.** Closed: designed in [Cloud sign-up, sign-in and first run](cloud-signup.md).

## Tests

| Test | Proves | Covers |
|---|---|---|
| `it::members::w8_seat_limit` | An invitation with no seat left gets `402` with `feature: seats`; pending invitations count as seats; a re-sent invitation takes no new seat | [W8], FR-CON-4 |
| `it::members::w9_remove_revokes_sessions` | After removal the member's next request redirects to sign-in, including a request made with a session created before the removal | [W9], FR-CON-4 |
| `it::members::w10_owner_required` | Removing, demoting or leaving as the owner gets `409 owner_required`; a transfer to a non-admin changes nothing | [W10], FR-CON-2 |
| `it::console::w15_signin_limits` | A fourth request in 10 minutes is refused; a token burns after 10 failed codes; an 11th request from one client IP within 60 seconds is refused by `RL_SIGNIN`, also from a second IPv6 address in the same /64; responses for known and unknown addresses are byte-identical apart from the request ID, and no email goes to an unknown address. M21 covers its own routes (sign-in, link, code); M24 adds sign-up, waitlist, the pending step and the OAuth start to the same test | [W15], FR-CON-3 |
| `it::console::w16_csrf` | A `POST` without the token, with another session's token, without `Origin`, with `Origin: null` or a foreign origin (also `http://` with the right host) gets `403`; the cookie has `__Host-`, `Secure`, `HttpOnly` and `SameSite=Lax`; the unsubscribe `POST` alone is accepted without a session, token or `Origin` | [W16], FR-CON-1 |
| `it::members::w40_invitation_needs_second_factor` | Accepting an invitation as a person enrolled in two-step verification creates no session and no membership until the second factor passes, then both in one batch; abandoning the step leaves the invitation pending; a person without two-step verification, or a new person, gets the membership and a session; a session of another person accepts nothing; signing in with a pending invitation accepts nothing and lands on `/console/invitations`, where the **Accept** form does | [W40], FR-CON-16 |
| `it::console::w43_failed_code_daily_cap` | 30 failed codes in a UTC day for one address, spread over several tokens and client IPs, lock code sign-in until 00:00 UTC while the link still works; the lock sends one `sign_in_codes_locked` email to an active user and none to an unknown address; the response for the two is the same | [W43], FR-CON-3 |
| `it::console::attachments_and_inline_images` | The console attachment route serves a file with the API's serving headers for every role, `404` for a foreign ID and nothing for a quarantined message; a `cid:` PNG of 1 MiB becomes a `data:` URI in the `srcdoc`, a 3 MiB one a placeholder linking to the route, and the rendered page makes no request to the API host | FR-CON-6, [W17], [W18] |
| `it::console::w17_hostile_html` | The hostile-HTML corpus renders in a sandboxed `srcdoc` frame under the CSP: no script runs, no remote request is made, no form posts | [W17], FR-CON-6 |
| `it::console::w18_role_and_scope` (table test) | Each role against each route of [Roles](#roles) gets exactly the allowed outcome; IDs from another workspace give `404`; a `tenant_id` in a form is ignored | [W18], FR-CON-2 |
| `it::console::signin_link_and_code` | The link `GET` does not consume the token; link and code are single use and burn each other; expired tokens fail | FR-CON-3 |
| `it::console::session_lifetime` | 7-day rolling and 30-day absolute expiry with a fake clock; sign-out and sign-out-everywhere | FR-CON-3 |
| `it::console::reauth_sensitive` | Each sensitive action redirects to re-authentication after 10 minutes, writes an audit row, and the session is rotated | FR-CON-5 |
| `it::members::invitation_lifecycle` | Accept (only by the explicit form), re-send, revoke and expire, with the seat count after each (the per-tenant daily invitation budget is tested by `it::abuse::w44_system_mail_budgets`) | FR-CON-4 |
| `it::members::ownership_transfer` | Exactly one owner before and after; concurrent transfers leave one owner | FR-CON-2 |
| `it::console::quarantine_release` | A member releases with re-authentication and an audit row; with key release off, an API key cannot release unless the workspace's policy has `quarantine.key_release: true` (`it::quarantine::j16_key_release_override`); the policy page shows that field read-only | FR-CON-6 |
| `it::console::policy_page` ([Workspace policy §9](workspace-policy.md#9-tests)) | Roles, re-authentication, changed fields only, ceilings, the deleting-change confirmation | FR-TEN-4, FR-CON-5 |
| `it::console::accounts_page` ([Service sign-up ledger §10](service-accounts.md#10-tests)) | Roles, approval with re-authentication, the Overview item, escaped `purpose` | FR-IDN-10 |
| `it::console::disabled` | `PM_CONSOLE=off` removes every `/console` route except the invitation-accept and unsubscribe pairs; the members API still works | FR-CON-7 |
| `it::console::notification_settings` | Each role sees its defaults; saving writes rows for the session's person and workspace only; a mode a kind does not accept and an inbox from another workspace are refused; `account` cannot be turned off; the cap notice appears after the 50th email of the day | FR-CON-14, FR-CON-15 |
| `it::console::identity_keys_page` | Every role sees the key list and the JWKS link; only owner and admin can create, rotate and revoke, each after re-authentication with an `identity_key.*` audit row and event; a paused identity's keys can still be revoked | FR-IDN-6, [W18] |
| `it::console::account_emails` | Turning two-step verification off, linking a sign-in method, transferring ownership, a failed payment (`invoice.payment_failed` fixture) and a code lock (`sign_in_codes_locked`) each send one `account` email after the batch commits, also with `PM_NOTIFICATIONS=off`; it goes through the Notifier of the person's `last_tenant_id` when set, and of the workspace where the event happened otherwise; a redelivered webhook sends nothing more | FR-CON-15 |
| `it::notify::one_click_unsubscribe`, `it::notify::bounce_pauses_prefs`, `it::notify::member_removed_drops_pending` ([Notifications §10](notifications.md#10-tests)) | Unsubscribe without a session; the bounce banner and **Confirm my address**; member removal deletes preferences | [O17](../edge-cases.md)–[O19](../edge-cases.md) |
| `cli::setup::owner_email` ([CLI and setup](cli.md)) plus `it::console::first_owner_signin` | `pmail setup --owner-email` creates the default tenant's owner, who receives a link and can sign in | FR-CON-7 |
| `browser::console::no_js`, `browser::console::axe_scan` ([Testing §6.8](testing.md#68-browser-suite-browser)) | Every console route works with `javaScriptEnabled: false`; an axe scan finds no violation of impact `serious` or `critical` | FR-CON-1, M21 |
| `it::console::render_budget` | Server render time p95 ≤ 300 ms on the fixture workspace | NFR-CON-1 |

[W8]: ../edge-cases.md
[W9]: ../edge-cases.md
[W10]: ../edge-cases.md
[W15]: ../edge-cases.md
[W16]: ../edge-cases.md
[W17]: ../edge-cases.md
[W18]: ../edge-cases.md
[W40]: ../edge-cases.md
[W43]: ../edge-cases.md
