# Configuration

There are three layers:

1. **Deployment configuration**: the Worker's bindings, variables and secrets, written into
   `deploy/wrangler.toml` by `pmail setup` and uploaded by `pmail deploy`.
2. **Tenant policy**: a JSON document per tenant, managed through the API. Defaults come from
   `PM_DEFAULT_POLICY` or the built-in defaults below.
3. **CLI configuration**: `~/.config/pylota-mail/config.toml` on the machine that runs `pmail`.

## Bindings

| Binding | Type | Name created by setup | Notes |
|---|---|---|---|
| `DB` | D1 | `pylota-mail` | Created with the chosen jurisdiction. It cannot be moved later |
| `BLOBS` | R2 | `pylota-mail-blobs` | Same jurisdiction. Lifecycle rule: delete `inbound-staging/` after 1 day |
| `MAILBOX` | Durable Object namespace | class `IdentityMailbox` | SQLite-backed |
| `DOMAINS` | Durable Object namespace | class `DomainMonitor` | SQLite-backed |
| `JOBS` | Durable Object namespace | class `JobRunner` | SQLite-backed |
| `QUOTA` | Durable Object namespace | class `TenantQuota` | SQLite-backed |
| `Q_INBOUND` | Queue producer and consumer | `pm-inbound` (DLQ `pm-inbound-dlq`) | Batch 10, max retries 10 |
| `Q_OUTBOUND` | Queue producer and consumer | `pm-outbound` (DLQ `pm-outbound-dlq`) | Batch 10, max retries 100 (backoff covers 24 h of quota waits) |
| `Q_DELIVERY` | Queue consumer and producer | `pm-delivery-events` (DLQ `pm-delivery-events-dlq`) | Batch 10, max retries 20 (the G8 retry schedule needs at least 11). Fed by Email Sending event subscriptions; the producer is used only to redrive dead-lettered items |
| `Q_WEBHOOKS` | Queue producer and consumer | `pm-webhooks` (DLQ `pm-webhooks-dlq`) | Batch 20, max retries 13 |
| `Q_INDEX` | Queue producer and consumer | `pm-index` (DLQ `pm-index-dlq`) | Batch 10, max retries 10 |
| `VECTORS` | Vectorize | `pm-mail-chunks` | 1024 dimensions, cosine, 8 metadata indexes |
| `VECTORS_NEXT` | Vectorize | the new index of a re-embed | Only while an embedding-model change is re-embedding; `pmail deploy` adds and removes it ([Search design › Index lifecycle](../project/design/search.md#7-index-lifecycle)) |
| `AI` | Workers AI | – | Embeddings, rerank, triage, planner, `toMarkdown` |
| `EMAIL` | `send_email` | – | No address restrictions; the Worker enforces policy |
| `RL_API` | Rate limiting | – | 600 per 60 s, keyed by API key ID |
| `RL_SEARCH` | Rate limiting | – | 120 per 60 s, keyed by API key ID |
| `RL_AGENTIC` | Rate limiting | – | 20 per 60 s, keyed by API key ID |
| `RL_SEND` | Rate limiting | – | 120 per 60 s, keyed by identity ID |
| `RL_SIGNIN` | Rate limiting | – | 10 per 60 s, keyed by client IP (`CF-Connecting-IP`). Applies to `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-up` and `/console/waitlist` ([Cloud sign-up](../project/design/cloud-signup.md#10-abuse-and-safety-on-cloud)) |
| `METRICS` | Analytics Engine dataset | `pylota_mail_metrics` | Metrics and alerts ([Observability](../project/design/observability.md#3-metrics)). Holds IDs and counts only |
| `BACKUP` | R2 | the value of `PM_BACKUP_BUCKET` | Only when `PM_BACKUP_BUCKET` is set. Same jurisdiction as `BLOBS` |

Every work queue has a dead-letter queue with a consumer (batch 100) that records items in D1
(`dlq_items`). That makes ten queues in all.

The Durable Object migrations (`new_sqlite_classes`) are part of the generated `wrangler.toml` and are
versioned with the release. The generated file also turns invocation logs off and traces off in
production (`[observability.logs] invocation_logs = false`), because invocation logs record request URLs
and email recipients ([Observability › Signals](../project/design/observability.md#1-signals)).

Cron triggers:

- `* * * * *`: address retirement, the platform-event outbox sweep, restarting jobs left `queued`, the
  state-alert evaluator, and the SES inbound backstop (draining `PM_SES_INBOUND_QUEUE_URL`, when set).
  Retrying stuck sends, transport claims and uncertain-send bookkeeping run in each mailbox's own alarms,
  not in the cron.
- `*/15 * * * *`: domain health scheduling, retention, usage roll-up, the master-key re-seal sweep, and
  the nightly backup job once per UTC day when `PM_BACKUP_BUCKET` is set.

## Variables

| Variable | Default | Meaning |
|---|---|---|
| `PM_PLATFORM_DOMAIN` | – (required) | The shared mail domain. It must be a zone apex in this account |
| `PM_API_HOST` | – (required) | The host that serves the REST API, MCP, signed links, `/hooks/*`, the Stripe webhook and `/health`, for example `mail.example.com`. It also serves the console unless `PM_CONSOLE_HOST` names another host |
| `PM_JURISDICTION` | `eu` | `eu` or `default`. Applied to D1, R2 and Durable Objects at creation |
| `PM_CF_ACCOUNT_ID` | – (written by setup) | The Cloudflare account ID. Needed by the Worker's own Cloudflare REST calls (zone onboarding, event subscriptions, the Email Sending suppression list) |
| `PM_ENV` | `production` | `production`, `staging` or `local`. Shown in `/health` and logs |
| `PM_EMBED_MODEL` | `@cf/baai/bge-m3` | Changing it starts a background re-embed (see [Search design › Index lifecycle](../project/design/search.md#7-index-lifecycle)) |
| `PM_EMBED_MODEL_PREVIOUS` | unset | Only during a re-embed: the old model, used for semantic reads until the new index is complete. `pmail deploy` sets and removes it |
| `PM_RERANK_MODEL` | `@cf/baai/bge-reranker-base` | Set to `none` to disable reranking |
| `PM_AGENT_MODEL` | `@cf/qwen/qwen3.8-27b` | The function-calling model for agentic search |
| `PM_TRIAGE_MODEL` | `@cf/openai/gpt-oss-20b` | A JSON-output model for triage |
| `PM_AI_GATEWAY` | unset | Optional AI Gateway ID. Model calls go through it for logging and caching |
| `PM_TRUSTED_AUTHSERV_ID` | empty | The `Authentication-Results` authserv-id stamped by Cloudflare's MX. When it is empty, only the service's own DKIM, ARC and DMARC verification counts. `pmail doctor --mail-test` sends a message through the deployment and prints the authserv-id it observed. Headers from any other authserv-id are always ignored |
| `PM_DOH_RESOLVERS` | `https://cloudflare-dns.com/dns-query,https://dns.google/resolve` | Two independent resolvers for domain checks and DKIM keys |
| `PM_SES_REGION` | unset | The AWS region of Amazon SES, for both directions: with the secrets `PM_SES_ACCESS_KEY_ID` and `PM_SES_SECRET_ACCESS_KEY` it enables the SES transport, and with the three `PM_SES_INBOUND_*` variables also SES receiving. `pmail setup ses` requires one of the 22 regions that receive mail ([SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html#ses_inbound_endpoints), read 2026-10-09), and an EU region when `PM_JURISDICTION=eu` unless it was run with `--allow-non-eu` |
| `PM_SES_SNS_TOPIC_ARN` | unset | The only SNS topic whose notifications `POST /hooks/ses` accepts. Required with the SES transport |
| `PM_SES_INBOUND_BUCKET` | unset | The S3 bucket of the receipt rule `pm-deliver`. Set with the two below, it enables `inbound = ses` (`dns_records`, and `smtp_relay` with `inbound: ses`). Without all three, those domains get `422 transport_unavailable` (`ses_receiving_not_configured`) ([Domains on any DNS host › Deployment set-up for SES](../project/design/domain-connections.md#42-deployment-set-up-for-ses)) |
| `PM_SES_INBOUND_TOPIC_ARN` | unset | The only SNS topic whose notifications `POST /hooks/ses/inbound` accepts |
| `PM_SES_INBOUND_QUEUE_URL` | unset | The SQS backstop queue subscribed to the same topic, drained by the every-minute cron |
| `PM_SES_RULE_SET` | `pylota-mail` | The active SES receipt rule set. It holds `pm-deliver` and the `pm-retired-{n}` rules that the domain monitors edit |
| `PM_CF_SUBDOMAIN_SETUP` | `off` | `on` allows the `delegated_subdomain` method (Cloudflare Enterprise accounts only, once spike S10 has passed). While it is `off`, that method gets `422 transport_unavailable` (`subdomain_setup_disabled`) |
| `PM_DAILY_SEND_QUOTA` | unset | The account's Email Sending daily quota, copied from the Cloudflare dashboard. Cloudflare does not expose it to the Worker. When set, an alert fires at 80% of it; when unset, the alert fires on the first quota error ([G3](../project/edge-cases.md)) |
| `PM_BACKUP_BUCKET` | unset | Name of a second R2 bucket. When set, setup creates it in the same jurisdiction, binds it as `BACKUP`, and a nightly job copies new `t/` objects into it ([Privacy design](../project/design/privacy.md#54-optional-r2-backup-copy)). Off by default |
| `PM_SCANNER_URL` | unset | Optional malware scanner endpoint (see [Inbound](../project/design/inbound.md#attachment-safety)) |
| `PM_SECURITY_CONTACT` | unset | Served in `/.well-known/security.txt` |
| `PM_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. Content is never logged at any level |
| `PM_DEFAULT_POLICY` | `{}` | JSON merged over the built-in tenant policy defaults |
| `PM_CONSOLE` | `on` | `on` serves the console at `/console`; `off` removes its routes |
| `PM_QUARANTINE_KEY_RELEASE` | `on` | `on`: API keys with `quarantine:review` may release quarantined mail (`POST …/release`). `off`: only a signed-in person can, in the console, and API keys get `403 permission_denied` (FR-CON-6). Pylota Mail Cloud sets `off`. With `PM_CONSOLE=off` it is always treated as `on` |
| `PM_CONSOLE_HOST` | the value of `PM_API_HOST` | The host that serves the console. When it differs from `PM_API_HOST`, console paths answer only on this host and API paths only on `PM_API_HOST`; anything else gets `404`, and no cookie is set or read on the API host. Every console POST must carry `Origin: https://{PM_CONSOLE_HOST}` (CSRF defence in depth), and console links in mail use that origin |
| `PM_SIGNUP` | `closed` | Self-serve sign-up: `closed` (people join by invitation or `pmail setup --owner-email`), `waitlist` (double opt-in, invited in batches with `pmail waitlist invite`) or `open` ([Cloud sign-up](../project/design/cloud-signup.md#6-sign-up)) |
| `PM_SYSTEM_FROM` | `Pylota Mail <no-reply@{PM_PLATFORM_DOMAIN}>` | The **platform identity**: the sender of sign-in, invitation and notification mail, sent through the platform domain |
| `PM_TERMS_URL`, `PM_PRIVACY_URL`, `PM_DPA_URL` | unset | Terms of Service, Privacy Policy and Data Processing Addendum, linked from the sign-up checkbox. Required when `PM_SIGNUP` is not `closed` |
| `PM_TERMS_VERSION` | unset | The terms version stored on the user (`users.terms_version`) when they accept. Required when `PM_SIGNUP` is not `closed` |
| `PM_SIGNUP_BLOCKED_DOMAINS` | unset | Comma-separated domains refused at sign-up, before any mail is sent, in addition to the built-in list of disposable-mail domains that ships with each release |
| `PM_OAUTH_GOOGLE_CLIENT_ID` | unset | With the secret `PM_OAUTH_GOOGLE_CLIENT_SECRET`, enables "Continue with Google" |
| `PM_OAUTH_GITHUB_CLIENT_ID` | unset | With the secret `PM_OAUTH_GITHUB_CLIENT_SECRET`, enables "Continue with GitHub" |
| `PM_BILLING` | `off` | `off` (no plan checks; operator quotas only) or `stripe` (plans, metering, Stripe checkout and portal) |
| `PM_PLAN_CATALOG` | built-in Cloud catalog | JSON plan catalog (see [Billing design](../project/design/billing.md#plan-catalog)), including each plan's Stripe price IDs |
| `PM_BILLING_GRACE_DAYS` | `7` | Days a `past_due` workspace keeps its plan before Free limits apply |

## Secrets

`pmail setup` generates the random ones (32 bytes from the OS CSPRNG, base64) and uploads them as Worker
secrets. They are never written to disk unless you pass `--print-secrets`.

| Secret | Required | Used for (one purpose each; no secret is derived from another) |
|---|---|---|
| `PM_MASTER_KEY` | yes | AES-256-GCM encryption at rest of webhook secrets, identity signing keys, the Worker-generated thread, link and cursor keys, SMTP relay credentials, TOTP secrets and recovery codes, and OAuth PKCE verifiers ([Data model › Notes](../project/design/data-model.md#notes)) |
| `PM_MASTER_KEY_NEXT` | only during `pmail secrets rotate-master` | The new master key while stored values are re-sealed. `pmail doctor` warns while it is set |
| `PM_KEY_PEPPER` | yes | HMAC-SHA256 of API key secrets |
| `PM_HASH_KEY` | yes | Pseudonymisation: address tombstones, suppression hashes, log and query hashes |
| `PM_CF_API_TOKEN` | for some domain methods | Runtime automation of tenant domains (zone onboarding and creation, literal routing rules, event subscriptions). Required on the Worker for the `cloudflare_zone`, `nameservers` (a token that can create zones) and `delegated_subdomain` methods; without it they get `422 cf_token_required`. `pmail domains add` with your local token can then add an apex `cloudflare_zone` domain only (catch-all, no literal rules). `dns_records`, `send_only` and `smtp_relay` need no Cloudflare token |
| `PM_SES_ACCESS_KEY_ID`, `PM_SES_SECRET_ACCESS_KEY` | no | Amazon SES in both directions: sending (`dns_records`, `send_only`, failover), creating domain identities, and receiving (S3 objects, the SQS backstop, receipt-rule updates). `pmail setup ses` creates the IAM user with exactly one policy |
| `PM_STRIPE_SECRET_KEY` | only with `PM_BILLING=stripe` | Stripe API calls (Checkout sessions, Customer Portal sessions, subscription reads). Use a restricted key with only those permissions |
| `PM_STRIPE_WEBHOOK_SECRET` | only with `PM_BILLING=stripe` | Verifying the `Stripe-Signature` header on `/billing/stripe/webhook` |
| `PM_OAUTH_GOOGLE_CLIENT_SECRET`, `PM_OAUTH_GITHUB_CLIENT_SECRET` | only with the matching client ID | The OAuth code exchange for Google and GitHub sign-in |

Rotating `PM_KEY_PEPPER` (`pmail setup --rotate-pepper`) invalidates every API key, so it is a
break-glass action. Rotating
`PM_MASTER_KEY` uses `pmail secrets rotate-master`, which uploads `PM_MASTER_KEY_NEXT`, waits until the
Worker has re-sealed every stored value under it, then replaces `PM_MASTER_KEY`. No secret is ever read
back from the Worker by the CLI ([Security design](../project/design/security.md#62-rotation-procedures)).

### Thread and link keys

The keys that sign thread tokens, signed links and search cursors are not Worker secrets. The Worker
generates them (32 random bytes each), stores them in D1 `signing_keys` sealed under `PM_MASTER_KEY`, and
puts a one-character key ID (kid) in every token, link and cursor it signs. No API, CLI command or log ever
returns them.

| Purpose | Signs | Rotate with | Old kid keeps verifying for |
|---|---|---|---|
| `thread` | Thread tokens in `Reply-To` sub-addresses | `POST /v1/platform/keys/thread/rotate` | 90 days |
| `link` | Signed attachment and export links, console sign-in, invitation and session tokens, OAuth state hashes | `POST /v1/platform/keys/link/rotate` | 7 days (the longest link lifetime) |
| `cursor` | Search cursors (`next_cursor`) | `POST /v1/platform/keys/cursor/rotate` | 24 hours (the cursor lifetime) |

All three need a platform key with `platform:ops` ([REST API](api.md#platform-operations)); the CLI is
`pmail keys rotate thread|link|cursor`. Add `?revoke_previous=true` (`--revoke-previous`) after a suspected
leak: the previous kid is deleted at once instead of verifying for its window, so what it signed stops
working (thread tokens fall back to header threading; open links, sign-in tokens, invitations, sessions,
OAuth flows and cursors fail). Then rotate `PM_MASTER_KEY`.

## Tenant policy

Stored per tenant. `PATCH /v1/tenants/{tenant_id}` (a platform key with `tenants:manage`) with
`{ "policy": { … } }` deep-merges it. This is the full
document with defaults:

```json
{
  "identity_daily_send_cap": 500,
  "tenant_daily_send_cap": 5000,
  "max_recipients": 10,
  "send_allowlist_only": false,
  "large_attachments": "refuse",
  "link_ttl_hours": 72,
  "ai_disclosure": { "mode": "none", "text": "This message was written with the help of an AI assistant." },
  "auto_reply": {
    "allowed": true,
    "max_automatic_exchanges": 2
  },
  "quarantine": {
    "on_auth_fail": true,
    "spam_threshold": 0.8,
    "unsolicited_otp": true
  },
  "inbound": {
    "per_sender_per_hour": 60,
    "extract_attachment_text": ["pdf", "office", "text", "html"],
    "extract_image_text": false,
    "ses_bounce_retired": true
  },
  "retention": {
    "raw_days": 90,
    "message_days": null,
    "events_days": 30
  },
  "triage": {
    "enabled": true,
    "categories": null,
    "rules": []
  },
  "search": {
    "agentic_enabled": true,
    "agentic_daily_cap": 500,
    "agentic_max_steps": 6,
    "agentic_max_seconds": 8,
    "refs_packs": ["core"],
    "custom_refs": []
  },
  "webhook_text_bytes": 16384,
  "abuse": {
    "complaint_rate_pause": 0.003,
    "bounce_rate_pause": 0.05
  },
  "domains": {
    "allow_create_zone": false
  },
  "domain_fallback": true
}
```

| Field | Notes |
|---|---|
| `tenant_daily_send_cap` | On Pylota Mail Cloud, a new workspace on the Free plan starts with a cap of 50 for its first 7 days. The ramp lifts on day 7 if its bounce and complaint rates are under the `abuse` thresholds, or at once on a paid plan ([Cloud sign-up › Abuse and safety](../project/design/cloud-signup.md#10-abuse-and-safety-on-cloud)) |
| `max_recipients` | 1–49. Cloudflare allows 50 recipients per message, and one is kept for the hidden journal copy of Message-ID strategy B ([Outbound design](../project/design/outbound.md#message-id-of-outbound-mail-spike-s7)) |
| `large_attachments` | `refuse`, or `link` (expiring signed links, `link_ttl_hours` 1–168) |
| `ai_disclosure.mode` | `none`, `footer` (appended to text and HTML) or `header` (`X-AI-Generated: true`) |
| `auto_reply.max_automatic_exchanges` | Automatic replies allowed per thread before a human must act ([D6](../project/edge-cases.md)) |
| `inbound.ses_bounce_retired` | `true` bounces mail to retired addresses on SES-receiving domains with `550 5.1.6`, through SES receipt rules; `false` drops it without a bounce ([Domains on any DNS host › Retired and unknown recipients](../project/design/domain-connections.md#46-retired-and-unknown-recipients)) |
| `quarantine.unsolicited_otp` | Quarantine password-reset and OTP mail that no `wait` asked for ([E5](../project/edge-cases.md)) |
| `retention.message_days` | `null` keeps parsed messages indefinitely. A number deletes messages, attachments, index rows and vectors after that age, except held threads |
| `triage.categories` | `null` uses the built-in list. Otherwise an array of up to 20 `{ "name": "pcn", "description": "Penalty charge notices from councils" }`, which replaces it |
| `triage.rules` | Deterministic rules. See [Triage](../guides/triage.md#rules) |
| `search.refs_packs` | `core` (amounts, phones, emails, domains, dates, invoice and order numbers) and optional `uk_vehicle` (plates, PCNs). There is no built-in pack for booking references: add them with `custom_refs` |
| `search.custom_refs` | Up to 20 `{ "name": "booking", "pattern": "BK-\\d{4,6}", "normalise": "upper" }`. Patterns use the `regex` crate syntax: linear time, no back-references, compiled size capped at 64 KB |
| `domains.allow_create_zone` | Lets the tenant's own keys use the `nameservers` method, which creates a Cloudflare zone. `false` by default; Pylota Mail Cloud sets it to `true`. Without it, the request gets `422 transport_unavailable` (`zone_creation_not_allowed`). Platform keys may always use it |
| `domain_fallback` | `false` fails sends on a failing domain instead of using the platform address |

## CLI configuration

```toml
# ~/.config/pylota-mail/config.toml
default_profile = "prod"

[profiles.prod]
url = "https://mail.example.com"
key = "pmk_live_…"                 # or key_command = "op read op://vault/pylota-mail/key"
identity = "bookings.acme@agents.example"   # default for mail commands

[profiles.staging]
url = "https://mail-staging.example.com"
key_env = "PYLOTA_MAIL_STAGING_KEY"
```

Precedence, highest first: command-line flags (`--url`, `--key`, `--profile`), then environment
(`PYLOTA_MAIL_URL`, `PYLOTA_MAIL_KEY`, `PYLOTA_MAIL_PROFILE`), then the profile in the file. The file
is created with mode `0600`, and `pmail` refuses to read it if it is group- or world-readable.

Setup and deploy use `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (or `--account-id`). They are
never stored in the config file.
