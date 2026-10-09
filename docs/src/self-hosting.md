# Deploy to Cloudflare

This guide deploys Pylota Mail to your own Cloudflare account. You will:

1. install the `pmail` CLI;
2. create a Cloudflare API token;
3. run `pmail setup`, which creates every Cloudflare resource and deploys a prebuilt, checksum-verified
   Worker;
4. check that the Worker answers;
5. create the first API key;
6. run `pmail doctor --mail-test` to prove mail flows both ways.

Optionally, connect Amazon SES with `pmail setup ses`, so that tenants can connect domains whose DNS
stays at another host ([Tenant domains](#tenant-domains)).

Hands-on time is about 15 minutes ([NFR-OPS-1](project/prd.md#7-non-functional-requirements)). DNS
propagation can add a few minutes of waiting. You do not need a Rust toolchain unless you build from
source.

The rest of the page covers tenant domains and Amazon SES, DNS authentication and the DMARC ramp,
postmaster mail, signed HTTP requests, staging, upgrades, backups, costs, uninstalling, troubleshooting
and deploying the docs site.

## Before you start

| You need | Why |
|---|---|
| A Cloudflare account on the **Workers Paid** plan | Email Sending to arbitrary recipients needs Workers Paid. Email Sending is in public beta |
| A **platform mail domain**: a zone apex on Cloudflare DNS in that account, that does not receive mail anywhere else. Examples use `agents.example` | Every identity gets an address on it, such as `bookings.acme@agents.example`. Only this domain must be on Cloudflare: tenants' own domains can be on any DNS host ([Custom domains](guides/custom-domains.md)) |
| An **API host**: any hostname on a zone in the account, with no existing CNAME record. Examples use `mail.example.com` | The Worker serves there, as a Worker Custom Domain: the REST API (`/v1/*`, including signed links `/v1/links/*`), the MCP server (`/mcp`), `/openapi.json`, `/health`, `/.well-known/*`, the provider hooks (`/hooks/*`) and `/billing/stripe/webhook`; and the console, unless you give it its own host with `--console-host` |
| Node.js 22 or later | `pmail setup` and `pmail deploy` run Cloudflare's `wrangler` CLI (version `4.139.0`, through `npx --yes wrangler@4.139.0`) |
| The `pmail` binary | It runs setup, deploy, the doctor and every admin and mail command |

### Why the mail domain must be a dedicated zone apex

- **Catch-all routing works only on a zone apex.** Pylota Mail routes every address on the platform
  domain to the Worker with one catch-all rule and looks the recipient up in its own directory. That
  is what lets identities be created without touching DNS. On a subdomain, Cloudflare needs one
  routing rule per address, with a limit of 200 ([Limits](reference/limits.md#domains-and-addresses)).
- **Email Routing takes over the domain's MX records.** Cloudflare's Email Routing requires its own MX
  records, and cannot share a domain with an external mail server. If the domain already receives
  mail (for example your company's Google Workspace or Microsoft 365 mailboxes), that mail would stop
  arriving. Use a domain that exists only for agent mail.
- **It is shared reputation.** Every tenant's platform addresses send from this domain. Keep it
  separate from your main brand domain, and move busy tenants to their own domains, which can stay at
  any DNS host ([Custom domains](guides/custom-domains.md)).

The API host can be on any zone in the account, including the mail domain's own zone (for example
`api.agents.example`). Cloudflare cannot create a Custom Domain on a hostname that already has a
CNAME record, so pick a free hostname.

## 1. Install the CLI

Download the binary for your platform from the
[GitHub Releases page](https://github.com/PILOTAAI/pylota-mail/releases) and check it against the
signed `SHA256SUMS` file in the same release. Builds exist for macOS (arm64, x64), Linux (x64, arm64)
and Windows (x64).

Or build it with Cargo, once `pylota-mail-cli` is published to crates.io (until then, build it from a
checkout of the repository with `cargo install --path crates/cli --locked`):

```bash
cargo install pylota-mail-cli --locked
```

```bash
pmail --version
node --version     # must be v22 or later (wrangler 4.139.0 declares node >=22.0.0)
```

The CLI's version decides which Worker release `pmail setup` and `pmail deploy` install, so keep the
CLI and the deployment on the same version.

## 2. Create a Cloudflare API token

`pmail` uses a Cloudflare API token from the `CLOUDFLARE_API_TOKEN` environment variable for the commands
listed in [CLI › Commands that use your Cloudflare token](reference/cli.md#commands-that-use-your-cloudflare-token):
`setup`, `deploy` and `doctor` among them. It is never written to the CLI's config file. The Worker can
hold a second token, the secret `PM_CF_API_TOKEN`, so that tenants can add domains on Cloudflare through
the API ([Domains on Cloudflare](#domains-on-cloudflare)). This table is the one list of what each token
needs; other pages link here.

Create the token in the Cloudflare dashboard, either as an account token (**Manage account** >
**Account API tokens**) or as a user token (**My Profile** > **API Tokens**), with these permissions.
Names are as the dashboard shows them; the API tab of Cloudflare's
[permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
shows *Write* where the dashboard shows *Edit* (for example "DNS Write"), and they are the same
permission.

| Scope | Permission | Your token (`CLOUDFLARE_API_TOKEN`) | Worker token (`PM_CF_API_TOKEN`) | Used for |
|---|---|---|---|---|
| Account | Workers Scripts · Edit | Yes | – | Uploading the Worker, its secrets, cron triggers and Durable Object migrations; reading secret names (`doctor`); deleting the Worker (`destroy`) |
| Account | D1 · Edit | Yes | – | Creating the `pylota-mail` database, applying migrations, and the CLI's D1 queries (setup, `doctor`, `secrets rotate-master`, `domains add --local-token`, `domains subscribe`) |
| Account | Workers R2 Storage · Edit | Yes | – | Creating the `pylota-mail-blobs` bucket (and the backup bucket) and its lifecycle rule |
| Account | Queues · Edit | Yes | Yes | Creating the five work queues and their dead-letter queues (your token); listing queues and creating each domain's Email Sending event subscription to `pm-delivery-events` (both) |
| Account | Vectorize · Edit | Yes | Only if spike S6 fails | Creating the `pm-mail-chunks` index, its metadata indexes and later index generations; the Worker's REST fallback |
| Account | Workers AI · Read and Workers AI · Edit | Yes | Only if spike S6 fails | Checking that the configured models exist, and the embedding probe when you change `PM_EMBED_MODEL`; the Worker's REST fallback. Cloudflare's Workers AI REST page asks a custom token for both to run a model (read 2026-10-09) |
| Account | Email Sending · Edit | Yes | Yes | Onboarding domains for sending and reading their DNS records |
| Account | Account Settings · Read | Yes | – | Used by `wrangler` to read the account |
| Account | Account Analytics · Read | Yes | – | The doctor's `quota` check (Workers Analytics Engine SQL API). Without it that check warns instead of reading the quota errors |
| Zone | Zone · Read | Yes | Yes | Finding zones, checking the mail domain is an apex, reading zone status, counting zones (`doctor`) |
| Zone | Zone · Edit | Only for `destroy` when `nameservers` or `delegated_subdomain` domains still exist | Yes, for `nameservers` and `delegated_subdomain` | Creating a zone for a domain used only for mail, and deleting it when the domain is removed (by the Worker, or by `pmail destroy --skip-erasure`, which deletes the zones this deployment created) |
| Zone | DNS · Edit | Yes | Yes | Mail DNS records: the ownership TXT, removing MX records with `--replace-mx`, the platform domain's SES DKIM records (`setup ses`) |
| Zone | Zone Settings · Edit | Yes | Yes | Enabling Email Routing and sub-addressing, reading the routing DNS records, and turning routing off when a domain is removed (`POST /zones/{zone_id}/email/routing/dns` accepts Zone Settings Write, [API reference](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/), read 2026-10-09) |
| Zone | Email Routing Rules · Edit | Yes | Yes | The catch-all rule to the Worker, and the per-address rules on subdomains |
| Zone | Workers Routes · Edit | Yes | – | Attaching the API host, and the console host if it differs, to the Worker as Custom Domains |
| User (user tokens only) | User Details · Read, Memberships · Read | Yes | – | Token verification and account lookup by `wrangler` with a user token |

**Which zones.** Choose **All zones** in the account for the zone permissions; this is the
recommended setting, because the CLI writes to several zones: the platform mail domain's zone, the zones
of the API host and the console host, and the zone of every tenant domain you add with
`pmail domains add --local-token`. The Worker's token likewise needs every zone that tenants add with
`cloudflare_zone`, and a zone it creates for `nameservers` or `delegated_subdomain` exists in no list of
specific zones. For least privilege, give your own token **specific zones** instead: the mail domain's
zone, the API host's zone, the console host's zone, and each tenant zone you will add with
`--local-token` (add a zone to the token before you add its domain).

Notes:

- If your account uses **Workers roles**, creating a Worker needs the *Admin* role at the Workers
  product scope (later deploys need only *Editor*), and changing Routes or Custom Domains needs
  *Workers Routes Write* on each affected zone.
- Cloudflare's documentation names the permission for sending (**Email Sending: Edit**, which is not on
  the permissions page; its scope is verified at build time) and for enabling Email Routing
  (**Zone Settings Write**), but not the one for creating Queues event subscriptions. `Queues · Edit` is
  assumed to cover it. `pmail doctor` checks that the event subscription and the catch-all rule exist
  and tells you if either is missing
  (spike [S9](project/build-plan.md#m1--spikes-each-one-gates-design-choices)).
- Whether a zone-scoped grant can create new zones (Zone · Edit for `nameservers`) is not stated by
  Cloudflare; it is verified at build time.
- Neither token needs permission to manage tokens, billing, members or Email Routing destination
  addresses (setup registers none). Do not add them.

Export the token, and the account ID if you prefer it to the `--account-id` flag. Setup also stores the
account ID (not the token) in your CLI profile, so later commands find it:

```bash
export CLOUDFLARE_API_TOKEN=…
export CLOUDFLARE_ACCOUNT_ID=…        # optional; same as --account-id
```

## 3. Run setup

```bash
pmail setup --account-id <account-id> --domain mail.example.com --mail-domain agents.example \
  --jurisdiction eu --owner-email sam@acmecarhire.example
```

| Flag | Meaning |
|---|---|
| `--account-id` | Your Cloudflare account ID (or set `CLOUDFLARE_ACCOUNT_ID`). Setup stores it in your CLI profile |
| `--domain` | The **API host**, where the Worker serves the API, MCP, `/openapi.json`, `/health`, `/.well-known/*`, `/hooks/*` and the console ([Before you start](#before-you-start)). Becomes `PM_API_HOST` |
| `--mail-domain` | The **platform mail domain**. It must be a zone apex in this account. Becomes `PM_PLATFORM_DOMAIN`. If you leave it out, setup asks for it |
| `--jurisdiction` | `eu` (the default) or `default`. Applied when D1, R2 and every Durable Object are created. **It cannot be changed later.** Becomes `PM_JURISDICTION`. See [Privacy](guides/privacy.md#choosing-a-jurisdiction) |
| `--owner-email` | The first console owner of the default tenant, who receives a sign-in link. Setup asks for it unless you pass `--no-console` |
| `--console-host` | Optional. Serve the console on its own host instead of the API host (`PM_CONSOLE_HOST`) |
| `--profile` | Optional. The CLI profile that receives the URL, the account ID and the temporary key; `default` unless you name another |
| `--print-secrets` | Optional. Prints the generated secrets once, to stdout. Without it they go only to the Worker (through Wrangler, on stdin) and are never printed or written to a file or a log |

Every flag is in the [CLI reference](reference/cli.md#setup).

Setup also deploys the Worker. It downloads the release for the CLI's version
(`pylota-mail-worker-<version>.tar.gz`) and the release's signed `SHA256SUMS` from GitHub Releases,
refuses to continue if the checksum does not match, renders `deploy/wrangler.toml`, applies the D1
migrations and runs `npx --yes wrangler@4.139.0 deploy`. `--version <v>` picks another release, and
`--from-source` builds the Worker locally from a checkout of the repository (`--source-dir <path>`,
default the current directory) instead; it needs the Rust toolchain, the `wasm32-unknown-unknown` target
and `worker-build` 0.8.7, and it still downloads crates from crates.io (unless you vendor them) and
Wrangler from npm.

Setup is idempotent: if it stops half-way (a missing permission, a network error), fix the cause
and run the same command again. It finds what already exists and creates only what is missing
([FR-OPS-1](project/prd.md#613-operations)).

### What setup creates

| Resource | Name | Notes |
|---|---|---|
| Release bundle | `deploy/.bundle/<version>/` | The verified Worker release that setup deploys |
| D1 database | `pylota-mail` | In the chosen jurisdiction. Migrations applied. Holds the control plane: tenants, identities, the address directory, domains, hashed API keys, webhooks, suppressions, jobs, audit log |
| R2 bucket | `pylota-mail-blobs` | Same jurisdiction. Lifecycle rule deletes `inbound-staging/` after one day |
| Queues | `pm-inbound`, `pm-outbound`, `pm-delivery-events`, `pm-webhooks`, `pm-index` | Each with a dead-letter queue (`pm-inbound-dlq` and so on) |
| Vectorize index | `pm-mail-chunks` | 1,024 dimensions, cosine, eight metadata indexes. Holds no message text |
| Email Routing | On the platform domain | Enabled, with a catch-all rule that sends every address to the Worker |
| Ownership record | TXT `_pylota-mail.agents.example` | `pm-verify=…`, the proof that this deployment controls the domain |
| Email Sending | On the platform domain | Onboarded. Cloudflare adds MX and SPF records on `cf-bounce.agents.example`, DKIM at `cf-bounce._domainkey.agents.example` and DMARC at `_dmarc.agents.example` |
| Event subscription | Platform domain → `pm-delivery-events` | Delivery, bounce, complaint and other Email Sending events |
| Rate-limit namespaces | `RL_API`, `RL_SEARCH`, `RL_AGENTIC`, `RL_SEND`, `RL_SIGNIN`, `RL_SIGN` | Six bindings, with namespace IDs from 1001 that no other Worker in the account uses |
| Worker secrets | `PM_MASTER_KEY`, `PM_KEY_PEPPER`, `PM_HASH_KEY` | 32 random bytes each, one purpose each. The keys that sign thread tokens, links, search cursors and Web Bot Auth requests, and each identity's signing keys, are generated later by the Worker itself and kept sealed in D1. See [Configuration › Secrets](reference/configuration.md#secrets) |
| Worker | `pylota-mail` | Its six Durable Object classes (`IdentityMailbox`, `DomainMonitor`, `JobRunner`, `TenantQuota`, `SesControl`, `Notifier`), its cron triggers and the API host's Custom Domain (two, with `--console-host`) |
| Temporary platform key | `setup-bootstrap`, in your CLI profile | Expires after 24 hours. Replace it in [step 5](#5-create-the-first-api-key) |
| Platform domain record | `dom_…` with `tenant_id: null` | Visible to every key. Its health is monitored like any other domain, from the Worker's first cron run |
| Default tenant | – | The one tenant whose address suffix is empty, so its identities get `name@agents.example`. Its console owner is the `--owner-email` person |
| System identity | `PM_SYSTEM_FROM` on the platform domain | Sends sign-in links, invitations and notification emails |
| `deploy/wrangler.toml` | – | Bindings, variables, cron triggers and Durable Object migrations for `pmail deploy`. It holds no secrets |

The bindings and variables are listed in [Configuration](reference/configuration.md#bindings).

## 4. Check the Worker

Setup has already deployed the Worker. Check that it answers:

```bash
curl https://mail.example.com/health
```

```json
{ "status": "ok", "version": "1.0.0", "commit": "abc1234", "env": "production" }
```

Mail sent to the platform domain while setup runs is refused at SMTP time, so its sender learns it was
not delivered. Setup turns on the catch-all rule only once the Worker can store mail, so accepted mail is
never lost.

`pmail deploy` is for later: after you change a variable in `deploy/wrangler.toml` (as in step 6), or to
deploy another release with `--version <v>`. It verifies the release the same way. Run straight after
setup, it finds nothing to change and exits without deploying.

## 5. Create the first API key

```bash
pmail keys create --level platform --name first-key --permissions \
tenants:manage,platform:ops,keys:manage,identities:read,identities:write,domains:read,domains:write,\
messages:read,messages:send,messages:write,attachments:read,search:read,search:agentic,\
quarantine:review,webhooks:read,webhooks:manage,erasure:manage,suppressions:manage,usage:read,\
audit:read,members:read,members:manage
```

A platform key must list its permissions; there is no implicit full set. This one holds every permission
a platform key may hold, so it can create every other key and run `pmail doctor --mail-test`. Setup's
summary prints this command for you. (`identities:sign` is not in it: platform keys cannot sign as an
identity.)

This call authenticates with the short-lived **bootstrap key** that `pmail setup` stored in your CLI
profile. Setup is the only moment the CLI knows `PM_KEY_PEPPER` (it generated it), so it mints that one
key itself, valid for 24 hours ([CLI and setup › The bootstrap key](project/design/cli.md#65-the-bootstrap-key)).

The secret (`pmk_live_…`) is printed **once**. Store it in a password manager. It is a platform key:
it reaches every tenant, so use it for administration only, and create tenant and identity keys for
applications and agents ([Security](guides/security.md#keys-and-permissions)).

Because the call used the bootstrap profile, `pmail` then asks whether to save the new key in that
profile and revoke the bootstrap key. Answer yes. In a non-interactive run, add `--save-profile default`
to the command instead: the new key is stored in the profile, and the bootstrap key expires on its own
within 24 hours (or revoke it at once with `pmail keys revoke <key-id>`).

## 6. Run the doctor with a mail test

```bash
pmail doctor --mail-test
```

`pmail doctor` checks DNS, routing, sending, event subscriptions, bindings, secrets and quota, and
prints a fix for every failure ([FR-OPS-3](project/prd.md#613-operations)). With `--mail-test` it
also sends a message out through the deployment and receives it back through Email Routing, then
prints the `Authentication-Results` authserv-id that Cloudflare's MX stamped on it.

`pmail setup` already ran this test as its last step and set that value as `PM_TRUSTED_AUTHSERV_ID`
(see [Configuration › Variables](reference/configuration.md#variables)). If setup's mail test failed,
the doctor says so; fix the cause and run `pmail setup` again, which sets it. Until it is set, SPF
cannot be checked: mail from a sender whose DMARC policy is `quarantine` or `reject` and whose DKIM does
not align is quarantined as `auth_unverified`. Headers from any
other authserv-id are always ignored, because senders can forge them
([D9](project/edge-cases.md)).

Run `pmail doctor` again whenever something looks wrong. It is safe to run at any time.

You now have a working deployment. Continue with the [Quickstart](quickstart.md) to create a tenant,
an identity and send your first message.

## Tenant domains

Only the platform domain has to be on Cloudflare. Tenants can connect their own domains in six ways
([Custom domains](guides/custom-domains.md#choose-how-to-connect-your-domain)), and each way needs
something from the deployment:

| Methods | The deployment needs |
|---|---|
| `cloudflare_zone`, `nameservers`, `delegated_subdomain` (the domain's DNS is on Cloudflare, in this account) | The Worker secret `PM_CF_API_TOKEN`, below. `delegated_subdomain` also needs a Cloudflare Enterprise account and `PM_CF_SUBDOMAIN_SETUP = "on"` |
| `dns_records`, `send_only`, and `smtp_relay` with `inbound: ses` (the domain's DNS stays at any host) | Amazon SES, connected with `pmail setup ses`, below |
| `smtp_relay` with `inbound: forward` | Nothing: the tenant brings their own SMTP relay |

### Domains on Cloudflare

Without `PM_CF_API_TOKEN`, adding a `cloudflare_zone`, `nameservers` or `delegated_subdomain` domain
fails with `422 cf_token_required`. You can still add a zone **apex** yourself with
`pmail domains add <domain> --method cloudflare_zone --tenant <tenant> --local-token`, which uses your
local `CLOUDFLARE_API_TOKEN` (its zone permissions must cover that zone, [step 2](#2-create-a-cloudflare-api-token)).
A zone subdomain, `nameservers` and `delegated_subdomain` need the token on the Worker, because the Worker
keeps calling Cloudflare over the domain's life (a routing rule per address, onboarding once a new zone is
active). To let tenants add these domains through the API, create a second token with the permissions
marked for the Worker token in [step 2](#2-create-a-cloudflare-api-token) and store it as a Worker
secret:

```bash
npx --yes wrangler@4.139.0 secret put PM_CF_API_TOKEN --name pylota-mail
```

What the Worker does with it is in
[Identities, addresses and domains › Cloudflare API token permissions](project/design/identity-domains.md#cloudflare-api-token-permissions).

### Connect Amazon SES (optional)

`pmail setup ses` connects the deployment to Amazon SES once. It runs after `pmail setup`, from the same
directory.

```bash
pmail setup ses --region eu-west-2
```

Before you run it:

| You need | Why |
|---|---|
| An AWS account | The resources below are created in it. Amazon Web Services then processes the mail of SES domains, so list it as a sub-processor ([Privacy](guides/privacy.md)) |
| SES production access in the chosen region | The SES sandbox sends only to verified addresses, at most 200 messages a day ([SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09). Without production access, the command prints the AWS console steps to request it and stops before creating anything |
| The SES à la carte plan, not Essentials | Sending costs $0.10 per 1,000 messages à la carte against $0.16 on Essentials ([SES pricing](https://aws.amazon.com/ses/pricing/), read 2026-10-09). The command warns on Essentials |
| A region that receives mail | Not every SES region receives mail; the command refuses one that does not. With `PM_JURISDICTION` `eu`, the region must also be in the EU or the UK (`eu-central-1`, `eu-west-1`, `eu-west-2` (London), `eu-south-1`, `eu-west-3` or `eu-north-1`) unless you pass `--allow-non-eu`. For the SES region, `eu` means "EU or UK": the UK has an EU adequacy decision under the GDPR (European Commission [adequacy decisions](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en), renewed 19 December 2025, read 2026-10-09). Cloudflare's own `eu` jurisdiction for D1, R2 and Durable Objects means the EU only |
| AWS credentials on your machine that can create the resources below (SES, S3, SNS, SQS and IAM) | Read from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, else from the profile named by `AWS_PROFILE` (else `default`) in `~/.aws/credentials` and `~/.aws/config`. They are never stored, uploaded or printed |
| `CLOUDFLARE_API_TOKEN`, as in [step 2](#2-create-a-cloudflare-api-token) | To store the Worker's own SES key as Worker secrets, redeploy, and publish the platform domain's SES DKIM records in its zone |

What it creates in the region:

| Resource | Name | Notes |
|---|---|---|
| S3 bucket | `{prefix}-inbound` (default prefix `pylota-mail-{aws-account-id}`, or `--prefix`) | Raw inbound mail waits here until the Worker has stored it, normally seconds and never more than 14 days. No public access, encrypted at rest. Only SES may write to it, and only for the rule below |
| SNS topic | `pylota-mail-inbound` | Signature version 2. Pushes each inbound notification to `https://{api host}/hooks/ses/inbound` |
| SQS queue | `pylota-mail-inbound` | Subscribed to the same topic. Keeps every notification for 14 days, so mail is not lost if a push fails |
| Receipt rule set and rule | `pylota-mail` (or your account's existing active rule set), rule `pm-deliver` | Stores mail for every verified domain in the bucket and notifies the topic, with spam and virus scanning on. An existing active rule set is kept; the rule is added to it |
| Configuration set and delivery-events topic | `pylota-mail` | Delivery, bounce and complaint events go to `https://{api host}/hooks/ses` |
| Platform identity | The platform domain | Verified in SES through its Cloudflare zone, so that SES can bounce mail to retired addresses from `mailer-daemon@` the platform domain |
| IAM user | `pylota-mail-worker` | One policy, with only the SES, S3 and SQS actions the Worker needs. **The policy JSON is printed for you to review before it is applied**; interactive runs ask, and `--yes` accepts it without asking. The user's access key goes straight into the Worker secrets `PM_SES_ACCESS_KEY_ID` and `PM_SES_SECRET_ACCESS_KEY`, and is never written to disk or printed |

It then writes the `PM_SES_*` variables into `deploy/wrangler.toml`, runs `pmail deploy` so the Worker
reads them, subscribes the Worker's two SNS endpoints and waits up to 5 minutes for them to be
confirmed. Like setup, it is idempotent: if it stops, fix the cause and run it again. `pmail doctor`
then checks SES as well. The details are in
[Domains on any DNS host › Deployment set-up for SES](project/design/domain-connections.md#42-deployment-set-up-for-ses).

Tenants can now add `dns_records` and `send_only` domains. SES allows 10,000 verified domains per region
([SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09); `pmail doctor`
warns at 9,000.

## DNS authentication and the DMARC ramp

Setup makes the platform domain authenticate correctly from the first message: Email Sending signs
with DKIM for the domain, and the Return-Path is on `cf-bounce.<domain>`, which aligns under relaxed
SPF alignment. What remains is your DMARC policy and reports.

Email Sending onboarding writes a DMARC record at `_dmarc.<domain>`. Cloudflare's documentation shows
it as `v=DMARC1; p=reject;`. Check what your zone has:

```bash
dig +short TXT _dmarc.agents.example
pmail domains records dom_…      # the platform domain's ID, from pmail domains list
```

If you want aggregate reports before enforcing, ramp the policy over four to six weeks:

| Weeks | Record at `_dmarc.agents.example` | Watch for |
|---|---|---|
| 0–2 | `v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com` | Every source in the reports that sends as the domain. Mail from the deployment should pass on DKIM |
| 2–4 | `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@example.com` | Failures from sources you did not expect |
| 4–6 | `v=DMARC1; p=reject; rua=mailto:dmarc-reports@example.com` | Keep reading the reports |

- Send `rua` reports to a mailbox someone reads, or to a DMARC reporting service. If that mailbox is
  on a different domain, that domain must publish an authorisation record (RFC 7489 §7.1).
- A platform domain used only by Pylota Mail can also stay on `p=reject` from the start. The ramp
  gives you reports first, which helps when you are unsure what else sends as the domain.
- Enrol the domain with the large mailbox providers' postmaster tools to watch reputation.

**MTA-STS and TLS-RPT** are optional. They protect inbound mail against TLS downgrade:

- MTA-STS: follow Cloudflare's guide. Add a DNS-only CNAME `_mta-sts.agents.example` →
  `_mta-sts.mx.cloudflare.net`, and serve the policy at
  `https://mta-sts.agents.example/.well-known/mta-sts.txt` (Cloudflare provides a small proxy Worker
  for this). Start with `mode: testing` and switch to `enforce` once reports are clean, because a
  wrong policy in `enforce` mode rejects legitimate mail.
- TLS-RPT (RFC 8460): add a TXT record `_smtp._tls.agents.example` with
  `v=TLSRPTv1; rua=mailto:tls-reports@example.com`.

## Postmaster and abuse mail

Role names from RFC 2142 (`postmaster`, `abuse`, `security`, `hostmaster`, `webmaster`, `support`,
`sales`, `info` and the rest) and names such as `noreply` and `mailer-daemon` can never be addresses on
the shared platform domain. Mail to the operational names there goes to the operator's contact,
`PM_SECURITY_CONTACT`, not to an agent ([A4](project/edge-cases.md)): the Worker sends it there as a new
message from `postmaster@` the platform domain, with the original attached. On a tenant's own domain the role
names are allowed, except `postmaster` and `abuse`, whose mail goes to the tenant's owner.

- Set `PM_SECURITY_CONTACT`. It is also served at `/.well-known/security.txt`.
- Make sure a person reads postmaster and abuse mail. Mailbox providers and other operators use these
  addresses to report problems with your sending.
- Spam complaints from recipients do not arrive as mail. They arrive as `message.complained` events,
  suppress the recipient permanently, and count towards automatic pausing
  ([Sending › Bounces, complaints and suppressions](guides/sending.md#bounces-complaints-and-suppressions)).
- The system identity also sends people's notification emails from the platform domain: new-mail
  counts, usage alerts and the daily "needs a person" email, as each person chooses in the console
  ([Notifications](project/design/notifications.md)). `PM_NOTIFICATIONS = "on"` is the default; set it
  to `"off"` in `deploy/wrangler.toml` and run `pmail deploy` to send only `account` notifications
  (security and billing events, which cannot be turned off).

## Signed HTTP requests (Web Bot Auth)

Identities can sign the HTTP requests their agents make, so that a website can tell which agent made a
request and that it came through your deployment: `pmail http-sign` and the MCP tool
`mail_sign_http_request` return `Signature-Agent`, `From`, `Signature-Input` and `Signature` headers,
signed with a key that belongs to the deployment ([Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/),
read 2026-10-09). Agent assertions are separate and need nothing from you
([Using it from an agent](guides/agents.md#agent-assertions)).

**It is off by default.** `PM_WEB_BOT_AUTH = "off"` is written into `deploy/wrangler.toml`; while it is
off, signing requests fail with `422 web_bot_auth_disabled` and the key directory answers
`404 key_not_found`. Turn it
on only if spike S13 passed (the [build plan](project/build-plan.md) records the result): S13 checks the
signature format against Cloudflare's test endpoint before release. If it did not pass, signed HTTP
requests stay off in this release and the setting cannot be turned on.

To turn it on:

1. Set `PM_WEB_BOT_AUTH = "on"` under `[vars]` in `deploy/wrangler.toml` and run `pmail deploy`. The
   Worker creates the deployment's signing key the first time it is needed and publishes the key
   directory at `https://mail.example.com/.well-known/http-message-signatures-directory` (your API
   host). The directory is signed once per listed key and lists at most three keys.
2. Run `pmail doctor --check web_bot_auth`, which fetches the directory and checks its signatures.
3. Let each tenant that wants it opt in. Tenant policy `web_bot_auth.allowed` is `false` by default, and
   until it is `true` that tenant's identities get `403 policy_denied`. With a platform key that holds
   `tenants:manage`:

   ```bash
   pmail tenants update brightwell --policy '{"web_bot_auth":{"allowed":true}}'
   ```

Agents then sign with a tenant or identity key that holds `identities:sign`. Signing shares the
`RL_SIGN` limit with assertions (600 calls a minute per identity) and uses no plan allowance.

**Rotating the key.** `pmail keys rotate web_bot_auth` makes a new key active; the previous one stays
listed in the directory for 7 days. After a suspected leak, add
`--revoke-previous` to remove the old key from the directory at once, then run
`pmail secrets rotate-master` ([CLI reference](reference/cli.md#keys-rotate-threadlinkcursorweb_bot_auth)).
Verifiers may cache the directory for up to 24 hours.

**Cloudflare's verified bots (optional).** Sites behind Cloudflare can treat your agents as a verified
bot once you register the directory with Cloudflare. In the dashboard, go to **Manage Account** >
**Configurations** > **Bot Submission Form**, choose the verification method **Request Signature**, and
enter the directory URL from step 1 (Cloudflare's Web Bot Auth page, read 2026-10-09). You do not need
this for any other verifier: any Web Bot Auth verifier can check the signatures against your directory
without it. The design is in
[Agent signing keys › Signed HTTP requests](project/design/agent-keys.md#5-signed-http-requests-web-bot-auth).

## A staging environment

Run staging as a completely separate deployment: its own platform mail domain, API host, D1, R2,
Vectorize index and queues. Nothing is shared
([Architecture §7](project/architecture.md#7-deployment-topology)).

The simplest way is a **separate Cloudflare account**, because setup uses fixed resource names
(`pylota-mail`, `pylota-mail-blobs`, `pm-*`). Give staging its own deployment directory and its own CLI
profile, so it never touches production's `deploy/wrangler.toml` or production's key:

```bash
export CLOUDFLARE_API_TOKEN=…        # a token for the staging account (step 2)
pmail setup --account-id <staging-account-id> --domain mail-staging.example.com \
  --mail-domain agents-staging.example --jurisdiction eu \
  --dir ./deploy-staging --profile staging
```

Pass `--profile staging` to every command for staging, and `--dir ./deploy-staging` to the commands that
read the deployment directory (`setup ses`, `deploy`, `upgrade`, `doctor`, `destroy` and
`secrets rotate-master`). Without them `pmail` uses `./deploy` and the `default` profile, which belong to
production:

```bash
pmail keys create --level platform --name first-key --permissions … --profile staging
pmail doctor --dir ./deploy-staging --profile staging
pmail upgrade --dir ./deploy-staging --profile staging
```

(`…` is the list from [step 5](#5-create-the-first-api-key).)

The profile holds staging's URL, its account ID and its key, so commands that use your Cloudflare token
find the right account. After both setups, the config file looks like this:

```toml
# ~/.config/pylota-mail/config.toml
[profiles.default]                    # production, written by pmail setup
url = "https://mail.example.com"
account_id = "<production-account-id>"
key = "pmk_live_…"

[profiles.staging]                    # written by pmail setup --profile staging
url = "https://mail-staging.example.com"
account_id = "<staging-account-id>"
key = "pmk_live_…"
```

To keep a key out of the file, store an environment variable's name instead:
`pmail login --profile staging --key-env PYLOTA_MAIL_STAGING_KEY`.

Before an upgrade reaches production, try it on staging: inbound from a real mailbox, outbound and a
reply, a bounce, and a domain change.

## Upgrades and rollbacks

1. Read the release notes for the new version.
2. Install the new CLI version (step 1). The CLI decides the Worker version.
3. Upgrade staging, then production:

   ```bash
   pmail upgrade --dir ./deploy-staging --profile staging
   pmail upgrade
   ```

   `pmail upgrade` deploys the new, checksum-verified release as a gradual deployment
   (10% → 50% → 100% of traffic). See the [CLI reference](reference/cli.md#upgrade) for its options.
4. Run `pmail doctor` (for staging, with `--dir ./deploy-staging --profile staging`).

What to expect during an upgrade:

- D1 and Durable Object schema changes are always *expand, then contract*: a release only adds what
  the new code needs, and removes old columns in a later release. So the previous release can still
  run against the new schema.
- Durable Object migrations run when each object wakes, inside a transaction, and are idempotent
  ([J9](project/edge-cases.md)). Each Durable Object runs one Worker version at a time during a
  gradual deployment.

To roll back, deploy the previous version:

```bash
pmail deploy --version <previous-version>
```

A rollback changes the code that runs. **It does not revert data.** Mail received, messages sent and
schema changes made under the newer version stay. Because schema changes are expand-then-contract,
rolling back one release is safe; do not jump back across several releases.

## Backups and restore

| Store | What protects it | Notes |
|---|---|---|
| D1 (control plane) | D1 Time Travel: restore to any point in the last 30 days | Restoring D1 alone can leave it out of step with the mailboxes. Restore both to the same point in time |
| Durable Object SQLite (mailboxes) | Point-in-time recovery for the last 30 days, per object | Exposed by Cloudflare as an API inside the object. Pylota Mail's restore drill tooling is planned (P1) |
| R2 (raw mail, attachments, exports) | Raw `.eml` is the source of truth. Any message can be re-parsed from it ([J3](project/edge-cases.md)) | If you copy the bucket elsewhere, erasure must reach the copy too ([I6](project/edge-cases.md)) |
| Vectorize | Rebuilt from the mailboxes by a re-embed job | Holds no text |

The recovery objectives are RPO ≤ 1 minute for indexes and ≤ 15 minutes for blobs, and RTO ≤ 4 hours
([NFR-OPS-2](project/prd.md#7-non-functional-requirements)).

Point-in-time recovery is also **residual retention**: for 30 days after an erasure, a restore could
bring the erased data back. Keep the `erasure.completed` events (or the erasure receipts) outside the
deployment, and re-run any erasure that completed after the restore point. See
[Privacy](guides/privacy.md#backups-and-residual-retention).

## What it costs

Pylota Mail is source available, and self-hosting it has no licence fee. You pay Cloudflare for what
the deployment uses in your account, and AWS if you connect Amazon SES. An idle
deployment costs approximately nothing beyond the Workers Paid subscription, because nothing runs
unless mail arrives, a request is made or a cron fires
([NFR-COST-1](project/prd.md#7-non-functional-requirements)).

What is billed (see Cloudflare's pricing pages for current prices):

| Item | Driven by |
|---|---|
| Workers Paid subscription | Required |
| Workers requests and CPU time | API calls, inbound mail, queue consumers, cron |
| Email Sending | Outbound messages. Workers Paid includes a monthly allowance, then a per-message charge. Inbound Email Routing has no per-message charge; the Worker it invokes is billed as Workers usage |
| Durable Objects | Requests, duration and SQLite storage of mailboxes |
| D1 | Rows read and written, and storage |
| R2 | Storage of raw mail and attachments, and operations. Egress is free |
| Queues | Operations on the five queues |
| Vectorize | Stored and queried vector dimensions |
| Workers AI | Embeddings, reranking, triage, attachment text extraction and the agentic planner, measured in neurons |
| Amazon SES, S3, SNS and SQS (only with `pmail setup ses`) | Mail sent and received on SES domains, billed by AWS. Prefer the à la carte plan ([Connect Amazon SES](#connect-amazon-ses-optional)) |

The biggest levers are inbound volume (each message is parsed, embedded and triaged), agentic search
(each question runs the planner model several times), attachment text extraction and how long you
keep raw mail (`retention.raw_days`). Watch usage per tenant with `pmail usage daily` or
`GET /v1/usage/daily`, which report inbound, outbound, search, agentic, `ai_neurons` and storage per day.

## Uninstall

```bash
pmail destroy
```

`pmail destroy` removes the Worker and the Cloudflare resources setup created. **This deletes all mail,
keys and configuration permanently.** Point-in-time recovery cannot bring back a deleted database or
bucket. It prints the plan first; `pmail destroy --dry-run` prints only the plan.

Before you run it:

1. Export anything you must keep (`pmail export create`, see
   [Privacy](guides/privacy.md#subject-access-export)).
2. Tell integrators: their webhooks will stop and their keys will stop working.
3. If you connected Amazon SES, decide what happens to its AWS resources. By default `destroy` leaves
   them and lists them at the end, and the Worker's IAM access key stays valid until you delete it in the
   AWS console. With `--include-ses`, `destroy` deletes them with your local AWS credentials, in the
   reverse order of `setup ses`:

   ```bash
   pmail destroy --include-ses
   ```

Threads under a legal hold stop `destroy` before it deletes anything else; release the holds (export
the mail first if you must keep it) and run it again. Afterwards, check the platform domain's zone for
leftover mail DNS records, and delete the Cloudflare API tokens if you no longer need them. See the
[CLI reference](reference/cli.md#destroy) for `destroy`'s options.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Setup says the mail domain is not a zone apex | You gave a subdomain, or the zone is in another account | Use the zone's apex, in the account named by `--account-id` |
| Setup refuses the mail domain because it has MX records | The domain already receives mail elsewhere | Use a dedicated domain. Replacing the MX records would stop that mail |
| Setup stops with a Cloudflare permission error | The token lacks a permission, or a zone, from step 2 | Add it and re-run setup. It continues where it stopped |
| `pmail doctor` warns on `quota` that it cannot read the quota errors | The token lacks Account Analytics · Read | Add it ([step 2](#2-create-a-cloudflare-api-token)) |
| `pmail setup` or `pmail deploy` fails before uploading | Node.js older than 22, or no network access to GitHub Releases | Install Node.js 22+. Behind a proxy, set `HTTPS_PROXY`, which `pmail` honours. `--from-source --source-dir <checkout>` avoids the GitHub Releases download only: it still needs crates.io (or vendored crates) and npm for Wrangler |
| `pmail setup` or `pmail deploy` refuses the bundle | The checksum did not match | Do not override it. Download again, or report it ([SECURITY.md](https://github.com/PILOTAAI/pylota-mail/blob/main/SECURITY.md)) |
| The Custom Domain cannot be created | The API host already has a CNAME record | Delete the record or choose another hostname |
| `/health` does not answer | The Custom Domain or its certificate is still being created | Wait a few minutes, then run `pmail doctor` |
| Inbound mail bounces with `550 5.1.1` | The address does not exist (or was erased) | Check it with `pmail identities lookup <address>` |
| Inbound mail does not arrive at all | MX records are not Cloudflare's, or the catch-all does not point to the Worker | `pmail doctor` checks both and prints the fix |
| Sends stay `queued` | Email Sending onboarding is incomplete, or the daily quota is used up | `pmail doctor`. Quota waits retry for up to 24 hours ([G3](project/edge-cases.md)). Cloudflare does not tell the Worker your quota: copy it into `PM_DAILY_SEND_QUOTA` to be alerted at 80% |
| Sends end `rejected` with `sender_domain_unavailable` | The sending domain is not onboarded for Email Sending | Re-run setup, or fix the domain (see [Custom domains](guides/custom-domains.md)) |
| Delivery statuses never change after `submitted` | The Email Sending event subscription is missing | `pmail doctor` checks it. Re-run setup to create it |
| Every verdict ignores Cloudflare's header | `PM_TRUSTED_AUTHSERV_ID` is not set | Run `pmail doctor --mail-test` and set the value it prints |
| An alert says a dead-letter queue is not empty | A queue message failed every retry | `pmail dlq list` (`GET /v1/platform/dlq`), fix the cause, then `pmail dlq redrive` ([J8](project/edge-cases.md)) |
| `401 unauthenticated` from every command | Wrong profile, URL or key; a `PYLOTA_MAIL_KEY` in the environment overrides the profile's key | `pmail config show` shows where each setting came from |
| `pmail http-sign` fails with `422 web_bot_auth_disabled` or `403 policy_denied` | Signed HTTP requests are off, or the tenant has not opted in | [Signed HTTP requests](#signed-http-requests-web-bot-auth) |

## Deploy the landing site and docs

The repository's `site/` directory is an optional, assets-only Worker (no script, no bindings) that
serves the landing page and these docs at `/docs/`.

```bash
cargo install mdbook --version 0.5.4 --locked
mdbook build docs                         # writes the docs into site/public/docs
cd site
npx --yes wrangler@4.139.0 deploy         # deploys the Worker pylota-mail-site
```

From the repository root, `npx --yes wrangler@4.139.0 deploy --config site/wrangler.jsonc` does the
same. To serve the site on your own hostname, uncomment the `routes` entry in `site/wrangler.jsonc`
and set the hostname (its zone must be on Cloudflare). Security headers, including the content
security policy, are in `site/public/_headers`.
