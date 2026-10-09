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
postmaster mail, staging, upgrades, backups, costs, uninstalling, troubleshooting and deploying the docs
site.

## Before you start

| You need | Why |
|---|---|
| A Cloudflare account on the **Workers Paid** plan | Email Sending to arbitrary recipients needs Workers Paid. Email Sending is in public beta |
| A **platform mail domain**: a zone apex on Cloudflare DNS in that account, that does not receive mail anywhere else. Examples use `agents.example` | Every identity gets an address on it, such as `bookings.acme@agents.example`. Only this domain must be on Cloudflare: tenants' own domains can be on any DNS host ([Custom domains](guides/custom-domains.md)) |
| An **API host**: any hostname on a zone in the account, with no existing CNAME record. Examples use `mail.example.com` | The Worker serves the REST API, the MCP server, `/openapi.json` and `/health` there, as a Worker Custom Domain |
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

Or build it with Cargo:

```bash
cargo install pylota-mail-cli --locked
```

```bash
pmail --version
node --version     # must be v20 or later
```

The CLI's version decides which Worker release `pmail setup` and `pmail deploy` install, so keep the
CLI and the deployment on the same version.

## 2. Create a Cloudflare API token

`pmail setup`, `pmail setup ses`, `pmail deploy` and `pmail doctor` use a Cloudflare API token from the
`CLOUDFLARE_API_TOKEN` environment variable, and so does `pmail domains add` when it adds a zone apex
for a deployment without `PM_CF_API_TOKEN` ([Tenant domains](#tenant-domains)). It is never written to
the CLI's config file.

Create the token in the Cloudflare dashboard, either as an account token (**Manage account** >
**Account API tokens**) or as a user token (**My Profile** > **API Tokens**), with these
permissions:

| Scope | Permission (as named on Cloudflare's permissions page) | Used for |
|---|---|---|
| Account | Workers Scripts · Edit | Uploading the Worker, its secrets, cron triggers and Durable Object migrations |
| Account | D1 · Edit | Creating the `pylota-mail` database and applying migrations |
| Account | Workers R2 Storage · Edit | Creating the `pylota-mail-blobs` bucket and its lifecycle rule |
| Account | Queues · Edit | Creating the five work queues and their dead-letter queues, and the Email Sending event subscription that feeds `pm-delivery-events` |
| Account | Vectorize · Edit | Creating the `pm-mail-chunks` index and its metadata indexes |
| Account | Workers AI · Read | Checking that the configured models are available |
| Account | Email Sending · Edit | Onboarding the platform domain for sending |
| Account | Account Settings · Read | Used by `wrangler` to read the account |
| Zone (the mail domain's zone and the API host's zone) | Zone · Read | Finding the zones and checking the mail domain is an apex |
| Zone (same) | DNS · Edit | Reading and writing mail DNS records |
| Zone (same) | Zone Settings · Edit | Enabling Email Routing on the mail domain (`POST /zones/{zone_id}/email/routing/dns` accepts Zone Settings Write, [API reference](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/), read 2026-10-09) |
| Zone (same) | Email Routing Rules · Edit | Creating the catch-all rule to the Worker |
| Zone (same) | Workers Routes · Edit | Attaching the API host to the Worker as a Custom Domain |
| User (user tokens only) | User Details · Read, Memberships · Read | Used by `wrangler` with user tokens |

Notes:

- Cloudflare's permissions page lists some groups as *Edit* in one table and *Write* in another
  (for example "DNS Write"). They are the same permission.
- If your account uses **Workers roles**, creating a Worker needs the *Admin* role at the Workers
  product scope (later deploys need only *Editor*), and changing Routes or Custom Domains needs
  *Workers Routes Write* on each affected zone.
- Cloudflare's documentation names the permission for sending (**Email Sending: Edit**) and for enabling
  Email Routing (**Zone Settings Write**), but not the one for creating Queues event subscriptions.
  `Queues · Edit` is assumed to cover it. `pmail doctor` checks that the event subscription and the
  catch-all rule exist and tells you if either is missing
  (spike [S9](project/build-plan.md#m1--spikes-each-one-gates-design-choices)).
- Pylota Mail does not need permission to manage tokens, billing or members. Do not add them.

Export the token, and the account ID if you prefer it to the `--account-id` flag:

```bash
export CLOUDFLARE_API_TOKEN=…
export CLOUDFLARE_ACCOUNT_ID=…        # optional; same as --account-id
```

## 3. Run setup

```bash
pmail setup --account-id <account-id> --domain mail.example.com --mail-domain agents.example --jurisdiction eu
```

| Flag | Meaning |
|---|---|
| `--account-id` | Your Cloudflare account ID (or set `CLOUDFLARE_ACCOUNT_ID`) |
| `--domain` | The **API host**: where the Worker serves `/v1`, `/mcp`, `/openapi.json` and `/health`. Becomes `PM_API_HOST` |
| `--mail-domain` | The **platform mail domain**. It must be a zone apex in this account. Becomes `PM_PLATFORM_DOMAIN`. If you leave it out, setup asks for it |
| `--jurisdiction` | `eu` (the default) or `default`. Applied when D1, R2 and every Durable Object are created. **It cannot be changed later.** Becomes `PM_JURISDICTION`. See [Privacy](guides/privacy.md#choosing-a-jurisdiction) |
| `--print-secrets` | Optional. Prints the generated secrets once. Without it they are never written to disk |

Setup also deploys the Worker. It downloads the release for the CLI's version
(`pylota-mail-worker-<version>.tar.gz`) and the release's signed `SHA256SUMS` from GitHub Releases,
refuses to continue if the checksum does not match, renders `deploy/wrangler.toml`, applies the D1
migrations and runs `npx --yes wrangler@4.139.0 deploy`. `--version <v>` picks another release, and
`--from-source` builds the Worker locally instead; it needs the Rust toolchain, the
`wasm32-unknown-unknown` target and `worker-build` 0.8.7.

Setup is idempotent: if it stops half-way (a missing permission, a network error), fix the cause
and run the same command again. It finds what already exists and creates only what is missing
([FR-OPS-1](project/prd.md#613-operations)).

### What setup creates

| Resource | Name | Notes |
|---|---|---|
| D1 database | `pylota-mail` | In the chosen jurisdiction. Migrations applied. Holds the control plane: tenants, identities, the address directory, domains, hashed API keys, webhooks, suppressions, jobs, audit log |
| R2 bucket | `pylota-mail-blobs` | Same jurisdiction. Lifecycle rule deletes `inbound-staging/` after one day |
| Queues | `pm-inbound`, `pm-outbound`, `pm-delivery-events`, `pm-webhooks`, `pm-index` | Each with a dead-letter queue (`pm-inbound-dlq` and so on) |
| Vectorize index | `pm-mail-chunks` | 1,024 dimensions, cosine, eight metadata indexes. Holds no message text |
| Email Routing | On the platform domain | Enabled, with a catch-all rule that sends every address to the Worker |
| Email Sending | On the platform domain | Onboarded. Cloudflare adds MX and SPF records on `cf-bounce.agents.example`, DKIM at `cf-bounce._domainkey.agents.example` and DMARC at `_dmarc.agents.example` |
| Event subscription | Platform domain → `pm-delivery-events` | Delivery, bounce, complaint and other Email Sending events |
| Worker secrets | `PM_MASTER_KEY`, `PM_KEY_PEPPER`, `PM_HASH_KEY` | 32 random bytes each, one purpose each. The keys that sign thread tokens, links and search cursors are generated later by the Worker itself and kept sealed in D1. See [Configuration › Secrets](reference/configuration.md#secrets) |
| Default tenant | – | The one tenant whose address suffix is empty, so its identities get `name@agents.example` |
| Worker | `pylota-mail` | Its four Durable Object classes (`IdentityMailbox`, `DomainMonitor`, `JobRunner`, `TenantQuota`), its cron triggers and the API host's Custom Domain |
| Platform domain record | `dom_…` with `tenant_id: null` | Visible to every key. Its health is monitored like any other domain, from the Worker's first cron run |
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
pmail keys create --level platform --name first-key
```

This call authenticates with the short-lived **bootstrap key** that `pmail setup` stored in your CLI
profile. Setup is the only moment the CLI knows `PM_KEY_PEPPER` (it generated it), so it mints that one
key itself, valid for 24 hours ([CLI and setup › The bootstrap key](project/design/cli.md#65-the-bootstrap-key)).

The secret (`pmk_live_…`) is printed **once**. Store it in a password manager. It is a platform key:
it reaches every tenant, so use it for administration only, and create tenant and identity keys for
applications and agents ([Security](guides/security.md#keys-and-permissions)).

Save it in a CLI profile:

```bash
pmail login          # API URL https://mail.example.com, then the key
```

## 6. Run the doctor with a mail test

```bash
pmail doctor --mail-test
```

`pmail doctor` checks DNS, routing, sending, event subscriptions, bindings, secrets and quota, and
prints a fix for every failure ([FR-OPS-3](project/prd.md#613-operations)). With `--mail-test` it
also sends a message out through the deployment and receives it back through Email Routing, then
prints the `Authentication-Results` authserv-id that Cloudflare's MX stamped on it.

Set that value as `PM_TRUSTED_AUTHSERV_ID` (see
[Configuration › Variables](reference/configuration.md#variables)) and run `pmail deploy`.
Until it is set, only Pylota Mail's own DKIM, ARC and DMARC verification counts. Headers from any
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
`pmail domains add <domain> --method cloudflare_zone --tenant <tenant>`, which uses your local
`CLOUDFLARE_API_TOKEN`. A zone subdomain, `nameservers` and `delegated_subdomain` need the token on the
Worker, because the Worker keeps calling Cloudflare over the domain's life (a routing rule per address,
onboarding once a new zone is active). To let tenants add these domains through the API, create a token
with the permissions in
[Identities, addresses and domains › Cloudflare API token permissions](project/design/identity-domains.md#cloudflare-api-token-permissions)
and store it as a Worker secret:

```bash
npx --yes wrangler@4.139.0 secret put PM_CF_API_TOKEN --name pylota-mail
```

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
| A region that receives mail | Not every SES region receives mail; the command refuses one that does not. With `PM_JURISDICTION` `eu`, the region must also be in the EU (`eu-central-1`, `eu-west-1`, `eu-west-2`, `eu-south-1`, `eu-west-3` or `eu-north-1`) unless you pass `--allow-non-eu` |
| AWS credentials on your machine that can create the resources below (SES, S3, SNS, SQS and IAM) | Read from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, or from the profile named by `AWS_PROFILE` in `~/.aws/credentials`. They are never stored, uploaded or printed |
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

## A staging environment

Run staging as a completely separate deployment: its own platform mail domain, API host, D1, R2,
Vectorize index and queues. Nothing is shared
([Architecture §7](project/architecture.md#7-deployment-topology)).

The simplest way is a **separate Cloudflare account**, because setup uses fixed resource names
(`pylota-mail`, `pylota-mail-blobs`, `pm-*`). For example:

```bash
pmail setup --account-id <staging-account-id> --domain mail-staging.example.com \
  --mail-domain agents-staging.example --jurisdiction eu
```

Keep a CLI profile per environment:

```toml
# ~/.config/pylota-mail/config.toml
default_profile = "prod"

[profiles.prod]
url = "https://mail.example.com"
key_env = "PYLOTA_MAIL_KEY"

[profiles.staging]
url = "https://mail-staging.example.com"
key_env = "PYLOTA_MAIL_STAGING_KEY"
```

Then `pmail --profile staging doctor`. Before an upgrade reaches production, try it on staging:
inbound from a real mailbox, outbound and a reply, a bounce, and a domain change.

## Upgrades and rollbacks

1. Read the release notes for the new version.
2. Install the new CLI version (step 1). The CLI decides the Worker version.
3. Upgrade staging, then production:

   ```bash
   pmail upgrade
   ```

   `pmail upgrade` deploys the new, checksum-verified release as a gradual deployment
   (10% → 50% → 100% of traffic). See the [CLI reference](reference/cli.md) for its options.
4. Run `pmail doctor`.

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

`pmail destroy` removes the Worker and the resources setup created. **This deletes all mail, keys and
configuration permanently.** Point-in-time recovery cannot bring back a deleted database or bucket.

Before you run it:

1. Export anything you must keep (`pmail export create`, see
   [Privacy](guides/privacy.md#subject-access-export)).
2. Tell integrators: their webhooks will stop and their keys will stop working.

Afterwards, check the platform domain's zone for leftover mail DNS records, and delete the Cloudflare
API token if you no longer need it. See the [CLI reference](reference/cli.md) for `destroy`'s options.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Setup says the mail domain is not a zone apex | You gave a subdomain, or the zone is in another account | Use the zone's apex, in the account named by `--account-id` |
| Setup refuses the mail domain because it has MX records | The domain already receives mail elsewhere | Use a dedicated domain. Replacing the MX records would stop that mail |
| Setup stops with a Cloudflare permission error | The token lacks a permission from step 2 | Add it and re-run setup. It continues where it stopped |
| `pmail setup` or `pmail deploy` fails before uploading | Node.js older than 22, or no network access to GitHub Releases | Install Node.js 22+. Behind a proxy, use `--from-source` |
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
| `401 unauthenticated` from every command | Wrong profile, URL or key | `pmail config show` |

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
