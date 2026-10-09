# Domains on any DNS host

| | |
|---|---|
| Requirements | FR-DOM-7 to FR-DOM-12 ([PRD](../prd.md)), and U4 (never send unauthenticated mail) |
| Edge cases | [N1–N30](../edge-cases.md) |
| Decision | [ADR 0008](../adr/0008-domains-on-any-dns-host.md) |
| Code | `crates/core/src/{connect.rs, smtp.rs, sns.rs, ses.rs}`, `crates/worker/src/handlers/{domains.rs, hooks_ses.rs}`, `transport/{ses.rs, smtp.rs}`, `inbound/sources/{routing.rs, ses.rs}`, `consumers/inbound.rs`, `crons/ses_backstop.rs`, `domains/monitor.rs` |

## 1. The problem

Cloudflare Email Routing and Email Sending need the domain to be on Cloudflare DNS: "You must be using
Cloudflare DNS to use Email Service" ([send](https://developers.cloudflare.com/email-service/get-started/send-emails/),
read 2026-10-09). Most operators keep their DNS at a registrar or with Google, Microsoft, Route 53 or a
web host, and many already run mail on their main domain. Asking them to move nameservers loses most of them.

This page adds four ways to connect a domain whose DNS stays where it is. It keeps the two Cloudflare ways
that already existed.

## 2. Inbound source and outbound transport are separate choices

A connected domain has three stored properties:

| Property | Values | Meaning |
|---|---|---|
| `kind` | `platform`, `zone`, `delegated`, `external` | Where its DNS lives relative to this deployment |
| `inbound` | `routing`, `ses`, `forward`, `none` | How mail to its addresses reaches identities |
| `transport` | `cloudflare`, `ses`, `smtp` | How mail from its addresses is sent |

Users do not combine these by hand. They choose a **connection method** when they add the domain, and the
method fixes the three properties:

| `method` | Customer changes at their DNS host | `kind` | `inbound` | `transport` | Addresses on the domain | Deployment needs |
|---|---|---|---|---|---|---|
| `cloudflare_zone` | Nothing (the Worker writes the records) | `zone` | `routing` | `cloudflare` | Any (apex); at most 200 (subdomain) | `PM_CF_API_TOKEN` |
| `nameservers` | Two NS records at the registrar, for a domain used only for mail | `zone` | `routing` | `cloudflare` | Any | `PM_CF_API_TOKEN` that can create zones; tenant policy `domains.allow_create_zone` |
| `dns_records` | One MX, three DKIM CNAMEs, a MAIL FROM MX and TXT, the ownership TXT | `external` | `ses` | `ses` | Any, on an apex or a subdomain | SES with receiving ([4.3](#43-dns_records)) |
| `send_only` | Three DKIM CNAMEs, a MAIL FROM MX and TXT, the ownership TXT. Their existing mailbox forwards to the agent | `external` | `forward` | `ses` | Any; each needs a forwarding rule in their mailbox | SES (sending only) |
| `smtp_relay` | The ownership TXT, plus what their own mail provider already needs | `external` | `forward` or `ses` | `smtp` | Any | Relay credentials, and a passing alignment probe |
| `delegated_subdomain` | NS records for one subdomain, for example `agents.brightwell.example` | `delegated` | `routing` | `cloudflare` | Any | Cloudflare Enterprise, `PM_CF_SUBDOMAIN_SETUP=on`, spike S10 passed |

The platform domain is always `platform` / `routing` / `cloudflare` on a zone apex in this account
(FR-DOM-1). Fallback sends (FR-DOM-6) always use it, whatever the failing domain's method.

Thread tokens in `Reply-To` sub-addresses (`reply_token = 'subaddress'`) are used when `inbound` is
`routing` or `ses`; for `ses` this depends on spike S11 showing that `user+tag@` reaches the Worker. With
`inbound: forward` the customer's forwarding rule matches only the bare address, so `reply_token` is
`none` and replies thread by headers ([Identities › Kinds](identity-domains.md#kinds)).

### Which method to choose

This table is in the [Custom domains guide](../../guides/custom-domains.md) in the user's words:

| The customer wants | Method |
|---|---|
| A domain already on Cloudflare in this account | `cloudflare_zone` |
| A new domain just for agents, such as `brightwell-agents.example` | `nameservers` (no AWS, every address works) |
| Agents on a subdomain of their main domain, which stays at their DNS host and keeps its mail | `dns_records` on `agents.brightwell.example` |
| Agents that answer as their existing addresses (`bookings@brightwell.example`) while Google Workspace or Microsoft 365 stays their mail system | `send_only`, with forwarding rules, or `smtp_relay` through their provider |
| A Cloudflare Enterprise deployment that wants the simplest subdomain set-up | `delegated_subdomain` |

## 3. Methods that move DNS to Cloudflare

### 3.1 `cloudflare_zone`

Unchanged: [Identities, addresses and domains › Kind `zone`](identity-domains.md#kind-zone).

### 3.2 `nameservers`

This is `create_zone` from [Creating a zone](identity-domains.md#creating-a-zone), opened to tenants and
made safe for domains that are not empty.

1. **Who may use it.** Platform keys always. Tenant keys only when the tenant's policy has
   `domains.allow_create_zone: true`; otherwise `422 transport_unavailable` with
   `details.reason = "zone_creation_not_allowed"`. The default is `false` for self-hosted deployments, and
   Pylota Mail Cloud sets it to `true`.
2. **Dedicated-domain check ([N21](../edge-cases.md)).** Moving nameservers hands the whole domain to this
   deployment, which only manages mail records. Before creating the zone, the Worker queries both DoH
   resolvers for `A`, `AAAA` and `MX` at the name and for `CNAME`, `A` and `AAAA` at `www.{name}`. If any exist and the
   request lacks `"confirm_dedicated": true`, it refuses with `409 domain_not_dedicated`. `details.records`
   lists what it found, and the fix says the website or mail on that domain would stop.
3. **Create the zone:** `POST /zones` with `"type": "full"`. A `1105` error ("too many attempts to add a
   domain") becomes `429 upstream_rate_limited` with `Retry-After` and `details.retry_after` of 10800
   seconds (3 hours)
   ([cannot add domain](https://developers.cloudflare.com/dns/zone-setups/troubleshooting/cannot-add-domain/),
   read 2026-10-09) ([N22](../edge-cases.md)).
4. **NS records.** The returned `name_servers` are the only records the customer sets: at their
   registrar, not at a DNS host. The domain is `pending`, with reminders at 24 hours, 72 hours and 7 days.
5. **Expiry ([N23](../edge-cases.md)).** A Free-plan zone that is not activated within 28 days is deleted
   by Cloudflare ([domain status](https://developers.cloudflare.com/dns/zone-setups/reference/domain-status/),
   read 2026-10-09). At day 21 the monitor sends a final `domain.reminder`. If the zone disappears, the
   domain moves to `removed` with `state_reason = zone_expired`, and `domain.removed` carries
   `reason: "zone_expired"` (a removal the user asked for carries `"requested"`). The user can add it again.
6. Once the zone is active, onboarding continues as `cloudflare_zone` at an apex (catch-all).
   `confirm_dedicated: true` also stands for `replace_mx: true` there, because the user has already
   accepted that existing mail on the domain stops.
7. **Record quota.** Free zones created after 2024-09-01 hold at most 200 DNS records
   ([DNS records](https://developers.cloudflare.com/dns/manage-dns-records/), read 2026-10-09). Mail
   onboarding uses about 8, so this is not a constraint for a dedicated mail domain.

The number of zones a non-Enterprise account may hold is not documented. `pmail doctor` reports the
account's zone count, and the operator runbook says to contact Cloudflare above 1,000.

### 3.3 `delegated_subdomain`

Off unless `PM_CF_SUBDOMAIN_SETUP=on`; otherwise `422 transport_unavailable` with
`details.reason = "subdomain_setup_disabled"`. It needs an Enterprise account: "Subdomain setup is only available
for Enterprise accounts" ([subdomain setup](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/setup/),
read 2026-10-09). The parent domain may stay at any DNS provider. **Spike S10** must show that Email
Routing catch-all and Email Sending work on a child zone; no Cloudflare page says so either way.

1. `POST /zones` with `"type": "full"` and the subdomain as the name, for example
   `agents.brightwell.example`. The child zone may live in a different account from the parent
   ([parent on full](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/setup/parent-on-full/),
   read 2026-10-09).
2. The records shown are the zone's `name_servers` as `NS` records for the subdomain, which the customer
   adds at their DNS host. No TXT is needed for a full child zone.
3. A zone hold on the customer's own Cloudflare account may block creation. Whether a hold reaches other
   accounts is unclear in Cloudflare's docs. Such an error becomes `409 zone_hold`, with a fix asking the
   customer to release the hold for subdomains ([N24](../edge-cases.md)).
4. Once active, onboarding continues as `cloudflare_zone` at an apex: the subdomain is the child zone's
   apex, so catch-all is allowed.
5. Health adds a weekly check that the parent still delegates the subdomain to the assigned name servers.
   A change is `nameservers_changed`, which suspends the domain ([N25](../edge-cases.md)).

## 4. Methods that keep DNS where it is

### 4.1 What each method asks the customer to publish

All records are returned by the API with both `name` (fully qualified) and `host` (relative to the
registrable domain from the Public Suffix List), because DNS hosts differ in which one they want
([N17](../edge-cases.md)).

| Record | `dns_records` | `send_only` | `smtp_relay` | Value comes from |
|---|---|---|---|---|
| TXT `_pylota-mail.{domain}` = `pm-verify={token}` | yes | yes | yes | Generated |
| MX `{domain}` 10 `inbound-smtp.{region}.amazonaws.com` | yes | – | when `inbound: ses` | AWS's published receiving endpoint for `PM_SES_REGION` |
| Three CNAMEs `{token}._domainkey.{domain}` → `{token}.{SigningHostedZone}` | yes | yes | when `inbound: ses` | SES `CreateEmailIdentity` response |
| MX `pm-bounce.{domain}` 10 `feedback-smtp.{region}.amazonses.com` | yes | yes | – | AWS's published feedback endpoint |
| TXT `pm-bounce.{domain}` = `v=spf1 include:amazonses.com ~all` | yes | yes | – | SES custom MAIL FROM guide |
| TXT `_dmarc.{domain}` = `v=DMARC1; p=quarantine` (only when no DMARC record exists at the domain or its organisational domain) | suggested | suggested | suggested | Generated |

The SES DKIM targets are built from the returned `SigningHostedZone`, never a hard-coded
`dkim.amazonses.com`, because the zone differs by region
([creating identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html), read 2026-10-09).
Each record carries `purpose` (`ownership`, `mx`, `dkim`, `return_path`, `spf`, `dmarc`) and `required`.

### 4.2 Deployment set-up for SES

`pmail setup ses --region eu-west-2` does this once, with the operator's local AWS credentials. It is
idempotent and reads before it writes. `{prefix}` below is the `--prefix` flag, by default
`pylota-mail-{AWS account ID}`, because S3 bucket names are global.

| Step | Resource | Settings |
|---|---|---|
| 1 | Region check | `PM_SES_REGION` must be one of the 22 regions that receive mail ([endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html#ses_inbound_endpoints), read 2026-10-09). With `PM_JURISDICTION=eu` it must be in the EU or the UK (`eu-central-1`, `eu-west-1`, `eu-west-2` (London), `eu-south-1`, `eu-west-3`, `eu-north-1`) unless `--allow-non-eu`. For this check `eu` means "EU or UK", because the UK has an EU adequacy decision under the GDPR (European Commission [adequacy decisions](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en), renewed 19 December 2025, read 2026-10-09). It is not Cloudflare's `eu` jurisdiction, which means the EU only ([R2 data location](https://developers.cloudflare.com/r2/reference/data-location/), read 2026-10-09) |
| 2 | Account checks | `GetAccount`: production access enabled (sandbox sends only to verified addresses, 200 a day). Setup prints the console steps to request it and stops if it is missing. It also warns when the account is on the Essentials plan ($0.16 per 1,000) and not à la carte ($0.10) ([pricing](https://aws.amazon.com/ses/pricing/), read 2026-10-09) |
| 3 | S3 bucket `{prefix}-inbound` | Same region; block all public access; SSE-S3; lifecycle rule deleting `in/` after 14 days; bucket policy letting `ses.amazonaws.com` `s3:PutObject` on `in/*` only with `aws:SourceAccount` = the account and `aws:SourceArn` = the receipt rule |
| 4 | SNS topic `pylota-mail-inbound` | `SignatureVersion = 2` (SHA-256). The default is 1 ([SetTopicAttributes](https://docs.aws.amazon.com/sns/latest/api/API_SetTopicAttributes.html), read 2026-10-09) |
| 5 | HTTPS subscription | `https://{PM_API_HOST}/hooks/ses/inbound`, confirmed automatically by the Worker. Setup creates it only after it has deployed the Worker with the new topic ARNs, because the Worker confirms only its configured topic |
| 6 | SQS queue `pylota-mail-inbound` | Subscribed to the same topic, message retention 14 days, SSE on. This is the backstop ([4.5](#45-inbound-through-ses)) |
| 7 | Receipt rule set | The active rule set `PM_SES_RULE_SET` (default `pylota-mail`). If the account already has an active rule set, setup adds its rules to that set and never deactivates it. A region has one active rule set |
| 8 | Rule `pm-deliver` | No recipient condition, so it applies to every verified identity ([concepts](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html), read 2026-10-09). `ScanEnabled: true`, `TlsPolicy: Optional`, one S3 action (bucket, prefix `in/`, the topic) |
| 9 | Platform identity | Verifies the platform domain in SES through its Cloudflare zone, so `mailer-daemon@{platform domain}` can send the bounces in [4.6](#46-retired-and-unknown-recipients) |
| 10 | Configuration set and events | As in [Outbound › Amazon SES](outbound.md#amazon-ses). Its SNS topic (`PM_SES_SNS_TOPIC_ARN`, for `/hooks/ses`) also gets `SignatureVersion = 2` |
| 11 | IAM user `pylota-mail-worker` | One policy listing exactly: `ses:SendRawEmail`/`SendEmail`, `ses:CreateEmailIdentity`, `ses:GetEmailIdentity`, `ses:DeleteEmailIdentity`, `ses:PutEmailIdentityMailFromAttributes`, `ses:GetAccount`, receipt-rule read and update on the one rule set, `s3:GetObject` and `s3:DeleteObject` on `{bucket}/in/*`, `sqs:ReceiveMessage` and `sqs:DeleteMessage` on the queue. The access key goes into Worker secrets and is never written to disk |

The printed summary includes the policy JSON so an operator can review it before it is applied.

**One deployment per AWS account and region.** A region has one active rule set, and `pm-deliver` has no
recipient condition, so it matches every verified identity in the region. Two deployments in the same
account and region (for example staging and production) would receive each other's mail and share the
10,000-identity quota. Give each deployment its own AWS account, or its own region.

### 4.3 `dns_records`

`POST /v1/tenants/{tenant_id}/domains` with `{ "name": "agents.brightwell.example", "method": "dns_records" }`.
It needs SES with receiving configured (`PM_SES_INBOUND_TOPIC_ARN` set); without it the request fails with
`422 transport_unavailable` and `details.reason = "ses_receiving_not_configured"`.

1. **Common checks**, as in [Adding a domain](identity-domains.md#adding-a-domain). The platform domain
   and names under it are refused (`400 invalid_request`).
2. **Existing mail ([H5](../edge-cases.md)).** MX at the name on both resolvers. If MX records exist and
   none is the SES inbound host, the request must carry `"replace_mx": true`; otherwise
   `409 existing_mx`. The Worker cannot change the customer's DNS, so here `replace_mx` means "I will
   replace these". Until the old MX records are gone, health reports `mx_unexpected` (degraded), because
   mail is split between two systems ([N9](../edge-cases.md)).
3. **Ownership TXT** generated.
4. **SES identity.** `CreateEmailIdentity` with the domain and `ConfigurationSetName`.
   `AlreadyExistsException` → `GetEmailIdentity` (same account: re-use). The three DKIM tokens and
   `SigningHostedZone` give the CNAMEs. SES allows 10,000 verified identities per region, raised only
   through the AWS account manager ([quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read
   2026-10-09). The count is the number of `domains` rows with `ses_region` set and not `removed`, plus
   the platform identity. At 9,000 (90%) the operator alert `ses_identities_90pct` fires
   ([Observability](observability.md)) and `pmail doctor` warns. At 10,000, creating a domain that needs
   an SES identity (`dns_records`, `send_only`, or `smtp_relay` with `inbound: ses`) fails with
   `422 transport_unavailable` and `details.reason = "ses_identity_limit"` ([N26](../edge-cases.md)).
   There is no webhook event for this count.
5. **Custom MAIL FROM.** `PutEmailIdentityMailFromAttributes` with `MailFromDomain = pm-bounce.{domain}`
   and `BehaviorOnMxFailure = USE_DEFAULT_VALUE`. The MAIL FROM domain must not be a subdomain that sends
   or receives mail ([MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html), read
   2026-10-09). The local-part prefix `pm-bounce` is therefore reserved on every `external` domain.
   **SPF preflight ([H2](../edge-cases.md)).** Before the call, resolve TXT at `pm-bounce.{domain}` on both
   resolvers. No `v=spf1` record there is the normal case. When one exists and differs from the record in
   [4.1](#41-what-each-method-asks-the-customer-to-publish), count the lookups of that record merged with
   `include:amazonses.com` ([SPF lookup count](identity-domains.md#spf-lookup-count)). More than 10, or
   more than 2 void lookups: refuse with `400 spf_lookup_limit`, `details.lookups`, and a fix saying to
   replace the record at `pm-bounce.{domain}` with the expected one. Nothing has been created in SES yet.
6. **Records** as in [4.1](#41-what-each-method-asks-the-customer-to-publish), stored in `records_json`.
7. Insert the row with `kind = 'external'`, `inbound = 'ses'`, `transport = 'ses'`,
   `routing_mode = 'catch_all'`, `mail_from_domain`, `ses_region`, then start the monitor. Addresses on the
   domain become `active` when it first reaches `healthy` or `degraded`.

### 4.4 `send_only`

This is the existing `external` kind ([Kind `external`](identity-domains.md#kind-external)), now also
with a custom MAIL FROM (steps 4–5 above). Inbound arrives at each identity's platform address through a
forwarding rule in the customer's own mail system. It needs the SES transport (`PM_SES_*`); without it the
request fails with `422 transport_unavailable` and `details.reason = "ses_not_configured"`.

- **Forwarding state ([N12](../edge-cases.md)).** Each address on a domain with `inbound: forward`
  (`send_only`, or `smtp_relay` with `inbound: forward`) has `forwarding`: `unverified` until a
  forwarding test or any real message has arrived through forwarding, then `ok`; `failed` after a test
  whose token did not arrive. `forwarding_checked_at` records the last change. On other domains
  `forwarding` is `null`. There is no webhook event for it.
- **Forwarding test.** `POST /v1/identities/{identity_id}/addresses/{address_id}/test-forwarding`
  (`identities:write`) answers `202` and sends a short message, from `mailer-daemon@{platform domain}`
  with subject "Pylota Mail forwarding check" and a one-time token in the header `X-Pylota-Mail-Check`
  (format in [Inbound › Steps](inbound.md#steps), step 3), to the external address. `forwarding`
  becomes `ok` when the token arrives at the identity's platform address within 10 minutes, and `failed`
  otherwise. The token is kept in the domain's `DomainMonitor` storage until it arrives or expires; it is
  not a D1 column. The test message is never stored as a message and does not count towards plan sends.
  On a domain without `inbound: forward` the request fails with `422 transport_unavailable` and
  `details.reason = "method_not_supported"`.
- **Authentication of forwarded mail.** Forwarding breaks SPF for the original sender. Trust is decided by
  DKIM and ARC as for any forwarded message ([Inbound](inbound.md)). A forwarder that rewrites the body
  breaks DKIM, so such messages are marked `unauthenticated` and quarantined by default. The guide names
  this as the main drawback of `send_only`.
- **Loops ([N13](../edge-cases.md)).** An agent writing to its own external address, which forwards back
  to the platform address, is caught by loop detection: our outbound mail carries `X-Pylota-Mail-Hop`,
  which forwarding keeps, and automatic exchanges per thread are capped ([D6](../edge-cases.md)).

### 4.5 Inbound through SES

```text
sender ──SMTP──▶ inbound-smtp.{region}.amazonaws.com
                   │ receipt rules, in order:
                   │   pm-retired-{n}   (retired addresses)  → Bounce 550 5.1.6, Stop
                   │   pm-deliver       (everything else)    → S3 in/{messageId} + SNS notification
                   ▼
             SNS topic (signed, version 2) ──HTTPS──▶ POST /hooks/ses/inbound      fast path, seconds
                   │
                   └──▶ SQS queue (14 days) ◀── cron every minute: ReceiveMessage   backstop
                                   │
          both paths ─▶ verify SNS ─▶ ses_ingest ledger (exactly once per object and recipient)
                                   │
                                   ▼
                     pm-inbound  InboundPointer { source: Ses { bucket, key, verdicts }, rcpt, mail_from }
                                   │  consumer: S3 GetObject (SigV4) → R2 inbound-staging/ → same pipeline
                                   ▼        as the email() handler, from "parse" onwards
                        delete the S3 object once no recipient of it is queued or held
```

**Why two paths.** SNS push makes mail visible within seconds. SNS retries an HTTPS endpoint for a limited
time, so a Worker outage could lose a notification. The SQS subscription receives every notification as
well and keeps it for 14 days. The every-minute cron (`crons/ses_backstop.rs`) drains it with
`ReceiveMessage` (10 per call, until empty or 25 seconds) and passes each one to the same handler. The
ledger makes the second arrival a no-op. The S3 object stays until no recipient of it is still waiting,
so the backstop can always fetch it.

**The handler** (`handlers/hooks_ses.rs`, shared by both paths):

1. Verify the SNS message ([Security › SNS](security.md)): `SignatureVersion` must be `2`, as setup sets
   it; version 1 (SHA-1) is refused. `SigningCertURL` must be `https` on host `sns.{PM_SES_REGION}.amazonaws.com`.
   `TopicArn` must equal `PM_SES_INBOUND_TOPIC_ARN`. `Timestamp` must be within one hour on the push path
   and within 14 days on the backstop path. Failure → `403 invalid_signature` and
   `ses_sns_rejected_total` ([N1](../edge-cases.md)).
2. `SubscriptionConfirmation` for that exact topic → `GET SubscribeURL` (same host rule); any other topic
   is ignored ([N2](../edge-cases.md)).
3. `Notification`: parse `Message` as the SES receipt notification. It must have
   `notificationType = "Received"` and `receipt.action.type = "S3"` with `bucketName` equal to
   `PM_SES_INBOUND_BUCKET`. `objectKey` "is the same as the `messageId`"
   ([notification contents](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html),
   read 2026-10-09). That page does not say whether the rule's `in/` prefix is included, so the handler
   accepts `{messageId}` or `in/{messageId}`, uses `mail.messageId` as the ledger's `object_key` and
   `in/{messageId}` as the S3 key. Spike S11 records the form SES sends.
4. For each address in `receipt.recipients` (the envelope `RCPT TO` addresses the rule matched):
   `INSERT OR IGNORE INTO ses_ingest (object_key, recipient, received_at, status) VALUES (?, ?, ?, 'queued')`.
   Only when a row was inserted, send `InboundPointer` to `pm-inbound`. Duplicates from SNS retries, the
   backstop, or both are dropped here ([N3](../edge-cases.md)). The insert and the enqueue are not one
   transaction, so the every-minute backstop cron also re-sends the pointer of every row still `queued`
   15 minutes after `received_at` (at most 100 a run, through the `ses_ingest_pending` index). The
   consumer skips a pointer whose row is no longer `queued`, so a re-sent pointer is harmless.
5. Respond `200` after the enqueue. An internal failure responds `500`, because SNS retries only `5xx`
   and `429`.

**Verdicts.** The notification is signed by our topic, so its verdicts are trusted. SES fields are
`spfVerdict`, `dkimVerdict`, `dmarcVerdict`, `spamVerdict` and `virusVerdict`, each with `status` `PASS`,
`FAIL`, `GRAY` or `PROCESSING_FAILED`, plus `dmarcPolicy` when DMARC fails.

| Verdict | Use |
|---|---|
| SPF | Taken from SES, with `mail.source` (envelope MAIL FROM) as the checked domain. SES saw the connecting IP; the Worker did not |
| DKIM, ARC, DMARC | Recomputed by our own code over the raw bytes, as for every source, using SES's SPF result. SES's own DKIM and DMARC results are stored in `auth_json.ses` for comparison, and a disagreement increments `ses_auth_disagreement_total` |
| Virus `FAIL` | Quarantine, by rule 4 of [Inbound › Quarantine decision](inbound.md#quarantine-decision) ([N27](../edge-cases.md)) |
| Spam `FAIL` | Spam score at least 0.9, so the default threshold of 0.8 quarantines it |
| `PROCESSING_FAILED` | Recorded and treated like `GRAY`; not a reason to drop mail |

**The consumer** fetches the object (`GET https://{bucket}.s3.{region}.amazonaws.com/in/{key}`, SigV4 with
service `s3`) and writes it to R2 as `inbound-staging/ses/{key}`. It then runs the normal pipeline, with
`envelope_from = mail.source` and `envelope_to = recipient`. After the message is committed, it sets the
ledger row to `done` (or `dropped`, `held`, below). When no row for the key is still `queued` or
`held`, it calls `DeleteObject`. A missing S3 object
(`NoSuchKey`) with a ledger row still `queued` is impossible unless the lifecycle rule ran. In that case
the row becomes `lost`, `ses_object_lost_total` is incremented and the `ses_object_lost` alert pages
([N4](../edge-cases.md)).
The ledger is pruned after 30 days.

**Size.** SES writes messages up to 40 MB to S3
([S3 action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html), read 2026-10-09),
more than Email Routing's 25 MiB. The pipeline accepts up to 40 MB from this source; the parser's own
limits on parts and depth still apply ([N5](../edge-cases.md)).

**Many recipients and tenants.** One SES message can list recipients on several connected domains,
including domains of different tenants. Each recipient becomes its own pointer and is resolved in the
directory separately, so tenants stay isolated ([N28](../edge-cases.md)).

### 4.6 Retired and unknown recipients

Cloudflare routing lets the Worker reject during the SMTP session (`550 5.1.1`, `550 5.1.6`). SES receiving
accepts first and then runs rules, so the behaviour differs:

| Recipient on an SES domain | What happens | Why |
|---|---|---|
| Active or retiring address | Delivered | – |
| `postmaster@` or `abuse@` | Sent to the tenant's owner as a new message, as on routing domains ([Inbound › Steps](inbound.md#steps), step 3) | RFC 2142 names must reach a person; the consumer applies the same role-address step to SES mail |
| Retired address | SES sends a bounce, `550 5.1.6`, from `mailer-daemon@{platform domain}` | Rule `pm-retired-{n}`. The SES Bounce action "rejects the email by returning a bounce response to the sender" ([bounce action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-bounce.html), read 2026-10-09) |
| Address of a suspended tenant | Held: the ledger row becomes `held` and the S3 object is kept. The every-minute backstop cron re-sends the pointer once the tenant is active again. After 5 days of suspension the row becomes `dropped`, without a bounce (`inbound_dropped_total{reason="tenant_suspended", source="ses"}`) | FR-TEN-3 answers a temporary failure for 5 days and then refuses. SES has already accepted the message, so holding it is the equivalent of the temporary failure, and a bounce would be backscatter. 5 days fit inside the 14-day lifecycle rule |
| Any other address | Accepted by SES, then dropped by the Worker without a bounce. `inbound_dropped_total{reason="unknown_recipient", source="ses"}` | A bounce after acceptance goes to whatever sender address the message claims, which spam forges (backscatter). Dropping is the safe default ([N6](../edge-cases.md)) |

**Retired-address rules ([N7](../edge-cases.md), [N29](../edge-cases.md)).** When an address on an SES
domain retires, the domain monitor adds it to the recipient list of the newest `pm-retired-{n}` rule, or
creates the next rule when that one holds 500. Rules are inserted before `pm-deliver`. A rule set holds at
most 200 rules ([quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09), so
Pylota Mail uses at most 150 retired rules (75,000 addresses per deployment). Beyond that, the oldest
retired addresses are removed from the rules and their mail is dropped like an unknown address's. Rule
updates are idempotent (read, merge, write) and retried by the monitor. `addresses.ses_bounce_rule` records
the rule that holds each address. Tenant policy `inbound.ses_bounce_retired: false` drops mail to retired
addresses instead of bouncing it.

### 4.7 Outbound through SES

As [Outbound › Amazon SES](outbound.md#amazon-ses). The custom MAIL FROM makes SPF align under relaxed
`aspf`, and Easy DKIM signs with `d=` the domain, so DKIM aligns even under `adkim=s`
([SES DMARC](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html), read
2026-10-09). If the MAIL FROM MX disappears, SES falls back to its own MAIL FROM domain
(`USE_DEFAULT_VALUE`). SPF then stops aligning but DKIM still does, so the domain is `degraded`
(`mail_from_failed`), not `failing` ([N11](../edge-cases.md)).

### 4.8 SES API rate: one request per second

Amazon SES throttles every API action except `SendEmail`, `SendRawEmail` and `SendTemplatedEmail` at
**one request per second**, per account and region, and the quota is not adjustable
([SES quotas › SES API sending quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read
2026-10-09). The Worker makes such control-plane calls from several places: domain create, `PATCH` to
`ses` and removal (`CreateEmailIdentity`, `GetEmailIdentity`, `PutEmailIdentityMailFromAttributes`,
`DeleteEmailIdentity`), the daily identity check of each SES domain, the 15-minute platform check
(`GetAccount`, the active receipt rule set) and the retired-address rule sync (§4.6). With up to 10,000
identities in a region, uncoordinated calls would be throttled.

**One deployment-wide token bucket.** Every SES call other than sending first takes a token from the
`SesControl` Durable Object, one per deployment: 1 token per second, burst 1.

```rust
// crates/worker/src/domains/ses_control.rs
pub enum SesControlRequest {
    Init,                                        // first call after the cron minted the object
    Acquire { caller: SesCaller, deadline_ms: i64 },
    // → Granted { at_ms } | Busy { retry_after_ms }
}
pub enum SesCaller { Request, DomainCheck, PlatformCheck, RuleSync, Removal }
```

- `Acquire` runs in one transaction: `at = max(now, meta.next_free_ms)`. If `at > deadline_ms` it returns
  `Busy { retry_after_ms: at − now }` and consumes nothing; otherwise it stores `next_free_ms = at + 1000`
  and returns `Granted { at_ms: at }`. The caller waits until `at` (a timer, no CPU), then calls SES. No
  two callers are ever given the same second.
- **Deadlines.** Request-path callers (domain create, `PATCH`, the start of removal) wait at most
  5 seconds; `Busy` answers `429 upstream_rate_limited` with `Retry-After` and `details.retry_after`
  (seconds, rounded up). Background callers wait at most 60 seconds; on `Busy` they set their alarm to
  `retry_after_ms` later.
- **Throttled anyway.** SES `ThrottlingException` or `TooManyRequestsException` on a control-plane call
  (another client of the same AWS account) makes the caller acquire again after 2 seconds, at most three
  times, then treat it as `Busy`. Each one increments `ses_control_throttled_total`.
- **Singleton ID.** The object is created with `new_object_id` (so `PM_JURISDICTION` applies) and its ID
  is stored in D1 `platform_objects` under `name = 'ses_control'`. The every-minute cron mints it when SES
  is configured and the row is missing (`INSERT … ON CONFLICT (name) DO NOTHING`, then read back, as for
  [monitor IDs](identity-domains.md#create)), then sends `Init`. It holds no personal data: its `meta` has
  `schema_version` and `next_free_ms` only ([Data model §3](data-model.md#3-other-durable-objects)).

**Daily identity checks are spread across the day.** Each `DomainMonitor` of a domain with an SES
identity runs its `GetEmailIdentity` check once a day at a fixed offset from 00:00 UTC:
`offset_s = u64::from_be_bytes(SHA-256(domain_id)[0..8]) % 86_400`. Its wake-up `alarm:ses_check` is the
next such time. 10,000 domains then average one call every 8.6 seconds instead of bunching at midnight,
and the bucket's queue stays short.

Test: `it::ses::control_plane_rate` (below).

## 5. `smtp_relay`: the customer's own sending provider

For customers who already send through Microsoft 365, Google Workspace, Postmark, Mailgun, SendGrid or
any other provider with SMTP submission. The agent's mail then leaves through the customer's own
reputation and authentication.

### 5.1 Configuration

```json
{ "name": "brightwell.example", "method": "smtp_relay", "inbound": "forward",
  "smtp": { "host": "smtp.provider.example", "port": 587, "username": "agents@brightwell.example",
            "password": "…", "probe_from": "agents@brightwell.example" } }
```

| Field | Rules |
|---|---|
| `host` | A DNS name, not an IP literal. It must resolve to public addresses; the [SSRF rules](security.md#9-ssrf-controls) apply to every connection |
| `port` | `465` (implicit TLS) or `587` (STARTTLS). Port `25` is refused with `400 smtp_port_not_allowed`: "Workers cannot create outbound connections on port `25`" ([TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), read 2026-10-09) |
| `username`, `password` | Sealed under `PM_MASTER_KEY` in `domains.smtp_sealed` (`pm1` envelope, aad `pm1\|domains\|smtp_sealed\|{domain_id}`; re-sealed by `pmail secrets rotate-master`). Never returned, logged or exported. Rotated with `PATCH /v1/domains/{id}` |
| `probe_from` | An address the relay accepts as sender, used by the alignment probe. Defaults to `postmaster@{domain}` |
| `inbound` | `forward` (the customer's mailbox forwards) or `ses` (also publish the SES MX and DKIM records; needs SES receiving, otherwise `422 transport_unavailable` with `details.reason = "ses_receiving_not_configured"`) |

Before it stores new values, on create and on `PATCH` with `smtp`, the Worker connects once (`EHLO`,
`STARTTLS` or implicit TLS, `AUTH`, `QUIT`). No TLS offered → `422 smtp_tls_required`, and the credentials
are not sent. `535` → `422 smtp_auth_failed`. A connection that cannot be made → `502 upstream_error`.

### 5.2 The client

The protocol is a pure state machine in `core::smtp`. `transport/smtp.rs` drives it over a TCP socket
from the `platform` crate, which wraps the workers-rs `Socket` (only `platform` names `worker` types,
[Design conventions](index.md#1-layering)). workers-rs 0.8.7 has `SecureTransport::{Off, On, StartTls}` and `Socket::start_tls()`, which
unwraps internally and panics unless the socket was opened with `StartTls`
([socket.rs at v0.8.7](https://github.com/cloudflare/workers-rs/blob/v0.8.7/worker/src/socket.rs), read
2026-10-09). The transport therefore always opens port 587 with `StartTls`, and calls `start_tls()` exactly
once, after the server advertises `STARTTLS`.

| Step | Sent | Accepted reply | Otherwise |
|---|---|---|---|
| Connect | – (465: TLS from the start) | `220` within 10 s | `RetryLater` |
| Hello | `EHLO {PM_API_HOST}` | `250` with extensions | `RetryLater` |
| TLS (587) | `STARTTLS` (only if advertised) | `220`, then TLS, then `EHLO` again | Not advertised: `Rejected`, issue `smtp_tls_required` (fail). Credentials are never sent without TLS ([N16](../edge-cases.md)) |
| Auth | `AUTH PLAIN` (or `AUTH LOGIN` if only that is advertised) | `235` | `535`: `Rejected` (`sender_domain_unavailable`), issue `smtp_auth_failed` (fail) ([N14](../edge-cases.md)); `4xx`: `RetryLater` |
| Envelope | `MAIL FROM:<{from address}>` with `SIZE=` when advertised | `250` | `4xx`: `RetryLater`; `5xx`: `Rejected` |
| Recipients | `RCPT TO:<…>` per queued delivery | `250`/`251` | `4xx`: that delivery is retried later; `5xx`: that delivery is `rejected` with the code. All refused: `Rejected` |
| Data | `DATA`, then the dot-stuffed MIME, then `.` | `250` → `Accepted`, `provider_message_id = "smtp:{host}:{Message-ID}"` | Before the final `.` is written: `RetryLater`. **After the final `.` and before the reply: `Unknown` (uncertain), never resent** ([N15](../edge-cases.md)) |
| Close | `QUIT` | – | Ignored |

Timeouts are 10 seconds to connect, 30 seconds per command and 60 seconds for the reply to the final `.`.
There is one connection per message and no pipelining. A Worker invocation can have at most six
connections waiting at once
([limits](https://developers.cloudflare.com/workers/platform/limits/), read 2026-10-09), so the outbound
consumer runs at most four SMTP sends in parallel. TLS certificate and host-name checking by the runtime is
part of **spike S12**. If the runtime does not check the host name, `smtp_relay` does not ship. The replies
this table leaves open (another `5xx` to `AUTH`, a `4xx` or `5xx` to the final `.`, the 4-minute overall
deadline, and how a delivery that got a `4xx` is retried) are settled in
[Outbound › SMTP relay](outbound.md#smtp-relay).

### 5.3 Proving alignment: the probe

The relay controls signing, so the Worker cannot read the alignment from DNS alone. To keep U4, an SMTP
domain has to pass a **probe** before it may send, and again every day ([N18](../edge-cases.md)):

1. Through the relay, send `From: {probe_from}` to `pm-probe+{token}@{platform domain}`, with subject
   "Pylota Mail alignment probe". It is not counted as a plan send.
2. The platform domain's inbound path recognises the probe token before directory resolution, and records
   the result instead of storing a message. The token is kept in the domain's `DomainMonitor` storage
   until it arrives or expires (15 minutes); it is not a D1 column.
3. **Pass** when the `From` header is unchanged and DMARC for `{domain}` passes on our own check: an
   aligned DKIM signature, or SPF on an aligned MAIL FROM. Otherwise the issue is `smtp_unaligned` (fail),
   or `smtp_from_rewritten` (fail) when the relay changed the `From` address.
4. No probe arrives within 15 minutes: `smtp_probe_timeout`. Until the domain has passed its first probe
   this is `fail`, because the domain must never reach `healthy` or `degraded` without a pass. After a
   pass, it is degraded the first time and fail after three in a row.
5. **Record the result.** The `DomainMonitor` writes `domains.probe_last_at` and `probe_last_json`
   (`{result, dkim_d, dmarc, from_unchanged, at, failures_in_row, pending}`) in one D1 statement. The
   alignment-probe health check reads them on every 15-minute check
   ([§6](#6-health-checks-per-method)), and `GET /v1/domains/{id}` returns them as `probe.last_at` and
   `probe.result`.

**Schedule.** The monitor keeps the next probe time in `alarm:probe`:

| Last result | Next probe | Health-check level of the alignment issue |
|---|---|---|
| Pass | 24 hours later | – (`ok` while the pass is under 26 hours old) |
| First `smtp_unaligned` or `smtp_from_rewritten` in a row | 20 minutes later | degraded (sends continue for at most one retry) |
| Second or later in a row | Every hour until a pass, or until the domain is suspended | fail |
| `smtp_probe_timeout` | 20 minutes later; hourly from the third in a row | as in step 4 |

So two failed probes in a row (about 20 minutes apart) make the issue fail-level, and the state machine
moves the domain to `failing` after its two agreeing checks: about 40 minutes from the first failure in
the worst case. Probes are sent daily only while the domain passes. Sends from a `failing` domain fall back
to the platform address (FR-DOM-6), so the domain never sends mail that fails DMARC for long.
`POST /v1/domains/{id}/probe` runs a probe now, at most once a minute per domain (`429 rate_limited`
otherwise).

**Pending values.** New `smtp` values from `PATCH` are sealed into `domains.smtp_pending_sealed`, and sends
keep using `smtp_sealed`. A probe runs at once with the pending values (`pending: true` in the result). When
it passes, the monitor re-seals the values under the `smtp_sealed` aad, writes them to `smtp_sealed` and
sets `smtp_pending_sealed = NULL` in the same D1 statement. A failed probe with pending values changes
neither column and does not count towards `failures_in_row` of the live values: the stored values keep
sending, and the result shows on the domain. A later `PATCH` replaces the pending values.

### 5.4 Delivery events from a relay

SMTP relays do not report deliveries back. A message is `submitted` after the `250`, and per-recipient
statuses stay `submitted` unless a bounce arrives. The return path is the `From` address, so bounces
reach the identity's own inbound (through forwarding or SES). The inbound pipeline recognises RFC 3464
delivery status notifications for messages it sent, by `Message-ID` in the DSN's original headers. It
turns each into a `bounced` event (`hard` for `5.x.x`, `soft` for `4.x.x`) with a suppression for hard
bounces ([N19](../edge-cases.md)). The DSN itself is stored with `kind = 'dsn'` and `status = 'hidden'`
([Inbound › DSN routing](inbound.md#dsn-routing-and-backscatter)) and is not shown to agents as new mail.

## 6. Health checks per method

These rows add to [What each check verifies](identity-domains.md#what-each-check-verifies):

| Record or check | Applies to | `ok` when | Issue codes (level) |
|---|---|---|---|
| SES inbound MX at the domain | `inbound = ses` | The MX set contains `inbound-smtp.{ses_region}.amazonaws.com` | `mx_missing` (fail); `mx_unexpected`: another MX host too (degraded) ([N9](../edge-cases.md)); `mx_wrong_region`: an SES inbound host for another region (fail) ([N8](../edge-cases.md)) |
| SES identity | `transport = ses` or `inbound = ses` | `GetEmailIdentity` (once a day, at the domain's hash offset, through the SES token bucket, §4.8): `VerifiedForSendingStatus = true` and `DkimAttributes.Status = SUCCESS` | `ses_dkim_failed` (fail) ([N10](../edge-cases.md)) |
| SES DKIM CNAMEs | as above | Each CNAME points at `{token}.{SigningHostedZone}` | `dkim_missing` (fail) |
| MAIL FROM | `transport = ses` | `MailFromAttributes.MailFromDomainStatus = SUCCESS`, and the MX and SPF at `pm-bounce.{domain}` match | `mail_from_failed` (degraded) ([N11](../edge-cases.md)) |
| SES account | deployment, in `pmail doctor` and the 15-minute platform check | Production access enabled, sending not paused, the receipt rule set active and containing `pm-deliver` | `ses_sending_paused`, `ses_rule_missing` (platform alerts; every SES domain uses fallback while sending is paused) ([N10](../edge-cases.md)) |
| Alignment probe | `transport = smtp` | Last probe (with the live values) passed within 26 hours | `smtp_unaligned`, `smtp_from_rewritten` (degraded for the first in a row, fail from the second; [§5.3](#53-proving-alignment-the-probe)); `smtp_probe_timeout` (fail before the first pass; after it degraded, then fail after three in a row) |
| SMTP login | `transport = smtp` | The last send or probe authenticated | `smtp_auth_failed`, `smtp_tls_required` (fail) |
| Parent delegation | `kind = delegated` | NS for the subdomain at the parent equal the zone's `name_servers` | `nameservers_changed` (ownership) |
| Doubled names | `external` | No record exists at `{name}.{registrable domain}` that matches an expected value | `record_doubled_name` (degraded) with a fix telling the user to enter the `host` value only ([N17](../edge-cases.md)) |

Ownership TXT and RDAP checks apply to every `external` and `delegated` domain, as for zones.

## 7. Data model

```sql
-- D1: domains (the columns the methods use; all are in 0001_init.sql, full table in data-model.md;
-- no migration adds or changes them before v1.0)
kind        TEXT NOT NULL CHECK (kind IN ('platform','zone','delegated','external')),
method      TEXT NOT NULL CHECK (method IN ('platform','cloudflare_zone','nameservers','dns_records',
                                             'send_only','smtp_relay','delegated_subdomain')),
inbound     TEXT NOT NULL CHECK (inbound IN ('routing','ses','forward','none')),
transport   TEXT NOT NULL CHECK (transport IN ('cloudflare','ses','smtp')),
ses_region        TEXT,          -- set when inbound or transport is ses
mail_from_domain  TEXT,          -- pm-bounce.{domain}
smtp_sealed       BLOB,          -- pm1 envelope of {host, port, username, password, probe_from}
smtp_pending_sealed BLOB,        -- values from PATCH waiting for a passing probe (pm1, aad column smtp_pending_sealed)
probe_last_at     INTEGER,
probe_last_json   TEXT,          -- {result, dkim_d, dmarc, from_unchanged, at, failures_in_row, pending}

-- D1: exactly-once ingestion of SES messages
CREATE TABLE ses_ingest (
  object_key  TEXT NOT NULL,
  recipient   TEXT NOT NULL,               -- normalised envelope recipient
  received_at INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued','held','done','dropped','lost')),
  done_at     INTEGER,                     -- set with any terminal status; the retention job prunes by it
  PRIMARY KEY (object_key, recipient),
  CHECK ((status IN ('queued','held')) = (done_at IS NULL))
);
CREATE INDEX ses_ingest_pending ON ses_ingest (status, received_at) WHERE status IN ('queued','held');

-- D1: addresses
ses_bounce_rule TEXT,             -- pm-retired-{n} holding this retired address, if any
forwarding      TEXT CHECK (forwarding IN ('unverified','ok','failed')),  -- NULL unless inbound = forward
forwarding_checked_at INTEGER,
```

`InboundPointer` (queue `pm-inbound`) gains `source`: `{"type": "routing"}` or
`{"type": "ses", "bucket", "key", "spf", "dkim", "dmarc", "spam", "virus", "dmarc_policy"}`.

Alignment-probe and forwarding-test tokens are not D1 columns. They live in the domain's `DomainMonitor`
storage until they arrive or expire (15 and 10 minutes).

## 8. API

| Change | Detail |
|---|---|
| `POST /v1/tenants/{tenant_id}/domains` | New field `method` (required for new clients; when it is absent, the old `kind` is mapped: `zone` → `cloudflare_zone`, `external` → `send_only`; `create_zone: true` with `kind: zone` is the old spelling of `nameservers`). New fields: `confirm_dedicated` (`nameservers`), `smtp` and `inbound` (`smtp_relay`). `replace_mx` applies to a `cloudflare_zone` apex and to `dns_records`. `402 billing_limit` (`feature: custom_domains`) as before. `422 cf_token_required` only for `cloudflare_zone`, `nameservers` and `delegated_subdomain` |
| Domain object | Adds `method`, `inbound`, `transport`, `ses_region`, `mail_from_domain`, `smtp` (`host`, `port`, `username`, `probe_from`; never the password; `null` unless `smtp_relay`) and `probe` (`last_at`, `result`; `null` unless the transport is `smtp`). `kind` is `platform`, `zone`, `delegated` or `external`. Records gain `host` (relative to the registrable domain) next to `name` |
| `PATCH /v1/domains/{id}` | `transport` (platform key only, as before) and `smtp` (tenant or platform key with `domains:write`: rotate credentials or change the host). New `smtp` values stay pending until a probe with them passes ([5.3](#53-proving-alignment-the-probe)). `200` with the domain |
| `POST /v1/domains/{id}/probe` | `domains:write`. Runs the alignment probe now (`smtp` transport only); `202 { "probe_id": "prb_…" }`; at most once a minute per domain (`429 rate_limited`); the result arrives as a domain health change |
| `POST /v1/identities/{identity_id}/addresses/{address_id}/test-forwarding` | `identities:write`. Domains with `inbound: forward` (`send_only`, `smtp_relay`); `202`; the result is in the address's `forwarding` |
| Address object | Adds `forwarding` (`null` unless the domain uses `inbound: forward`, else `unverified`, `ok` or `failed`) and `forwarding_checked_at` |
| `domain.removed` event | Gains `reason`: `requested` or `zone_expired` |
| `POST /hooks/ses/inbound` | SNS endpoint for SES inbound notifications (topic `PM_SES_INBOUND_TOPIC_ARN`), outside the developer API, no API key. `POST /hooks/ses` keeps SES delivery events (topic `PM_SES_SNS_TOPIC_ARN`). Both accept only SNS signature version 2 and answer `403 invalid_signature` on any verification failure |

New error codes:

| HTTP | Code | When |
|---|---|---|
| 409 | `domain_not_dedicated` | `nameservers` on a name with A, AAAA or MX records, or a `www` CNAME or A, without `"confirm_dedicated": true`; `details.records` lists them |
| 409 | `zone_hold` | Cloudflare refused the zone because of a zone hold (`delegated_subdomain`, `nameservers`) |
| 429 | `upstream_rate_limited` | Cloudflare error 1105 when creating a zone; `Retry-After` and `details.retry_after` = 10800 |
| 400 | `smtp_port_not_allowed` | `smtp.port` is not 465 or 587 (port 25 included) |
| 422 | `smtp_tls_required` | The relay does not offer STARTTLS on 587 (or TLS on 465); credentials were not sent |
| 422 | `smtp_auth_failed` | The relay answered `535` to `AUTH`. Also a domain health issue |

`transport_unavailable` (422) gains `details.reason`:

| `reason` | When |
|---|---|
| `ses_not_configured` | The SES transport (`PM_SES_*`) is not configured: `dns_records`, `send_only`, `PATCH transport: ses` |
| `ses_receiving_not_configured` | `dns_records`, or `smtp_relay` with `inbound: ses`, without `PM_SES_INBOUND_TOPIC_ARN` (and bucket and queue) |
| `ses_identity_limit` | The SES region already has 10,000 identities; creating a domain that needs one ([4.3](#43-dns_records)) |
| `subdomain_setup_disabled` | `delegated_subdomain` while `PM_CF_SUBDOMAIN_SETUP` is not `on` |
| `zone_creation_not_allowed` | `nameservers` by a tenant key whose policy lacks `domains.allow_create_zone: true` |
| `method_not_supported` | The method does not support the operation: `PATCH transport` to a transport the method cannot use; `probe` when the transport is not `smtp`; `test-forwarding` without `inbound: forward` |

## 9. Configuration

| Variable or secret | Default | Meaning |
|---|---|---|
| `PM_SES_INBOUND_BUCKET` | unset | The S3 bucket of rule `pm-deliver`. With the two below, enables `inbound = ses` |
| `PM_SES_INBOUND_TOPIC_ARN` | unset | The only topic `/hooks/ses/inbound` accepts |
| `PM_SES_INBOUND_QUEUE_URL` | unset | The backstop SQS queue |
| `PM_SES_RULE_SET` | `pylota-mail` | The active receipt rule set the monitor edits |
| `PM_CF_SUBDOMAIN_SETUP` | `off` | `on` allows `delegated_subdomain` (Enterprise accounts only) |

The existing `PM_SES_REGION`, `PM_SES_ACCESS_KEY_ID` and `PM_SES_SECRET_ACCESS_KEY` serve both directions.

## 10. Cost per method

Read 2026-10-09; USD as billed by each provider.

| Method | Inbound per 1,000 | Outbound per 1,000 | Fixed |
|---|---|---|---|
| `cloudflare_zone`, `nameservers`, `delegated_subdomain` | Included (Worker requests only) | $0.35 after 3,000 a month ([Email Sending](https://developers.cloudflare.com/email-service/platform/pricing/)) | Enterprise contract for `delegated_subdomain` |
| `dns_records` | $0.10, plus $0.09 per 1,000 chunks of 256 KB, plus S3, SNS and SQS requests (fractions of a cent) | $0.10 à la carte or $0.16 on Essentials, plus $0.12 per GB of attachments ([SES pricing](https://aws.amazon.com/ses/pricing/)) | none |
| `send_only` | Included (arrives through the platform domain) | as `dns_records` | none |
| `smtp_relay` | Depends on `inbound` | The customer's provider bills them | none |

On Pylota Mail Cloud the plan price does not depend on the method. SES sending costs less than Email
Sending, so a `dns_records` domain costs less to serve than one on a Cloudflare zone.

## 11. Privacy and jurisdiction

- With `inbound = ses` or `transport = ses`, Amazon Web Services processes message content and is listed as
  a sub-processor in the DPIA ([Privacy](privacy.md)).
- Raw inbound mail rests in S3 only until it is ingested (normally seconds), and never longer than the
  14-day lifecycle rule. The bucket uses SSE-S3 and denies public access.
- With `PM_JURISDICTION=eu`, setup refuses an SES region outside the EU and the UK unless `--allow-non-eu`
  is given ([N30](../edge-cases.md)). For the SES region, `eu` means "EU or UK" (the UK has an EU GDPR
  adequacy decision); Cloudflare's `eu` jurisdiction for D1, R2 and Durable Objects means the EU only.
  This deployment's SES runs in `eu-west-2` (London), the owner's decision of 2026-10-09. Whenever SES is configured, `/health` reports `ses_region`.
- An `smtp_relay` domain sends content to the customer's own provider, chosen by the customer.

## 12. Spikes

| Spike | Must prove | Pass | Fallback |
|---|---|---|---|
| S10 Child zones | On an Enterprise account, a subdomain-setup child zone accepts Email Routing catch-all to the Worker and Email Sending onboarding, and both work end to end | Mail to any address at the child apex reaches `email()`; a send is DKIM-aligned | `delegated_subdomain` stays off; `dns_records` covers the case |
| S11 SES receiving | Rule set, S3 action and topic as specified. The notification shape matches §4.5. S3 `GetObject` with SigV4 from a Worker. A 30 MB message. `user+tag@` routing. The retired-address bounce. The backstop picks up a message whose push failed | All pass in `eu-west-2` | `dns_records` does not ship in v1.0; `send_only` still does |
| S12 SMTP from a Worker | Ports 465 and 587 with `StartTls` against two real providers. The certificate host name is checked (a wrong-name certificate is refused). Timeouts and the uncertain window behave as in §5.2 | All pass | `smtp_relay` does not ship in v1.0 |

## 13. Options considered and not taken

| Option | Why not |
|---|---|
| Cloudflare partial (CNAME) setup | Business or Enterprise only, Cloudflare is not authoritative, and no Email Service page mentions it ([partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/), read 2026-10-09) |
| Cloudflare for SaaS custom hostnames | Its product-compatibility table has no email row, and Spectrum is not supported |
| Running our own MX gateway (Postfix, Stalwart) | Servers, IP reputation and on-call work, against the "nothing to keep running" promise. Outbound port 25 is blocked by default on AWS, Google Cloud, Azure, DigitalOcean and Hetzner. Stalwart is AGPL-3.0 or a commercial licence |
| Postmark, CloudMailin inbound | No HMAC signature on raw-MIME webhooks; basic auth in the URL is not enough for mail that agents act on |
| Mailgun and SendGrid inbound webhooks | Both sign requests (Mailgun HMAC-SHA256 over timestamp and token; SendGrid ECDSA over timestamp and raw body) and can deliver raw MIME. They are planned for v1.1 as `inbound = mailgun` and `inbound = sendgrid` behind the same `InboundSource` trait. SES already covers every DNS host in v1.0 |

## 14. Tests

| Test | Covers |
|---|---|
| `core::connect::method_matrix` | Every `method` maps to the documented `kind`, `inbound` and `transport`; invalid combinations are refused |
| `core::sns::verify_v2_vectors` | Real SNS notifications (fixtures) verify; a changed byte, version 1, a wrong host, a wrong topic and a stale timestamp are refused ([N1](../edge-cases.md), [N2](../edge-cases.md)) |
| `it::ses::invalid_signature_403` | Each refused case from `verify_v2_vectors`, posted to `/hooks/ses/inbound` and `/hooks/ses`, gets `403 invalid_signature`, increments `ses_sns_rejected_total` and enqueues nothing; a `SubscriptionConfirmation` for another topic is never confirmed ([N1](../edge-cases.md), [N2](../edge-cases.md)) |
| `it::ses::push_and_backstop_once` | The same notification by push and from SQS produces one message ([N3](../edge-cases.md)) |
| `it::ses::object_lost` | Lifecycle-deleted object → ledger `lost`, alert ([N4](../edge-cases.md)) |
| `it::ses::large_message_40mb` | A 39 MB message is ingested ([N5](../edge-cases.md)) |
| `it::ses::unknown_recipient_dropped` | No bounce, metric incremented ([N6](../edge-cases.md)) |
| `it::ses::retired_rule_sync` | Retire → address in `pm-retired-{n}`; 501st opens a new rule; cap 150 rules evicts the oldest ([N7](../edge-cases.md), [N29](../edge-cases.md)) |
| `it::ses::h2_mail_from_spf_preflight` | `dns_records` and `send_only`: an existing SPF at `pm-bounce.{domain}` whose merge with `include:amazonses.com` needs 11 lookups → `400 spf_lookup_limit` with `details.lookups`, and no SES identity is created ([H2](../edge-cases.md)) |
| `it::ses::verdict_mapping` | Virus `FAIL` quarantines, spam `FAIL` scores 0.9, SPF taken from SES, DKIM recomputed ([N27](../edge-cases.md)) |
| `it::ses::cross_tenant_recipients` | One object with recipients in two tenants → two messages, no leakage ([N28](../edge-cases.md)) |
| `it::ses::stuck_queued_row_resent` | The enqueue after the ledger insert fails → the backstop cron re-sends the pointer after 15 minutes → one message; a second pointer for a `done` row is acked without work ([N3](../edge-cases.md)) |
| `it::ses::suspended_tenant_held` | A suspended tenant's SES mail is `held`, ingested when the tenant is resumed, and `dropped` without a bounce after 5 days; the S3 object is kept until then ([A6](../edge-cases.md)) |
| `it::domains::existing_mx_external` | `dns_records` with MX elsewhere → `409 existing_mx`; with `replace_mx` → created, `mx_unexpected` until removed ([N9](../edge-cases.md)) |
| `it::domains::nameservers_dedicated_check` | A/AAAA/MX/www present → `409 domain_not_dedicated`; confirmed → created ([N21](../edge-cases.md)) (FR-DOM-12) |
| `it::domains::zone_expired` | Pending zone deleted upstream → `removed`, `zone_expired`, `domain.removed` with `reason: "zone_expired"`; the final reminder is sent on day 21 ([N23](../edge-cases.md)) |
| `it::domains::mx_wrong_region` | An MX at another region's SES inbound host → `mx_wrong_region` (fail) ([N8](../edge-cases.md)) |
| `it::ses::control_plane_rate` | Twenty concurrent `Acquire` calls are granted one second apart; a request-path caller past its 5-second deadline gets `429 upstream_rate_limited` with `Retry-After`; the daily checks of 1,000 fake domains fall at their hash offsets, at most one per second; an SES `ThrottlingException` re-acquires after 2 s |
| `it::ses::dkim_failed_or_paused` | `GetEmailIdentity` without DKIM `SUCCESS` → `ses_dkim_failed` → `failing` → fallback; account sending paused → `ses_sending_paused` alert and every SES domain uses fallback ([N10](../edge-cases.md)) |
| `it::ses::mail_from_mx_missing` | MX at `pm-bounce.{domain}` removed → `mail_from_failed` (degraded); sends continue with SES's default MAIL FROM ([N11](../edge-cases.md)) |
| `it::domains::zone_create_rate_limited` | Cloudflare `1105` on zone create → `429 upstream_rate_limited`, `Retry-After: 10800` ([N22](../edge-cases.md)) |
| `it::domains::zone_hold` | A zone-hold error on create → `409 zone_hold` ([N24](../edge-cases.md)) |
| `it::domains::delegation_removed` | The parent's NS for a `delegated_subdomain` change → `nameservers_changed` → `suspended` ([N25](../edge-cases.md)) |
| `it::domains::ses_identity_limit` | 9,000 identities → `ses_identities_90pct` alert and a doctor warning; 10,000 → `422 transport_unavailable` with `ses_identity_limit` for `dns_records`, `send_only` and `smtp_relay` with `inbound: ses`, while `cloudflare_zone` still succeeds ([N26](../edge-cases.md)) |
| `cli::setup::ses_region_check` | `pmail setup ses` refuses a region that cannot receive mail, and a region outside the EU and the UK under `PM_JURISDICTION=eu` unless `--allow-non-eu`; `eu-west-2` is accepted ([N30](../edge-cases.md)) |
| `core::smtp::state_machine` | Every row of the client table, including no STARTTLS → refused before AUTH, `535` → auth failure, 5xx on one RCPT ([N14](../edge-cases.md), [N16](../edge-cases.md), [N20](../edge-cases.md)) |
| `it::smtp::create_connect_check` | Domain create and `PATCH smtp`: port 25 → `400 smtp_port_not_allowed`; no STARTTLS → `422 smtp_tls_required` with no `AUTH` sent; `535` → `422 smtp_auth_failed`; nothing stored in each case ([N14](../edge-cases.md), [N16](../edge-cases.md)) |
| `it::smtp::uncertain_after_final_dot` | Connection dropped after the final `.` → `uncertain`, never resent ([N15](../edge-cases.md)) |
| `it::smtp::partial_rcpt` | `4xx` on one `RCPT` → `DATA` is still sent to the others, that delivery stays `queued` and is retried later (the message stays `queued` until then; its `sends` unit stays held); `5xx` on another → that delivery is `rejected` with the code; the rest are sent in the same session ([N20](../edge-cases.md)) |
| `it::smtp::probe_unaligned_falls_back` | A relay re-signing with its own `d=` → `smtp_unaligned` ×2 → `failing` → the next send uses the platform address ([N18](../edge-cases.md)) |
| `it::smtp::probe_schedule_and_pending` | Fake time: a failed probe is retried after 20 minutes and is degraded; the second failure is fail-level and the domain is `failing` within 40 minutes; probes then run hourly, and daily again after a pass. A `PATCH smtp` probe that passes moves `smtp_pending_sealed` into `smtp_sealed`; one that fails changes neither column nor the live `failures_in_row` ([N18](../edge-cases.md)) |
| `it::smtp::dsn_to_bounce` | An RFC 3464 DSN for a sent message → `bounced` (hard) and a suppression ([N19](../edge-cases.md)) |
| `it::forwarding::test_forwarding` | New address → `forwarding: unverified`; token arrives → `ok`; none in 10 minutes → `failed` ([N12](../edge-cases.md)) |
| `it::forwarding::loop_capped` | An agent writing to its own external address, forwarded back, does not loop: the hop counter and the automatic-exchange cap stop it ([N13](../edge-cases.md)) |
| `core::dns::doubled_name_detected` | `agents.brightwell.example.brightwell.example` matching an expected value → `record_doubled_name` ([N17](../edge-cases.md)) |
