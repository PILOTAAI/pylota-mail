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
| `SES_CONTROL` | Durable Object namespace | class `SesControl` | SQLite-backed. One object per deployment, used only when SES is configured: the SES control-plane token bucket |
| `NOTIFY` | Durable Object namespace | class `Notifier` | SQLite-backed. One object per tenant: coalescing, schedules and caps of notification email ([Notifications](../project/design/notifications.md#8-notifier-object)) |
| `Q_INBOUND` | Queue producer and consumer | `pm-inbound` (DLQ `pm-inbound-dlq`) | Batch 10, max retries 10 |
| `Q_OUTBOUND` | Queue producer and consumer | `pm-outbound` (DLQ `pm-outbound-dlq`) | Batch 10, max retries 100. They count only unexpected errors: provider rate-limit, quota and relay back-offs re-enqueue a new message with a delay, so they never use them up; every back-off ends `failed` (`quota_exhausted`) 24 hours after submit |
| `Q_DELIVERY` | Queue consumer and producer | `pm-delivery-events` (DLQ `pm-delivery-events-dlq`) | Batch 10, max retries 20 (the G8 retry schedule needs at least 11). Fed by Email Sending event subscriptions; the producer is used only to redrive dead-lettered items |
| `Q_WEBHOOKS` | Queue producer and consumer | `pm-webhooks` (DLQ `pm-webhooks-dlq`) | Batch 20, max retries 13 |
| `Q_INDEX` | Queue producer and consumer | `pm-index` (DLQ `pm-index-dlq`) | Batch 10, max retries 10 |
| `VECTORS` | Vectorize | `pm-mail-chunks` | 1024 dimensions, cosine, 8 metadata indexes |
| `VECTORS_NEXT` | Vectorize | the new index of a re-embed | Only while an embedding-model change is re-embedding; `pmail deploy` adds and removes it ([Search design › Index lifecycle](../project/design/search.md#7-index-lifecycle)) |
| `AI` | Workers AI | – | Embeddings, rerank, triage, planner, `toMarkdown` |
| `EMAIL` | `send_email` | – | No address restrictions; the Worker enforces policy |
| `RL_API` | Rate limiting | – | 600 per 60 s, keyed by API key ID |
| `RL_TENANT` | Rate limiting | – | 1,800 per 60 s, keyed by tenant ID: every request made with a tenant or identity key of the tenant, on top of `RL_API` ([Security § 10](../project/design/security.md#10-rate-limiting-and-abuse)) |
| `RL_PARTNER_API` | Rate limiting | – | 1,800 per 60 s, keyed by partner ID: every request made with a partner key of the partner, on top of `RL_API` |
| `RL_SEARCH` | Rate limiting | – | 120 per 60 s, keyed by API key ID |
| `RL_AGENTIC` | Rate limiting | – | 20 per 60 s, keyed by API key ID |
| `RL_SEND` | Rate limiting | – | 120 per 60 s, keyed by identity ID |
| `RL_SIGNIN` | Rate limiting | – | 10 per 60 s, keyed by client IP (`CF-Connecting-IP`). Applies to `POST /console/sign-in`, `/console/sign-in/link`, `/console/sign-in/code`, `/console/sign-up` and `/console/waitlist` ([Cloud sign-up](../project/design/cloud-signup.md#10-abuse-and-safety-on-cloud)) |
| `RL_SIGN` | Rate limiting | – | 600 per 60 s, keyed by identity ID. Agent assertions and signed HTTP requests together ([Agent signing keys](../project/design/agent-keys.md#6-permissions-limits-and-plans)) |
| `RL_PARTNER` | Rate limiting | – | 10 per 60 s, keyed by partner ID. `POST /v1/tenants` and `POST /v1/tenants/{tenant_id}/invitations` called with a partner key, across all of the partner's keys ([Security § 10](../project/design/security.md#10-rate-limiting-and-abuse)) |
| `METRICS` | Analytics Engine dataset | `pylota_mail_metrics` | Metrics and alerts ([Observability](../project/design/observability.md#3-metrics)). Holds IDs and counts only |
| `BACKUP` | R2 | the value of `PM_BACKUP_BUCKET` | Only when `PM_BACKUP_BUCKET` is set. Same jurisdiction as `BLOBS` |

Every work queue has a dead-letter queue with a consumer (batch 100) that records items in D1
(`dlq_items`). That makes ten queues in all.

The Durable Object migrations (`new_sqlite_classes`: `IdentityMailbox`, `DomainMonitor`, `JobRunner`,
`TenantQuota`, `SesControl` and `Notifier`, six classes) are part of the generated `wrangler.toml` and are
versioned with the release ([Rust workspace › Generated wrangler.toml](../project/design/rust-workspace.md#8-generated-wranglertoml)). The generated file also turns invocation logs off and traces off in
production (`[observability.logs] invocation_logs = false`), because invocation logs record request URLs
and email recipients ([Observability › Signals](../project/design/observability.md#1-signals)).

Cron triggers:

- `* * * * *`: address retirement, the platform-event outbox sweep, restarting jobs left `queued`, the
  state-alert evaluator, the SES inbound backstop (draining `PM_SES_INBOUND_QUEUE_URL`, when set), and
  minting the Durable Object IDs that only the Worker can mint for rows written outside it: the system
  identity's mailbox, the `DomainMonitor` of a domain row with `monitor_do_id = ''` (the platform domain,
  and domains added with `pmail domains add --local-token`), the `Notifier` of a tenant row with
  `notify_do_id = ''` (then `NotifierRequest::Init`), and the `SesControl` object when SES is
  configured.
  Retrying stuck sends, transport claims and uncertain-send bookkeeping run in each mailbox's own alarms,
  not in the cron.
- `*/15 * * * *`: domain health scheduling, retention, usage roll-up, the master-key re-seal sweep, the
  nightly backup job once per UTC day when `PM_BACKUP_BUCKET` is set, and the new-workspace send-ramp
  evaluation once per UTC day (`crons/signup_ramp.rs`; it finds ramped Free workspaces with
  `PM_BILLING=stripe`, and ramped tenants of partners on any deployment).

## Variables

| Variable | Default | Meaning |
|---|---|---|
| `PM_PLATFORM_DOMAIN` | – (required) | The shared mail domain. It must be a zone apex in this account |
| `PM_API_HOST` | – (required) | The host that serves the REST API (`/v1/*`, including signed links `/v1/links/*`), MCP (`/mcp`), `/openapi.json`, `/health`, `/.well-known/*` (the security contact, identity JWKS and the Web Bot Auth key directory), `/hooks/*` and the Stripe webhook (`/billing/stripe/webhook`), for example `mail.example.com`. It is the issuer (`iss`) of agent assertions. It also serves the console unless `PM_CONSOLE_HOST` names another host |
| `PM_JURISDICTION` | `eu` | `eu` or `default`. Applied to D1, R2 and Durable Objects at creation, where `eu` is Cloudflare's jurisdiction: the European Union only ([R2 data location](https://developers.cloudflare.com/r2/reference/data-location/), read 2026-10-09). For the SES region checked by `pmail setup ses`, `eu` means "EU or UK": the UK has an EU adequacy decision under the GDPR (European Commission [adequacy decisions](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en), renewed 19 December 2025, read 2026-10-09), so `eu-west-2` (London) is accepted |
| `PM_CF_ACCOUNT_ID` | – (written by setup) | The Cloudflare account ID. Needed by the Worker's own Cloudflare REST calls (zone onboarding, event subscriptions, the Email Sending suppression list) |
| `PM_ENV` | `production` | `production`, `staging` or `local`. Shown in `/health` and logs |
| `PM_EMBED_MODEL` | `@cf/baai/bge-m3` | Changing it starts a background re-embed (see [Search design › Index lifecycle](../project/design/search.md#7-index-lifecycle)) |
| `PM_EMBED_MODEL_PREVIOUS` | unset | Only during a re-embed: the old model, used for semantic reads until the new index is complete. `pmail deploy` sets and removes it |
| `PM_RERANK_MODEL` | `@cf/baai/bge-reranker-base` | Set to `none` to disable reranking |
| `PM_AGENT_MODEL` | `@cf/qwen/qwen3.8-27b` | The function-calling model for agentic search |
| `PM_TRIAGE_MODEL` | `@cf/openai/gpt-oss-20b` | A JSON-output model for triage |
| `PM_AI_GATEWAY` | unset | Optional AI Gateway ID. Model calls go through it for logging and caching |
| `PM_TRUSTED_AUTHSERV_ID` | empty (set by `pmail setup`) | The `Authentication-Results` authserv-id stamped by Cloudflare's MX. `pmail setup` runs the mail test as its last step and writes the authserv-id it observed here; `pmail doctor --mail-test` prints it too. While it is empty, SPF cannot be read (Email Workers do not see the client IP), so a sender whose DMARC policy is `quarantine` or `reject` and who aligns only through SPF gets the verdict `unverified` and is quarantined as `auth_unverified`, never `fail`. Headers from any other authserv-id are always ignored |
| `PM_DOH_RESOLVERS` | `https://cloudflare-dns.com/dns-query,https://dns.google/resolve` | Two independent resolvers for domain checks and DKIM keys |
| `PM_SES_REGION` | unset | The AWS region of Amazon SES, for both directions: with the secrets `PM_SES_ACCESS_KEY_ID` and `PM_SES_SECRET_ACCESS_KEY` it enables the SES transport, and with the three `PM_SES_INBOUND_*` variables also SES receiving. `pmail setup ses` requires one of the 22 regions that receive mail ([SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html#ses_inbound_endpoints), read 2026-10-09), and a region in the EU or the UK when `PM_JURISDICTION=eu` unless it was run with `--allow-non-eu` |
| `PM_SES_SNS_TOPIC_ARN` | unset | The only SNS topic whose notifications `POST /hooks/ses` accepts. Required with the SES transport |
| `PM_SES_INBOUND_BUCKET` | unset | The S3 bucket of the receipt rule `pm-deliver`. Set with the two below, it enables `inbound = ses` (`dns_records`, and `smtp_relay` with `inbound: ses`). Without all three, those domains get `422 transport_unavailable` (`ses_receiving_not_configured`) ([Domains on any DNS host › Deployment set-up for SES](../project/design/domain-connections.md#42-deployment-set-up-for-ses)) |
| `PM_SES_INBOUND_TOPIC_ARN` | unset | The only SNS topic whose notifications `POST /hooks/ses/inbound` accepts |
| `PM_SES_INBOUND_QUEUE_URL` | unset | The SQS backstop queue subscribed to the same topic, drained by the every-minute cron |
| `PM_SES_RULE_SET` | `pylota-mail` | The active SES receipt rule set. It holds `pm-deliver` and the `pm-retired-{n}` rules, which only the `SesControl` object edits ([Domains on any DNS host § 4.6](../project/design/domain-connections.md#46-retired-and-unknown-recipients)) |
| `PM_CF_SUBDOMAIN_SETUP` | `off` | `on` allows the `delegated_subdomain` method (Cloudflare Enterprise accounts only, once spike S10 has passed). While it is `off`, that method gets `422 transport_unavailable` (`subdomain_setup_disabled`) |
| `PM_WEB_BOT_AUTH` | `off` | `on` publishes the Web Bot Auth key directory at `/.well-known/http-message-signatures-directory` and allows signed HTTP requests (`POST …/http-signatures`), for tenants whose policy has `web_bot_auth.allowed: true`. Turn it on only once spike S13 has passed; while it is `off`, those requests and the `web_bot_auth` key rotation get `422 web_bot_auth_disabled` and the directory `404` ([Agent signing keys](../project/design/agent-keys.md#5-signed-http-requests-web-bot-auth), [Deploy › Signed HTTP requests](../self-hosting.md#signed-http-requests-web-bot-auth)) |
| `PM_IDENTITY_KEY_OVERLAP_DAYS` | `7` | Days a rotated identity signing key stays `retiring`: still published in the identity's JWKS, no longer signing ([Agent signing keys › Keys](../project/design/agent-keys.md#2-keys)) |
| `PM_DAILY_SEND_QUOTA` | unset | The account's Email Sending daily quota, copied from the Cloudflare dashboard. Cloudflare does not expose it to the Worker. When set, an alert fires at 80% of it; when unset, the alert fires on the first quota error ([G3](../project/edge-cases.md)) |
| `PM_BACKUP_BUCKET` | unset | Name of a second R2 bucket. When set, setup creates it in the same jurisdiction, binds it as `BACKUP`, and a nightly job copies new `t/` objects into it ([Privacy design](../project/design/privacy.md#54-optional-r2-backup-copy)). Off by default |
| `PM_SCANNER_URL` | unset | Optional malware scanner endpoint (see [Inbound](../project/design/inbound.md#attachment-safety)) |
| `PM_SECURITY_CONTACT` | unset | Served in `/.well-known/security.txt` |
| `PM_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. Content is never logged at any level |
| `PM_DEFAULT_POLICY` | `{}` | JSON merged over the built-in tenant policy defaults |
| `PM_CONSOLE` | `on` | `on` serves the console at `/console`; `off` removes its routes |
| `PM_QUARANTINE_KEY_RELEASE` | `on` | `on`: API keys with `quarantine:review` may release quarantined mail (`POST …/release`). `off`: only a signed-in person can, in the console, and API keys get `403 permission_denied` (FR-CON-6), except on a tenant whose policy has `quarantine.key_release: true` ([Tenant policy](#tenant-policy)). Pylota Mail Cloud sets `off`. With `PM_CONSOLE=off` it is always treated as `on` |
| `PM_CONSOLE_HOST` | the value of `PM_API_HOST` | The host that serves the console. When it differs from `PM_API_HOST`, console paths answer only on this host and API paths only on `PM_API_HOST`; anything else gets `404`, and no cookie is set or read on the API host. Every console POST must carry `Origin: https://{PM_CONSOLE_HOST}` (CSRF defence in depth), and console links in mail use that origin. It is read even with `PM_CONSOLE=off`, because invitation links use it |
| `PM_SIGNUP` | `closed` | Self-serve sign-up: `closed` (people join by invitation or `pmail setup --owner-email`), `waitlist` (double opt-in, invited in batches with `pmail waitlist invite`) or `open` ([Cloud sign-up](../project/design/cloud-signup.md#6-sign-up)) |
| `PM_SYSTEM_FROM` | `Pylota Mail <no-reply@{PM_PLATFORM_DOMAIN}>` | The display name and address of the **system identity**, which `pmail setup` creates on the default tenant and which sends sign-in, invitation and notification mail through the platform domain. Its local part may be a reserved name; it is never listed to tenants ([Identities and domains › The system identity](../project/design/identity-domains.md#the-system-identity)). Read even with `PM_CONSOLE=off` |
| `PM_NOTIFICATIONS` | `on` | `on` sends notification email to people: usage alerts, new-mail notifications and the daily "needs a person" email, each as their preferences allow. `off` sends only `account` emails ([Notifications](../project/design/notifications.md)). Read even with `PM_CONSOLE=off` |
| `PM_TERMS_URL`, `PM_PRIVACY_URL`, `PM_DPA_URL` | unset | Terms of Service, Privacy Policy and Data Processing Addendum, linked from the sign-up checkbox. Required when `PM_SIGNUP` is not `closed` |
| `PM_TERMS_VERSION` | unset | The terms version stored on the user (`users.terms_version`) when they accept. Required when `PM_SIGNUP` is not `closed` |
| `PM_SIGNUP_BLOCKED_DOMAINS` | unset | Comma-separated domains refused at sign-up, before any mail is sent, in addition to the built-in list of disposable-mail domains that ships with each release |
| `PM_OAUTH_GOOGLE_CLIENT_ID` | unset | With the secret `PM_OAUTH_GOOGLE_CLIENT_SECRET`, enables "Continue with Google" |
| `PM_OAUTH_GITHUB_CLIENT_ID` | unset | With the secret `PM_OAUTH_GITHUB_CLIENT_SECRET`, enables "Continue with GitHub" |
| `PM_BILLING` | `off` | `off` (no plan checks and no usage alerts; only the daily caps in tenant policy apply) or `stripe` (plans, metering, Stripe checkout and portal) |
| `PM_PLAN_CATALOG` | built-in Cloud catalog | JSON plan catalog (see [Billing design](../project/design/billing.md#plan-catalog)), including each plan's Stripe price IDs |
| `PM_BILLING_GRACE_DAYS` | `7` | Days a `past_due` workspace keeps its plan before Free limits apply |

## Secrets

`pmail setup` generates the random ones (32 bytes from the OS CSPRNG, base64) and uploads them as Worker
secrets. Without `--print-secrets` they go only to the Worker (through Wrangler, on stdin), never to
stdout, a file or a log; with it they are printed once to stdout.

| Secret | Required | Used for (one purpose each; no secret is derived from another) |
|---|---|---|
| `PM_MASTER_KEY` | yes | AES-256-GCM encryption at rest of webhook secrets, identity signing keys, the Worker-generated thread, link and cursor keys and the Web Bot Auth deployment key, SMTP relay credentials, TOTP secrets and recovery codes, and OAuth PKCE verifiers ([Data model › Notes](../project/design/data-model.md#notes)) |
| `PM_MASTER_KEY_NEXT` | only during `pmail secrets rotate-master` | The new master key while stored values are re-sealed. `pmail doctor` warns while it is set |
| `PM_KEY_PEPPER` | yes | HMAC-SHA256 of API key secrets |
| `PM_HASH_KEY` | yes | Pseudonymisation: address tombstones, suppression hashes, log and query hashes |
| `PM_CF_API_TOKEN` | for some domain methods (for every deployment if a spike S6 REST fallback is taken) | Runtime automation of tenant domains (zone onboarding and creation, literal routing rules, event subscriptions), and the REST fallbacks for Vectorize and Workers AI if spike S6 fails ([Rust workspace §7](../project/design/rust-workspace.md#7-wasm-bindgen-externs)). Required on the Worker for the `cloudflare_zone`, `nameservers` (a token that can create zones) and `delegated_subdomain` methods; without it they get `422 cf_token_required`. `pmail domains add --local-token` with your own token can then add an apex `cloudflare_zone` domain only (catch-all, no literal rules). `dns_records`, `send_only` and `smtp_relay` need no Cloudflare token. Scope it to named zones (the platform domain's zone and every zone listed in a tenant's `domains.cloudflare_zones`); only a deployment that offers `nameservers` or `delegated_subdomain` needs All zones. Its permissions are in [Deploy › Create a Cloudflare API token](../self-hosting.md#2-create-a-cloudflare-api-token) |
| `PM_SES_ACCESS_KEY_ID`, `PM_SES_SECRET_ACCESS_KEY` | no | Amazon SES in both directions: sending (`dns_records`, `send_only`, failover), creating domain identities, and receiving (S3 objects, the SQS backstop, receipt-rule updates). `pmail setup ses` creates the IAM user with exactly one policy |
| `PM_STRIPE_SECRET_KEY` | only with `PM_BILLING=stripe` | Stripe API calls: create and retrieve Checkout Sessions, create Customer Portal sessions, read subscriptions, and cancel subscriptions when a workspace is deleted. Use a restricted key with exactly those permissions ([Billing › Stripe integration](../project/design/billing.md#stripe-integration)) |
| `PM_STRIPE_WEBHOOK_SECRET` | only with `PM_BILLING=stripe` | Verifying the `Stripe-Signature` header on `/billing/stripe/webhook` |
| `PM_OAUTH_GOOGLE_CLIENT_SECRET`, `PM_OAUTH_GITHUB_CLIENT_SECRET` | only with the matching client ID | The OAuth code exchange for Google and GitHub sign-in |

Rotating `PM_KEY_PEPPER` (`pmail setup --rotate-pepper`) invalidates every API key, so it is a
break-glass action. Rotating
`PM_MASTER_KEY` uses `pmail secrets rotate-master`, which uploads `PM_MASTER_KEY_NEXT`, waits until the
Worker has re-sealed every stored value under it, then replaces `PM_MASTER_KEY`. No secret is ever read
back from the Worker by the CLI ([Security design](../project/design/security.md#62-rotation-procedures)).

### Thread and link keys

The keys that sign thread tokens, signed links, search cursors and Web Bot Auth requests are not Worker
secrets. The Worker generates them (32 random bytes each), stores them in D1 `signing_keys` sealed under
`PM_MASTER_KEY`, and puts their key ID (kid) in everything it signs: one character for `thread`, `link`
and `cursor`, and the RFC 7638 thumbprint of the public key for `web_bot_auth`. No API, CLI command or log
ever returns a private key; the `web_bot_auth` public key is published in the key directory.

| Purpose | Signs | Rotate with | Old kid keeps verifying for |
|---|---|---|---|
| `thread` | Thread tokens in `Reply-To` sub-addresses | `POST /v1/platform/keys/thread/rotate` | 90 days |
| `link` | Signed attachment and export links, console sign-in, invitation and session tokens, OAuth state hashes | `POST /v1/platform/keys/link/rotate` | 7 days (the longest link lifetime) |
| `cursor` | Search cursors (`next_cursor`) | `POST /v1/platform/keys/cursor/rotate` | 24 hours (the cursor lifetime) |
| `web_bot_auth` | Signed HTTP requests (Web Bot Auth) and the key directory; only with `PM_WEB_BOT_AUTH=on` | `POST /v1/platform/keys/web_bot_auth/rotate` | 7 days (still listed in the key directory) |

All four need a platform key with `platform:ops` ([REST API](api.md#platform-operations)); the CLI is
`pmail keys rotate thread|link|cursor|web_bot_auth`. Identity signing keys are not in this table: each
identity has its own, rotated through `POST /v1/identities/{identity_id}/keys/rotate`
([Agent signing keys](../project/design/agent-keys.md)). Add `?revoke_previous=true` (`--revoke-previous`) after a suspected
leak: the previous kid is deleted at once instead of verifying for its window, so what it signed stops
working (thread tokens fall back to header threading; open links, sign-in tokens, invitations, sessions,
OAuth flows and cursors fail). Then rotate `PM_MASTER_KEY`.

## Tenant policy

Stored per tenant. `PATCH /v1/tenants/{tenant_id}` with `{ "policy": { … } }` deep-merges it; it needs
`tenants:manage`, so a platform key changes any tenant's policy and a partner key the policy of the
tenants its partner's keys created ([REST API › Partners](api.md#partners)). Tenant keys and the console
cannot change it. A partner key may change only some fields, and some only downwards
([Who may change a field](#who-may-change-a-field)), so one partner cannot spend the shared sending
reputation or the AI budget of a Cloud deployment. This is the full document with defaults:

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
    "unsolicited_otp": true,
    "key_release": false
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
    "allow_create_zone": false,
    "cloudflare_zones": []
  },
  "web_bot_auth": {
    "allowed": false
  },
  "domain_fallback": true
}
```

| Field | Notes |
|---|---|
| `tenant_daily_send_cap` | With `PM_BILLING=stripe`, a new workspace on the Free plan has an effective cap of min(this value, 50) until `tenants.ramp_lifted_at` is set: for its first 7 days, then until the daily evaluation (the `*/15` cron's `crons/signup_ramp.rs`) finds its bounce and complaint rates under the `abuse` thresholds. A paid plan lifts it at once. A tenant a partner's key created follows the same ramp whatever `PM_BILLING` and its billing mode (`exempt` included), unless a platform key set the partner's `ramp_exempt`; an `exempt` tenant has no plan, so only the daily evaluation lifts it. The system identity is never counted against this cap ([Cloud sign-up › New-workspace send ramp](../project/design/cloud-signup.md#101-new-workspace-send-ramp)) |
| `max_recipients` | 1–49. Cloudflare allows 50 recipients per message, and one is kept for the hidden journal copy of Message-ID strategy B ([Outbound design](../project/design/outbound.md#message-id-of-outbound-mail-spike-s7)) |
| `large_attachments` | `refuse`, or `link` (expiring signed links, `link_ttl_hours` 1–168) |
| `ai_disclosure.mode` | `none`, `footer` (appended to text and HTML) or `header` (`X-AI-Generated: true`) |
| `auto_reply.max_automatic_exchanges` | Automatic replies allowed per thread before a human must act ([D6](../project/edge-cases.md)) |
| `inbound.ses_bounce_retired` | `true` bounces mail to retired addresses on SES-receiving domains with `550 5.1.6`, through SES receipt rules; `false` drops it without a bounce ([Domains on any DNS host › Retired and unknown recipients](../project/design/domain-connections.md#46-retired-and-unknown-recipients)) |
| `quarantine.unsolicited_otp` | Quarantine password-reset and OTP mail that no `wait` asked for ([E5](../project/edge-cases.md)) |
| `quarantine.key_release` | `true` lets keys with `quarantine:review` that reach this tenant, its partner key included, release its quarantined mail even when `PM_QUARANTINE_KEY_RELEASE` is `off`. `false` by default. Only a platform key, or the partner key of the tenant's own partner, can set it (a tenant key cannot call `PATCH /v1/tenants/{tenant_id}`: `403 permission_denied`). With `PM_QUARANTINE_KEY_RELEASE=on` it changes nothing. On Pylota Mail Cloud, Pylota's partner key sets it to `true` on each operator's tenant ([J14](../project/edge-cases.md), [J16](../project/edge-cases.md)) |
| `retention.message_days` | `null` keeps parsed messages indefinitely. A number deletes messages, attachments, index rows and vectors after that age, except held threads |
| `retention.events_days` | 1–365, default 30. Webhook delivery rows, the event index and the event payloads kept for replay are deleted after this many days. Webhook replay reaches back 30 days from an event's `occurred_at`, or this many days if fewer ([Privacy design › Retention](../project/design/privacy.md#52-steps-of-a-tenant-retention-job)) |
| `triage.categories` | `null` uses the built-in list. Otherwise an array of up to 20 `{ "name": "pcn", "description": "Penalty charge notices from councils" }`, which replaces it |
| `triage.rules` | Deterministic rules. See [Triage](../guides/triage.md#rules) |
| `search.refs_packs` | `core` (amounts, phones, emails, domains, dates, invoice and order numbers) and optional `uk_vehicle` (plates, PCNs). There is no built-in pack for booking references: add them with `custom_refs` |
| `search.custom_refs` | Up to 20 `{ "name": "booking", "pattern": "BK-\\d{4,6}", "normalise": "upper" }`. Patterns use the `regex` crate syntax: linear time, no back-references, compiled size capped at 64 KB |
| `domains.allow_create_zone` | Lets the tenant's own keys, and its partner key, use the `nameservers` method, which creates a Cloudflare zone. `false` by default, and Pylota Mail Cloud keeps it `false`: Cloud's Worker token is limited to named zones and cannot create zones ([ADR 0010](../project/adr/0010-cloud-in-the-existing-cloudflare-account.md)). Without it, the request gets `422 transport_unavailable` (`zone_creation_not_allowed`). Platform keys may use the method when the Worker's token can create zones (it needs All zones, [Deploy › step 2](../self-hosting.md#2-create-a-cloudflare-api-token)). Only a platform key can set it |
| `domains.cloudflare_zones` | Zones of the deployment's Cloudflare account, by name (A-label apex, lower case, up to 50), that the tenant's own keys and its partner key may use with the `cloudflare_zone` method and with `replace_mx`, besides the zones this deployment created for the tenant (`nameservers`, `delegated_subdomain`). A listed zone grants names strictly under it; its apex and `replace_mx` there stay platform-only. `[]` by default. A zone created for another tenant, or one under the zones of `PM_PLATFORM_DOMAIN`, `PM_API_HOST` or `PM_CONSOLE_HOST`, is refused even when listed (`403 scope_denied`, `details.reason = "zone_not_allowed"`). Platform keys may use any zone. Each listed zone must also be in the zone list of the Worker's `PM_CF_API_TOKEN`. Dropping a zone while the tenant still has domains in it is refused with `409 domain_in_use` (`details.reason = "zone_has_domains"`) ([H13](../project/edge-cases.md)). Only a platform key can set it ([Identities and domains › Zone permission](../project/design/identity-domains.md#zone-permission)) |
| `web_bot_auth.allowed` | Lets the tenant's identities obtain signed HTTP requests (Web Bot Auth). `false` by default, and until it is `true` those requests get `403 policy_denied`. Only a platform key can set it: a tenant or partner key cannot turn it on. It has no effect while `PM_WEB_BOT_AUTH` is `off` ([Agent signing keys](../project/design/agent-keys.md#5-signed-http-requests-web-bot-auth)) |
| `domain_fallback` | `false` fails sends on a failing domain instead of using the platform address |

### Who may change a field

Every policy write is checked against this table: the `policy` of `POST /v1/tenants` and of
`PATCH /v1/tenants/{tenant_id}`. Only the fields present in the write are compared; one refused field
refuses the whole write and nothing is stored. Platform keys may set every field. Tenant keys, identity
keys and the console cannot write the policy at all (`PATCH /v1/tenants/{tenant_id}` needs
`tenants:manage`).

| Class | Fields | A partner key |
|---|---|---|
| Platform-only | `web_bot_auth.allowed`, `domains.allow_create_zone`, `domains.cloudflare_zones` | `403 scope_denied` with `details.field` |
| Platform or own partner | `quarantine.key_release` | May set it on the tenants of its own partner, at creation and later |
| Lower-only | `identity_daily_send_cap`, `tenant_daily_send_cap`, `max_recipients`, `auto_reply.allowed`, `auto_reply.max_automatic_exchanges`, `inbound.per_sender_per_hour`, `inbound.extract_image_text`, `retention.raw_days`, `retention.events_days`, `triage.enabled`, `search.agentic_enabled`, `search.agentic_daily_cap`, `search.agentic_max_steps`, `search.agentic_max_seconds`, `abuse.complaint_rate_pause`, `abuse.bounce_rate_pause` | May set a value at or below the field's ceiling; above it, `403 scope_denied` with `details.field` |
| Free | Every other field: `send_allowlist_only`, `large_attachments`, `link_ttl_hours`, `ai_disclosure`, `quarantine.on_auth_fail`, `quarantine.spam_threshold`, `quarantine.unsolicited_otp`, `inbound.extract_attachment_text`, `inbound.ses_bounce_retired`, `retention.message_days`, `triage.categories`, `triage.rules`, `search.refs_packs`, `search.custom_refs`, `webhook_text_bytes`, `domain_fallback` | May set any valid value |

- **Ceiling.** A lower-only field's ceiling is the more restrictive of the deployment default (the
  built-in defaults above merged with `PM_DEFAULT_POLICY`) and the tenant's platform ceiling, the value a
  platform key last set on that field, at creation or by `PATCH` (kept in `tenants.policy_ceilings_json`):
  min(deployment default, platform ceiling). A platform key's `null` for the field removes its platform
  ceiling. A higher number is always the looser value, the `abuse` thresholds included (a higher rate
  makes auto-pause more lenient), and so are longer retention, more steps or seconds, and more automatic
  exchanges.
- **Switches.** For `auto_reply.allowed`, `inbound.extract_image_text`, `triage.enabled` and
  `search.agentic_enabled`, `true` is the looser value (it sends more mail or spends Workers AI). A
  partner key may always set `false`, and `true` only when the deployment default and the platform
  ceiling (if any) are both `true`.
- **`null` from a partner key** on a lower-only field resets it to the deployment default, so it is
  compared as that value: refused when a platform ceiling is lower.
- Ceilings are checked when a value is written. Changing `PM_DEFAULT_POLICY` later does not rewrite
  stored values; a platform key that wants a tenant lower sets the field.
- **An identity's `send_policy.daily_cap`** (`POST …/identities`, `PATCH /v1/identities/{identity_id}`)
  may not exceed the tenant's effective `identity_daily_send_cap` for any key but a platform key
  (`403 scope_denied`, `details.field = "send_policy.daily_cap"`), so a lower-only cap cannot be raised
  one identity at a time.
- **`quarantine.on_auth_fail: false`** is free, but it removes a guarantee: mail whose authentication
  verdict is `fail` or `unverified` is then stored as `received` and evented to agents with that verdict,
  instead of being quarantined (rules 3 and 3a of
  [Inbound › Quarantine decision](../project/design/inbound.md#quarantine-decision)). A partner that turns
  it off accepts that its agents must check `verdict` themselves.

## CLI configuration

```toml
# ~/.config/pylota-mail/config.toml
[profiles.default]                 # the profile pmail setup and pmail login write unless --profile names another
url = "https://mail.example.com"
key = "pmk_live_…"                 # or key_command = "op read op://vault/pylota-mail/key"
identity = "bookings.acme@agents.example"   # default for mail commands
account_id = "0123456789abcdef0123456789abcdef"   # Cloudflare account ID, stored by pmail setup

[profiles.staging]
url = "https://mail-staging.example.com"
key_env = "PYLOTA_MAIL_STAGING_KEY"
```

Precedence, highest first: command-line flags (`--url`, `--key`, `--profile`, `--account-id`), then the
environment (`PYLOTA_MAIL_URL`, `PYLOTA_MAIL_KEY`, `PYLOTA_MAIL_PROFILE`, `CLOUDFLARE_ACCOUNT_ID`), then
the profile in the file. Without `--profile` or `PYLOTA_MAIL_PROFILE`, the profile is `default_profile`
when the file sets it, else the one named `default`. `pmail setup` and `pmail login` write the profile
named by `--profile`, default `default`; `PYLOTA_MAIL_PROFILE` and `default_profile` do not change it.
The file is created with mode `0600`, and `pmail` refuses to read it (exit 3) if its group or other users
have any access to it, or if another user owns it.

The commands that use `CLOUDFLARE_API_TOKEN` are listed in
[CLI › Commands that use your Cloudflare token](cli.md#commands-that-use-your-cloudflare-token). The
token is never stored. The account ID comes from `--account-id` (a global flag), else
`CLOUDFLARE_ACCOUNT_ID`, else the profile's `account_id` (written by `pmail setup`; not a secret), else
`PM_CF_ACCOUNT_ID` in `deploy/wrangler.toml`.
