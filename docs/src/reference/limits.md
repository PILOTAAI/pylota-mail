# Limits

Some limits come from Cloudflare, some from Amazon SES (only for domains that use it) and some from
Pylota Mail. Cloudflare's and Amazon's were read from their documentation on 2026-10-09 and can change.
`pmail doctor` reports the ones it can observe.

## Mail

| Limit | Value | Source | What happens |
|---|---|---|---|
| Inbound message size | 25 MiB through Email Routing; 40 MB, including headers, through Amazon SES (domains with `inbound = ses`) | Cloudflare Email Routing; [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09 | Never reaches the Worker: Cloudflare rejects it, and SES stores at most 40 MB in S3 |
| Outbound message size, encoded, including attachments | 5 MiB | Cloudflare Email Sending | `413 message_too_large`, or a signed link if `large_attachments: link` |
| Recipients per message (`to` + `cc` + `bcc`) | 49, default policy 10. Cloudflare allows 50; one is kept for the hidden journal copy of Message-ID strategy B | Cloudflare / Pylota Mail / policy | `400 too_many_recipients` |
| Subject length | 998 characters | RFC 5322 / Cloudflare | `400 invalid_request` |
| Custom headers on a send | 16 KB total; at most 20 non-`X-` headers, service-set ones included; values ≤ 2,048 bytes. Names, matched case-insensitively: `X-` names matching `^X-[A-Za-z0-9_-]+$` (≤ 100 bytes), or `Importance`, `Priority`, `Sensitivity`, `Keywords`, `Comments`, `Organization` (sent in that casing). Values of `Importance`: `high`, `normal`, `low`; `Priority`: `normal`, `non-urgent`, `urgent`; `Sensitivity`: `personal`, `private`, `company-confidential` | Cloudflare (Email headers reference, read 2026-10-10) | Checked when the request arrives: `400 header_not_allowed` for a name, `400 invalid_request` for a value |
| Attachments per send | 32 (REST); 10 per call in the MCP tool `mail_send` | Pylota Mail | `400 invalid_request` |
| Inbound MIME nesting depth | 32 | Pylota Mail | Deeper parts are kept raw; flag `parse_degraded` |
| Inbound MIME parts | 500 | Pylota Mail | Further parts are kept raw; flag `parse_degraded` |
| Attachment text extracted | 20 MB input, 200 pages, 2 MB text | Pylota Mail | `text_status: unavailable` beyond it |
| Archive expansion checked | ratio ≤ 100:1, ≤ 100 MB | Pylota Mail | Larger means `risk: archive_bomb`, quarantined |
| Local part length | 64 characters, including the thread token | RFC 5321 | Username plus suffix at most 40 |
| References kept on our replies | 20: the first plus the 19 most recent | Pylota Mail | The ones between are trimmed ([C2](../project/edge-cases.md)) |
| Daily sending | Account quota, set and raised by Cloudflare. It is not exposed to the Worker | Cloudflare | Queue backs off for up to 24 hours. An alert fires at 80% of `PM_DAILY_SEND_QUOTA` when you set it to your quota, otherwise on the first quota error ([G3](../project/edge-cases.md)) |

## Domains and addresses

| Limit | Value | Source |
|---|---|---|
| Mail domains per zone (routing + sending, including apex) | 30 | Cloudflare |
| Literal routing rules per domain (subdomain mail domains) | 200 | Cloudflare. So at most 200 addresses per subdomain mail domain. Apex domains use catch-all and have no limit |
| Literal routing rule matcher | 90 characters | Cloudflare (Email Routing rules API, read 2026-10-09). An address on a subdomain mail domain longer than 90 characters is refused with `400 address_invalid` |
| Catch-all | apex domains only | Cloudflare. This is why the platform domain must be a zone apex |
| Addresses per identity (all states) | 20 | Pylota Mail |
| Pending addresses per identity per domain | 1 | Pylota Mail |
| Address retirement grace | 0–365 days, default 90 | Pylota Mail |
| Forwarding test (`inbound: forward`) | The token must arrive within 10 minutes, otherwise `forwarding` is `failed` | Pylota Mail |

## Amazon SES

Applies to domains connected with `dns_records`, `send_only`, or `smtp_relay` with `inbound: ses`
([Domains on any DNS host](../project/design/domain-connections.md)). SES quotas are per AWS region.

| Limit | Value | Source | What happens |
|---|---|---|---|
| Inbound message size | 40 MB, including headers | [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09 | Larger messages are not stored in S3 and never reach the Worker |
| Verified identities per region | 10,000 (raised only through the AWS account manager) | [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09 | At 9,000 the operator alert `ses_identities_90pct` fires and `pmail doctor` warns. At 10,000, adding a domain that needs an SES identity gets `422 transport_unavailable` with `details.reason = "ses_identity_limit"`. The count is the `domains` rows with `ses_region` set and not `removed`, plus the platform identity |
| Rules per receipt rule set | 200, not adjustable | [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09 | Pylota Mail uses at most 150 `pm-retired-{n}` rules |
| Recipients per receipt rule | 500, not adjustable | [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09 | When a `pm-retired-{n}` rule is full, the domain monitor opens the next one |
| Retired addresses bounced per deployment | 75,000 (150 rules × 500) | Pylota Mail | Beyond it the oldest retired addresses leave the rules, and their mail is dropped without a bounce, like mail to an unknown address |
| SES API requests other than sends | 1 per second per account and region; not adjustable | [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html) (SES API sending quotas), read 2026-10-09 | One deployment-wide token bucket (the `SesControl` Durable Object) admits one control-plane call per second. Domain create, `PATCH` and removal wait up to 5 s, then get `429 upstream_rate_limited` with `Retry-After`; background checks wait up to 60 s, then retry later. Each SES domain's daily identity check runs at a fixed time of day derived from a hash of its ID, so checks spread across the day ([Domains on any DNS host §4.8](../project/design/domain-connections.md#48-ses-api-rate-one-request-per-second)) |
| Sending from the SES sandbox | 200 messages per 24 hours, 1 per second, to verified addresses only | [SES quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09 | `pmail setup ses` stops until production access is enabled |
| Raw message in S3, and notifications in the SQS backstop | 14 days | Pylota Mail (`pmail setup ses`) | An object deleted before ingestion is lost: its `queued` ledger row becomes `lost` and the `ses_object_lost` alert pages |

## SMTP relay

Applies to domains connected with `smtp_relay`.

| Limit | Value | Source |
|---|---|---|
| Ports | 465 (TLS from the start) and 587 (STARTTLS) only. Any other port, 25 included: `400 smtp_port_not_allowed`. A relay that offers no TLS: `422 smtp_tls_required`, and the credentials are not sent | Cloudflare: "Workers cannot create outbound connections on port `25`" ([TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), read 2026-10-09); Pylota Mail |
| SMTP sends in parallel | 4 per outbound consumer invocation | Cloudflare allows each invocation up to six connections waiting at once, and opening a socket counts ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), read 2026-10-09) |
| Connections per message | 1, without pipelining | Pylota Mail |
| Timeouts | 10 s to connect, 30 s per command, 60 s for the reply after the final dot | Pylota Mail. No reply after the final dot makes the send `uncertain`; it is never resent |
| Alignment probe | Before the first send and every day. On demand at most once a minute per domain (`429 rate_limited`). No probe back within 15 minutes is `smtp_probe_timeout` | Pylota Mail |

## API

| Limit | Value |
|---|---|
| Request body | 7 MiB (a 5 MiB message after base64 decoding, plus JSON) |
| Requests per API key | 600 per minute |
| Search per key | 120 per minute |
| Agentic search per key | 20 per minute. Tenant daily cap 500 by default |
| Sends per identity | 120 per minute. Daily caps from policy |
| Signing per identity (`RL_SIGN`): agent assertions and signed HTTP requests together | 600 per minute. Not counted against any plan allowance |
| Rate-limit headers | Every authenticated response carries `RateLimit-Limit` (the bucket's limit per period). A `429` also carries `Retry-After` and `RateLimit-Reset`, the seconds to the end of the bucket's current period (for `rate_limited` the two are equal; other `429` codes set `Retry-After` to their own wait). No `RateLimit-Remaining`: the rate-limiting binding answers only allow or deny |
| Page size | 25 by default, 100 maximum |
| Search `limit` | 10 by default, 50 maximum |
| Search response size | 256 KB. Above it, results are cut and `truncated: true` |
| Tenant search fan-out | 100 identities |
| `wait` timeout | 60 seconds |
| Idempotency key retention | 30 days |
| Cursor lifetime | 24 hours |
| Metadata on identities and messages | 16 keys, 512 bytes per value |
| Labels | 64 per message, 64 characters each |

## Agent signing keys

From [Agent signing keys and signed requests](../project/design/agent-keys.md). Every value outside its
range gets `400 invalid_request`.

| Limit | Value |
|---|---|
| Active signing keys per identity | 1, plus `retiring` keys during an overlap |
| Overlap after an identity key rotation | `PM_IDENTITY_KEY_OVERLAP_DAYS`, default 7 days |
| Identity JWKS cache | `Cache-Control: public, max-age=300`: verifiers should cache it for at most 5 minutes |
| Assertion `audience` | 1–256 printable ASCII characters, required |
| Assertion `expires_in` | 60–600 seconds, default 300 |
| Assertion `nonce` | 1–128 printable ASCII characters |
| Assertion `ext` | 2 KB as JSON; it cannot set a registered or Pylota claim |
| HTTP signature `url` | `https` only, 2,048 characters |
| HTTP signature `expires_in` | 30–300 seconds, default 60 |
| HTTP signature components | Always `@authority`, `signature-agent` and `from`; optionally `@method`, `@path` and `@query`. ASCII values only |
| Web Bot Auth key directory | At most 3 keys (one active, two retiring); a rotated deployment key stays listed for 7 days. `Cache-Control: max-age=86400` |

## Notifications

From [Notifications and usage alerts](../project/design/notifications.md).

| Limit | Value |
|---|---|
| Notification email per person | 50 a day (in the workspace's time zone), all kinds except `account` and `digest`; further items go into one `digest` email at the next 09:00 |
| Notification email per workspace | 200 a day, all kinds except `account` and `digest` |
| `new_mail`, `instant` | A 2-minute hold after the first message, then at most one email per person and inbox every 10 minutes |
| `new_mail`, `hourly` and `daily` | One email at the top of each hour that had messages; one at 09:00 local time |
| `needs_reply` filter | Waits up to 5 minutes for triage |
| "Needs a person" email | Daily at 09:00 in the workspace's time zone |
| Usage alerts | 80% and 100% of each allowance; once per threshold per period for `sends` and `triage`; a 24-hour cooldown per feature and threshold for counts. None with `PM_BILLING=off` |
| Unsubscribe link | 90 days, or until its `link` key leaves its 7-day window after a rotation |
| Retries while the platform domain is failing, or while the system identity's submit is refused | Hourly, for 24 hours |

## Storage

| Limit | Value | Source |
|---|---|---|
| Durable Object SQLite per identity | 10 GB | Cloudflare. Alert at 70%. Raw MIME and attachments live in R2, so this is mostly text and index |
| D1 database | 10 GB | Cloudflare. Control plane only. Event and delivery logs are pruned after the tenant's `retention.events_days` (default 30) |
| Vectorize vectors per index | 20,000,000 | Cloudflare. About 4,000–10,000 vectors per 1,000 messages |
| Vectorize namespaces per index | 50,000 | Cloudflare. One per tenant, so at most 50,000 tenants per index |
| Queue message | 128 KB | Cloudflare. Queues carry pointers only |
| Queue delay per retry | 24 hours | Cloudflare |
| Queue retention | 14 days | Cloudflare. Dead-letter items are kept at most 14 days |

## Plans

On a deployment with billing on (Pylota Mail Cloud), the plan sets allowances for inboxes, sends, triage
analyses, custom domains, storage and seats. The table and the rules (holds, `402 billing_limit`, top-ups,
resets) are in [Plans and billing](../guides/plans.md). Read your workspace's live numbers with
`GET /v1/usage`. Self-hosted deployments have no plan limits; only the daily caps in tenant policy apply
(see [API](#api)).

## Console

| Limit | Value |
|---|---|
| Sign-in link or code requests | 3 per 10 minutes per address |
| Code verification attempts | 10 per code; the token is burned after 10 failures |
| Sign-in requests per client IP (`RL_SIGNIN`) | 10 per minute, keyed by `CF-Connecting-IP`, across sign-in, sign-up and waitlist requests |
| Link and code lifetime | 10 minutes, single use |
| Two-step verification codes | 5 attempts a minute per person. 10 failures in a row lock two-step sign-in for 15 minutes |
| Recovery codes | 10 per person, each single use. Generating new ones invalidates the old |
| Google or GitHub sign-in | 10 minutes from start to callback, single use |
| Waitlist | An entry is written only when its confirmation link is used; an unused confirmation link expires after 10 minutes. An invite link (`/console/sign-up?invite=…`) is valid for 7 days, for the waitlisted address only. Entries are deleted 30 days after invitation |
| New workspace on Free (Pylota Mail Cloud) | At most 50 messages a day (the effective `tenant_daily_send_cap` is the policy value or 50, whichever is lower) for the first 7 days. A daily evaluation lifts the ramp from day 7 if bounce and complaint rates are under the auto-pause thresholds; otherwise it stays and is evaluated again each day. A paid plan lifts it at once. Above it: `429 daily_cap_reached` |
| Session lifetime | 7 days rolling, 30 days absolute |
| Re-authentication for sensitive actions | signed in within the last 10 minutes |
| Invitation lifetime | 7 days |

## Webhooks

| Limit | Value |
|---|---|
| Endpoints per tenant | 20 |
| Endpoints per partner | 20 |
| Platform endpoints | 20 |
| Timeout per attempt | 15 seconds |
| Retry window | About 72 hours, 13 attempts |
| Replay window | 30 days from the event's `occurred_at` (never from when the delivery went dead), or the tenant's `retention.events_days` if that is shorter |
| Response body read | 4 KB |
