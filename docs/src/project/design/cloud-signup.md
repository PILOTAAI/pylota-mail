# Cloud sign-up, sign-in and first run

How a customer of **Pylota Mail Cloud** goes from the pricing page to a working agent inbox. It covers how
they sign up and sign in, how they pay, which screen they land on, and the first-run checklist. It closes
open point 6 of [Console and workspaces](console.md#open-points) and extends that design. Money is in
[Plans, metering and billing](billing.md).

| | |
|---|---|
| Requirements | FR-CON-8 to FR-CON-13 ([PRD](../prd.md)) |
| Edge cases | [W20–W34](../edge-cases.md) |
| Code | `crates/worker/src/console/{signup.rs, oauth.rs, totp.rs, landing.rs, onboarding.rs, pages/overview.rs}`; `crates/worker/src/crons/signup_ramp.rs` (the daily ramp evaluation, [§10.1](#101-new-workspace-send-ramp)); `crates/core/src/totp.rs` (RFC 6238 codes, pure) |
| Tables | D1 `users`, `tenants` and `login_tokens` (new columns), `oauth_identities`, `oauth_states`, `waitlist` ([§11](#11-data-model)) |

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
in `eu-west-2` (London), decided on 2026-10-09.

`PM_CONSOLE_HOST` defaults to `PM_API_HOST`, so a self-hosted deployment keeps one hostname. When the two
differ, the router answers console paths only on the console host and API paths only on the API host;
everything else gets `404`. That keeps session cookies off the API, and API keys out of browser history.

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

1. `GET /console/oauth/{provider}/start?intent={sign_in|sign_up}&next={path}&plan={plan}&terms=1`. On
   the sign-up page the "Continue with" buttons are `GET` forms that include the terms checkbox, so
   `intent=sign_up` arrives with `terms=1`; without it the start shows the sign-up page again with the
   checkbox marked as required, and creates nothing. Otherwise the Worker creates an `oauth_states` row
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
5. **Find or create the person.** When the flow started from an invitation link, the verified address
   must first equal the invited address. Otherwise the flow is refused, nothing is created or linked, and
   the invitation stays pending ([W23](../edge-cases.md)). Then:
   1. `oauth_identities` has `(provider, subject)` → that user; set its `last_used_at = now`.
   2. Otherwise a `users` row with the verified email exists → link: insert `oauth_identities`. The same
      person can then use any method ([W22](../edge-cases.md)).
   3. Otherwise, create the user ([§6](#6-sign-up)) when a pending invitation exists for that verified
      address, or when the flow's `intent` is `sign_up` and either sign-up is open or the verified
      address has a valid waitlist invite ([§6.1](#61-before-launch-the-waitlist)). The new `users` row
      copies `terms_version` from the `oauth_states` row, with `terms_accepted_at` = the row's
      `created_at` (both `NULL` for an invitation). Otherwise, show the "no workspace yet" page; no
      account is created ([W32](../edge-cases.md)).
6. If the person has two-step verification, ask for it ([§5](#5-two-step-verification)). Then create the
   session and route ([§7](#7-where-people-land)).

`intent` selects the page shown when no account matches: `sign_up` continues to workspace creation,
`sign_in` shows "no workspace yet" ([W32](../edge-cases.md)). Re-authentication never uses OAuth: it is an
emailed code ([Console › Re-authentication](console.md#re-authentication)). `/console/settings/security`
lists the person's linked providers with the address each was linked with (`email_at_link`) and when it
was last used (`last_used_at`).

Provider endpoints and claim names must be re-read from Google's and GitHub's current documentation when
M24 is built. Errors from a provider (`error=access_denied`, timeouts) show a page with a "try another way"
link. They never reveal whether an account exists.

## 5. Two-step verification

- **Enrol** at `/console/settings/security`. It needs re-authentication. The page shows a QR code
  rendered on the server as an inline SVG (the `qrcode` crate, pure Rust) and the base32 secret as text.
  The person confirms with a current code. The secret (20 random bytes) is sealed under `PM_MASTER_KEY` in
  `users.totp_sealed`, and `totp_enabled_at` is set in the same statement. "Enrolled" means
  `totp_enabled_at IS NOT NULL`: the sign-in step and the workspace requirement read it, and
  `/console/settings/security` shows the date.
- **Codes** follow RFC 6238: HMAC-SHA1, 30-second step, six digits, one step of clock drift either way. A
  code is refused if it was already used in its step. Attempts are limited to 5 a minute per person, and
  10 failures in a row lock two-step sign-in for 15 minutes. The counters are columns of `users`
  (`totp_window_start`, `totp_window_count`, `totp_failures`, `totp_locked_until`, [§11](#11-data-model));
  a success resets `totp_failures`.
- **Recovery codes.** Ten codes of 10 characters (Crockford base32) are shown once at enrolment, and each
  works once. Generating new ones invalidates the old ([W28](../edge-cases.md)). They are stored sealed:
  `users.recovery_codes_sealed` is a `pm1` envelope under `PM_MASTER_KEY` of
  `[{ "hash": SHA-256(code), "used_at": null }]`. They are not keyed hashes under the `link` keyring,
  because a link key is deleted 7 days after rotation and recovery codes live for months. The
  `pmail secrets rotate-master` re-seal sweep covers them, as it covers `users.totp_sealed`.
- **When it is asked for.** After any first factor (link, code, Google or GitHub), before the session is
  created. It is also asked for at re-authentication when enrolled.
- **Workspace requirement.** An owner can set `require_two_factor` in workspace settings. Pylota Mail Cloud
  recommends it for Team workspaces. A member without two-step verification who opens that workspace goes
  to enrolment first ([W27](../edge-cases.md)). The API is unaffected: keys are not people.
- Turning it off needs re-authentication with a current code. It sets `totp_sealed`, `totp_enabled_at`,
  `totp_last_step` and `recovery_codes_sealed` to `NULL`, emails the person and writes an audit row.

## 6. Sign-up

### 6.1 Before launch: the waitlist

With `PM_SIGNUP=waitlist`, the landing page's "Get early access" buttons go to
`https://app.pylotamail.com/console/waitlist?plan={plan}`. The person enters an email address, and
`POST /console/waitlist` writes a `login_tokens` row with `purpose = 'waitlist'` and the plan of interest
in `login_tokens.plan`, then emails a confirmation link and code. This is double opt-in on the sign-in
token machinery: the same limits, lifetime and email, sent from the system identity
([Console › Requesting a link or code](console.md#requesting-a-link-or-code)), except that it is sent to
any address that passes the disposable-domain check of [§6.2](#62-after-launch-open-sign-up). The
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
   ([W29](../edge-cases.md)).
3. **Create the workspace** (`/console/workspaces/new?plan={plan}`, the plan carried from the token or the
   OAuth flow), shown when the person has no workspace and no pending invitation. The fields are the
   workspace name, the address suffix (pre-filled from the name, for example `.brightwell`, with the
   resulting example address shown under it) and the time zone, plus the plan in a hidden field. A taken
   suffix returns the form with `suffix_taken` ([W33](../edge-cases.md)). On success the tenant is
   created on the Free plan with this person as owner, and `users.last_tenant_id` is set.
4. **Pay, when a paid plan was chosen.** The owner goes straight to Stripe Checkout for that plan
   ([Billing › Checkout](billing.md#checkout)). Coming back from Checkout is [§9](#9-coming-back-from-checkout).
   Cancelling Checkout returns to `/console?upgrade={plan}`: the Overview, on Free, with the banner
   "Finish upgrading to Developer" ([W24](../edge-cases.md)). The banner comes from the query parameter,
   so nothing is stored.
5. **Land on the Overview** with the first-run checklist ([§8](#8-the-overview-the-screen-people-land-on)).

## 7. Where people land

After any successful sign-in (and two-step verification), the first matching row decides:

| Situation | Lands on |
|---|---|
| A valid `next` was carried through sign-in: a relative path starting with `/console/`, with no `//`, no backslash and no scheme ([W31](../edge-cases.md)) | That page |
| A pending invitation exists for this address | Accept the invitation, then that workspace's Overview |
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
   equal this workspace's tenant ID. It compares the session's `customer` with
   `billing_accounts.stripe_customer_id` only when that column is already set: on a first Checkout the
   webhook may not have linked the customer yet ([W25](../edge-cases.md)). Any mismatch shows a neutral
   "Nothing to show" page and changes nothing ([W26](../edge-cases.md)). The handler never writes
   `stripe_customer_id`; only the webhook links it ([Billing › Events handled](billing.md#events-handled)).
2. Stripe webhooks are the only source of plan state (FR-BILL). If the webhook has already changed the
   plan, the page says "You're on Team" and links to the Overview.
3. If it has not, the page says "Confirming your payment" and reloads itself with
   `<meta http-equiv="refresh" content="3">` (no JavaScript), at most 7 times. After that it says "Payment
   received; your plan updates within a minute" and links to the Overview. The Overview shows the same
   message until the webhook arrives ([W25](../edge-cases.md)).

## 10. Abuse and safety on Cloud

| Risk | Control |
|---|---|
| Sign-in mail used as a spam cannon, and code guessing | 3 link or code requests per 10 minutes per address and 10 attempts per code, after which the token is burned ([Sign-in](console.md#sign-in)). Plus a rate-limit binding `RL_SIGNIN`: 10 requests per 60 s per client IP, keyed by `CF-Connecting-IP`, on `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-up` and `/console/waitlist`. This closes [Console open point 1](console.md#open-points) |
| Free workspaces created to send spam | A new-workspace send ramp: the effective tenant daily cap is at most 50 for the first 7 days on Free, lifted on day 7 by a daily evaluation when the bounce and complaint rates are under the auto-pause thresholds, or at once on a paid plan ([§10.1](#101-new-workspace-send-ramp)). The usual auto-pause still applies ([W30](../edge-cases.md)) |
| Disposable addresses | `PM_SIGNUP_BLOCKED_DOMAINS` ([W29](../edge-cases.md)) |
| Who system mail comes from | `PM_SYSTEM_FROM`, for example `Pylota Mail <no-reply@pylotamail.com>`, sent through the platform domain by the system identity ([Identities and domains › The system identity](identity-domains.md#the-system-identity)). It is the identity that other pages name as the sender of sign-in, invitation and notification mail. This closes [Console open point 2](console.md#open-points) |
| Open redirects through `next` | [§7](#7-where-people-land) |
| Lost access to the sign-in address | No self-service recovery. Pylota support verifies the requester against the workspace's Stripe billing details and a recent invoice number, then moves ownership to a new verified address. The audit log records it with `via: support` |
| Lost authenticator | Recovery codes; otherwise the support route above |
| Leaving | A person can delete their account at `/console/settings` when they own no workspace (otherwise `409 owner_required`) ([W34](../edge-cases.md)). An owner can delete a workspace after re-authentication and typing its name. That starts tenant erasure, whose second step, `cancel_billing`, runs right after routing stops and cancels the plan subscription and every top-up subscription at once, with no proration and no refund, before any domain, mailbox or D1 row is removed ([Privacy › Tenant scope](privacy.md#66-tenant-scope)). Deleting an account deletes the person's sessions, `oauth_identities` and `waitlist` row, and scrubs the `users` row ([Privacy › People](privacy.md#69-people-console-accounts)) |

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
- **Lifted at once on a paid plan.** The billing webhook's state application sets `ramp_lifted_at` when
  the workspace moves to a paid plan ([Billing › Applying state](billing.md#applying-state)), so a later
  downgrade to Free does not ramp it again. This applies to a partner's `metered` tenant too; an `exempt`
  tenant has no plan, so only the daily evaluation (or `ramp_exempt`) ends its ramp.

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

-- tenants: new columns
require_two_factor     INTEGER NOT NULL DEFAULT 0,
onboarding_dismissed_at INTEGER,
ramp_lifted_at         INTEGER,          -- new-workspace send ramp ended (§10.1): daily evaluation or paid plan

-- login_tokens: new columns (sign-in, sign-up and waitlist share the token machinery)
purpose        TEXT NOT NULL CHECK (purpose IN ('sign_in','sign_up','waitlist')),
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
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
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

Erasure of a person deletes their `oauth_identities` and any `waitlist` row
([Console open point 5](console.md#open-points), [Privacy › People](privacy.md#69-people-console-accounts)).
The global retention job deletes `oauth_states` rows 24 hours after `expires_at`, and `waitlist` rows as in
[§6.1](#61-before-launch-the-waitlist) ([Privacy › Global retention job](privacy.md#53-global-retention-job)).

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
| Binding `RL_SIGNIN` | 10 per 60 s | Keyed by client IP (`CF-Connecting-IP`), on `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-up` and `/console/waitlist` |

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
| `it::oauth::link_by_verified_email` | Google, then an email link → one user ([W22](../edge-cases.md)) |
| `it::oauth::invitation_email_mismatch` | Invitation for one address, OAuth with another → refused, invitation still pending ([W23](../edge-cases.md)); with the invited address on a deployment where sign-up is closed → account created and invitation accepted |
| `core::totp::rfc6238_vectors` | RFC 6238 test vectors; drift ±1; replay in the same step refused |
| `it::totp::workspace_requirement` | `require_two_factor` sends an unenrolled member to enrolment before the workspace opens; API keys of that workspace still work ([W27](../edge-cases.md)) |
| `it::totp::recovery_code_single_use` | A recovery code signs in once and is refused the second time; generating new codes makes every old code fail ([W28](../edge-cases.md)) |
| `it::totp::recovery_codes_survive_key_rotation` | Recovery codes are stored only in `recovery_codes_sealed` (no plain code in D1); one still works after the `link` key is rotated and the fake clock moves 8 days on; with all ten used, the page points to the support route ([W28](../edge-cases.md)) |
| `it::landing::routing_table` | Every row of §7, including a hostile `next` ([W31](../edge-cases.md), FR-CON-11) |
| `it::checkout::return_wrong_workspace` | A session whose `client_reference_id` or `metadata.tenant_id` names another workspace, or whose customer differs from an already linked `stripe_customer_id`, changes nothing; a first Checkout whose customer is not linked yet is accepted ([W26](../edge-cases.md)) |
| `it::checkout::return_before_webhook` | Waits, then "within a minute"; the plan is applied by the webhook only ([W25](../edge-cases.md), FR-CON-13) |
| `it::onboarding::derived_steps` | Each checklist step turns done from real data alone; each Overview banner condition shows its banner and hides it once resolved (FR-CON-12) |
| `it::abuse::free_ramp` | 51st send on day 1 of a Free workspace → `429 daily_cap_reached` (effective cap min(policy, 50)); lifted at once on upgrade, and not ramped again after a downgrade ([W30](../edge-cases.md)) |
| `it::abuse::ramp_evaluator` | On day 7 the daily evaluation lifts the ramp when the rates are under the thresholds; outcomes of an identity deleted before the evaluation still count (the tenant's per-day counters, not the identity's `outcomes` rows); with a complaint rate above them the ramp stays and is evaluated again daily, and the third failure fires `signup_ramp_review` without suspending the tenant ([W30](../edge-cases.md)) |
| `it::abuse::partner_ramp` | A tenant created by a partner key is ramped (51st send of the day → `429 daily_cap_reached`) with billing mode `exempt` and with billing `disabled` on the deployment, and the daily evaluation lifts it on day 7 as for a Free workspace; with the partner's `ramp_exempt` set by a platform key its tenants are not ramped, including ones already ramped; a tenant without a partner in billing mode `exempt` is still never ramped ([W30](../edge-cases.md), §10.1) |
| `it::hosts::console_api_split` | With two hosts, console paths 404 on the API host and API paths 404 on the console host; no `Set-Cookie` on the API host |
