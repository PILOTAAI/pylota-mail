# Cloud sign-up, sign-in and first run

How a customer of **Pylota Mail Cloud** goes from the pricing page to a working agent inbox. It covers how
they sign up and sign in, how they pay, which screen they land on, and the first-run checklist. It closes
open point 6 of [Console and workspaces](console.md#open-points) and extends that design. Money is in
[Plans, metering and billing](billing.md).

| | |
|---|---|
| Requirements | FR-CON-8 to FR-CON-13 and FR-CON-16 to FR-CON-18 ([PRD](../prd.md)) |
| Edge cases | [W20–W34 and W40–W46](../edge-cases.md) |
| Code | `crates/worker/src/console/{signup.rs, oauth.rs, totp.rs, pending.rs, landing.rs, onboarding.rs, pages/overview.rs}`; `crates/worker/src/crons/{signup_ramp.rs, send_breaker.rs}` (the daily ramp evaluation, [§10.1](#101-new-workspace-send-ramp), and the shared-domain breaker, [§10.3](#103-shared-domain-breaker)); `crates/worker/src/console/sysmail.rs` (system-mail budgets, [§10.2](#102-system-mail-budgets)); `crates/core/src/totp.rs` (RFC 6238 codes, pure) |
| Tables | D1 `users`, `tenants`, `login_tokens` and `oauth_states` (new columns), `oauth_identities`, `pending_auth`, `waitlist`, `platform_state` ([§11](#11-data-model)) |

## 1. Who signs in where

| Person | How they get access | Where they work |
|---|---|---|
| **Cloud customer** (a developer or a team buying Pylota Mail) | Self-serve sign-up, this page | The console on Pylota Mail Cloud |
| **Teammate** of a Cloud customer | An invitation ([Invitations](console.md#invitations)) | The same console, in the inviter's workspace |
| **Self-hoster** | `pmail setup --owner-email` creates the first owner ([Console](console.md#workspaces)) | The console on their own deployment |
| **Pylota car-rental operator** | Never signs in here. The operator's workspace is a tenant of Cloud on `pylotamail.com`, which Pylota's backend creates with Pylota's partner key ([REST API › Partners](../../reference/api.md#partners)) | Inside the Pylota app, which reads and acts on mail through the API |

Self-serve sign-up exists only where `PM_SIGNUP` is `waitlist` or `open` (Cloud). It is `closed` by
default, so a self-hosted deployment has no public sign-up unless its operator turns it on.

## 2. Hostnames

Decided on 2026-10-09: TREFT LTD bought `pylotamail.com` on Cloudflare, and one zone serves the whole Cloud
product. The shared mail domain has to be a zone apex, because catch-all routing exists only at an apex.
Using `pylota.io` would mix agent mail with Pylota's own sign-in mail and its booking wildcard.

| Host | Serves | Notes |
|---|---|---|
| `pylotamail.com` (apex) and `www.pylotamail.com` | The landing page and docs (the assets-only site Worker, `site/wrangler.jsonc`), and the shared mail domain, `PM_PLATFORM_DOMAIN` | Addresses like `bookings.brightwell@pylotamail.com`. The site adds only web records (Workers Custom Domains); the mail records (MX, SPF and DKIM TXT, `_dmarc`) are separate records that `pmail setup` writes, so the two never collide. Sign-up buttons link to `app.pylotamail.com` |
| `app.pylotamail.com` | The console, `PM_CONSOLE_HOST` | Same Worker as the API. Only console routes answer on this host |
| `api.pylotamail.com` | REST API, MCP, signed links (`/v1/links/*`), `/hooks/*`, the Stripe webhook (`/billing/stripe/webhook`), `/health`, `PM_API_HOST` | No cookies are ever set or read on this host |

Pylota's own car-rental operators are tenants of Cloud (decided 2026-10-10), on the shared
`pylotamail.com` domain until each operator adds its own domain. Pylota is a partner
([REST API › Partners](../../reference/api.md#partners)) with `default_billing_mode: exempt`: its backend
holds a partner key, not a platform key, and every operator workspace that key creates is billed `exempt`.
A partner key reaches only the tenants its partner's keys created, so no Pylota key reaches another Cloud
customer's mail. Cloud keeps `PM_QUARANTINE_KEY_RELEASE=off`, and Pylota's tenants set
`quarantine.key_release: true`, so Pylota's app can release held mail through its key
([Configuration › Tenant policy](../../reference/configuration.md#tenant-policy)). Amazon SES for Cloud runs
in `eu-west-2` (London), decided on 2026-10-09. Cloud also sets `PM_BACKUP_BUCKET = "pylota-mail-backup"`
(the nightly blob copy, [ADR 0016](../adr/0016-plan-items-changed-for-v1.md)), `PM_ALERT_EMAIL` to the
owner's address and `PM_HEARTBEAT_KEY_ID`, and runs the heartbeat workflow, because one person operates
it ([ADR 0015](../adr/0015-solo-operator.md)).

`PM_CONSOLE_HOST` defaults to `PM_API_HOST`, so a self-hosted deployment keeps one hostname. When the two
differ, the router answers console paths only on the console host and API paths only on the API host;
everything else gets `404`. That keeps session cookies off the API, and API keys out of browser history.
Both values are compared with the request's `Host` header as written, so a value may carry a port
(`console.localhost:8799`); only the local test harness uses one ([Testing › What cargo xtask itest does](testing.md#61-what-cargo-xtask-itest-does)).

## 3. Sign-in methods

| Method | Cloud | Self-hosted default | Notes |
|---|---|---|---|
| Email link or six-digit code | On | On | As in [Sign-in](console.md#sign-in) |
| Continue with Google | On | Off (needs `PM_OAUTH_GOOGLE_CLIENT_ID` and secret) | OpenID Connect, scopes `openid email profile` only |
| Continue with GitHub | On | Off (needs `PM_OAUTH_GITHUB_CLIENT_ID` and secret) | OAuth app, scopes `read:user user:email` |
| Two-step verification (authenticator app) | Optional per person; a workspace can require it | Same | TOTP ([§5](#5-two-step-verification)) |
| Passkeys | Not in v1.0 | – | They need browser JavaScript, and the console has none (FR-CON-1). Planned for v1.1 |
| SAML or OIDC single sign-on | Not in v1.0 | – | A candidate for a future Enterprise plan |

There is no password anywhere. Every method ends in the same session creation as the email method, with
the same cookie, lifetimes and re-authentication rules ([Sessions](console.md#sessions)).

## 4. Google and GitHub

Both flows are server-side redirects. They need no JavaScript.

1. `GET /console/oauth/{provider}/start?intent={sign_in|sign_up}&next={path}&plan={plan}&terms=1&invite={token}`.
   The route counts against `RL_SIGNIN`, because each hit writes a row ([W43](../edge-cases.md)). On
   the sign-up page the "Continue with" buttons are `GET` forms that include the terms checkbox, so
   `intent=sign_up` arrives with `terms=1`; without it the start shows the sign-up page again with the
   checkbox marked as required, and creates nothing. On an invitation's accept page the "Accept with
   Google" and "Accept with GitHub" buttons send `intent=sign_in` and the invitation's `invite` token; the
   start looks the token up as the accept route does and, when it names a pending, unexpired invitation,
   stores its ID in `oauth_states.invitation_id` (an unknown or expired token shows the expired-invitation
   page and creates nothing). Otherwise the Worker creates an `oauth_states` row
   valid for 10 minutes. The row holds a keyed hash of a 32-byte `state` (under the current `link` key,
   whose kid is stored as `key_kid`), a PKCE verifier sealed under `PM_MASTER_KEY`, a `nonce` (Google),
   the validated `next` and `plan`, and, for `intent=sign_up`, `terms_version` = `PM_TERMS_VERSION`. It
   also sets `__Host-pm_oauth` (HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes) to a random value whose keyed
   hash is stored in the row, binding the flow to this browser. It then redirects to the provider with the
   exact `redirect_uri` `https://{PM_CONSOLE_HOST}/console/oauth/{provider}/callback`, `state`,
   `code_challenge` (S256) and the scopes above.
2. `GET /console/oauth/{provider}/callback`. The handler requires the `state` row to exist, be unexpired
   and unused, and match the `__Host-pm_oauth` cookie. It marks the row used, then exchanges the `code` with
   the PKCE verifier at the token endpoint ([W20](../edge-cases.md)).
3. **Google.** The ID token comes straight from Google's token endpoint over TLS, so TLS server validation
   may stand in for checking its signature (OpenID Connect Core 1.0, §3.1.3.7, step 6). The handler still
   checks `iss` (`https://accounts.google.com` or `accounts.google.com`), `aud` = the client ID, `exp`,
   `nonce`, and `email_verified = true`. The subject is the `sub` claim.
4. **GitHub.** `GET https://api.github.com/user` gives the numeric `id`, which is the subject.
   `GET /user/emails` gives the address marked `primary` and `verified`. If there is none, the flow is
   refused with a page telling the person to verify an email address on GitHub ([W21](../edge-cases.md)).
5. **Find or create the person.** When `oauth_states.invitation_id` is set, the verified address must
   first equal that invitation's address (the flow knows it came from an invitation only through this
   column). Otherwise the flow is refused, nothing is created or linked, and the invitation stays pending
   ([W23](../edge-cases.md)). A verified address that this deployment hosts is refused the same way
   ([§10](#10-abuse-and-safety-on-cloud), [W45](../edge-cases.md)). Then:
   1. `oauth_identities` has `(provider, subject)` → that user; set its `last_used_at = now`.
   2. Otherwise a `users` row with the verified email exists → link it, but only after the person proves
      the address again. Google warns that its `email` claim may not be unique to an account and can
      change, and that `sub` is the identifier to link on (Google "OpenID Connect", read 2026-10-10), so
      an address match alone never joins two sign-in methods. The handler emails a code to the address
      (a `login_tokens` row with `purpose = 'oauth_link'`, under the same per-address limits) and starts
      a pending step `link_code` ([§5.1](#51-the-pending-step)) that carries `oauth_provider`,
      `oauth_subject` and `oauth_email`. Only a correct code inserts the `oauth_identities` row, sends the
      `account` email `sign_in_method_linked`, and continues. The same person can then use either method
      ([W22](../edge-cases.md), [W42](../edge-cases.md)).
   3. Otherwise, create the user ([§6](#6-sign-up)) when a pending invitation exists for that verified
      address, or when the flow's `intent` is `sign_up` and either sign-up is open or the verified
      address has a valid waitlist invite ([§6.1](#61-before-launch-the-waitlist)). The new `users` row
      copies `terms_version` from the `oauth_states` row, with `terms_accepted_at` = the row's
      `created_at` (both `NULL` for an invitation). Otherwise, show the "no workspace yet" page; no
      account is created ([W32](../edge-cases.md)).
6. If the person has two-step verification, the pending step `two_factor` asks for it
   ([§5.1](#51-the-pending-step)); no session exists before it passes. Then, when `invitation_id` is set,
   the invitation is accepted (the person clicked **Accept with Google** or **Accept with GitHub**, which
   is the explicit click [Console › Invitations](console.md#invitations) requires); then the session is
   created and the person is routed ([§7](#7-where-people-land)).

`intent` selects the page shown when no account matches: `sign_up` continues to workspace creation,
`sign_in` shows "no workspace yet" ([W32](../edge-cases.md)). Re-authentication never uses OAuth: it is an
emailed code ([Console › Re-authentication](console.md#re-authentication)). `/console/settings/security`
lists the person's linked providers with the address each was linked with (`email_at_link`) and when it
was last used (`last_used_at`), each with an **Unlink** button: a sensitive action (re-authentication)
that deletes that `oauth_identities` row and writes the audit row `user.oauth_unlink`. The email method
cannot be unlinked, so a person always keeps a way in.

Provider endpoints and claim names must be re-read from Google's and GitHub's current documentation when
M24 is built. Errors from a provider (`error=access_denied`, timeouts) show a page with a "try another way"
link. They never reveal whether an account exists.

## 5. Two-step verification

- **Enrol** at `/console/settings/security`. It needs re-authentication. Opening the enrolment form
  generates a secret (20 random bytes), seals it under `PM_MASTER_KEY` into
  `users.totp_pending_sealed` and sets `totp_pending_expires_at = now + 10 minutes`, replacing any earlier
  pending secret; the page shows a QR code rendered on the server as an inline SVG (the `qrcode` crate,
  pure Rust) and the base32 secret as text. The person confirms with a current code, checked against the
  pending secret while it is unexpired. One `UPDATE` then moves it to `users.totp_sealed`, sets
  `totp_enabled_at` and clears both pending columns; an expired pending secret is refused and the form
  starts again. The global retention job clears pending columns 24 hours after they expire. "Enrolled"
  means `totp_enabled_at IS NOT NULL`: the sign-in step and the workspace requirement read it, and
  `/console/settings/security` shows the date.
- **Codes** follow RFC 6238: HMAC-SHA1, 30-second step, six digits, one step of clock drift either way. A
  code is refused if it was already used in its step. Attempts are limited to 5 a minute per person, and
  10 failures in a row lock two-step sign-in for 15 minutes. The counters are columns of `users`
  (`totp_window_start`, `totp_window_count`, `totp_failures`, `totp_locked_until`, [§11](#11-data-model));
  a success resets `totp_failures`.
- **Recovery codes.** Ten codes of 10 characters (Crockford base32) are shown once at enrolment, and each
  works once. Generating new ones invalidates the old ([W28](../edge-cases.md)). They are the only way
  back after losing the authenticator: there is no support route, because nobody can verify a requester
  without the factors themselves, and a Free workspace has no billing record to check either. The
  enrolment page says so and asks the person to confirm that they have saved the codes. They are stored sealed:
  `users.recovery_codes_sealed` is a `pm1` envelope under `PM_MASTER_KEY` of
  `[{ "hash": SHA-256(code), "used_at": null }]`. They are not keyed hashes under the `link` keyring,
  because a link key is deleted 7 days after rotation and recovery codes live for months. The
  `pmail secrets rotate-master` re-seal sweep covers them, as it covers `users.totp_sealed`.
- **When it is asked for.** After any first factor (link, code, Google or GitHub, and the link in an
  invitation email), before any session is created, through the pending step of [§5.1](#51-the-pending-step).
  It is also asked for at re-authentication when enrolled.
- **Workspace requirement.** An owner can set `require_two_factor` in workspace settings. Pylota Mail Cloud
  recommends it for Team workspaces. It is checked on **every** console request, not only on entry: the
  session query reads `tenants.require_two_factor` and `users.totp_enabled_at`
  ([Console › Sessions](console.md#sessions)), and while the active workspace requires it and the person
  is not enrolled, only enrolment (`/console/settings/security` and the re-authentication it needs), the
  workspace picker, `/console/settings` and sign-out answer; every other route redirects to enrolment
  ([W27](../edge-cases.md)). Turning the requirement on therefore takes effect on each member's next
  request. The API is unaffected: keys are not people.
- Turning it off needs re-authentication with a current code. It sets `totp_sealed`, `totp_enabled_at`,
  `totp_last_step` and `recovery_codes_sealed` to `NULL`, emails the person and writes an audit row.

### 5.1 The pending step

A first factor that is not the last step leaves the browser in a pending state, never in a session
([W41](../edge-cases.md)). The state lives in D1 `pending_auth` ([§11](#11-data-model)) and in the
cookie `__Host-pm_pending=<value>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`:

1. **Start.** After a first factor, when the person is enrolled in two-step verification
   (`step = 'two_factor'`) or an OAuth identity waits for its link code (`step = 'link_code'`, §4 step
   5.2), the handler inserts a `pending_auth` row: a keyed hash of a 32-byte random cookie value under the
   current `link` key (`id_hash`, with `key_kid`, as for sessions), `user_id`, `step`, the validated
   `next_path`, `plan`, `invitation_id` (an invitation being accepted, from the accept route or
   `oauth_states`), the OAuth identity to link, and `expires_at` = now + 5 minutes (`two_factor`) or now
   + 10 minutes (`link_code`, so the emailed code has time to arrive). It sets the cookie and answers
   `303` to `/console/sign-in/verify`. A sign-in token or invitation token used to get here is already
   consumed, so it cannot start a second pending row.
2. **Verify.** `GET /console/sign-in/verify` shows the form for the row's step: the six-digit emailed
   code for `link_code`; an authenticator code or a recovery code for `two_factor`. The `POST` is a
   pre-session form, checked by `Origin` ([Console › CSRF](console.md#csrf)), and counts against
   `RL_SIGNIN`. It finds the row by the cookie's keyed hash; the row must be unexpired and unused.
   Two-step codes use the per-person limits above; a `link_code` row allows 5 wrong codes and is then
   used up.
3. **Advance or finish.** A correct `link_code` inserts the `oauth_identities` row and, when the person
   is enrolled, moves the same row to `step = 'two_factor'` with a fresh 5-minute `expires_at`. A correct
   `two_factor` finishes: `UPDATE pending_auth SET used_at = ?now WHERE id_hash = ?1 AND used_at IS NULL
   AND expires_at > ?now` must change exactly one row (single use, also under a double submit); then,
   in one D1 batch, the invitation is accepted when `invitation_id` is set, the session is created, and
   the cookie is cleared; the person is routed by [§7](#7-where-people-land) with `next_path` and `plan`.
4. **Expiry.** An expired, used or unknown row shows "Your sign-in timed out" with a link to
   `/console/sign-in`, and nothing else happens. The global retention job deletes `pending_auth` rows 24
   hours after `expires_at`.

Re-authentication needs no pending step: it already has a session, and its one form asks for the emailed
code and, when enrolled, the authenticator code together ([Console › Re-authentication](console.md#re-authentication)).

## 6. Sign-up

### 6.1 Before launch: the waitlist

With `PM_SIGNUP=waitlist`, the landing page's "Get early access" buttons go to
`https://app.pylotamail.com/console/waitlist?plan={plan}`. The person enters an email address, and
`POST /console/waitlist` writes a `login_tokens` row with `purpose = 'waitlist'` and the plan of interest
in `login_tokens.plan`, then emails a confirmation link and code. This is double opt-in on the sign-in
token machinery: the same limits, lifetime and email, sent from the system identity
([Console › Requesting a link or code](console.md#requesting-a-link-or-code)), except that it is sent to
any address that passes the disposable-domain and hosted-address checks of
[§6.2](#62-after-launch-open-sign-up), within the system-mail budgets of [§10.2](#102-system-mail-budgets)
and with the form ticket below. The
response is the same whether or not the address is already on the list. Using the link or the code
(through the sign-in link and code routes, which act on the token's `purpose`) writes the `waitlist` row
with `plan` from the token and `confirmed_at` = now, and shows "You're on the list". An address already
on the list keeps its row and its place. No account is created.

The operator invites people in batches with `pmail waitlist invite --count 50 [--plan P]`, which calls the
platform API:

| | |
|---|---|
| Request | `POST /v1/platform/waitlist/invite`, body `{ "count": 50, "plan": null }`. `count` is 1–500; `plan` filters by plan of interest (`null`: any) |
| Permission | `platform:ops`; audit action `waitlist.invite` |
| Response | `200 { "invited": 50, "waiting": 262 }` |
| Effect | Invites the oldest confirmed, uninvited entries. Each gets an email from the system identity with the invite link `https://{PM_CONSOLE_HOST}/console/sign-up?invite={token}`, valid for 7 days from `invited_at`, which works while `PM_SIGNUP` is `waitlist`. Its token is stored only as a keyed hash under the current `link` key (`waitlist.invite_token_hash`, with the kid in `key_kid`), like an invitation |

An address is written to `waitlist` only when its confirmation link is used, so there are no unconfirmed
entries and `confirmed_at` is never `NULL`: an unused confirmation link expires after 10 minutes, like a
sign-in link. Invitations go to the oldest `confirmed_at` first. Entries are deleted 30 days after
invitation.

**Signing up with an invite.** `GET /console/sign-up?invite={token}` hashes the token with the `link`
key named by its first character and looks it up in `waitlist.invite_token_hash`. A **valid waitlist
invite** is a `waitlist` row whose `invited_at` is less than 7 days old, while `PM_SIGNUP=waitlist`. With
one, the page is the sign-up page of [§6.2](#62-after-launch-open-sign-up), with the invited address
filled in, the plan of interest pre-selected and the token in a hidden `invite` field; otherwise it is the
"No workspace yet" page. The account's address must equal the waitlisted address: `POST /console/sign-up`
sends nothing for any other address, and with Google or GitHub the verified address must be the
waitlisted one ([§4](#4-google-and-github), step 5).

### 6.2 After launch: open sign-up

With `PM_SIGNUP=open`, the landing CTAs go to `https://app.pylotamail.com/console/sign-up?plan={free|developer|team}`.
An unknown plan value means `free`.

1. **Choose a method.** "Continue with Google", "Continue with GitHub", or an email address. A checkbox
   accepts the Terms of Service, the Privacy Policy and the Data Processing Addendum (`PM_TERMS_URL`,
   `PM_PRIVACY_URL`, `PM_DPA_URL`). It is required; the version (`PM_TERMS_VERSION`) and the time are
   stored on the user.
2. **Prove the address.** With email, `POST /console/sign-up` (the address, the checkbox, `plan`, `next`,
   and `invite` when the page came from an invite link) writes a `login_tokens` row with
   `purpose = 'sign_up'`, the `plan`, the validated `next` in `next_path`, and `terms_version` =
   `PM_TERMS_VERSION`, then emails a link and a code as sign-in does. Unlike sign-in, it sends to an
   address that has no account, when `PM_SIGNUP=open` or the request carries a valid waitlist invite for
   that address ([§6.1](#61-before-launch-the-waitlist)); otherwise it sends nothing. The response is the
   same in every case, and the per-address and `RL_SIGNIN` limits of sign-in apply. The account is created
   only when the link or code is used, so there are never unverified accounts: the new `users` row copies
   `terms_version` from the token, with `terms_accepted_at` = the token's `created_at` (when the box was
   ticked). If the address already has an account, the token signs that person in like a sign-in token and
   records the newly accepted terms. With Google or GitHub, the provider's verified address is used
   ([§4](#4-google-and-github)). Addresses on the built-in list of disposable-mail domains (it ships with
   each release) or on a domain in `PM_SIGNUP_BLOCKED_DOMAINS` are refused before any mail is sent
   ([W29](../edge-cases.md)), and so are addresses this deployment hosts, whose mail an API key could
   read ([§10](#10-abuse-and-safety-on-cloud), [W45](../edge-cases.md)).
3. **Create the workspace** (`/console/workspaces/new?plan={plan}`, the plan carried from the token or the
   OAuth flow), shown when the person has no workspace and no pending invitation. The fields are the
   workspace name, the address suffix (pre-filled from the name, for example `.brightwell`, with the
   resulting example address shown under it) and the time zone, plus the plan in a hidden field. A taken
   suffix, or one whose confusable fold equals another workspace's, returns the form with `suffix_taken`
   ([W33](../edge-cases.md)), and one that folds to a reserved name with `address_reserved`
   ([D12](../edge-cases.md), [REST API › Tenants](../../reference/api.md#post-v1tenants)). The form returns with
   `workspace_limit` when this person, or another person whose address is the same mailbox with a
   different `+tag` (the local part compared with everything from the first `+` removed, through
   `users.email = ?base OR users.email LIKE ?pattern ESCAPE '\'`), already owns a workspace on the
   catalog's default plan ([W46](../edge-cases.md)). On success the tenant is
   created on the Free plan with this person as owner, and `users.last_tenant_id` is set.
4. **Pay, when a paid plan was chosen.** The owner goes straight to Stripe Checkout for that plan
   ([Billing › Checkout](billing.md#checkout)). Coming back from Checkout is [§9](#9-coming-back-from-checkout).
   Cancelling Checkout returns to `/console?upgrade={plan}`: the Overview, on Free, with the banner
   "Finish upgrading to Developer" ([W24](../edge-cases.md)). The banner comes from the query parameter,
   so nothing is stored.
5. **Land on the Overview** with the first-run checklist ([§8](#8-the-overview-the-screen-people-land-on)).

**Form ticket.** The forms that send mail to an address someone types (`/console/sign-in`,
`/console/sign-up` and `/console/waitlist`) carry a hidden `ticket` field, rendered with the `GET`:
`base64url(payload || HMAC-SHA256(link key {kid}, payload)[0..16])`, with payload
`t1:{kid}:{form}:{issued_unix_s}:{net}`, where `net` is the first 16 hex characters of
`HMAC(PM_HASH_KEY, network)` and the network is the client's IPv4 address or IPv6 /64 prefix
(`CF-Connecting-IP`). The `POST` sends nothing, and shows the form again with "Please send the form
again", when the ticket is missing or altered, names another form or network, or was issued less than 2
seconds or more than 30 minutes before. It is the no-JavaScript stand-in for a proof of work: each
submission costs a page fetch and a wait from the same network, which the per-network budgets of
[§10.2](#102-system-mail-budgets) then count. Tickets are not single use; the budgets bound reuse
([W44](../edge-cases.md)).

## 7. Where people land

After any successful sign-in (and two-step verification), the first matching row decides:

| Situation | Lands on |
|---|---|
| A valid `next` was carried through sign-in: a relative path starting with `/console/`, with no `//`, no backslash and no scheme ([W31](../edge-cases.md)) | That page |
| The sign-in accepted an invitation (its accept page, or **Accept with Google** or **GitHub**) | That workspace's Overview |
| No workspace, and a pending invitation exists for this address | The pending invitations, `/console/invitations`, each with its own **Accept** button. Nothing is accepted without that click ([W40](../edge-cases.md)) |
| No workspace, and sign-up is open or the address has a valid waitlist invite ([§6.1](#61-before-launch-the-waitlist)) | Create your workspace ([§6.2](#62-after-launch-open-sign-up)), with the plan from the sign-up token or OAuth flow |
| No workspace, sign-up is closed or waitlist, and no valid waitlist invite | "No workspace yet", explaining how to be invited |
| The target workspace requires two-step verification and the person has none | Enrol two-step verification, then continue |
| One workspace | Its Overview |
| Several workspaces | The last one used (`users.last_tenant_id`); if that is gone, the workspace picker |

## 8. The Overview: the screen people land on

`/console` is the workspace home. Viewers see the same page without action buttons.

**Frame.** A header with the workspace switcher, a "Test" badge for test tenants, the plan name and the
user menu (settings, security, sign out). A left navigation, in this order: Overview, Inboxes, Search,
Quarantine, Service accounts, Domains, Webhooks, API keys, Connect, Members, Plan and usage, Audit log,
Settings (with the workspace policy).

**Body, top to bottom:**

1. **Banners**, most urgent first, each with one action:
   - payment failed, with the grace end date and "Update payment method";
   - an unfinished upgrade: `?upgrade={plan}` names a paid plan of the catalog while the workspace is on
     the default plan ("Finish upgrading to Developer", with a button that starts Checkout for owners;
     [W24](../edge-cases.md)). It reads only the query parameter and the current plan;
   - an allowance used up ("Sends are paused until 1 Nov. Add 1,000 sends for £1 or upgrade");
   - a domain `failing` or `suspended` ("Sending from bookings@brightwell.example uses your Pylota Mail
     address until the DNS is fixed");
   - an identity paused for bounces or complaints;
   - two-step verification required but missing;
   - your notification emails paused after a bounce or complaint, with "Confirm your address"
     ([Notifications § 5](notifications.md#5-the-emails)).
2. **First-run checklist**, until its required steps are done ([below](#first-run-checklist)).
3. **Needs a person.** The actions that only a person should take, each linking to the screen that
   resolves it:
   - quarantined messages waiting for review (count, plus the five oldest with their reasons);
   - sends whose outcome is `uncertain` and must be resolved;
   - domains with issues to fix;
   - webhook endpoints that are failing or disabled;
   - invitations about to expire;
   - service sign-ups waiting for approval (count, plus the five oldest with inbox and service;
     [Service sign-up ledger §8](service-accounts.md#8-console)).

   The daily "needs a person" email reads the same counts ([Notifications](notifications.md#3-how-notifications-are-produced)).
4. **Usage.** A meter per allowance (inboxes, sends, triage analyses, custom domains, storage, seats) from
   `GET /v1/usage`, with the reset date and a link to Plan and usage.
5. **Inboxes.** Per identity, for the last 24 hours: received, sent, waiting for a reply, unread. Each row
   opens the inbox.
6. **Recent activity.** The last 20 events of the workspace (the same events webhooks receive), as one line
   each.

On a deployment with `PM_BILLING=off`, items 1 (billing banners) and 4 (plan limits) show usage only.

### First-run checklist

Each step's state is worked out from real data on every render, never stored, so it cannot drift. Only
"dismiss the checklist" is stored (`tenants.onboarding_dismissed_at`), and it is offered once the required
steps are done: the "Dismiss" button (owners and admins) posts to a console handler that sets the column
to the current time, and the Overview render reads it and leaves the checklist out while it is set.

| Step | Required | Done when | Screen |
|---|---|---|---|
| Create your first inbox | Yes | The workspace has an identity | `/console/inboxes/new`: name it and see its address, for example `bookings.brightwell@pylotamail.com` |
| Send it a test email | Yes | An inbound message exists | The address with a copy-friendly box, and a "Check for email" button that reloads the step. It reports only that a message arrived |
| Create an API key | Yes | A key exists | `/console/keys/new`. The secret is shown once |
| Connect your agent | Yes | A workspace key made an authenticated API or MCP request in the last 7 days (`api_keys.last_used_at`) | `/console/connect`: the `claude mcp add` line, `.mcp.json`, a `curl` request and `pmail login`, with the key ID filled in (never the secret) |
| Add a webhook | No | An endpoint returned `2xx` to a test event | `/console/webhooks` |
| Connect your own domain | No | A domain is `healthy` | `/console/domains/new`, the method chooser from [Domains on any DNS host](domain-connections.md#which-method-to-choose) |
| Invite your team | No (Team plan only) | The workspace has a second member | `/console/members` |

Compared with goshen-email's guided setup, the checklist adds the "Connect your agent" proof, the domain
method chooser and team invitations. The "Needs a person" queue below it is new, and turns the human
approvals in the product promise into a daily task list.

## 9. Coming back from Checkout

Stripe redirects to `/console/plan/return?session_id={CHECKOUT_SESSION_ID}`.

1. The handler retrieves the Checkout Session from Stripe (`GET /v1/checkout/sessions/{id}` with
   `PM_STRIPE_SECRET_KEY`). It requires the session's `client_reference_id` and `metadata.tenant_id` to
   equal this workspace's tenant ID, and its `customer` to equal `billing_accounts.stripe_customer_id`,
   which the console wrote before creating the session ([Billing › Stripe objects](billing.md#stripe-objects)).
   Any mismatch shows a neutral "Nothing to show" page and changes nothing ([W26](../edge-cases.md)). The
   return handler never writes `billing_accounts`.
2. Stripe webhooks are the only source of plan state (FR-BILL). If the webhook has already changed the
   plan, the page says "You're on Team" and links to the Overview.
3. If it has not, the page says "Confirming your payment" and reloads itself with
   `<meta http-equiv="refresh" content="3">` (no JavaScript), at most 7 times. After that it says "Payment
   received; your plan updates within a minute" and links to the Overview. The Overview shows the same
   message until the webhook arrives ([W25](../edge-cases.md)).

## 10. Abuse and safety on Cloud

| Risk | Control |
|---|---|
| Sign-in mail used as a spam cannon, and code guessing | 3 link or code requests per 10 minutes per address and 10 attempts per code, after which the token is burned ([Sign-in](console.md#sign-in)); 30 failed codes per address per UTC day lock sign-in by code for that address until the next UTC day, links keep working, and the address is told once ([W43](../edge-cases.md)). Plus a rate-limit binding `RL_SIGNIN`: 10 requests per 60 s per client network (`CF-Connecting-IP`; an IPv6 address counts by its /64 prefix, so rotating addresses inside one prefix does not help), on `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-in/verify`, `/console/sign-up` and `/console/waitlist` and on `GET /console/oauth/{provider}/start`. Plus the form ticket ([§6.2](#62-after-launch-open-sign-up)) and the system-mail budgets ([§10.2](#102-system-mail-budgets)). This closes [Console open point 1](console.md#open-points) |
| Free workspaces created to send spam | A new-workspace send ramp: the effective tenant daily cap is at most 50 for the first 7 days on Free, lifted on day 7 by a daily evaluation when the bounce and complaint rates are under the auto-pause thresholds, or by a paid plan once its invoice is paid ([§10.1](#101-new-workspace-send-ramp)). The usual auto-pause still applies ([W30](../edge-cases.md)). One self-serve Free workspace per person, `+tag` variants included (`workspace_limit`, [§6.2](#62-after-launch-open-sign-up)), and an automatic breaker for the whole shared domain ([§10.3](#103-shared-domain-breaker), [W46](../edge-cases.md)) |
| Disposable addresses | `PM_SIGNUP_BLOCKED_DOMAINS` ([W29](../edge-cases.md)) |
| A console account whose sign-in address is mail this deployment receives | Refused: every key that reads that mailbox could read the sign-in codes. An address is **hosted** when its domain is `PM_PLATFORM_DOMAIN`, or when it is an `addresses` row in state `pending`, `active` or `retiring`. Sign-up (email, Google, GitHub), the waitlist, invitations (`400 invalid_request` on `email`) and workspace owners (`POST /v1/tenants`, `400 invalid_request` on `owner.email`) refuse it; `pmail setup --owner-email` refuses the platform domain. In the other direction, an identity address equal to an existing console user's sign-in address is refused with `409 address_taken` ([Identities and domains › Create](identity-domains.md#create), [W45](../edge-cases.md)) |
| System mail drained by others | Budgets per recipient, per client network and ASN, and per inviting tenant, and a reserve of the system identity's day for sign-in mail ([§10.2](#102-system-mail-budgets), [W44](../edge-cases.md)) |
| Who system mail comes from | `PM_SYSTEM_FROM`, for example `Pylota Mail <no-reply@pylotamail.com>`, sent through the platform domain by the system identity ([Identities and domains › The system identity](identity-domains.md#the-system-identity)). It is the identity that other pages name as the sender of sign-in, invitation and notification mail. This closes [Console open point 2](console.md#open-points) |
| Open redirects through `next` | [§7](#7-where-people-land) |
| Lost access to the sign-in address | No recovery route. Nothing the deployment holds proves who controls a workspace once its sign-in address is gone, and a Free workspace has no billing record either, so moving ownership on request would let anyone who tells a good story take a workspace. Owners should keep a second admin (who still cannot take ownership) and keep their address. The workspace keeps working through its API keys; billing stays reachable through Stripe's own Portal sign-in page (`login_page`, [Billing › Customer Portal](billing.md#customer-portal)), where the owner can cancel |
| Lost authenticator | Recovery codes only ([§5](#5-two-step-verification), [W28](../edge-cases.md)) |
| Leaving | A person can delete their account at `/console/settings` when they own no workspace (otherwise `409 owner_required`) ([W34](../edge-cases.md)). An owner can delete a workspace after re-authentication and typing its name. That starts tenant erasure, whose second step, `cancel_billing`, runs right after routing stops and cancels the plan subscription and every top-up subscription at once (`invoice_now=true`, `prorate=false`: anything not yet invoiced is billed, no credit and no refund), before any domain, mailbox or D1 row is removed ([Privacy › Tenant scope](privacy.md#66-tenant-scope)). Deleting an account deletes the person's sessions, `oauth_identities` and `waitlist` row, and scrubs the `users` row ([Privacy › People](privacy.md#69-people-console-accounts)) |

### 10.1 New-workspace send ramp

The ramp limits what a new Free workspace, or a new tenant of a partner, can send before it has a
sending history ([W30](../edge-cases.md)).

- **When it applies.** `tenants.ramp_lifted_at IS NULL`, and either:
  - the tenant has no partner, `PM_BILLING=stripe`, and the workspace is `metered` on the catalog's
    `default_plan` (Free). That is every new Free workspace for its first 7 days (only a paid plan can set
    the column that early), and afterwards until the daily evaluation lifts it. The default tenant
    (billing `disabled`) and `exempt` workspaces without a partner are never ramped; or
  - the tenant was created by a partner's key (`tenants.partner_id` set) and that partner's
    `ramp_exempt` is `0`, the default, whatever `PM_BILLING` and the tenant's billing mode (`exempt`
    included): a partner cannot skip the ramp by provisioning `exempt` tenants. Only a platform key sets
    `ramp_exempt` (`PATCH /v1/partners/{partner_id}`), for a partner whose sending it vouches for; it
    applies at once to the partner's ramped tenants.
- **What it does.** Outbound policy step 18 uses an effective tenant cap of
  min(`policy.tenant_daily_send_cap`, 50) ([Outbound › Policy pipeline](outbound.md#policy-pipeline)).
  The 51st message of the day gets `429 daily_cap_reached` with `details.resets_at`, like any tenant cap.
  Identity caps are unchanged.
- **Daily evaluation.** The `*/15` cron runs `crons/signup_ramp.rs` once per UTC day (the run whose UTC
  hour is 03 and minute is below 15), on every deployment: with billing off it finds only partners'
  tenants, and on a deployment with neither it selects nothing. It selects the ramped workspaces (both
  kinds above) created at least 7 days ago and
  asks each one's `TenantQuota` for `OutcomeRates { since: created_at }`: the number of delivery
  outcomes recorded for its identities since then, and how many were `bounced` and `complained`. They
  come from the tenant's per-day outcome counters, which `RecordOutcome` increments with every outcome
  and identity deletion leaves in place, so an identity deleted during the ramp still counts
  ([Outbound › Abuse auto-pause](outbound.md#abuse-auto-pause-fr-dlv-3)). When neither
  `complained / outcomes` nor `bounced / outcomes` is above the tenant's `policy.abuse` thresholds (both
  are 0 with no outcomes), it sets `ramp_lifted_at = now` and writes the audit row `tenant.ramp_lifted`.
  Otherwise the ramp stays, the audit row `tenant.ramp_held` records the rates, and the workspace is
  evaluated again the next day.
- **Operator review.** The third `tenant.ramp_held` row of a workspace raises the state alert
  `signup_ramp_review:{tenant_id}` (ticket; [Observability › Alert list](observability.md#53-alert-list)).
  Nothing is suspended automatically. The ramp stays and is still evaluated daily; the operator may
  suspend the tenant (FR-TEN-3) or change its plan with `PATCH /v1/tenants/{tenant_id}/billing`.
- **Lifted on a paid plan once paid.** The billing webhook's state application sets `ramp_lifted_at` when
  the workspace moves to a paid plan, which its payment gate allows only once that plan's invoice is
  `paid` ([Billing › Applying state](billing.md#applying-state), [W37](../edge-cases.md)), so a later
  downgrade to Free does not ramp it again. This applies to a partner's `metered` tenant too; an `exempt`
  tenant has no plan, so only the daily evaluation (or `ramp_exempt`) ends its ramp. A disputed payment
  clears `ramp_lifted_at` again ([Billing › Disputes and refunds](billing.md#disputes-and-refunds)).

### 10.2 System mail budgets

The system identity's mail is shared by everyone: one sender, one platform domain, and Cloudflare's daily
Email Sending quota, which is per account and on Pylota Mail Cloud shared with Pylota itself. If anyone
could spend it, `system_mail_blocked` would follow and nobody could sign in. Every system-identity send is
therefore counted, before it is submitted, against exact budgets kept by the default tenant's
`TenantQuota` (`QuotaRequest::SystemMail`, [Outbound › TenantQuota](outbound.md#tenantquota)), in its
`counters` rows `sysmail:{class}:{key}` per UTC day ([W44](../edge-cases.md)):

| Class | What | Budgets per UTC day |
|---|---|---|
| `signin` | Sign-in, re-authentication, sign-up, waitlist confirmation and OAuth link codes | 10 per recipient (with `invitation`); 20 per client network (IPv4 address or IPv6 /64) and 200 per ASN (`request.cf.asn`) |
| `invitation` | Invitations and their re-sends, waitlist invites, and the owner email of `POST /v1/tenants` | 10 per recipient (with `signin`); 50 per inviting tenant; at most 20% of the system identity's day |
| `notification` | Every Notifier email except `account` | The Notifier's own caps ([Notifications § 3](notifications.md#caps-and-the-daily-digest)); at most 50% of the system identity's day |
| `account` | `account` emails | none besides the day |

- **The system identity's day** is its `send_policy.daily_cap` (50,000), lowered to 20% of
  `PM_DAILY_SEND_QUOTA` when that variable is set. Because `invitation` and `notification` together can
  use at most 70% of it, at least 30% of every day stays for `signin` and `account` mail.
- **Keys.** The recipient is a keyed hash (`HMAC(PM_HASH_KEY, address)`), the network and the ASN are
  hashed the same way, and the tenant is its ID; no clear address or IP is stored. The counters are
  deleted with the day by the object's daily cleanup, like the other daily counters.
- **When a budget is spent.** Sign-in, sign-up and waitlist requests still get their usual identical
  response, and nothing is sent ([W15](../edge-cases.md) holds: the response does not say why). An
  invitation is refused before anything is written: `429 daily_cap_reached` with
  `details.cap: "invitations"` and `details.resets_at` at the next 00:00 UTC. A Notifier item is kept and
  retried as for `system_mail_blocked`. Each refusal counts `system_mail_budget_denied_total{class,scope}`,
  and 1,000 refusals in an hour raise the state alert `system_mail_budget` (ticket).
- The partner bucket `RL_PARTNER` and each partner's `max_tenants` still apply on top of these budgets.

### 10.3 Shared-domain breaker

The ramp contains one new workspace; the breaker contains all of them at once. The `*/15` cron
(`crons/send_breaker.rs`) reads today's (UTC) `sends` in `usage_daily` summed over live tenants, which
lag by up to the hourly roll-up, and compares them with `PM_DAILY_SEND_QUOTA` (no variable, no breaker)
([W46](../edge-cases.md)):

| Share of the daily quota | Stage | Effect until 00:00 UTC |
|---|---|---|
| ≥ 60% | 1 | Sends from every ramped workspace ([§10.1](#101-new-workspace-send-ramp)) and every workspace on the catalog's default plan are refused |
| ≥ 90% | 2 | Every tenant's sends are refused; the system identity still sends, so sign-in mail has the last 10% |

- The cron writes the stage and its end to D1 `platform_state` (`key = 'send_breaker'`), with the audit
  row `platform.send_breaker` and the state alert `shared_domain_breaker` (page at stage 2, ticket at
  stage 1). The send handler reads the row with the tenant row (cached for 60 seconds per isolate) and
  passes it to outbound policy step 18, which refuses with `429 daily_cap_reached`,
  `details.cap: "shared_domain"` and `details.resets_at` at the next 00:00 UTC
  ([Outbound › Policy pipeline](outbound.md#policy-pipeline)). Retrying with the same key the next day
  is safe. The breaker never stops inbound mail.
- The stage only rises during a day and ends at 00:00 UTC, when the next cron run deletes the row.
- **Considered and not done in v1.0: a separate subdomain for Free mail.** Free addresses would then
  change on upgrade (they are `name.suffix@pylotamail.com`), which breaks threads with the other side.
  The ramp, this breaker, per-identity auto-pause and the DMARC ramp of the platform domain contain the
  risk instead. If the platform domain's reputation drops (Postmaster Tools), the operator revisits it.

## 11. Data model

```sql
-- users: new columns
last_tenant_id     TEXT,
terms_version      TEXT,
terms_accepted_at  INTEGER,
totp_sealed        BLOB,                 -- pm1 envelope of the 20-byte TOTP secret
totp_enabled_at    INTEGER,
totp_last_step     INTEGER,              -- last accepted time step, against replay
recovery_codes_sealed BLOB,              -- pm1 envelope of [{ "hash": SHA-256(code), "used_at": null }]
totp_window_start  INTEGER,              -- start of the current one-minute attempt window
totp_window_count  INTEGER NOT NULL DEFAULT 0,  -- attempts in that window (at most 5)
totp_failures      INTEGER NOT NULL DEFAULT 0,  -- failed codes in a row; 10 sets totp_locked_until
totp_locked_until  INTEGER,              -- two-step sign-in locked until this time (15 minutes)
totp_pending_sealed BLOB,                -- enrolment: pm1 envelope of the candidate secret (§5)
totp_pending_expires_at INTEGER,         -- enrolment: the candidate secret is refused after this (10 minutes)

-- tenants: new columns
require_two_factor     INTEGER NOT NULL DEFAULT 0,
onboarding_dismissed_at INTEGER,
ramp_lifted_at         INTEGER,          -- new-workspace send ramp ended (§10.1): daily evaluation or paid plan

-- login_tokens: new columns (sign-in, sign-up, waitlist and OAuth link codes share the token machinery)
purpose        TEXT NOT NULL CHECK (purpose IN ('sign_in','sign_up','waitlist','oauth_link')),
plan           TEXT,                     -- sign_up: the plan intent; waitlist: the plan of interest
next_path      TEXT,                     -- sign_up: the validated next (§7)
terms_version  TEXT,                     -- sign_up: PM_TERMS_VERSION accepted with the checkbox

CREATE TABLE oauth_identities (
  provider     TEXT NOT NULL CHECK (provider IN ('google','github')),
  subject      TEXT NOT NULL,              -- Google sub, GitHub numeric id
  user_id      TEXT NOT NULL REFERENCES users(id),
  email_at_link TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX oauth_identities_user ON oauth_identities (user_id);

CREATE TABLE oauth_states (
  state_hash   TEXT PRIMARY KEY,           -- keyed hash of state
  cookie_hash  TEXT NOT NULL,              -- keyed hash of the __Host-pm_oauth value
  key_kid      TEXT NOT NULL,              -- the link-key kid of state_hash and cookie_hash
  provider     TEXT NOT NULL CHECK (provider IN ('google','github')),
  intent       TEXT NOT NULL CHECK (intent IN ('sign_in','sign_up')),
  pkce_sealed  BLOB NOT NULL,
  nonce        TEXT,
  next_path    TEXT,
  plan         TEXT,
  terms_version TEXT,                     -- intent sign_up: PM_TERMS_VERSION accepted at the start
  invitation_id TEXT REFERENCES invitations(id),  -- started from an invitation's accept page (§4 step 1)
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);

CREATE TABLE pending_auth (                -- a first factor passed; the next step is outstanding (§5.1)
  id_hash        TEXT PRIMARY KEY,         -- keyed hash of the __Host-pm_pending value (link keyring)
  key_kid        TEXT NOT NULL,            -- the link-key kid of id_hash
  user_id        TEXT NOT NULL REFERENCES users(id),
  step           TEXT NOT NULL CHECK (step IN ('link_code','two_factor')),
  next_path      TEXT,                     -- validated next (§7)
  plan           TEXT,                     -- sign-up plan intent, carried to §7
  invitation_id  TEXT REFERENCES invitations(id),  -- accepted when the last step passes
  oauth_provider TEXT CHECK (oauth_provider IN ('google','github')),  -- link_code: the identity to link
  oauth_subject  TEXT,
  oauth_email    TEXT,
  login_token_id TEXT REFERENCES login_tokens(id),  -- link_code: the emailed code (purpose oauth_link)
  attempts       INTEGER NOT NULL DEFAULT 0,        -- wrong link codes; 5 uses the row up
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,         -- two_factor: now + 5 minutes; link_code: now + 10 minutes
  used_at        INTEGER                   -- single use
);

CREATE TABLE platform_state (              -- deployment-wide switches written by crons (§10.3)
  key        TEXT PRIMARY KEY CHECK (key IN ('send_breaker')),
  value_json TEXT NOT NULL,                -- send_breaker: {"stage": 1 | 2, "until": <ms>, "share": 0.63}
  updated_at INTEGER NOT NULL
);

CREATE TABLE waitlist (
  email        TEXT PRIMARY KEY,           -- needed to send the invitation; deleted per §6.1
  plan         TEXT,
  created_at   INTEGER NOT NULL,           -- when the confirmation was requested (login_tokens.created_at)
  confirmed_at INTEGER NOT NULL,           -- the row is written only when the confirmation link is used
  invited_at   INTEGER,                    -- invite link sent; valid 7 days
  invite_token_hash TEXT UNIQUE,          -- keyed hash of the sign-up link token (link keyring)
  key_kid      TEXT                       -- the link-key kid of invite_token_hash
);
```

Erasure of a person deletes their `oauth_identities`, `pending_auth` rows and any `waitlist` row
([Console open point 5](console.md#open-points), [Privacy › People](privacy.md#69-people-console-accounts)).
The global retention job deletes `oauth_states` and `pending_auth` rows 24 hours after `expires_at`,
clears `users.totp_pending_*` 24 hours after `totp_pending_expires_at`, and deletes `waitlist` rows as in
[§6.1](#61-before-launch-the-waitlist) ([Privacy › Global retention job](privacy.md#53-global-retention-job)).
All of these tables and columns are in `0001_init.sql`, like the rest of the schema before v1.0, so M24
adds no migration ([Data model](data-model.md#1-d1-control-plane)).

## 12. Configuration

| Variable or secret | Default | Meaning |
|---|---|---|
| `PM_CONSOLE_HOST` | `PM_API_HOST` | Host that serves the console ([§2](#2-hostnames)) |
| `PM_SIGNUP` | `closed` | `closed`, `waitlist` or `open` |
| `PM_SYSTEM_FROM` | `Pylota Mail <no-reply@{PM_PLATFORM_DOMAIN}>` | Sender of sign-in, invitation and notification mail |
| `PM_TERMS_URL`, `PM_PRIVACY_URL`, `PM_DPA_URL`, `PM_TERMS_VERSION` | unset | Required when `PM_SIGNUP` is not `closed` |
| `PM_SIGNUP_BLOCKED_DOMAINS` | unset | Comma-separated domains refused at sign-up, in addition to the built-in list of disposable-mail domains |
| `PM_OAUTH_GOOGLE_CLIENT_ID` / secret `PM_OAUTH_GOOGLE_CLIENT_SECRET` | unset | Enables Google |
| `PM_OAUTH_GITHUB_CLIENT_ID` / secret `PM_OAUTH_GITHUB_CLIENT_SECRET` | unset | Enables GitHub |
| Binding `RL_SIGNIN` | 10 per 60 s | Keyed by client network (`CF-Connecting-IP`; an IPv6 address by its /64 prefix), on `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-in/verify`, `/console/sign-up` and `/console/waitlist`, and `GET /console/oauth/{provider}/start` |
| `PM_DAILY_SEND_QUOTA` | unset | Also sizes the system identity's day ([§10.2](#102-system-mail-budgets)) and turns on the shared-domain breaker ([§10.3](#103-shared-domain-breaker)); Pylota Mail Cloud must set it, because its account's quota is shared with Pylota |

## 13. Tests

| Test | Covers |
|---|---|
| `it::signup::email_creates_account_only_on_use` | No `users` row until the link or code is used; the `sign_up` token holds `plan`, `next_path` and `terms_version`, and the new user copies `terms_version` and `terms_accepted_at` from it; an address with no account is emailed only with `PM_SIGNUP=open` or a valid waitlist invite, and the response is identical either way |
| `it::signup::plan_intent_to_checkout` | `?plan=team` → workspace → Checkout; cancel → `/console?upgrade=team`: Free with the "Finish upgrading" banner and nothing stored ([W24](../edge-cases.md)) |
| `it::signup::closed_and_waitlist` | No account is created when sign-up is closed; the waitlist row is written only when the confirmation link is used, with the plan from the token and `confirmed_at` set; batch invite through `POST /v1/platform/waitlist/invite`; the invite link `GET /console/sign-up?invite=…` lets the waitlisted address sign up by email or Google, refuses any other address, and stops working after 7 days ([W32](../edge-cases.md)) |
| `it::signup::disposable_domain_refused` | An address on a `PM_SIGNUP_BLOCKED_DOMAINS` domain is refused at email sign-up before any mail is sent, and at Google or GitHub sign-up ([W29](../edge-cases.md)) |
| `it::signup::suffix_taken_race` | Two workspaces created at once with the same suffix: one succeeds, the other form returns `suffix_taken` ([W33](../edge-cases.md)) |
| `it::console::delete_account_owner_required` | Deleting your account while you own a workspace → `409 owner_required`; after ownership moves, the deletion succeeds ([W34](../edge-cases.md)) |
| `it::oauth::state_cookie_binding` | Missing, reused, expired or other-browser state → refused ([W20](../edge-cases.md)) |
| `it::oauth::sign_up_records_terms` | `intent=sign_up` without `terms=1` creates nothing; with it, the new user's `terms_version` comes from the `oauth_states` row; `intent=sign_in` creates no account for an address without an invitation |
| `it::oauth::unverified_email_refused` | GitHub without a verified primary address; Google `email_verified: false` ([W21](../edge-cases.md)) |
| `it::oauth::link_by_verified_email` | Google, then an email link → one user ([W22](../edge-cases.md)); an existing email account, then Google with the same verified address → linked only after the emailed code ([W42](../edge-cases.md)) |
| `it::oauth::invitation_email_mismatch` | **Accept with Google** for an invitation to one address, verified with another → refused, invitation still pending ([W23](../edge-cases.md)); with the invited address on a deployment where sign-up is closed → account created and invitation accepted through `oauth_states.invitation_id`; a plain sign-in (no `invite`) with the invited address creates the account but accepts nothing |
| `it::oauth::w42_link_needs_code` | An OAuth identity whose verified address matches an existing user starts a `link_code` pending step: no `oauth_identities` row and no session until the emailed code is entered; 5 wrong codes use the step up; a correct code links, sends `sign_in_method_linked`, then asks for the second factor when enrolled; **Unlink** in settings needs re-authentication, deletes the row and writes `user.oauth_unlink`; `GET /console/oauth/{provider}/start` counts against `RL_SIGNIN` ([W42](../edge-cases.md), FR-CON-17) |
| `it::totp::w41_pending_auth_single_use` | After a first factor an enrolled person has a `pending_auth` row and the `__Host-pm_pending` cookie but no session; the row expires after 5 minutes; a second `POST` of the same correct code, or a replay of the cookie, creates no second session; an enrolment secret is kept in `totp_pending_sealed` and refused after 10 minutes; turning on `require_two_factor` sends an already signed-in, unenrolled member to enrolment on their next request ([W41](../edge-cases.md), FR-CON-16) |
| `core::totp::rfc6238_vectors` | RFC 6238 test vectors; drift ±1; replay in the same step refused |
| `it::totp::workspace_requirement` | `require_two_factor` sends an unenrolled member to enrolment before the workspace opens, and on every later request until they enrol (only enrolment, the picker, settings and sign-out answer); API keys of that workspace still work ([W27](../edge-cases.md)) |
| `it::totp::recovery_code_single_use` | A recovery code signs in once and is refused the second time; generating new codes makes every old code fail ([W28](../edge-cases.md)) |
| `it::totp::recovery_codes_survive_key_rotation` | Recovery codes are stored only in `recovery_codes_sealed` (no plain code in D1); one still works after the `link` key is rotated and the fake clock moves 8 days on; with all ten used, the page says that no way back is left and offers no other route ([W28](../edge-cases.md)) |
| `it::landing::routing_table` | Every row of §7, including a hostile `next` ([W31](../edge-cases.md), FR-CON-11) |
| `it::checkout::return_wrong_workspace` | A session whose `client_reference_id` or `metadata.tenant_id` names another workspace, or whose customer differs from the workspace's `stripe_customer_id` (written before the session was created), changes nothing ([W26](../edge-cases.md)) |
| `it::checkout::return_before_webhook` | Waits, then "within a minute"; the plan is applied by the webhook only ([W25](../edge-cases.md), FR-CON-13) |
| `it::onboarding::derived_steps` | Each checklist step turns done from real data alone; each Overview banner condition shows its banner and hides it once resolved (FR-CON-12) |
| `it::abuse::free_ramp` | 51st send on day 1 of a Free workspace → `429 daily_cap_reached` (effective cap min(policy, 50)); lifted once the upgrade's invoice is paid (not while it is open), and not ramped again after a downgrade ([W30](../edge-cases.md)) |
| `it::abuse::w44_system_mail_budgets` | The 11th system email of a day to one address (sign-in and invitations together), the 21st sign-in email from one IPv4 address or IPv6 /64 (also when the address part rotates), and the 201st from one ASN send nothing while the page stays identical; a tenant's 51st invitation of the day → `429 daily_cap_reached` with `details.cap: "invitations"`; `invitation` and `notification` mail stop at 20% and 50% of the system identity's day while sign-in mail still goes out; a sign-up `POST` without a valid ticket, with one issued under 2 seconds before, or from another network sends nothing ([W44](../edge-cases.md), FR-CON-18) |
| `it::abuse::w46_shared_domain_breaker` | With `PM_DAILY_SEND_QUOTA` set and today's `usage_daily` sends at 60%, the cron writes stage 1: a Free or ramped workspace's send → `429 daily_cap_reached` with `details.cap: "shared_domain"` and `resets_at` at 00:00 UTC, a paid workspace still sends; at 90% every tenant is refused and sign-in mail still goes out; at 00:00 UTC the row is deleted; without the variable nothing happens; a second self-serve Free workspace for `jo+2@example.org` while `jo@example.org` owns one returns `workspace_limit` ([W46](../edge-cases.md), FR-CON-18) |
| `it::console::w45_hosted_address_refused` | Sign-up (email, Google), the waitlist, an invitation (`400 invalid_request`, path `email`) and `POST /v1/tenants` with `owner` (path `owner.email`) refuse an address on the platform domain and an identity's `active` address; creating an identity address equal to a console user's sign-in address → `409 address_taken` ([W45](../edge-cases.md), FR-CON-17) |
| `it::abuse::ramp_evaluator` | On day 7 the daily evaluation lifts the ramp when the rates are under the thresholds; outcomes of an identity deleted before the evaluation still count (the tenant's per-day counters, not the identity's `outcomes` rows); with a complaint rate above them the ramp stays and is evaluated again daily, and the third failure fires `signup_ramp_review` without suspending the tenant ([W30](../edge-cases.md)) |
| `it::abuse::partner_ramp` | A tenant created by a partner key is ramped (51st send of the day → `429 daily_cap_reached`) with billing mode `exempt` and with billing `disabled` on the deployment, and the daily evaluation lifts it on day 7 as for a Free workspace; with the partner's `ramp_exempt` set by a platform key its tenants are not ramped, including ones already ramped; a tenant without a partner in billing mode `exempt` is still never ramped ([W30](../edge-cases.md), §10.1) |
| `it::hosts::console_api_split` | With two hosts, console paths 404 on the API host and API paths 404 on the console host; no `Set-Cookie` on the API host |
