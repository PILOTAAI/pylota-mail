# Console and workspaces

Binding design for the console at `/console`, and for the workspaces, members, roles, invitations, sign-in
and sessions behind it. It implements FR-CON-1 to FR-CON-7 and NFR-CON-1, build plan milestone M21, and
the edge-case rows M8–M10 and M15–M18 in the [edge-case register](../edge-cases.md). The plan and usage
page and everything about money is in [Plans, metering and billing](billing.md). Self-serve sign-up,
Google and GitHub sign-in, two-step verification, the landing rules and the Overview (FR-CON-8 to
FR-CON-13) are in [Cloud sign-up, sign-in and first run](cloud-signup.md), which extends this design.

| | |
|---|---|
| Code | `crates/worker/src/console/{mod.rs, router.rs, session.rs, signin.rs, csrf.rs, layout.rs, pages/*.rs}`, `crates/worker/src/members/{mod.rs, invitations.rs, roles.rs}`, `handlers/members.rs` |
| Tables | D1 `users`, `members`, `invitations`, `login_tokens`, `sessions` ([Data model](data-model.md#1-d1-control-plane)); `oauth_identities`, `oauth_states`, `waitlist` ([Cloud sign-up §11](cloud-signup.md#11-data-model)) |
| Configuration | `PM_CONSOLE`, `PM_CONSOLE_HOST`, `PM_SYSTEM_FROM`, `PM_SIGNUP` ([Configuration](../../reference/configuration.md#variables)); binding `RL_SIGNIN` ([Bindings](../../reference/configuration.md#bindings)) |
| Contracts | Members and invitations endpoints and the `members:manage` permission ([REST API](../../reference/api.md#members)); `member.*` events ([Webhook events](../../reference/events.md#workspaces-members-and-billing)); `409 owner_required`, `402 billing_limit` ([Errors](../../reference/errors.md)) |
| Limits | [Limits › Console](../../reference/limits.md#console) |
| External facts verified on 2026-10-09 | The Fetch Standard's "append a request `Origin` header" algorithm (fetch.spec.whatwg.org) |

## What the console is

The console is for the people who run the agents. Agents keep using the REST API and MCP. The console
holds the views a person needs to check on them, and the actions that should need a person: keys,
domains, members, quarantine release and billing ([PRD §4](../prd.md#4-goals-and-non-goals)). It is not a
webmail client: it has no compose or reply form.

- **Same Worker.** `fetch` routes `/console` and `/console/*` to `console::router`. With `PM_CONSOLE=off`
  those routes are not registered and answer `404` with the standard envelope (FR-CON-7). The members API
  keeps working.
- **Its own host, if configured.** The console is served on `PM_CONSOLE_HOST`, which defaults to
  `PM_API_HOST`. When the two differ, console paths answer only on the console host and API paths (REST,
  MCP, `/hooks/*`, `/billing/stripe/webhook`, `/health`, `/v1/links/*`) only on the API host; anything else gets `404`, and no
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

  The permissions come from the member's role ([Roles](#roles)). Validation, error codes, idempotency,
  metering and audit are therefore identical to the API's.
- **Budget.** Server render time p95 ≤ 300 ms (NFR-CON-1). A page makes at most one D1 query for the
  session, then the same calls the API would make.

## Workspaces

A workspace is a tenant (FR-CON-2). Everything in it (identities, domains, keys, webhooks, plan) belongs
to that tenant, and its scope always comes from the session, never from a form field ([M18]).

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
| See domains, their health and DNS records | Yes | Yes | Yes | Yes |
| Add, verify and remove domains (add and remove are sensitive) | Yes | Yes | No | No |
| Webhook endpoints: create, edit, rotate the secret, replay | Yes | Yes | No | No |
| API keys: list, create (sensitive), revoke | Yes | Yes | No | No |
| Erasure and legal holds (sensitive) | Yes | Yes | No | No |
| See members and pending invitations | Yes | Yes | Yes | Yes |
| Invite, revoke invitations, change roles, remove members (sensitive) | Yes | Yes, except anything that touches the owner | No | No |
| Transfer ownership to an admin (sensitive) | Yes | No | No | No |
| See plan and usage | Yes | Yes | Yes | Yes |
| Upgrade, buy top-ups, open the Customer Portal (sensitive) | Yes | No | No | No |
| See the audit log | Yes | Yes | No | No |
| Leave the workspace | No: transfer ownership first | Yes | Yes | Yes |

| Role | Permission set of the session principal |
|---|---|
| `owner` | Every tenant-level permission: `identities:*`, `domains:*`, `messages:*`, `attachments:read`, `search:read`, `search:agentic`, `quarantine:review`, `webhooks:manage`, `keys:manage`, `erasure:manage`, `suppressions:manage`, `usage:read`, `audit:read`, `members:manage`; plus the console-only rights to buy and manage billing and to transfer ownership |
| `admin` | The owner's tenant-level permissions, without billing and without ownership transfer |
| `member` | `identities:read`, `domains:read`, `messages:read`, `messages:write`, `attachments:read`, `search:read`, `search:agentic`, `quarantine:review`, `usage:read` |
| `viewer` | `identities:read`, `domains:read`, `messages:read`, `attachments:read`, `search:read`, `usage:read` |

Rules:

- **One owner.** The owner cannot leave, be removed, or have their role changed; each attempt returns
  `409 owner_required` ([M10]). Ownership moves only by a transfer to an existing admin
  ([Members](#members)).
- **Admins and the owner.** An admin can manage admins, members and viewers, but cannot change the owner
  or make anyone owner.
- **Keys from the console** are tenant-level or identity-level, never platform-level, and can never hold a
  permission the session lacks (FR-KEY-1).
- **Tenant policy** is changed with a platform key, as in the API (`PATCH /v1/tenants/{id}` needs
  `tenants:manage`). The settings page shows the effective policy read-only.
- **Quarantine release** is possible for a signed-in person with the role above. On Pylota Mail Cloud no API
  key can release; a self-hosted deployment can also allow keys with `quarantine:review` (FR-CON-6).
- **Every handler checks the role**, through the console's route table, which registers each route with its
  required permission exactly like the API's deny-by-default table
  ([Security](security.md#51-deny-by-default-router-table)). A viewer's `POST` to a write route gets `403`,
  and a resource ID from another workspace gets the same `404` as a missing one ([M18]).

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
| Requests per client IP | `RL_SIGNIN`: 10 per 60 seconds per client IP, keyed by `CF-Connecting-IP`, on `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-up` and `/console/waitlist` |
| Two-step verification codes | 5 attempts a minute per person; 10 failures in a row lock two-step sign-in for 15 minutes |
| Link and code lifetime | 10 minutes, single use (using one burns the other) |
| Session lifetime | 7 days rolling, 30 days absolute |
| Re-authentication for sensitive actions | Signed in within the last 10 minutes |

### Requesting a link or code

`POST /console/sign-in` with `email`:

1. Normalise the address (lower case, IDNA A-label domain) and validate it.
2. If `login_tokens` already has 3 rows for this address created in the last 10 minutes, answer the
   "too many requests, wait 10 minutes" page. The page is the same whether the address is known or not.
3. Insert a `login_tokens` row: a 32-byte random link token and a six-digit code from the platform RNG
   (uniform, by rejection sampling), stored only as `token_hash` and `code_hash`, keyed hashes under the
   current `link` signing key, whose kid goes in `key_kid` ([Keyed hashes](#keyed-hashes)), with
   `expires_at = now + 10 minutes`. The row is written for every address, known or not, so the limits
   behave the same.
4. Answer `200` with the "check your email" page, which holds the code form.
5. After the response (`wait_until`), send the email only if the address belongs to an `active` user with
   at least one membership, or has a pending invitation. Otherwise send nothing.

The email goes through the normal outbound pipeline from the default tenant (billing `disabled` or
`exempt`, so it is never metered), from `PM_SYSTEM_FROM` (default `Pylota Mail <no-reply@{PM_PLATFORM_DOMAIN}>`),
with `Idempotency-Key: signin:{login_token_id}`; tests use the simulator (build plan M21). It contains the
link `https://{PM_CONSOLE_HOST}/console/sign-in/link?t=<token>`, the code, and the request time. It never
says whether the address has an account.

Doing the lookup and the send after the response keeps the response identical in content and timing for
registered and unregistered addresses ([M15]).

### Using the link

`GET /console/sign-in/link?t=…` changes nothing. It shows a page with one **Sign in** button, which
`POST`s the token. Mail security scanners often open links in email; because the `GET` does not consume
the token, a scanner cannot burn it.

The `POST` hashes the token and looks for a row that is unexpired, unused and has fewer than 10 attempts.
On success it sets `used_at`, creates the `users` row if the address only had a pending invitation, sets
`last_login_at`, asks for two-step verification if the person has it, creates a session and answers `303`
to the page chosen by [Cloud sign-up §7](cloud-signup.md#7-where-people-land) (normally `/console`).

### Using the code

`POST /console/sign-in/code` with `email` and `code` computes `HMAC(link key {key_kid}, email || code)`
for each unexpired, unused token of the address (at most three) and compares it in constant time with
that row's `code_hash`. A failure increments `attempts` on each of them; a token reaching 10 is burned.
Success continues as for the link.

Each token allows 10 attempts. On top of the per-address limits, the Workers rate-limiting binding
`RL_SIGNIN` ([Configuration › Bindings](../../reference/configuration.md#bindings)) allows 10 requests per
60 seconds per client IP, keyed by `CF-Connecting-IP`, on `POST /console/sign-in`,
`/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-up` and `/console/waitlist`
([Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud)).

### Keyed hashes

Link tokens, codes, invitation tokens, session cookies and OAuth `state` values (with their
`__Host-pm_oauth` cookie values) are never stored. Each table keeps `HMAC-SHA256(link key {kid}, value)`
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
| Cookie | `__Host-pm_session=<value>; Path=/; Secure; HttpOnly; SameSite=Lax` ([M16]) |
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
SELECT s.user_id, s.tenant_id, s.csrf_secret, s.authenticated_at, s.last_seen_at, u.email, m.role
FROM sessions s
JOIN users u ON u.id = s.user_id AND u.status = 'active'
LEFT JOIN members m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id
WHERE s.id_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2;
```

No row: redirect to `/console/sign-in`. A session whose active workspace has no member row (the person
was removed) is sent to the workspace picker, so a removed member can never act in that workspace, even
in a request that was already in flight.

**Sign-out** sets `revoked_at` and clears the cookie. **Sign out everywhere** (settings) revokes every
session of the user. Revoked and expired rows are deleted 30 days later.

### Re-authentication

Sensitive actions require a sign-in within the last 10 minutes and write an audit row (FR-CON-5):
creating keys, inviting or removing members, changing roles, transferring ownership, adding or removing
domains, releasing quarantine, erasure and legal holds, and billing (Checkout and the Customer Portal).

If `authenticated_at` is older, the `POST` answers `303` to `/console/reauth?next=<path>`. That page sends a
code to the signed-in address (a new `login_tokens` row, counted in the same limits), and also asks for a
two-step verification code when the person is enrolled. A correct code creates a new session (new cookie, `authenticated_at = now`) and revokes the old one, then answers `303` to
`next`, which must be a path under `/console/`. The person submits the action again; the console never
replays a form on its own.

## CSRF

Three layers, all required ([M16]):

1. **Token.** Every form has a hidden `_csrf` field: `base64url(HMAC-SHA256(csrf_secret, "console-form"))`.
   A `POST` without it, or with a different value (constant-time comparison), gets `403`.
2. **Origin.** Every `POST` must carry an `Origin` header equal to `https://{PM_CONSOLE_HOST}` (which is
   `https://{PM_API_HOST}` by default). A missing header, `null`, or any other value gets `403`.
3. **Cookie.** `SameSite=Lax`, so cross-site `POST`s carry no session at all.

The forms used before a session exists (sign-in, code, link, invitation acceptance, sign-up, waitlist)
are checked by `Origin` alone; they cannot act as a signed-in person. The OAuth callback is a `GET` from
the provider and is bound to the browser by its `state` and `__Host-pm_oauth` cookie instead
([Cloud sign-up §4](cloud-signup.md#4-google-and-github)).

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
cannot act ([M17]):

- The default view is text: `extracted_text`, or the full `text`, HTML-escaped.
- The HTML view puts the sanitised HTML (sanitised at ingest) in `<iframe sandbox srcdoc="…">`. The
  `sandbox` attribute has no tokens, so the frame runs no scripts, has no same-origin access, submits no
  forms, opens no pop-ups and cannot navigate the page.
- Remote images are not loaded: the policy allows images only from the console itself and `data:`. `cid:`
  images are rewritten to the attachment URL. A **Load remote images** link re-renders that one message
  with `img-src https:` after a warning that the sender may learn the mail was opened.
- Quarantined messages show the text view and the quarantine reason only. Risky attachments are never
  offered for preview.
- Display names, subjects and filenames are always escaped; links in text view are not made clickable.

## Invitations

Members are invited by email (FR-CON-4). The owner and admins can invite, from the console or with
`POST /v1/tenants/{id}/invitations` (`members:manage`).

1. Validate the address and the role (`admin`, `member` or `viewer`). An address that is already a member
   is refused with `400 invalid_request`.
2. If a pending invitation for the address exists (`invitations_pending` is unique per workspace and
   address), it is re-sent instead: new token, `expires_at` restarted, no new seat.
3. Take a `seats` hold in `TenantQuota` (`ref` = the new `inv_` ID). With no seat left the request fails
   with `402 billing_limit` and `details.feature: "seats"`, before anything is written ([M8],
   [Billing](billing.md#what-the-worker-meters)).
4. Insert the invitation (`token_hash` and `key_kid` as in [Keyed hashes](#keyed-hashes),
   `expires_at = now + 7 days`) with its audit row and `member.invited` event in one D1 batch, then settle
   the hold.
5. Email the link `https://{PM_CONSOLE_HOST}/console/invitations/accept?t=<token>` from the default
   tenant and `PM_SYSTEM_FROM`, as for sign-in.

A pending invitation counts as a seat until it is accepted, revoked or expires.

**Accepting.** The `GET` shows the workspace name and the role with one **Accept** button; the `POST`
consumes the token. The link was sent to the invited address, so it proves control of it: acceptance
creates the `users` row if needed, inserts the `members` row with the invited role, marks the invitation
`accepted`, and signs the person in with the new workspace active. The seat taken by the invitation
becomes the member's seat; `TenantQuota` does not change. Event `member.joined`.

**Revoking** (`DELETE /v1/tenants/{id}/invitations/{inv}` or the console) sets `revoked` and releases the
seat (`Adjust −1`). **Expiry**: the hourly roll-up sets `expired` on pending invitations past `expires_at`
and releases their seats; acceptance also checks `expires_at`, so a late click never works.

## Members

**Changing a role** (owner or admin, sensitive) updates `members.role` and emits `member.role_changed`.
It takes effect on the person's next request, because the role is read on every request.

**Removing a member** (owner or admin, sensitive; `DELETE /v1/tenants/{id}/members/{user_id}`) and
**leaving** run one D1 batch: delete the `members` row, revoke every session of that user whose active
workspace is this one, write the audit row and the `member.removed` event. Then the seat is released with
`Adjust −1`; if that call is lost, the hourly reconciliation corrects the count. The person's next request
redirects to sign-in ([M9]). The owner cannot be removed and cannot leave (`409 owner_required`, [M10]).

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
`member.ownership_transfer` and two `member.role_changed` events. Stripe's customer email does not change;
the new owner can update it in the Customer Portal.

## Screens

| Path | Screen | Who |
|---|---|---|
| `/console/sign-in` | Email form, plus "Continue with Google" and "Continue with GitHub" where enabled; then the "check your email" page with the code form | Anyone |
| `/console/sign-in/link` | Confirm sign-in from the email link | Anyone with a link |
| `/console/sign-up` | Sign-up with Google, GitHub or an email address, and the terms checkbox (`PM_SIGNUP=open`; [Cloud sign-up §6.2](cloud-signup.md#62-after-launch-open-sign-up)) | Anyone |
| `/console/waitlist` | Join the waitlist, with double opt-in (`PM_SIGNUP=waitlist`; [Cloud sign-up §6.1](cloud-signup.md#61-before-launch-the-waitlist)) | Anyone |
| `/console/oauth/{provider}/start`, `/console/oauth/{provider}/callback` | Redirects to and from Google or GitHub; no page of their own ([Cloud sign-up §4](cloud-signup.md#4-google-and-github)) | Anyone |
| `/console/invitations/accept` | Accept an invitation | Anyone with a link |
| `/console/reauth` | Confirm it is you, with a code (and a two-step code when enrolled) | Signed in |
| `/console/workspaces` | Workspace picker and switcher | Signed in |
| `/console/workspaces/new` | Create your workspace: name, address suffix, time zone ([Cloud sign-up §6.2](cloud-signup.md#62-after-launch-open-sign-up)) | Signed in, with no workspace or pending invitation, when sign-up is open |
| `/console` | Overview, the workspace home: banners, the first-run checklist, "Needs a person", usage meters, inboxes and recent activity ([Cloud sign-up §8](cloud-signup.md#8-the-overview-the-screen-people-land-on)) | All roles (viewers without action buttons) |
| `/console/connect` | Connect your agent: the `claude mcp add` line, `.mcp.json`, a `curl` request and `pmail login`, with a key ID filled in, never a secret | Owner, admin |
| `/console/inboxes`, `/console/inboxes/{idn}` | Identities with their addresses and status; one identity's threads with triage | All roles |
| `/console/inboxes/{idn}/threads/{thr}` | A thread; each message in text view, HTML on request ([Showing untrusted mail](#showing-untrusted-mail)) | All roles |
| `/console/search` | Search one identity or the whole workspace, with facets; agentic answers with citations | All roles (agentic: not viewers) |
| `/console/quarantine` | Quarantined mail with reasons; release | Owner, admin, member |
| `/console/keys` | Keys with scope and last use; create (the secret is shown once); revoke | Owner, admin |
| `/console/domains`, `/console/domains/{dom}` | Domains, health and issues, DNS records read from the provider API; add, verify, remove | View: all roles. Change: owner, admin |
| `/console/webhooks` | Endpoints, recent deliveries, rotate secret, replay | Owner, admin |
| `/console/members` | Members, pending invitations, seats used; invite, resend, revoke, change role, remove, transfer ownership, leave | View: all roles. Change: owner, admin. Transfer: owner |
| `/console/plan` | Plan, a meter per allowance, upgrade, top-ups, manage billing ([Billing](billing.md#checkout)) | View: all roles. Buy: owner |
| `/console/plan/return` | Return from Stripe Checkout: confirms the plan once the webhook has applied it ([Cloud sign-up §9](cloud-signup.md#9-coming-back-from-checkout)) | Owner |
| `/console/audit` | Audit log with filters | Owner, admin |
| `/console/settings` | Your name and sessions; delete your account; workspace name, time zone, `require_two_factor` (owner) and effective policy (read-only) | All roles |
| `/console/settings/security` | Two-step verification: enrol with a QR code, recovery codes, turn off (re-authentication needed) ([Cloud sign-up §5](cloud-signup.md#5-two-step-verification)) | Signed in |

With `PM_BILLING=off`, `/console/plan` shows usage only, with no plans or buttons.

## Tables

The schema is in [Data model](data-model.md#1-d1-control-plane). How this design uses each table:

| Table | Use |
|---|---|
| `users` | One row per person, keyed by sign-in address. `status = 'disabled'` blocks sign-in. Created by `owner` on `POST /v1/tenants`, by `pmail setup --owner-email`, or when an invitation is accepted |
| `members` | Who is in which workspace, with which role. `members_one_owner` enforces one owner |
| `invitations` | Pending, accepted, revoked or expired invitations. `invitations_pending` allows one pending invitation per address and workspace |
| `login_tokens` | One row per sign-in or re-authentication request, holding both the link and the code hashes and the attempt count. Deleted 24 hours after expiry |
| `sessions` | Console sessions with their CSRF secret and the time of the last sign-in. Deleted 30 days after expiry or revocation |
| `oauth_identities`, `oauth_states`, `waitlist` | Google and GitHub links, OAuth flows in progress, and the waitlist ([Cloud sign-up §11](cloud-signup.md#11-data-model)) |

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
2. **System mail sender.** Closed: `PM_SYSTEM_FROM` names the platform identity that sends sign-in,
   invitation and notification mail ([Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud),
   [§12](cloud-signup.md#12-configuration)).
3. **Actor of console actions.** Closed: `audit_log.actor_user_id` records the person
   ([Data model](data-model.md#1-d1-control-plane)), and `message.released` carries `released_by_user_id`
   for a console release ([Webhook events](../../reference/events.md)).
4. **Key-based quarantine release** (FR-CON-6). Closed: `PM_QUARANTINE_KEY_RELEASE`
   ([Configuration](../../reference/configuration.md#variables)) is `on` by default for self-hosting, and
   Pylota Mail Cloud sets it to `off`, so only a signed-in person can release there.
5. **Erasure of console data.** Closed: tenant erasure deletes the workspace's `members`, `invitations`
   and `sessions`, and deletes every person it leaves with no workspace; deleting a person removes their
   `oauth_identities` and any `waitlist` row ([Cloud sign-up §11](cloud-signup.md#11-data-model),
   [Privacy › Tenant scope](privacy.md#66-tenant-scope), [Privacy › People](privacy.md#69-people-console-accounts)).
6. **Sign-up on Pylota Mail Cloud.** Closed: designed in [Cloud sign-up, sign-in and first run](cloud-signup.md).

## Tests

| Test | Proves | Covers |
|---|---|---|
| `it::members::m8_seat_limit` | An invitation with no seat left gets `402` with `feature: seats`; pending invitations count as seats; a re-sent invitation takes no new seat | [M8], FR-CON-4 |
| `it::members::m9_remove_revokes_sessions` | After removal the member's next request redirects to sign-in, including a request made with a session created before the removal | [M9], FR-CON-4 |
| `it::members::m10_owner_required` | Removing, demoting or leaving as the owner gets `409 owner_required`; a transfer to a non-admin changes nothing | [M10], FR-CON-2 |
| `it::console::m15_signin_limits` | A fourth request in 10 minutes is refused; a token burns after 10 failed codes; an 11th request from one client IP within 60 seconds is refused by `RL_SIGNIN`; responses for known and unknown addresses are byte-identical apart from the request ID, and no email goes to an unknown address | [M15], FR-CON-3 |
| `it::console::m16_csrf` | A `POST` without the token, with another session's token, without `Origin`, with `Origin: null` or a foreign origin gets `403`; the cookie has `__Host-`, `Secure`, `HttpOnly` and `SameSite=Lax` | [M16], FR-CON-1 |
| `it::console::m17_hostile_html` | The hostile-HTML corpus renders in a sandboxed `srcdoc` frame under the CSP: no script runs, no remote request is made, no form posts | [M17], FR-CON-6 |
| `it::console::m18_role_and_scope` (table test) | Each role against each route of [Roles](#roles) gets exactly the allowed outcome; IDs from another workspace give `404`; a `tenant_id` in a form is ignored | [M18], FR-CON-2 |
| `it::console::signin_link_and_code` | The link `GET` does not consume the token; link and code are single use and burn each other; expired tokens fail | FR-CON-3 |
| `it::console::session_lifetime` | 7-day rolling and 30-day absolute expiry with a fake clock; sign-out and sign-out-everywhere | FR-CON-3 |
| `it::console::reauth_sensitive` | Each sensitive action redirects to re-authentication after 10 minutes, writes an audit row, and the session is rotated | FR-CON-5 |
| `it::members::invitation_lifecycle` | Accept, re-send, revoke and expire, with the seat count after each | FR-CON-4 |
| `it::members::ownership_transfer` | Exactly one owner before and after; concurrent transfers leave one owner | FR-CON-2 |
| `it::console::quarantine_release` | A member releases with re-authentication and an audit row; with key release off, an API key cannot release | FR-CON-6 |
| `it::console::disabled` | `PM_CONSOLE=off` removes every `/console` route; the members API still works | FR-CON-7 |
| `cli::setup::owner_email` ([CLI and setup](cli.md)) plus `it::console::first_owner_signin` | `pmail setup --owner-email` creates the default tenant's owner, who receives a link and can sign in | FR-CON-7 |
| Playwright `console_no_js` | Every console route works with `javaScriptEnabled: false`; an axe scan finds no serious violation | FR-CON-1, M21 |
| `it::console::render_budget` | Server render time p95 ≤ 300 ms on the fixture workspace | NFR-CON-1 |

[M8]: ../edge-cases.md
[M9]: ../edge-cases.md
[M10]: ../edge-cases.md
[M15]: ../edge-cases.md
[M16]: ../edge-cases.md
[M17]: ../edge-cases.md
[M18]: ../edge-cases.md
