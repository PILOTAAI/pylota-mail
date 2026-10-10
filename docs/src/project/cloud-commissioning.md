# Cloud commissioning

How the owner, as the operator of Pylota Mail Cloud, sets up the production deployment at
`pylotamail.com`: its configuration, the Pylota partner and Pylota's own tenants, the checks, and the gates
that open it first to Pylota alone, then to the waitlist, then to everyone. [M20](build-plan.md#m20--staging-deploy-and-live-proof)
proves the software on staging; [M28](build-plan.md#m28--cloud-production-commissioning-after-m20) runs this
page against production (FR-OPS-5).

The owner is a solo developer and the only operator. Nothing here relies on a second person. The controls
are mechanical: a configuration that fails closed, scoped and short-lived credentials, the checks in
[§9](#9-checks), a fresh-agent dry run of this page, and an independent adversarial agent review before
each gate ([§10](#10-go-live-gates)). Pylota's own servers never hold a Pylota Mail platform key: Pylota
holds a partner key only.

| | |
|---|---|
| Requirement | FR-OPS-5 ([PRD](prd.md#613-operations)) |
| Built in | [M28](build-plan.md#m28--cloud-production-commissioning-after-m20), after M20 |
| Related | [Cloud sign-up §2](design/cloud-signup.md#2-hostnames) (hostnames), [Configuration](../reference/configuration.md), [Deploy to Cloudflare](../self-hosting.md), [Billing](design/billing.md#stripe-integration), [REST API › Partners](../reference/api.md#partners) |
| External facts read on 2026-10-10 | Cloudflare [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/) (last updated 2026-09-15) and [Durable Objects roles and permissions](https://developers.cloudflare.com/workers/authorization/durable-objects/): per-Worker roles for account-owned API tokens; creating a Worker needs product-level Admin, because per-Worker roles apply only to Workers that exist; Custom Domains do not support per-Worker roles yet; Durable Objects take the permissions of their Worker. Not verified: that a per-Worker `Editor` token can apply the first Durable Object migration; check CC3 proves it on the first deploy |

## 1. What runs where

| Piece | Production value | Owner decision |
|---|---|---|
| Cloudflare account | Pylota's existing account, shared with Pylota's own Workers, "shared, tightened" | D10, reaffirmed 2026-10-10 |
| Zones | `pylotamail.com` (Cloud) and `pylota.io` (Pylota's own; only its `notify.` and `reminders.` subdomains are used here) | 2026-10-09, 2026-10-10 |
| Worker `pylota-mail` | The service, on `api.pylotamail.com` (`PM_API_HOST`) and `app.pylotamail.com` (`PM_CONSOLE_HOST`) as Custom Domains | [Cloud sign-up §2](design/cloud-signup.md#2-hostnames) |
| Worker `pylota-mail-site` | The landing page and docs, on `pylotamail.com` and `www.pylotamail.com` (`site/wrangler.jsonc`) | – |
| Platform mail domain | `pylotamail.com` apex (`PM_PLATFORM_DOMAIN`) | 2026-10-09 |
| Amazon SES | `eu-west-2` (London), production access, for `dns_records`, `send_only`, `smtp_relay` with `inbound: ses`, the failover, and marketing mail | 2026-10-09 |
| Stripe | Live mode, GBP prices: Free £0, Developer £10, Team £49.50 a month, top-ups £1 | 2026-10-10 |
| Google and GitHub sign-in | One production OAuth client each, redirecting to `app.pylotamail.com` | – |
| Licensor | TREFT LTD | – |

Cloudflare's daily Email Sending quota is per account, so Cloud shares it with Pylota's own Workers
(decided 2026-10-10). `PM_DAILY_SEND_QUOTA` holds the account's figure, so the alert at 80% covers both.

## 2. Release order

Pylota's integration needs Cloud before the public does, so Cloud opens in three phases. Each phase is
entered only through its gate ([§10](#10-go-live-gates)); going back is always one variable away.

| Phase | Who can get in | `PM_SIGNUP` | What changes from the previous phase |
|---|---|---|---|
| **A. Partner-only** | Pylota's partner key and the workspaces it creates; the owner's default tenant | `waitlist` (the landing page collects the waitlist; nobody is invited) | Everything in [§4](#4-production-configuration) and [§7](#7-bootstrap-the-partner-and-pylotas-tenants) |
| **B. Waitlist** | Plus people the owner invites in batches with `pmail waitlist invite` | `waitlist` | Invitations start; paid plans can be bought |
| **C. Open (public v1.0 on Cloud)** | Anyone | `open` | `PM_SIGNUP=open` |

**Rolling back a phase.** `PM_SIGNUP=closed` stops all sign-ups and waitlist confirmations at the next
deploy and leaves every account working; `PATCH /v1/partners/{partner_id}` with `status: suspended` contains
Pylota at once ([J13](edge-cases.md)); `npx --yes wrangler@4.139.0 rollback` returns the Worker to the
previous version ([Security §10](design/security.md#10-rate-limiting-and-abuse)).

## 3. The Cloudflare account: shared, tightened

The account also runs Pylota's own Workers, so no credential that Cloud uses may reach them.

- **Workers are created by the owner in the dashboard**, signed in as a person: `pylota-mail` and
  `pylota-mail-site`, each with the dashboard's starter script. Creating a Worker needs product-level Admin,
  which an API token would then hold for every Worker of the account; a dashboard session is not a stored
  credential.
- **Custom Domains are attached by the owner in the dashboard**: `api.pylotamail.com` and
  `app.pylotamail.com` to `pylota-mail`, `pylotamail.com` and `www.pylotamail.com` to `pylota-mail-site`.
  Custom Domains do not support per-Worker roles yet; once attached, later deploys need only `Editor` on the
  Worker, as long as they do not add or remove a domain. `pmail setup` finds them present and creates
  nothing.
- **Every API token is account-owned, scoped to named zones and to single Workers** (per-Worker roles),
  never to all Workers of the account:

| Token | Held by | Workers | Zones | Account permissions | Lifetime |
|---|---|---|---|---|---|
| Setup token (`CLOUDFLARE_API_TOKEN`) | The owner's shell, for `pmail setup`, `setup ses`, `deploy`, `upgrade`, `doctor` and `secrets rotate-master` | `Editor` on `pylota-mail` only | `pylotamail.com`: Zone Read, DNS Edit, Zone Settings Edit, Email Routing Rules Edit | D1 Edit, Workers R2 Storage Edit, Queues Edit, Vectorize Edit, Workers AI Read and Edit, Email Sending Edit, Account Settings Read, Account Analytics Read | Created for one working session with an expiry 24 hours ahead, deleted at the end of it |
| Worker token (`PM_CF_API_TOKEN`, a Worker secret) | The Worker | None | `pylotamail.com` and `pylota.io` only: Zone Read, DNS Edit, Zone Settings Edit, Email Routing Rules Edit. No Zone Edit: `domains.allow_create_zone` is off on Cloud, so the Worker never creates a zone | Email Sending Edit, Queues Edit | Standing; rotated every 90 days and after any suspected leak |
| Site token | The owner's shell, for `pylota-mail-site` deploys | `Editor` on `pylota-mail-site` only | none | none | As the setup token |

The setup token's D1, R2, Queues and Vectorize permissions are account-wide for those products, because
those products have no per-resource roles for this use; that is why the token lives for one session only.
No token holds token management, billing, members or Email Routing destination addresses
([Deploy › step 2](../self-hosting.md#2-create-a-cloudflare-api-token) lists what each permission is for).

**What Cloud offers tenants as a result.** `nameservers` is not offered (`422 transport_unavailable`,
`zone_creation_not_allowed`); `delegated_subdomain` is off (`PM_CF_SUBDOMAIN_SETUP=off`); `cloudflare_zone`
works only on zones a platform key lists in a tenant's `domains.cloudflare_zones`, which on Cloud means only
`pylota.io` for Pylota's own two tenants. Customers bring their own domains with `dns_records`,
`send_only` and `smtp_relay` ([Domains on any DNS host](design/domain-connections.md)), each shipping only if
its spike passed (S8, S11, S12).

## 4. Production configuration

`pmail setup` writes `deploy/wrangler.toml` with self-hosting defaults (`PM_SIGNUP = "closed"`,
`PM_BILLING = "off"`). The owner then sets the `[vars]` below in that file and runs `pmail deploy`. Secrets
go only through `npx --yes wrangler@4.139.0 secret put <NAME>` (the value on stdin), or are generated and
uploaded by `pmail setup` and `pmail setup ses`; none is written to a file. The rendered file is kept in the
owner's private operations repository, never in `PILOTAAI/pylota-mail`.

**Variables:**

| Variable | Production value | Why |
|---|---|---|
| `PM_ENV` | `production` | Shown in `/health` |
| `PM_PLATFORM_DOMAIN` | `pylotamail.com` | The shared mail domain, a zone apex |
| `PM_API_HOST` | `api.pylotamail.com` | REST, MCP, hooks, the Stripe webhook; the assertion issuer |
| `PM_CONSOLE_HOST` | `app.pylotamail.com` | Keeps session cookies off the API host |
| `PM_JURISDICTION` | `eu` | D1, R2 and Durable Objects in the EU; fixed at setup |
| `PM_CF_ACCOUNT_ID` | Pylota's account ID (written by setup) | – |
| `PM_SIGNUP` | `waitlist` in phases A and B, `open` in phase C | [§2](#2-release-order) |
| `PM_CONSOLE` | `on` | – |
| `PM_SYSTEM_FROM` | `Pylota Mail <no-reply@pylotamail.com>` | Sign-in, invitation and notification mail |
| `PM_NOTIFICATIONS` | `on` | – |
| `PM_QUARANTINE_KEY_RELEASE` | `off` | Only people release quarantined mail, except where a partner opted a tenant in (FR-CON-6) |
| `PM_DEFAULT_POLICY` | The JSON of [§5](#5-the-cloud-default-policy) | – |
| `PM_BILLING` | `stripe` | – |
| `PM_PLAN_CATALOG` | The live catalog of [§6](#6-stripe-live-mode) | – |
| `PM_BILLING_GRACE_DAYS` | `7` | FR-BILL-10 |
| `PM_TERMS_URL`, `PM_PRIVACY_URL`, `PM_DPA_URL` | `https://pylotamail.com/terms`, `https://pylotamail.com/privacy`, `https://pylotamail.com/dpa` | Required when `PM_SIGNUP` is not `closed`; the site must serve all three before phase A |
| `PM_TERMS_VERSION` | The date of the published terms, `YYYY-MM-DD` | Stored on each user at sign-up |
| `PM_SIGNUP_BLOCKED_DOMAINS` | unset (the built-in disposable-domain list applies) | Add domains only after abuse is seen |
| `PM_OAUTH_GOOGLE_CLIENT_ID`, `PM_OAUTH_GITHUB_CLIENT_ID` | The production clients of [§8](#8-oauth-applications) | – |
| `PM_SES_REGION` | `eu-west-2` | Written by `pmail setup ses` |
| `PM_SES_SNS_TOPIC_ARN`, `PM_SES_INBOUND_BUCKET`, `PM_SES_INBOUND_TOPIC_ARN`, `PM_SES_INBOUND_QUEUE_URL`, `PM_SES_RULE_SET` | As `pmail setup ses` writes them | – |
| `PM_CF_SUBDOMAIN_SETUP` | `off` | No Enterprise child zones on Cloud |
| `PM_WEB_BOT_AUTH` | `off` | Turned on only after spike S13 passed and the owner decides, by a later change to this page |
| `PM_DAILY_SEND_QUOTA` | The account's Email Sending daily quota from the dashboard (shared with Pylota) | Alert at 80% |
| `PM_BACKUP_BUCKET` | `pylota-mail-backup` | Paying customers' mail gets the nightly copy (NFR-OPS-2) |
| `PM_SECURITY_CONTACT` | A mailbox outside `pylotamail.com` that the owner reads, for example `security@pylota.io` | Mail to role names on the platform domain routes to it, so it must not be on that domain |
| `PM_TRUSTED_AUTHSERV_ID` | Written by setup's mail test | – |
| `PM_LOG_LEVEL` | `info` | – |
| `PM_AI_GATEWAY`, `PM_SCANNER_URL` | unset | – |
| `PM_EMBED_MODEL`, `PM_RERANK_MODEL`, `PM_AGENT_MODEL`, `PM_TRIAGE_MODEL`, `PM_DOH_RESOLVERS`, `PM_IDENTITY_KEY_OVERLAP_DAYS` | Defaults | – |

**Secrets:**

| Secret | Source |
|---|---|
| `PM_MASTER_KEY`, `PM_KEY_PEPPER`, `PM_HASH_KEY` | Generated and uploaded by `pmail setup` (no `--print-secrets`) |
| `PM_CF_API_TOKEN` | The Worker token of [§3](#3-the-cloudflare-account-shared-tightened) |
| `PM_SES_ACCESS_KEY_ID`, `PM_SES_SECRET_ACCESS_KEY` | Created and uploaded by `pmail setup ses` |
| `PM_STRIPE_SECRET_KEY` | A live restricted key (`rk_live_…`) with exactly the permissions of [Billing › Stripe integration](design/billing.md#stripe-integration) |
| `PM_STRIPE_WEBHOOK_SECRET` | The signing secret of the live webhook endpoint ([§6](#6-stripe-live-mode)) |
| `PM_OAUTH_GOOGLE_CLIENT_SECRET`, `PM_OAUTH_GITHUB_CLIENT_SECRET` | The production OAuth clients |

`pmail setup` for production:

```bash
export CLOUDFLARE_API_TOKEN=…      # the setup token of §3, created for this session
pmail setup --account-id <pylota-account-id> --domain api.pylotamail.com \
  --console-host app.pylotamail.com --mail-domain pylotamail.com --jurisdiction eu \
  --owner-email <owner address> --owner-name "<owner name>" --tenant-name "Pylota Mail" \
  --daily-send-quota <account quota> --backup-bucket pylota-mail-backup --profile cloud-prod
pmail setup ses --region eu-west-2
```

The default tenant ("Pylota Mail", billing `disabled`) holds only the system identity and the owner's
console account; it is never a customer workspace.

## 5. The Cloud default policy

```json
{
  "domains": { "allow_create_zone": false },
  "accounts": { "require_approval": true }
}
```

- `domains.allow_create_zone: false` is already the built-in default; stating it records the
  shared-account decision: the Worker token cannot create zones, and no Cloud tenant may use `nameservers`.
- `accounts.require_approval: true` turns on the [service sign-up ledger](design/service-accounts.md) gate
  for every Cloud tenant. It is lower-only with `false` as the looser value, so neither a workspace nor a
  partner can turn it off; only a platform key can, tenant by tenant
  ([Workspace policy §2](design/workspace-policy.md#2-classes-and-ceilings)).
- Every other field keeps its built-in default. `quarantine.key_release` stays `false` and
  `web_bot_auth.allowed` stays `false`.

## 6. Stripe live mode

In the Stripe Dashboard, live mode, for TREFT LTD:

1. **Products and prices**, all monthly, recurring, GBP, tax behaviour as Stripe Tax requires: Developer
   £10, Team £49.50, and three top-up prices at £1 per unit (inboxes, sends, triage).
2. **Stripe Tax** on, with TREFT LTD's registrations; the Customer Portal configured as
   [Billing › Customer Portal](design/billing.md#customer-portal) describes.
3. **Webhook endpoint** `https://api.pylotamail.com/billing/stripe/webhook`, API version
   `2025-03-31.basil`, with exactly the six events of [Billing › Events handled](design/billing.md#events-handled);
   its signing secret becomes `PM_STRIPE_WEBHOOK_SECRET`.
4. **Restricted key** with exactly the permissions of [Billing › Stripe integration](design/billing.md#stripe-integration);
   it becomes `PM_STRIPE_SECRET_KEY`.
5. **`PM_PLAN_CATALOG`**: the built-in catalog of [Billing › Plan catalog](design/billing.md#plan-catalog)
   with the live price IDs filled in (`plans[].stripe_price_id` for Developer and Team,
   `topup.stripe_price_ids` for the three top-ups). `pmail deploy` refuses an invalid catalog. The staging
   catalog with small allowances (M20 step 11) is never used here.

## 7. Bootstrap the partner and Pylota's tenants

The owner runs these commands from their own machine. Platform keys are short-lived: setup's bootstrap key
expires after 24 hours, and every later session uses a new platform key with `--expires-in 1d`, read by the
CLI through `key_command` from the owner's password manager, never stored in a file
([Configuration › CLI configuration](../reference/configuration.md#cli-configuration)). No platform key is
ever given to Pylota's servers.

```bash
# 1. A platform key for this session (the profile reads it with key_command).
pmail --profile cloud-prod keys create --level platform --name ops-2026-10-12 --expires-in 1d \
  --permissions tenants:manage,partners:manage,platform:ops,keys:manage,domains:read,domains:write,\
identities:read,policy:write,audit:read,usage:read

# 2. The Pylota partner: exempt billing, more tenants than the default 25, no send ramp.
pmail --profile cloud-prod partners create --name Pylota --default-billing-mode exempt \
  --max-tenants 200 --ramp-exempt true

# 3. Pylota's partner key, 90 days. The secret goes straight into Pylota's backend secret store.
pmail --profile cloud-prod keys create --level partner --partner <ptn_id> --name pylota-backend \
  --expires-in 90d --permissions tenants:manage,keys:manage,webhooks:manage,webhooks:read,\
quarantine:review,usage:read,identities:read,identities:write,domains:read,domains:write,messages:read,\
messages:send,messages:write,attachments:read,search:read,members:manage,policy:write,accounts:approve
```

`max_tenants` 200 bounds Pylota at 200 × 5,000 sends a day in policy terms; the shared Email Sending quota
is the tighter bound in practice, and its 80% alert fires first. Raising it later is a platform-key
`PATCH /v1/partners/{partner_id}`.

**Pylota's own two tenants**, created with Pylota's partner key (a profile `pylota-partner` that holds it),
so they are Pylota's, billed `exempt` and outside the ramp:

```bash
# 4. Pylota's platform tenant (transactional mail from notify.pylota.io) and marketing tenant
#    (reminders, win-back and expired quotes from reminders.pylota.io, with consent).
pmail --profile pylota-partner tenants create --slug pylota-platform --name "Pylota platform"
pmail --profile pylota-partner tenants create --slug pylota-marketing --name "Pylota marketing"

# 5. Only a platform key lists pylota.io for them (domains.cloudflare_zones is platform-only).
pmail --profile cloud-prod tenants update pylota-platform  --policy '{"domains":{"cloudflare_zones":["pylota.io"]}}'
pmail --profile cloud-prod tenants update pylota-marketing --policy '{"domains":{"cloudflare_zones":["pylota.io"]}}'

# 6. Pylota adds the two subdomains with its partner key (cloudflare_zone, names strictly under the
#    listed zone; the pylota.io apex stays out of reach).
pmail --profile pylota-partner domains add notify.pylota.io --tenant pylota-platform --method cloudflare_zone
pmail --profile pylota-partner domains add reminders.pylota.io --tenant pylota-marketing --method cloudflare_zone

# 7. Marketing mail needs SES: Cloudflare Email Service is for transactional mail only. The transport
#    change is platform-only. With SES configured, onboarding already created the SES identity and its
#    DKIM CNAMEs, so the switch needs no new DNS.
pmail --profile cloud-prod domains update reminders.pylota.io --transport ses
```

Each operator workspace is then created by Pylota's backend with its partner key
(`POST /v1/tenants`, with `policy.quarantine.key_release: true`), never by the owner. Marketing sends from
`reminders.pylota.io` use `kind: marketing` with `unsubscribe` and `consent` (FR-OUT-8); a marketing send
from a `cloudflare` transport domain is refused with `422 transport_unavailable` (`marketing_needs_ses`).

## 8. OAuth applications

| Provider | Setting | Value |
|---|---|---|
| Google | OAuth client type | Web application, in a Google Cloud project owned by TREFT LTD |
| Google | Authorised redirect URI | `https://app.pylotamail.com/console/oauth/google/callback` |
| Google | Scopes | `openid email profile` only; consent screen published, with the terms and privacy URLs of [§4](#4-production-configuration) |
| GitHub | OAuth app callback URL | `https://app.pylotamail.com/console/oauth/github/callback` |
| GitHub | Scopes requested by the Worker | `read:user user:email` |

Provider endpoints and claim names follow [Cloud sign-up §4](design/cloud-signup.md#4-google-and-github),
re-read when M24 was built; re-read both providers' current documentation again before phase B, and record
the date on this page.

## 9. Checks

Run against production by the owner, each with its command and expected result. A check that fails stops
the phase; nothing is fixed by hand in the dashboard without the change being written back into this page.

| ID | Check | How | Pass |
|---|---|---|---|
| CC1 | Health and version | `curl https://api.pylotamail.com/health` | `200`, `env: production`, `version` = the release tag verified by `pmail deploy` |
| CC2 | Doctor | `pmail --profile cloud-prod doctor --mail-test` | Exit 0: DNS, routing, sending, event subscriptions, bindings, secrets and quota all pass |
| CC3 | Tokens are scoped | Each token's policies in the dashboard (Manage Account › Account API Tokens), and the first `pmail setup` and `pmail deploy` with the setup token | No standing token has a product-level Workers role; zones are exactly those of [§3](#3-the-cloudflare-account-shared-tightened); the first deploy, including the Durable Object migration, succeeded with the per-Worker `Editor` token; the setup token is deleted at the end of the session |
| CC4 | Configuration | Compare `deploy/wrangler.toml` `[vars]` with [§4](#4-production-configuration), and the Worker's secret list (Wrangler `secret list`, pinned as everywhere) with its secrets table | Equal, line by line; no other variable or secret |
| CC5 | Host split | `curl -i https://api.pylotamail.com/console`; `curl -i https://app.pylotamail.com/v1/me` | Both `404`; no `Set-Cookie` from the API host |
| CC6 | System mail | Sign in at `app.pylotamail.com` with an email link | The mail comes from `no-reply@pylotamail.com` with DKIM `pass` aligned to `pylotamail.com` |
| CC7 | Zone creation off | With a test tenant key, `POST /v1/tenants/{tenant_id}/domains` with `method: nameservers` | `422 transport_unavailable`, `details.reason = "zone_creation_not_allowed"` |
| CC8 | Key release off | With a key holding `quarantine:review` on a workspace without `quarantine.key_release`, release a quarantined message | `403 permission_denied` |
| CC9 | Partner containment | Pylota's partner key reads the owner's default tenant, and creates a test tenant and reads it | `404 tenant_not_found`, then `201` and `200`; the test tenant has `partner_id` and billing `exempt`; it is erased after CC10 |
| CC10 | Ledger gate | On Pylota's test tenant, `wait(kind=verification, from=@service.example)` for an identity with no approved entry | `403 policy_denied`, `details.reason = "account_not_approved"` |
| CC11 | SES | `pmail setup ses` exit 0; both SNS topics have `SignatureVersion=2`; a marketing send from `reminders.pylota.io` to the owner's mailbox | Delivered with DKIM aligned to `reminders.pylota.io` and the unsubscribe headers |
| CC12 | Pylota's domains | `pmail domains health notify.pylota.io` and `reminders.pylota.io` | `healthy`; adding the `pylota.io` apex with Pylota's key gets `403 scope_denied` (`zone_not_allowed`) |
| CC13 | Send quota alert | `PM_DAILY_SEND_QUOTA` set; the alert rule is listed by `pmail doctor` | Present |
| CC14 | Backups | The day after setup, list `pylota-mail-backup` | The nightly job copied the day's `t/` objects |
| CC15 | Stripe | A real Developer Checkout by the owner on a throwaway workspace, a top-up, a Portal plan switch, then cancellation and a refund in the Dashboard | The plan changes only through the webhook; `billing_events` has no `error:` outcome; the workspace returns to Free |
| CC16 | Google and GitHub | Sign up with each on `app.pylotamail.com`, with a waitlist invite | Each creates one account with the verified address |
| CC17 | Waitlist | Join the waitlist with an address the owner controls, confirm it, invite it with `pmail waitlist invite --count 1`, sign up | One `waitlist` row, then one account and workspace on Free |
| CC18 | DMARC | `dig TXT _dmarc.pylotamail.com` | `p=none` with `rua` at phase A; the ramp to `quarantine` and `reject` follows [Deploy › The DMARC ramp](../self-hosting.md#dns-authentication-and-the-dmarc-ramp) |
| CC19 | Security contact | `curl https://api.pylotamail.com/.well-known/security.txt` | Served, with `PM_SECURITY_CONTACT` |

## 10. Go-live gates

| Gate | Enters | Every item must hold |
|---|---|---|
| **A** | Phase A, partner-only | M20 accepted on staging and the release tagged; CC1–CC14, CC18 and CC19 pass; the terms, privacy and DPA pages are live; a fresh agent that never saw this deployment rebuilds [§4](#4-production-configuration) and [§5](#5-the-cloud-default-policy) from the docs alone and finds no difference from the deployed configuration; an independent adversarial agent review of the deployed configuration, the token scopes and [§7](#7-bootstrap-the-partner-and-pylotas-tenants) finds nothing rated high; `PM_SIGNUP=waitlist` with no invitation sent |
| **B** | Phase B, waitlist invitations | Gate A; Pylota's integration has run on Cloud for 14 days with no service-owned edge row failing in production and no state alert left open; CC15, CC16 and CC17 pass; the OAuth documentation re-read is recorded; the DMARC record is at `p=quarantine` |
| **C** | Phase C, open sign-up | Gate B; the [pre-release checklist](design/security.md#16-pre-release-checklist) is complete, the external penetration test included; 30 days of phase B with every Free workspace's complaint and bounce rates under the auto-pause thresholds and no `signup_ramp_review` alert unanswered; the DMARC record is at `p=reject`; a second fresh-agent dry run and adversarial review pass on the phase-C configuration (`PM_SIGNUP=open`) |

The owner records each gate in a dated note in the private operations repository: the release tag, the
check results, and the dry-run and review reports.
