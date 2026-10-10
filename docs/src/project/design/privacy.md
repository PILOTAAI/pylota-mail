# Privacy and erasure

Binding for implementation. This page lists every store of personal data, how long it is kept and how
it is deleted; how the jurisdiction applies; the retention and erasure jobs step by step; legal holds;
subject-access export; and what remains after deletion (backups, logs, processors). The user-facing
explanation is in [Privacy, retention and erasure](../../guides/privacy.md).

| | |
|---|---|
| Requirements | FR-PRV-1, FR-PRV-2, FR-PRV-3, FR-PRV-4, FR-PRV-5, FR-PRV-6, FR-IDN-4, FR-IDN-7, FR-IDN-9, FR-ADR-5, FR-SRCH-11, FR-DOM-9, FR-CON-8, FR-CON-14, FR-CON-15, FR-KEY-4 (partner deletion), NFR-PRV-1 |
| Edge cases | [I1](../edge-cases.md)–[I11](../edge-cases.md), [J7](../edge-cases.md), [A5](../edge-cases.md), [A6](../edge-cases.md), [A13](../edge-cases.md), [F6](../edge-cases.md), [J8](../edge-cases.md), [J12](../edge-cases.md), [W34](../edge-cases.md), [N4](../edge-cases.md), [N7](../edge-cases.md), [O7](../edge-cases.md), [O15](../edge-cases.md), [O19](../edge-cases.md) |
| Code | `crates/worker/src/jobs/` (`JobRunner`, step planners), `crates/core/src/jobs/` (pure step logic, receipt builder), `crates/worker/src/mailbox/erase.rs`, `crates/worker/src/mailbox/export.rs` |
| Tables | `jobs`, `erasure_requests`, `exports`, `address_tombstones`, `suppressions`, `ses_ingest`, `identity_keys`, `key_tombstones`, `notification_prefs`, `partners`, the console tables (`users`, `members`, `invitations`, `login_tokens`, `sessions`, `oauth_identities`, `oauth_states`, `waitlist`) (D1); `steps`, `meta` (JobRunner); every `IdentityMailbox` table; the `Notifier` tables ([Data model](data-model.md)) |

## 1. Principles

1. **Minimise.** Store the least that delivers the feature: vectors hold no text; queues hold pointers;
   logs hold pseudonyms; suppressions and tombstones hold keyed hashes.
2. **Delete together.** A message's rows, index entries, references, vectors and objects are deleted by
   the same job, and the receipt counts each store (FR-PRV-3, FR-SRCH-11).
3. **Prove deletion.** Every erasure ends with probe queries whose results are in the receipt
   ([F6](../edge-cases.md)).
4. **Say what remains.** Backups, processor-side logs and suppressions survive by design and are listed
   here (section 11).

## 2. Data inventory

| Store | Personal data | Purpose | Retention | Deletion mechanism |
|---|---|---|---|---|
| R2 `inbound-staging/{yyyy}/{mm}/{dd}/{ulid}.eml`, and `inbound-staging/ses/{key}` for the SES source | Whole raw message, envelope | Accept mail when the directory lookup fails transiently ([J7](../edge-cases.md)); hand SES mail to the normal pipeline | Until routed; at most 15 days | Inbound consumer deletes after the move; R2 lifecycle rule (15 days: longer than the 14 days a dead-letter item is kept, so a pointer redriven from the dead-letter queue still finds its object, [J7](../edge-cases.md)). Not keyed by tenant: erasure cannot find these objects, and section 11 lists them |
| Amazon S3 `{prefix}-inbound`, keys `in/{messageId}` (only with `inbound = ses`) | Whole raw inbound message, as SES received it | Hand-over from SES receiving to the Worker | Until every recipient is ingested, normally seconds; never longer than 14 days | The inbound consumer calls `DeleteObject` once every `ses_ingest` row of the object is `done`; the bucket's lifecycle rule deletes `in/` after 14 days. The bucket uses SSE-S3 and blocks all public access ([Domains on any DNS host §11](domain-connections.md#11-privacy-and-jurisdiction)) |
| Amazon SQS `pylota-mail-inbound` (only with `inbound = ses`) | Copies of SES receipt notifications: envelope sender and recipients, the message headers up to 10 KB (including From, To and Subject), verdicts ([notification contents](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-notifications-contents.html), read 2026-10-09) | Backstop for a missed SNS push | Until the every-minute backstop cron handles it; queue retention 14 days | The cron deletes each message after handling it; SQS retention |
| Amazon SES receipt rules `pm-retired-{n}` (SES domains) | Retired agent addresses, in clear, as rule recipients | Bounce mail to retired addresses with `5.1.6` ([N7](../edge-cases.md)) | While the address is retired; beyond 150 rules the oldest addresses are removed | Removed from the rules by domain removal, identity erasure and tenant erasure (sections 6.5, 6.6) |
| Amazon SES identities | Domain names | Sending and receiving for SES domains | Life of the domain | Domain removal calls `DeleteEmailIdentity` |
| Amazon SES account-level suppression list (only with `transport = ses` or SES failover) | Clear recipient addresses that hard-bounced or complained, with the reason | SES refuses later sends to them | Until removed: entries "remain there until you remove them" ([Using the Amazon SES account-level suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html), read 2026-10-10) | Kept by design and listed in section 11: the list is account-wide, shared by every SES domain of the deployment, so an entry cannot be attributed to one tenant, and our own hashed suppression keeps refusing the address anyway ([I10](../edge-cases.md)) |
| Cloudflare Email Sending suppression list | Clear recipient addresses, the reason (bounce, complaint, manual, policy) and the scope: `account`, or `sending_domain` with the domain name. Since 2026-09-25 Email Sending creates bounce and complaint entries at sending-domain scope automatically, falling back to account scope when it cannot tell the domain ([Suppress recipients for one sending domain](https://developers.cloudflare.com/changelog/post/2026-09-25-sending-domain-suppressions/), read 2026-10-10) | Cloudflare refuses later sends to them (`E_RECIPIENT_SUPPRESSED`, [Outbound › Provider suppressions](outbound.md#provider-suppressions-and-resending-g4)) | Complaints: no expiry; hard bounces: no expiry, or 7 days for some; soft bounces: 24 hours; manual entries: as set ([Suppression lists](https://developers.cloudflare.com/email-service/concepts/suppressions/), read 2026-10-10) | Domain removal deletes every `sending_domain` entry of the domain ([Identities and domains › Domain removal](identity-domains.md#domain-removal), so tenant erasure too); counterparty erasure deletes the address's `sending_domain` entries on the tenant's sending domains (section 6.4). `account` entries and Cloudflare's `read_only` `policy` entries stay: section 11 ([I10](../edge-cases.md)) |
| Cloudflare Email Routing literal rules (subdomain mail domains) | Agent addresses in clear, as rule matchers | Route each address of a subdomain mail domain to the Worker | Life of the address | Deleted by identity deletion and erasure (section 6.5, step 2), address deletion and domain removal |
| R2 `t/{ten}/i/{idn}/m/{msg}/raw.eml` | Whole raw inbound message | Re-parse, raw download, export, dispute evidence | `retention.raw_days` (default 90) | Retention job; erasure |
| R2 `t/{ten}/i/{idn}/out/{msg}.eml` | Composed outbound message | Sent copy, raw download, export | `retention.raw_days` | Retention job; erasure |
| R2 `…/a/{att}`, `…/a/{att}.md` | Attachment bytes and extracted text | Download, extraction, search | As the message (`retention.message_days`, default kept) | Retention job (message purge); erasure |
| R2 `t/{ten}/exports/{exp}.zip` | Every message in the export | Subject-access export | 7 days | Retention job sets the export `expired` and deletes the object; every erasure of the tenant expires the tenant's unexpired exports, and an export that was running restarts (section 6.11, [I9](../edge-cases.md)); tenant erasure |
| R2 backup bucket (`PM_BACKUP_BUCKET`, optional, off by default; set on Pylota Mail Cloud) | Copies of `t/` objects under the same keys | Recovery from a bug that deletes blobs (section 5.4) | As the source object | Every retention and erasure delete is applied to both buckets; tenant erasure sweeps `t/{tenant_id}/` in both; a copy that lands after the source was deleted is removed by the backup job itself (section 5.4, [I9](../edge-cases.md)) |
| `IdentityMailbox.messages`, `threads`, `deliveries`, `attachments`, `labels` | Addresses, names, subjects, bodies, filenames, SMTP responses | The mailbox | `retention.message_days` (default kept) | Retention job; erasure |
| `IdentityMailbox.fts`, `fts_tri`, `refs` | Index terms and extracted references (plates, phone numbers, emails, amounts) derived from content | Keyword search | As the message | Deleted in the same transaction as the message row |
| `IdentityMailbox.contacts` | Counterparty addresses, names, counts | Contacts, known-sender signal | Until the counterparty or identity is erased | Counterparty, identity and tenant erasure |
| `IdentityMailbox.outbox` | Event payloads: message summaries, addresses, up to 64 KB of extracted text | Webhook dispatch and replay | `retention.events_days` (default 30), counted from `occurred_at`, once dispatched | Retention job; erasure deletes events referencing erased messages |
| `IdentityMailbox.idempotency` | Response bodies of sends (recipients, subject summary) | Safe retries | 30 days | Hygiene step of the retention job; erasure |
| `IdentityMailbox.verifications` | Verification codes and links | `wait` | 24 hours | Hygiene step; erasure (cascade) |
| `IdentityMailbox.rate_windows` | Sender addresses in hourly windows | Inbound throttle, token brute-force limits | 48 hours ([Design conventions §4](index.md#4-durable-object-transactions), daily maintenance) | Hygiene step; counterparty erasure deletes the counterparty's rows (section 6.4); identity and tenant erasure |
| `IdentityMailbox.chunks` | Character offsets only | Semantic index bookkeeping | As the message | Cascade with the message row |
| Vectorize `pm-mail-chunks` | Embeddings derived from content; IDs; filter metadata (`identity_id`, `thread_id`, `sent_at`, `sender_domain`, `direction`, `has_attachment`, `verdict`, `kind`); no text, subjects or addresses | Semantic search | As the message | `deleteByIds` from the chunk map; namespace sweep for tenant erasure (section 7.5) |
| D1 `identities` | Accountable human (`owner_name`, `owner_email`), display name, signature, metadata | Identity management, FR-IDN-2 | Life of the identity | Identity and tenant erasure clear or delete the row |
| D1 `addresses` | Agent addresses | Directory | Life of the identity; retired rows kept so they are never reassigned | Moved to `address_tombstones` on identity deletion or erasure |
| D1 `domains` | Domain names; for `smtp_relay`, the sealed relay credentials (`smtp_sealed`; the username is often an address) and the last probe result | Domain management and sending | Life of the domain | Domain removal; tenant erasure |
| D1 `ses_ingest` | S3 object key and the envelope recipient (an agent address) | Exactly-once ingestion of SES messages ([N4](../edge-cases.md)) | 30 days | Global retention job (`ses_ingest` step) |
| D1 `tenants` | Workspace name, slug, address suffix, time zone, `policy_json`; `require_two_factor`, `onboarding_dismissed_at`, `quota_do_id`, `notify_do_id` and `partner_id` hold no personal data. The slug and the address suffix are often derived from the business's name, and for a sole trader that name can identify a person (section 3, "Names kept after tenant erasure") | The workspace | Life of the tenant | Tenant erasure blanks `name` and `policy_json` and keeps the row, so the slug and suffix are never reused; the slug and suffix are kept in clear, on the basis recorded in section 3 |
| D1 `partners` | The partner's name (an organisation's name; nothing about a person is asked for), its status and default billing mode | Partner keys ([REST API › Partners](../../reference/api.md#partners)) | Life of the partner | `DELETE /v1/partners/{partner_id}` once every tenant of the partner is erased (section 6.10) |
| D1 `users` | Sign-in address, name, `last_login_at`, `last_tenant_id`, `terms_version` and `terms_accepted_at`, the sealed TOTP secret (`totp_sealed`, with `totp_enabled_at` and `totp_last_step`), the sealed recovery-code hashes (`recovery_codes_sealed`) | Console accounts | Life of the account | Person deletion (section 6.9); tenant erasure for people left in no workspace |
| D1 `members` | Which person belongs to which workspace, and the role | Console access | Life of the membership | Member removal; person deletion; tenant erasure |
| D1 `invitations` | Invited address, role, inviting user | Invitations | Pending: until accepted, revoked or expired (7 days). Expired and revoked: 30 days after `expires_at`. Accepted: life of the workspace, because the row records who invited the member and when | Global retention job (`console` step) for expired and revoked rows; person deletion scrubs the address of the person's accepted invitations (section 6.9); tenant erasure |
| D1 `login_tokens` | Clear address; keyed hashes of the link token and code; for sign-up and waitlist tokens the plan, `next` path and accepted terms version | Sign-in, sign-up and waitlist confirmation | 10 minutes; rows deleted 24 hours after expiry | Global retention job (`console` step); person deletion |
| D1 `sessions` | Keyed hash of the cookie, browser family (`user_agent_hint`), times | Console sessions | Until 30 days after expiry or revocation | Global retention job (`console` step); person deletion; tenant erasure |
| D1 `oauth_identities` | Google `sub` or GitHub numeric ID; the address at linking time (`email_at_link`) | Google and GitHub sign-in | Life of the account | Person deletion; tenant erasure for people left in no workspace |
| D1 `oauth_states` | Keyed hashes of `state` and the browser cookie, the sealed PKCE verifier, the `next` path, plan and accepted terms version | One sign-in flow | 10 minutes; rows deleted 24 hours after expiry | Global retention job (`signup` step) |
| D1 `waitlist` | Address and plan of interest | Inviting people before open sign-up (FR-CON-8) | A row exists only once confirmed (an unused confirmation link expires after 10 minutes); kept until 30 days after its invitation | Global retention job (`signup` step); person deletion |
| D1 `billing_accounts` | Stripe customer and subscription IDs | Plans and billing ([Billing](billing.md)) | Life of the tenant | Tenant erasure, after its `cancel_billing` step (section 6.6) |
| D1 `billing_events` | Stripe event IDs, types and outcomes; the tenant ID | Webhook deduplication and the `stripe_webhook_errors` alert ([Billing › Webhook endpoint](billing.md#webhook-endpoint)) | 400 days from `received_at` | Global retention job (`billing_events` step); tenant erasure |
| D1 `address_tombstones` | Keyed hash of the address | Never reassign an address ([A5](../edge-cases.md)) | Permanent | Never deleted (no clear-text address) |
| D1 `suppressions` | Keyed hash, masked hint, optional note and source message ID | Honour bounces, complaints and objections | `expires_at` or permanent | Counterparty erasure clears `note` and `source_message_id` and keeps the rest ([I7](../edge-cases.md)); tenant erasure deletes |
| D1 `sender_lists` | Clear addresses or domains chosen by the tenant | Allow and block lists | Until the tenant removes them | Tenant erasure; otherwise the tenant's own `DELETE …/lists/…` (section 7.3) |
| D1 `webhook_endpoints`, `webhook_deliveries`, `event_index` | URLs; event IDs and types | Webhooks and replay | Deliveries and index: the tenant's `retention.events_days` (default 30); platform rows (`tenant_id IS NULL`): 30 days | Retention job; tenant erasure; partner deletion removes a partner's endpoints and their deliveries (section 6.10) |
| D1 `idempotency_records` | Response bodies of non-mail POSTs: an identity's owner name and address (identity create and update), agent addresses (address create), a suppressed or listed address (suppression and list writes) | Safe retries | 30 days (`expires_at`) | Retention job (global step); identity erasure deletes the tenant's records whose body names the identity ID, counterparty erasure those whose body contains the address (sections 6.4, 6.5); tenant erasure deletes them all |
| D1 `erasure_requests`, `jobs` | Counterparty HMAC, the identity and the `msg_` or `thr_` target ID, free-text `reason`, receipt counts | Accountability for erasure, and re-applying erasures after a restore (section 11) | Erasure records: life of the deployment. Other jobs: 90 days after completion | Retention job (global step) for non-erasure jobs |
| D1 `audit_log` | Key IDs and target IDs; never content or clear addresses | Accountability | Life of the tenant | Tenant erasure deletes all but `erasure.*` rows |
| D1 `identity_keys` | Public JWKs and sealed Ed25519 seeds, tied to one identity; no person's name or address | Agent assertions ([Agent signing keys](agent-keys.md#8-data-model)) | Life of the identity: `retired` rows stay until the identity is deleted, so a key ID is never reused | Identity and tenant erasure delete the rows and record each key ID in `key_tombstones` (sections 6.5 and 6.6) |
| D1 `key_tombstones` | Key IDs (RFC 7638 thumbprints) of deleted identity keys and `deleted_at`; no identity, tenant or address | Never publish a deleted key ID again ([O7](../edge-cases.md)) | Permanent | Never deleted (it holds no personal data) |
| D1 `notification_prefs` | Which person wants which notification kind in which workspace: `mode`, `filter`, the followed inboxes (`identity_ids`), `paused_reason` | Notifications ([Notifications §2](notifications.md#2-preferences)) | Life of the membership | Member removal deletes the person's rows for that workspace ([O19](../edge-cases.md)); person deletion deletes all their rows (section 6.9); tenant erasure deletes the workspace's rows |
| `Notifier` Durable Object (one per tenant) | Person (`usr_`), identity and message IDs, counts and times in `pending`, `held`, `windows` and `sent`; never mail content, subjects, senders or addresses ([Notifications §8](notifications.md#8-notifier-object)) | Coalescing, waiting for triage, schedules and daily caps of notifications | Pending items until their window sends them; `held` rows at most 5 minutes; or until the person is removed ([O19](../edge-cases.md)) | Member removal drops the person's pending and held items; tenant erasure deletes the object's storage (`delete_all`, section 6.6) |
| D1 `usage_daily`, `TenantQuota` | Counts only, including the `assertions` and `http_signatures` metrics, and the usage-alert markers `alerted:{feature}:{threshold}:{period}` in `TenantQuota.meta` | Usage, caps, abuse windows, usage alerts | 92 days (usage); 1,000 outcomes per identity | Retention job; identity and tenant erasure |
| JobRunner `meta` | During a counterparty erasure or export only: the clear target address | Matching messages | Until the job's `finalise` step, which also runs when the job fails or is canceled (section 4, [I11](../edge-cases.md)) | Deleted by `finalise` |
| `DomainMonitor` | Domain names, DNS results, RDAP fingerprint (hash) | Domain health | Last 500 checks | Domain removal; tenant erasure (`delete_all`) |
| Queues | Pointers; inbound pointers carry the envelope sender and recipient ([Inbound](inbound.md)) | Async work | Until consumed; dead-letter items at most 14 days | Consumers ack; queue retention |
| D1 `dlq_items` ([Observability](observability.md#8-dead-letter-queues)) | Pointers as received; inbound pointers include the envelope addresses | Dead-letter records and redrive | 14 days | Global retention job (`dlq` step); counterparty erasure deletes the tenant's rows whose pointer names the address, identity erasure the rows naming the identity, tenant erasure every row of the tenant (sections 6.4–6.6) |
| Workers Logs | Pseudonyms and IDs only (FR-PRV-6) | Debugging | 7 days (Cloudflare) | Expiry |
| Analytics Engine `pylota_mail_metrics` | Tenant and domain IDs only | Metrics and alerts | 3 months (Cloudflare) | Expiry |

Webhook receivers, AI processing and the email providers are covered in section 11.

## 3. Jurisdiction and residency

`PM_JURISDICTION` (`eu` or `default`) is chosen at `pmail setup` and applied at creation (FR-PRV-1):

| Resource | How `eu` is applied | Can it change later? |
|---|---|---|
| D1 `pylota-mail` | Created with `jurisdiction: "eu"` | No. Cloudflare sets a D1 jurisdiction only at creation |
| R2 `pylota-mail-blobs` | Created with the `eu` jurisdiction; the binding names `jurisdiction = "eu"` | No |
| Every Durable Object | ID from `unique_id_with_jurisdiction("eu")`, stored in D1 (`mailbox_do_id`, `monitor_do_id`, `runner_do_id`, `quota_do_id`, `notify_do_id`) | No. Existing objects keep their IDs |

With `default`, the same resources are created without a jurisdiction and objects use `unique_id()`.
Changing jurisdiction means a new deployment and a migration, which v1.0 does not provide.

**What the jurisdiction does not cover.** It controls where D1, R2 and Durable Objects store data and
where the database and objects run. It does not control:

- **Where the Worker runs.** Requests and queue consumers run in the data centre that receives them and
  read jurisdiction-bound data from there (Cloudflare D1 data-location docs, read 2026-10-09).
- **Queues**, which carry pointers only. Inbound pointers carry the envelope sender and recipient
  ([Inbound](inbound.md)).
- **Vectorize**, which has no documented data-location option. It stores vectors, vector IDs and the
  eight filter fields only: never text, subjects or addresses. Embeddings are derived from content and
  are treated as personal data: they are erased with their message.
- **Workers AI** (embeddings, reranking, triage, the agentic planner, `toMarkdown`), which processes mail
  content in transit. When `PM_AI_GATEWAY` is set, content-bearing calls disable gateway log collection
  and caching ([Security › STRIDE](security.md#3-stride-threat-model), TB5).
- **Email Routing and Email Sending**, which process mail on Cloudflare's network. Email Sending keeps an
  activity log for 30 days and, when **Email preview** is on, a copy of each sent message for about
  seven days. New sending domains have preview turned on automatically (Cloudflare Email Service docs,
  read 2026-10-09). Domain onboarding therefore sets `preview_enabled: false` on every sending domain
  through `PATCH /zones/{zone_id}/email/sending/subdomains/{subdomain_id}`, and `pmail doctor` fails if
  any sending domain has preview enabled.
- **Workers Logs and Analytics Engine**, which hold no personal data (section 2).
- **DNS-over-HTTPS** lookups, which send sender and tenant domain names to the configured resolvers
  (by default Cloudflare and Google).
- **Amazon Web Services**, only for domains with `inbound = ses` or `transport = ses` (the
  `dns_records`, `send_only` and `smtp_relay` with `inbound: ses` methods, and SES failover). SES
  processes message content in `PM_SES_REGION`; raw inbound mail rests in the S3 bucket until it is
  ingested (normally seconds, never longer than the 14-day lifecycle rule), with SSE-S3 and no public
  access; SNS and SQS carry receipt notifications. With `PM_JURISDICTION=eu`, `pmail setup ses` refuses
  an SES region outside the EU and the UK unless `--allow-non-eu` is given, and `/health` reports
  `ses_region` ([Domains on any DNS host §11](domain-connections.md#11-privacy-and-jurisdiction)). For
  the SES region, `eu` means "EU or UK": the UK has an EU adequacy decision under the GDPR (European
  Commission [adequacy decisions](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en), renewed 19 December 2025, read 2026-10-09), so London
  (`eu-west-2`, this deployment's SES region, decided 2026-10-09) is an acceptable data location. This is
  not Cloudflare's `eu` jurisdiction above, which means the European Union only ([R2 data location](https://developers.cloudflare.com/r2/reference/data-location/),
  read 2026-10-09).
- **The customer's own mail provider**, for an `smtp_relay` domain: outbound content goes to the relay
  the customer chose and configured.
- **Google and GitHub**, when console sign-in with them is enabled: the provider learns that the person
  signs in to this deployment and returns their verified address and account ID. No mail content is
  involved.

**DPIA.** Automated processing of business correspondence with AI models is likely to need a data
protection impact assessment by the deployer. This page and the data inventory are the data-flow input
for it. Pylota Mail does not provide legal advice and does not act as controller or processor for a
self-hosted deployment.

The processors to list in it:

| Processor | When | What it processes |
|---|---|---|
| Cloudflare | Always | Everything: Workers, D1, R2, Durable Objects, Queues, Vectorize, Workers AI, Email Routing, Email Sending |
| Amazon Web Services | Optional: only with `inbound = ses` or `transport = ses` | Message content in SES, S3, SNS and SQS in `PM_SES_REGION` |
| Google, GitHub | Optional: only when their sign-in is enabled | The person's verified address and provider account ID |
| Stripe | Only with `PM_BILLING=stripe` | Billing contacts and payment details of workspace owners ([Billing](billing.md)) |
| The operator of `PM_SCANNER_URL` | Optional: only when the variable is set | Attachment bytes of inbound mail, sent for malware scanning ([Inbound › Attachment safety](inbound.md#attachment-safety)) |
| Google (Google Public DNS, `https://dns.google/resolve`) | By default: it is the second of the two `PM_DOH_RESOLVERS` | Domain names: sender domains looked up for SPF, DKIM and DMARC, and tenant domains checked by the domain monitor. No addresses or content |
| RDAP servers of the domain registries, found through the IANA RDAP bootstrap registry | Domain health checks of tenant domains | Domain names only ([Identities and domains](identity-domains.md)) |

The customer's SMTP relay provider is the customer's own choice and contract, not a processor of the
deployment.

**Names kept after tenant erasure.** Tenant erasure keeps the `tenants` row with its slug and address
suffix, so that neither is ever given to another workspace: a reused suffix would route mail sent to
the erased workspace's old addresses to a new owner. Both are usually derived from the business's name,
and for a sole trader that name can identify a person. The owner accepted this residue on 2026-10-10
(decision D29). The basis recorded here for the DPIA is legitimate interests (UK and EU GDPR
Art. 6(1)(f)): preventing misdelivery of correspondents' mail outweighs keeping a business name that the
workspace itself chose and published in its addresses. The data is minimised: the workspace name and
policy are blanked, the row holds no person's name, address or contact detail, and nothing links the
slug to the erased mail. Section 11 lists the residue.

## 4. JobRunner

Retention, erasure and export run as `JobRunner` state machines driven by the object's alarm
([ADR 0005](../adr/0005-state-machines.md)).

```text
           start()                    all steps done/skipped
 queued ──────────▶ running ───────────────────────────────▶ completed
                      │  ▲
          step error  │  │ alarm (backoff)
                      ▼  │
                   (retry step) ── retry limit reached ──▶ finalise ──▶ failed
 queued/running ── cancel (tenant erasure supersedes) ──▶ finalise ──▶ canceled

 retry limit: the 10th failed attempt on one step; for erasure jobs, the first failed attempt
              after deadline_at − 4 h (section 4, "Errors")
```

- **Creation.** The handler inserts the `jobs` row (status `queued`, a new `runner_do_id` from
  `unique_id_with_jurisdiction`, `created_by_key_id` = the calling key) and, for erasure, the
  `erasure_requests` row (status `queued`, `target_id` = the `msg_` or `thr_` ID for message and thread
  scope, `created_by_key_id`, `deadline_at`, and `resumes_id` when it resumes or continues an earlier
  request, section 6.1), or, for an export, the `exports` row (status `queued`, `scope`, `job_id`, and
  `identity_id` for identity scope),
  in one D1 batch; then sends `JobRequest::Start { job_id, kind, tenant_id, params }`. If `Start` fails, the every-minute cron
  starts any job still `queued` after 60 seconds.
- **Steps.** `Start` writes the step list for the job kind into `steps` (all `pending`) and arms
  `alarm:step` for now. Each alarm runs the first non-finished step for a slice of at most 20 seconds or
  1,000 items, stores `cursor` and `counts_json`, and re-arms immediately while work remains.
- **Idempotency.** Every step can be re-run from its cursor with the same result: deletes of missing
  objects, rows or vectors count as success and are not counted twice (counts come from the store's
  own response or from rows deleted in the committed transaction).
- **Errors.** A failed slice increments `attempts`, stores `last_error` (a machine code), and re-arms
  after `30 s × 2^(attempts − 1)`, capped at 1 hour. A successful slice resets `attempts` to 0.
  - Jobs other than erasure: after 10 failed attempts on one step the job is `failed`, and the
    `job_failed:{kind}` alert fires ([Observability › Alert list](observability.md#53-alert-list)).
  - Erasure jobs retry automatically with no attempt limit until `erasure_requests.deadline_at − 4 h`
    (20 hours after the first request, section 6.1). The third consecutive failed attempt of any step
    fires `erasure_stalled:{erasure_id}` (page), so the operator learns of it with about 19 hours left;
    the first failed attempt after `deadline_at − 4 h` makes the job `failed`: the request becomes
    `failed`, `erasure.failed` (with `step` and `error`) is emitted, and the `erasure_failed` alert
    fires ([Observability](observability.md#erasure-failure)). A failed erasure is restarted with a new
    request (section 6.1), which for tenant scope resumes at the failed step.
- **Finalise on every end.** A job that fails or is canceled runs its kind's `finalise` step before the
  status is mirrored, exactly as a completed job does. `finalise` touches only the runner's own storage
  and R2, so it cannot be blocked by the fault that failed the job; a crash before it finishes re-runs
  it on the next alarm. It deletes `meta.target_address` and every other job-local copy of personal data,
  and for an export it also aborts the open multipart upload (section 9.1). No job ends with a clear
  address in its storage ([I11](../edge-cases.md)).
- **Mirroring.** On each step transition the runner updates `jobs.status` and `jobs.updated_at` in D1.
  When the first step starts it sets `jobs.status`, and `erasure_requests.status` or `exports.status`,
  from `queued` to `running` in one D1 batch. On completion it writes `jobs.result_json`,
  `jobs.completed_at` and, for erasure, the `erasure_requests` row (`completed` or
  `completed_with_holds`, `receipt_json`, `completed_at`). A `failed` job sets `erasure_requests.status`
  or `exports.status` to `failed` in the same batch.
- **Cancel.** A job is canceled only by tenant erasure (section 6.6, step 1), which cancels the tenant's
  other `queued` and `running` jobs: the runner stops at its next slice, runs `finalise`, and one D1
  batch sets `jobs.status`, and `erasure_requests.status` or `exports.status`, to `canceled`. A canceled
  erasure emits no `erasure.completed`; the tenant erasure that superseded it covers the same data.
- **Events** go through the runner's own outbox ([Design conventions](index.md#6-transactional-outbox)).
- **Deadline.** NFR-PRV-1 requires erasure within 24 hours of the first request. Each erasure request
  stores `deadline_at`: `created_at` + 24 hours, or, for a request that resumes a failed one, the failed
  request's `deadline_at` (section 6.1). The `erasure_overdue` alert fires for any erasure still
  `queued` or `running` after `deadline_at − 4 h`.

### 4.1 Mailbox operations used by jobs

These `MailboxRequest` variants are added by this design. All run inside the mailbox, all take the
caller's `tenant_id` and `identity_id` in the RPC envelope, and all write in one `transaction_sync`
per call.

| Operation | Returns / does |
|---|---|
| `RetentionPlan { raw_cutoff_ms, message_cutoff_ms, after_rowid, limit }` | Messages older than a cutoff outside held threads, with their R2 keys and vector IDs |
| `PurgeRaw { message_ids }` | Sets `raw_r2_key = NULL` (the raw endpoint then returns `410 raw_expired`) |
| `PurgeEvents { cutoff_ms }`, `Hygiene { now_ms }` | Deletes dispatched outbox rows older than the cutoff; expired `idempotency`, `verifications`, `rate_windows` |
| `ErasurePlan { target, after_rowid, limit }` | `{ messages: [{ rowid, id, thread_id, r2_keys, vector_ids }], held: [{ thread_id, reason }], next_after_rowid }` |
| `EraseRows { rowids, counterparty }` | Deletes the rows (section 6.2) and returns counts |
| `ProbeKeyword { target }` | Number of messages still matching the target |
| `CountAll` | Counts per table, used before a wipe |
| `WipeAll` | `delete_all()`, then writes a three-row tombstone `meta` (`erased = '1'`, `tenant_id`, `identity_id`) so the object refuses every later request with `identity_not_found` |
| `ExportBatch { target, after_rowid, limit }` | Message records and R2 keys for export |
| `ForgetSender { target }` | Deletes the `rate_windows` rows whose `sender` matches a counterparty target; returns the count |
| `ActiveHolds { now_ms }` | Clears holds whose `until` has passed (audit `hold.expired`, section 8) and returns the number of threads still held |

`target` is one of `Message { id }`, `Thread { id }`, `Counterparty { address }`,
`CounterpartyHash { hash }` or `All`. `CounterpartyHash` is used only when an erasure is re-applied after a
restore, because the erasure record keeps the address's HMAC and never the address (section 11): the
mailbox computes `HMAC-SHA256(PM_HASH_KEY, a)` for each normalised address `a` a message, contact,
participant list or `rate_windows` row holds, and matches it against `hash`. It matches exactly the
messages that `Counterparty` matches, more slowly; the keyword probe uses the same comparison instead
of a `participant:` search.

## 5. Retention

### 5.1 Scheduling

The `*/15` cron starts one `retention` job per tenant per UTC day: it selects up to 50 active tenants
whose latest `retention` job was created before today (UTC) and creates a job for each. A deployment
with more tenants catches up over the day's 96 runs. A separate global job (`tenant_id = NULL`) runs
once per day for control-plane tables.

### 5.2 Steps of a tenant retention job

| # | Step | Does |
|---|---|---|
| 1 | `plan` | Reads the tenant's effective `retention` policy and fixes the cutoffs: `raw_cutoff = now − raw_days`, `message_cutoff = now − message_days` (skipped when `null`), `events_cutoff = now − events_days`. The system identity (`is_system = 1`, default tenant only) always uses `raw_days = 7` and `message_days = 30`, whatever the policy says, because its mailbox holds sign-in, invitation and notification mail addressed to people ([Identities › The system identity](identity-domains.md#the-system-identity)) |
| 2 | `raw` | For each identity (cursor `identity_id:rowid`), `RetentionPlan` for raw cutoff → delete `raw.eml` and `out/{msg}.eml` objects → `PurgeRaw`. Objects are deleted before the column is cleared, so a crash leaves no unreferenced object |
| 3 | `messages` | Only when `message_days` is set: for each identity, `RetentionPlan` for message cutoff → `deleteByIds` for the vector IDs → delete every R2 key of the batch → `EraseRows` |
| 4 | `events` | For each identity, `PurgeEvents { events_cutoff }`. In D1, in batches (section 6.12): `DELETE FROM event_index WHERE rowid IN (SELECT rowid FROM event_index WHERE tenant_id = ?1 AND occurred_at < ?2 LIMIT 1000)`, repeated until it deletes nothing, and the same for `webhook_deliveries.created_at` |
| 5 | `hygiene` | For each identity, `Hygiene`. Expire exports: `exports` rows past `expires_at` → delete the ZIP object → status `expired` |
| 6 | `audit` | One `audit_log` row per step that deleted anything: `action = "retention.purge"`, `target_type = "tenant"`, `details_json = { "step", "cutoff_ms", "identities", "r2_objects_deleted", "messages_deleted", "vectors_deleted", "events_deleted" }` (FR-PRV-2) |

Every R2 delete in steps 2, 3 and 5 is sent to `BACKUP` too when it is configured (section 5.4).

Held threads ([section 8](#8-legal-holds)) are excluded by `RetentionPlan` in steps 2 and 3. Messages
in held threads keep their raw MIME and rows until the hold ends; the next daily run then purges them.

Webhook replay reaches back 30 days from each event's `occurred_at` (or `retention.events_days`, if
shorter). Replay reads payloads from the outbox, which keeps them for `events_days`, so a tenant with
`events_days` below 30 can replay only that far; a longer `events_days` keeps the payloads and the
delivery log longer but never extends replay past 30 days ([Webhooks › Replay](webhooks.md#replay)).
`events_days` is 1–365.

### 5.3 Global retention job

| Step | Does | Test |
|---|---|---|
| `idempotency` | `DELETE FROM idempotency_records WHERE expires_at < ?now` (batches of 1,000) | `it::retention::global_job_steps` |
| `platform_events` | `event_index` and `webhook_deliveries` rows with `tenant_id IS NULL` older than 30 days | `it::retention::global_job_steps` |
| `jobs` | Non-erasure `jobs` rows completed, failed or canceled more than 90 days ago, and their JobRunner objects (`WipeAll`) | `it::retention::global_job_steps` |
| `usage` | `usage_daily` rows older than 92 days | `it::retention::global_job_steps` |
| `dlq` | `dlq_items` older than 14 days | `it::retention::global_job_steps` |
| `signing_keys` | `signing_keys` rows whose `verify_until` has passed | `it::retention::global_job_steps` |
| `identity_keys` | `UPDATE identity_keys SET status = 'retired', retired_at = ?now WHERE status = 'retiring' AND verify_until < ?now`. The rows stay until the identity is erased, so a thumbprint is never reused ([Agent signing keys](agent-keys.md#2-keys)); the JWKS already leaves out a `retiring` key past `verify_until`, so this step never changes what is published | `it::retention::global_identity_keys` |
| `billing_events` | `DELETE FROM billing_events WHERE received_at < ?now − 400 days` (batches of 1,000) ([Billing › Webhook endpoint](billing.md#webhook-endpoint)) | `it::retention::global_billing_events` |
| `ses_ingest` | `ses_ingest` rows whose `done_at` (set with `done`, `dropped` or `lost`) is more than 30 days ago. `queued` and `held` rows are never pruned: the backstop cron owns them | `it::retention::global_ses_ingest` |
| `console` | `login_tokens` rows 24 hours past `expires_at`; `sessions` 30 days after expiry or revocation; `invitations` with status `expired` or `revoked` 30 days after `expires_at` | `it::retention::global_console_rows` |
| `signup` | `oauth_states` rows 24 hours past `expires_at`; `waitlist` rows 30 days after their invitation (there are no unconfirmed rows: an unused confirmation link simply expires after 10 minutes) | `it::retention::global_signup_rows` |
| `staging` | Reconciliation of `inbound-staging/` older than 1 hour against mailbox records: an unrouted object is re-queued once a day while it exists (a pointer may sit in a dead-letter queue for up to 14 days, [J7](../edge-cases.md)); objects are never deleted here (the 15-day lifecycle rule does that). An object still unrouted 14 days after it was written counts in `inbound_lost_total` | `it::retention::global_job_steps` |
| `held_erasures` | For each `erasing` tenant whose latest tenant-scope erasure request is `completed_with_holds`: `ActiveHolds` on the mailbox of every identity still `deleting`; when every answer is 0, create a tenant-scope erasure request with reason `hold_released:{era_id}` and `resumes_id` = that request, audit-logged (`erasure.create`), which finishes the erasure (section 6.6, "Holds in a tenant being erased") | `it::erasure::i2_hold_tenant_scope` |
| `audit` | One `audit_log` row per step with counts (`tenant_id = NULL`) | `it::retention::global_job_steps` |

Each step is added to `jobs/retention.rs`, with its test, by the milestone that builds the feature
writing its table's rows ([Build plan › M14](../build-plan.md#m14--privacy-after-m9-m10) names them); the job
runs the steps in the order above.

### 5.4 Optional R2 backup copy

R2 has no object versioning and no replication (`PutBucketVersioning` and `PutBucketReplication` are
not implemented, per the R2 S3 API compatibility page, last updated 2026-07-31, read 2026-10-09). R2
bucket locks exist, but a lock rule blocks deletion, so it would stop retention and erasure from
deleting personal data; the design does not use them. Without help, a bug that deletes blobs loses
them.

The optional backup covers that case. It is **off by default**, and **on for Pylota Mail Cloud**, which
sets `PM_BACKUP_BUCKET = "pylota-mail-backup"` ([ADR 0011](../adr/0011-plan-items-changed-for-v1.md)
records why a nightly copy replaces the event-driven copy the plan proposed):

- Setting `PM_BACKUP_BUCKET` makes `pmail setup` create that bucket in the deployment's jurisdiction and
  bind it as `BACKUP` ([Configuration](../../reference/configuration.md#variables)).
- Once per UTC day the `*/15` cron starts a `backup` job (`jobs.kind = 'backup'`, `tenant_id = NULL`).
  Its one step lists `t/` in key order (cursor = the last key) and copies to `BACKUP`, under the same
  key and with the same custom metadata, every object uploaded since the previous run's start. Errors
  retry under the JobRunner backoff; the result counts copied, skipped and failed objects
  (`backup_objects_total`).
- The backup never deletes an object that still exists in `BLOBS`. Retention and erasure delete each
  key from `BLOBS` first and then from `BACKUP`, in the same step, and tenant erasure sweeps
  `t/{tenant_id}/` in both. A copy can still be in flight when an erasure runs: the job has read the
  object from `BLOBS` and writes it to `BACKUP` after the erasure deleted both. So after every `put` to
  `BACKUP`, the job sends a `head` for the same key to `BLOBS`; when `BLOBS` no longer has it, the job
  deletes the key from `BACKUP` at once (counted as `backup_objects_total{result=revoked}`). Whatever
  the interleaving, the copy is gone once both the erasure's delete and the job's check have run
  ([I9](../edge-cases.md)). An object deleted from `BLOBS` by anything else before the night's run is
  removed from `BACKUP` by the same check only if the job copies it again; otherwise it stays in
  `BACKUP` until the operator restores or removes it.
- Restoring is a manual copy back from `BACKUP` to `BLOBS` for the affected keys, listed from the
  mailbox rows that point at missing objects.
- Cost: one list operation per 1,000 objects in `t/` each night, and one write per new object.

## 6. Erasure

### 6.1 Request

`POST /v1/erasure-requests` (`erasure:manage`), or `DELETE /v1/identities/{id}` (identity scope,
reason `identity_deleted`), or `DELETE …/messages/{id}` (message scope, reason `message_deleted`).

- Validation runs before anything is written: the target must exist and be in the key's scope
  ([Security › Authorisation](security.md#5-authorisation-and-tenant-isolation)); otherwise the
  resource's `*_not_found`.
- For `counterparty`, the address is normalised (lower case, IDNA A-label domain) and
  `counterparty_hash = hex(HMAC-SHA256(PM_HASH_KEY, address))` is stored in D1. The clear address is
  passed only to the JobRunner, which keeps it in `meta.target_address` until the `finalise` step.
- The response is `202` with the erasure request object (`status: "queued"`, `deadline_at` =
  `created_at` + 24 hours). Repeating a request creates a new request and job; erasure is idempotent,
  so a second run deletes nothing and reports zero counts. This is also how a `failed` message, thread,
  counterparty or identity erasure is restarted: submit it again (the counterparty address is needed
  again, because the failed job's `finalise` deleted it).
- Tenant scope is different, because its job is the only writer of the tenant's status from `erasing` on
  ([I8](../edge-cases.md)). On a tenant already `erasing`, what happens depends on the latest
  tenant-scope request of that tenant:

  | Latest tenant-scope request | Answer |
  |---|---|
  | `queued` or `running` | `200` with that request (the same `era_` ID); nothing starts |
  | `failed` | `202` with a new request whose `resumes_id` is the failed one and whose `deadline_at` is copied from it. Its job **resumes** the failed job: `JobRequest::Start` carries `resume_job_id`, and the new runner first reads the failed runner's `steps` rows (status, cursor, attempts reset to 0, `counts_json`) and its `held` list with `JobRequest::Snapshot`, copies them, and continues at the failed step from its cursor. The receipt is cumulative. A tenant left `erasing` by a failed job is therefore never stuck |
  | `completed_with_holds` | `202` with a new request whose `resumes_id` is that one: a continuation that runs every step again and finishes the erasure if no hold remains, or ends `completed_with_holds` again (section 6.6, "Holds in a tenant being erased") |

  On an `erased` tenant the request returns `409 tenant_erased`. For a non-platform key, any other
  write to an `erasing` or `erased` tenant (or to anything in it) is refused as `*_not_found`
  ([Security § 5.2](security.md#52-order-of-checks), step 4), except the hold routes on a tenant that is
  `erasing` with holds (section 8); reading the tenant and its erasure requests keeps working for its
  partner key (section 6.10). The CLI command `pmail erasure retry <era_id>` submits the same scope and
  target again ([CLI and setup](cli.md#19-command-to-endpoint-map)).
- An erasure request never returns `423 legal_hold`: held items are skipped and listed (FR-PRV-4,
  api.md). Only the single-message `DELETE …/messages/{message_id}` checks the thread's hold first and
  answers `423 legal_hold` without creating a request.

### 6.2 What `EraseRows` deletes

In one transaction per batch, for each message rowid:

1. `DELETE FROM fts WHERE rowid = ?1` and `DELETE FROM fts_tri WHERE rowid = ?1`, and, while a
   tokenizer-mode reindex has created them, the same from `fts_next` and `fts_tri_next`
   ([Search §7.2](search.md#72-reindex-job-analyzer-change)), so a swap can never bring an erased row back.
2. `DELETE FROM messages WHERE rowid = ?1`, cascading to `deliveries`, `attachments`, `labels`, `refs`,
   `chunks` and `verifications`.
3. `DELETE FROM outbox WHERE payload_json` references the message ID (the outbox payload builder stores
   the message ID in a top-level `data.message_id` or `data.message.id`; the delete uses
   `json_extract`).
4. `DELETE FROM idempotency WHERE message_id = ?1`.
5. Update the thread's counters and `participants_json`; delete a thread left with no messages.
6. For a counterparty target, also: delete the `contacts` row for the address, and remove the address
   from `participants_json` of every surviving thread.

Counts returned per batch: messages, attachments, FTS rows (rows deleted from `fts`; `fts_tri` rows are
deleted alongside and not counted), refs, outbox events.

### 6.3 Message and thread scope

| # | Step | Does |
|---|---|---|
| 1 | `init` | Records the target; resolves the identity's `mailbox_do_id` |
| 2 | `erase_mailbox` | `ErasurePlan { Message \| Thread }`. A held thread yields no messages and one `held` entry. For each batch: `deleteByIds(vector_ids)` → delete each R2 key (`raw.eml`, `out/{msg}.eml`, inbound and outbound attachments and their `.md`) from `BLOBS` and, when configured, `BACKUP` → `EraseRows` |
| 3 | `scrub_control_plane` | Delete `event_index` rows for the deleted event IDs; expire the tenant's exports (section 6.11) |
| 4 | `probe` | Section 6.7 |
| 5 | `receipt` | Section 10 |
| 6 | `finalise` | Clears job-local target data |

### 6.4 Counterparty scope ([I1](../edge-cases.md))

A message matches when the normalised address equals `from_address`, appears in `to_json`, `cc_json`,
`bcc_json` or `reply_to_json`, or is a `deliveries.address` of the message. A message that only
mentions the address in its body is not "to or from" the counterparty and is not erased; erase it with
message scope if needed.

| # | Step | Does |
|---|---|---|
| 1 | `init` | Stores `meta.target_address`; lists the tenant's identities (every status except `deleted`), or, when the job's params carry `identity_ids`, only those identities |
| 2 | `erase_mailboxes` | For each identity (cursor `identity_id:rowid`): `ErasurePlan { Counterparty }` → per batch `deleteByIds` → delete R2 keys (in `BACKUP` too, when configured) → `EraseRows { counterparty }`; then `ForgetSender { Counterparty }`. Held threads are collected into `held` |
| 3 | `scrub_control_plane` | `suppressions` for `(tenant_id, counterparty_hash)`: set `note = NULL`, `source_message_id = NULL`, keep the row ([I7](../edge-cases.md)); delete `event_index` rows for deleted event IDs; delete the tenant's `dlq_items` whose pointer's envelope sender or recipient, normalised, is the address (the Worker reads the tenant's rows, at most 14 days' worth, and compares); `DELETE FROM idempotency_records WHERE tenant_id = ?1 AND instr(response_body, ?2) > 0` with the normalised address; expire the tenant's exports (section 6.11). With `PM_CF_API_TOKEN`: `GET /accounts/{PM_CF_ACCOUNT_ID}/email/sending/suppressions?email={address}` and `DELETE …/suppressions/{suppression_id}` for each entry whose scope is `sending_domain` with one of the tenant's domains and that is not `read_only` (our hashed suppression keeps refusing the address, so the provider's clear copy is not needed; [I10](../edge-cases.md)); `account` entries are kept (section 11). Without the token the provider step is skipped and counted in `jobs.result_json` as `provider_suppressions_skipped` |
| 4 | `probe` | Section 6.7, for every identity in `identities_affected` |
| 5 | `receipt` | Section 10 |
| 6 | `finalise` | Deletes `meta.target_address` |

Counterparty erasure is not an objection: mail the counterparty sends afterwards is stored as usual. To
stop contact, the tenant adds a suppression (outbound) or a receive-block entry (inbound).

**Restricting the identities.** `JobRequest::Start` params for a counterparty erasure (stored in
`jobs.params_json`) may carry `identity_ids`, a list of identity IDs of the job's tenant. It is internal
only: `POST /v1/erasure-requests` has no such field and never sets it. Person deletion (section 6.9,
step 5) sets it to the system identity, so a person's deletion erases the system mail sent to them and
leaves the default tenant's other mailboxes untouched. `identities_affected` and the probes then cover only
those identities.

### 6.5 Identity scope (FR-IDN-4)

| # | Step | Does |
|---|---|---|
| 1 | `init` | `identities.status = 'deleting'`; revoke every identity-level key (`revoked_at = now`, `prev_hash = NULL`) |
| 2 | `tombstone_addresses` | For every address row of the identity (all statuses): `INSERT OR IGNORE` into `address_tombstones (address_hash, identity_id, reason)` with reason `erased`, delete the `addresses` row, and delete its literal routing rule. For `DELETE /v1/identities/{identity_id}` the handler has already done the tombstones and row deletes in its D1 batch with reason `deleted` ([Identities and domains › Delete](identity-domains.md#delete-fr-idn-4-a13)) and passes the deleted rows' `(zone_id, routing_rule_id)` pairs in the job's `params_json`, so this step only deletes those rules. From here inbound to these addresses gets `550 5.1.1` ([A6](../edge-cases.md), [A13](../edge-cases.md)) after at most the 60-second directory cache. On an SES domain, each retired address is also removed from the `pm-retired-{n}` rule named by `addresses.ses_bounce_rule` (for `DELETE /v1/identities/{identity_id}` the handler passes these names in `params_json` with the rule pairs), so its mail is dropped like an unknown address's instead of being bounced as retired |
| 3 | `erase_mailbox` | No holds: page through `chunks` for every vector ID → `deleteByIds`; list and delete every R2 object under `t/{ten}/i/{idn}/` (in `BACKUP` too, when configured); `CountAll` (recorded for the receipt); `WipeAll`. With holds: as counterparty step 2 with target `All`, deleting R2 objects by key and keeping held threads |
| 4 | `scrub_control_plane` | `identities`: clear `owner_name`, `owner_email`, `signature_text`, `signature_html`, `client_id`, `client_fingerprint`, set `display_name = ''`, `metadata_json = '{}'`, `send_policy_json = '{}'`, and `status = 'deleted'` (no holds) or keep `deleting` (holds). In one D1 batch, `INSERT OR IGNORE INTO key_tombstones (kid, deleted_at)` the `id` of every `identity_keys` row of the identity, then delete those rows, so a deleted key ID is never published again ([O7](../edge-cases.md); the JWKS already answers `404 identity_not_found` from step 1, when the identity became `deleting`); delete `event_index` and `webhook_deliveries` rows for the identity's events; `QuotaRequest::ForgetIdentity` deletes its `outcomes` and counters; `DELETE FROM idempotency_records WHERE tenant_id = ?1 AND instr(response_body, ?2) > 0` with the identity ID (the identity create and update responses carry the owner's name and address); delete the tenant's `dlq_items` whose pointer names the identity; expire the tenant's exports (section 6.11). Webhook `identity_ids` filters keep the opaque ID: removing it could widen an endpoint to every identity |
| 5 | `probe` | Section 6.7. A wiped mailbox answers `identity_not_found`, recorded as zero hits |
| 6 | `receipt` | Section 10. When the identity is now `deleted` (no holds remain), emits `identity.deleted` with `identity_id` and `erasure_request_id`, once: the event is written only by the job that moves the identity to `deleted` (the first job when there are no holds, otherwise the follow-up `hold_released` job) |
| 7 | `finalise` | — |

**Holds on an identity being deleted.** The request completes as `completed_with_holds`: everything
outside held threads is gone, the addresses are tombstoned, and the identity stays `deleting`. The hold
routes stay usable on a `deleting` identity for tenant, partner and platform keys with `erasure:manage`. When the
daily retention job finds a `deleting` identity with no remaining holds (removed, or `until` passed),
it creates a new identity-scope erasure request with reason `hold_released:{era_id}` and `resumes_id` =
that request, audit-logged, which finishes the deletion and emits `erasure.completed`. Identities of a
tenant that is being erased are handled by the global job's `held_erasures` step instead (section 6.6).

### 6.6 Tenant scope

Order: stop routing, then billing (money stops before anything else is removed), then domains and mailboxes, then D1 rows, then the vector namespace.

| # | Step | Does |
|---|---|---|
| 1 | `stop_routing` | `tenants.status = 'erasing'`, which only this job changes afterwards (a `PATCH` with `status` gets `409 tenant_erased`, and non-platform keys can no longer write to the tenant) (inbound for every tenant address now gets `550 5.1.1`; outbound consumers drop messages for the tenant); revoke every tenant and identity key; disable the tenant's webhook endpoints (`enabled = 0`, `disabled_reason = 'manual'`); cancel the tenant's other running jobs |
| 2 | `cancel_billing` | Skipped when `PM_BILLING=off`, or when the tenant has no `billing_accounts.stripe_customer_id`. Otherwise read the customer's subscriptions (`GET /v1/subscriptions?customer=…`, every status except canceled) and cancel each one, the plan subscription and every top-up subscription, at once: immediate cancellation, with no proration credit and no refund ([Billing › Stripe integration](billing.md#stripe-integration)). The step is done when the read returns none, so a re-run after a partial failure cancels only what is left; a customer Stripe no longer knows counts as done. Failures retry under the job's backoff (section 4). The third failed attempt fires `billing_cancel_failed:{tenant_id}` (page; [Observability › Alert list](observability.md#53-alert-list)), so the operator cancels in the Stripe Dashboard at once, while the step keeps retrying until `deadline_at − 4 h` like any erasure step (section 4). Webhooks for this tenant afterwards are answered `200` and recorded `ignored_erased`, except that a live subscription created after the deletion is cancelled (`cancelled_after_erasure`; [Billing › Webhook endpoint](billing.md#webhook-endpoint)) |
| 3 | `remove_domains` | For each tenant domain, run the `domain_remove` steps of [Identities and domains › Domain removal](identity-domains.md#domain-removal) inline (literal rules, catch-all, routing, sending onboarding, event subscription, the SES identity with `DeleteEmailIdentity` and its DKIM CNAMEs, including a failover identity, the domain's addresses in `pm-retired-{n}` receipt rules, ownership record, zone); then `DomainMonitor` `delete_all` |
| 4 | `erase_identities` | For each identity: identity steps 2 and 3 (tombstone every address, including retired ones; erase the mailbox). An identity with held threads keeps them, with their R2 objects and vectors, and stays `deleting` (below) |
| 5 | `delete_d1_rows` | In this order, all `WHERE tenant_id = ?1`, each table in batches of at most 1,000 rows (section 6.12): `webhook_deliveries`, `webhook_endpoints`, `event_index`, `suppressions`, `sender_lists`, `idempotency_records` (`scope = ?1 OR tenant_id = ?1`: the tenant's own records, and the records of platform and partner keys whose stored response belongs to the tenant, such as the `POST /v1/tenants` that created it), `usage_daily`, `identity_keys` (after `INSERT OR IGNORE INTO key_tombstones` of every row's `id`, as in identity scope), `notification_prefs`, `api_keys`, `identities` (except rows still `deleting` with holds, which are scrubbed as in identity step 4 and kept), `domains`, `exports`, non-erasure `jobs`, `invitations`, `sessions` (active workspace = this tenant), `members`, `billing_events`, `billing_accounts`, `dlq_items`, `audit_log` rows whose `action` does not start with `erasure.` (or `hold.`, while holds remain); then `tenants` set `status = 'erased'`, `name = ''`, `policy_json = '{}'` (the row, slug and suffix stay, so neither is reused; with holds, `status` stays `erasing`); `TenantQuota` `delete_all` and `Notifier` `delete_all`, so no pending notification survives. Every person the `members` delete left with no workspace is then deleted as in section 6.9, which also removes their `oauth_identities`, `login_tokens` and `waitlist` row |
| 6 | `sweep_vectors` | Vectorize has no method to delete a namespace (Vectorize client API, read 2026-10-09: only `deleteByIds`). Query the tenant namespace with a fixed probe vector (`topK = 100`, `returnMetadata: "none"`), `deleteByIds` the IDs returned, wait 10 seconds, and repeat until two consecutive queries return nothing (at most 100 rounds per alarm slice; section 6.8). With holds: skipped, because the held vectors would answer every query; the vectors of everything not held were deleted by ID in step 4, and the continuation runs the sweep |
| 7 | `sweep_r2` | List and delete every object under `t/{tenant_id}/`, in `BLOBS` and, when configured, `BACKUP`. With holds: only `t/{tenant_id}/exports/` and the `t/{tenant_id}/i/{idn}/` prefix of each identity wiped without holds; the other objects of a held identity were deleted by key in step 4, and the continuation sweeps the whole prefix |
| 8 | `probe` | Section 6.7, plus: `t/{tenant_id}/` lists empty; a namespace query returns nothing; D1 counts for the tenant are zero except the kept rows. With holds, the prefix and namespace probes cover only what steps 6 and 7 swept, and held items are excluded as in every scope |
| 9 | `receipt` | Section 10. `erasure.completed` goes to platform endpoints and, for a tenant a partner's key created, to that partner's endpoints (the tenant's own endpoints are disabled). With holds the status is `completed_with_holds` and the tenant stays `erasing` |
| 10 | `finalise` | — |

Suppressions are deleted in tenant erasure because the tenant can no longer send; [I7](../edge-cases.md)
applies to counterparty erasure.

**Holds in a tenant being erased** ([I2](../edge-cases.md)). A tenant erasure never deletes a held
thread, in any step, and the tenant is not `erased` while one remains:

- Each identity with a held thread keeps that thread's messages, their R2 objects and their vectors, its
  mailbox (holding only held threads) and its `identities` row, scrubbed as in identity step 4 and left
  `deleting`. Its addresses are tombstoned and its domains removed like any other, so nothing new
  arrives; its keys and identity keys are gone, so nothing is sent or signed.
- Everything else of the tenant is erased by the same steps: billing, domains, the other identities,
  every other D1 row, people left with no workspace, the `TenantQuota` and `Notifier` objects.
- The request ends `completed_with_holds`, with each held thread in `receipt.held`, and the tenant stays
  `erasing`, so every write from a non-platform key is still refused.
- The held mail stays readable through the API with a platform key, and with the tenant's partner key
  when a partner created it (reads resolve on an `erasing` tenant, [Security § 5.2](security.md#52-order-of-checks)).
  The hold routes (`POST` and `DELETE …/hold`) stay usable on these identities for platform and partner
  keys with `erasure:manage`, so a hold can be extended or released. The tenant's own keys were revoked,
  and a self-serve workspace with no partner is reached by the platform operator only.
- Once no hold remains (released, or `until` passed), the global retention job's `held_erasures` step
  (section 5.3) creates the continuation request, `hold_released:{era_id}`. It runs all ten steps again:
  the steps already done find nothing left, the held threads are now erased, `delete_d1_rows` deletes the
  remaining `identities` rows and `hold.*` audit rows, steps 6 and 7 sweep the namespace and the whole
  prefix, and the tenant becomes `erased`. A continuation can also be started at once with a new
  tenant-scope request (section 6.1).
- Pylota, the first partner, releases its own holds before it erases a tenant, so its erasures end
  `completed`; the rule above is what happens when it does not.

### 6.7 Probes ([F6](../edge-cases.md))

| Probe | How | Receipt field |
|---|---|---|
| Keyword | For each affected identity, `ProbeKeyword { target }`: a search for the erased message IDs and, for counterparty scope, the address as a `participant:` filter ([Search §6.7](search.md#67-deletion-on-erasure)); it must return no hits | `probe.keyword_hits` (sum) |
| Semantic | `getByIds` over every vector ID deleted by the job, in batches (section 6.8); count IDs still returned. Tenant scope adds the namespace query of step 6 | `probe.semantic_hits` |
| Objects | `head` on every deleted R2 key (or a prefix list for identity and tenant scope) | not in the receipt; a non-zero result re-runs the deleting step |

A non-zero probe re-runs the step that should have deleted the item (counted as an attempt). The job
completes only with all probes at zero, except held items.

### 6.8 Waiting for Vectorize

Vectorize mutations are asynchronous: `deleteByIds` returns a mutation ID and the change becomes visible
after a few seconds (Vectorize client API, read 2026-10-09). Deletes are sent in batches of 500, to both
indexes while a re-embed is running ([Search §6.7](search.md#67-deletion-on-erasure)). The semantic
probe calls `getByIds` on the deleted IDs every 10 seconds for up to 2 minutes, until none is returned.
If IDs remain after that, the probe step fails this attempt: the step that deleted them runs again
(re-sending `deleteByIds` for the remaining IDs) under the job's backoff (section 4).

### 6.9 People (console accounts)

A person can delete their own account at `/console/settings` once they own no workspace; otherwise the
request gets `409 owner_required` ([W34](../edge-cases.md),
[Cloud sign-up §10](cloud-signup.md#10-abuse-and-safety-on-cloud)). Tenant erasure runs the same
deletion for every person it leaves with no workspace (section 6.6, step 5).

1. A person deleting their own account first leaves each workspace as in
   [Console › Members](console.md#members): the `members` row and the person's `notification_prefs` rows
   for that workspace are deleted, their pending notifications there are dropped
   ([O19](../edge-cases.md)), the seat is released and `member.removed` is emitted.
2. In one D1 batch: delete the person's `sessions`, the `login_tokens` for their address, their
   `oauth_identities`, their `notification_prefs` rows in every workspace, and any `waitlist` row for
   their address; and scrub the address of the invitations they accepted
   (`UPDATE invitations SET email = ?usr_id WHERE status = 'accepted' AND email = ?address`), whose rows
   stay with their workspaces as the record of who invited the member.
3. In the same batch, scrub the `users` row rather than delete it, because `invitations.invited_by` and
   audit rows refer to its ID: `email` becomes the row's own `usr_` ID; `name`, `last_tenant_id`,
   `terms_version`, `terms_accepted_at`, `totp_sealed`, `totp_enabled_at`, `totp_last_step` and
   `recovery_codes_sealed` are cleared; `status = 'disabled'`. The address is then free, and signing up
   again creates a new person.
4. Write an audit row `user.delete` with `tenant_id = NULL` and only the `usr_` ID in `details_json`.
5. Start a counterparty erasure of the person's former address on the default tenant, with
   `identity_ids` set to the system identity alone (section 6.4, "Restricting the identities"), so the
   sign-in, invitation and notification mail sent to them is deleted now rather than at the 30-day
   cutoff, and mail in the default tenant's other mailboxes is untouched. Its receipt is kept like any
   erasure record.

Invitations to the address that were not accepted stay with the workspaces that sent them: a pending one
expires after 7 days, and the global retention job deletes expired and revoked rows 30 days after
`expires_at` (section 5.3). Section 11 lists them.

### 6.10 Partners

A partner holds only its name, its status, its limits and its default billing mode; its customers' data
lives in its tenants, which tenant erasure covers (section 6.6). A partner key with `erasure:manage` can
start that erasure for each of its own tenants (`POST /v1/erasure-requests` with `scope: "tenant"`).
While the tenant is `erasing` and after it is `erased`, the partner key can still read
`GET /v1/tenants/{tenant_id}` (status, slug and `partner_id`; the name is `''` once erased) and the
tenant's erasure requests (`GET /v1/erasure-requests?tenant_id=…` and `GET /v1/erasure-requests/{id}`,
with the receipt), so it can show its customer the outcome. Every write to that tenant from a
non-platform key gets `404 tenant_not_found` ([I8](../edge-cases.md)).

`DELETE /v1/partners/{partner_id}` (platform key, `partners:manage`) deletes a partner only when every
tenant with its `partner_id` is `erased` ([J12](../edge-cases.md)); otherwise `409 partner_has_tenants`
and nothing changes. It is a soft delete. In one D1 batch, guarded by that condition on every statement
([Data model › Notes](data-model.md#notes)), it:

1. deletes the partner's webhook endpoints (`webhook_endpoints.partner_id`), and with them their delivery
   rows (`ON DELETE CASCADE`);
2. revokes and deletes its partner keys (`api_keys.partner_id`), so their next request is
   `401 unauthenticated`;
3. deletes its `idempotency_records` (`scope` = the partner ID);
4. sets the `partners` row to `status = 'deleted'`, `name = ''` and `deleted_at = now`.

The row stays, so `tenants.partner_id` of its erased tenants keeps pointing at it and is never changed:
the provenance of an erased tenant (which partner created it) survives, and no `NULL` can appear where a
partner was. A deleted partner keeps only its ID, status, limits, billing mode and timestamps, none of
which is personal data. `GET /v1/partners/{partner_id}` shows it with `status: "deleted"`; `PATCH`, a
second `DELETE` and minting a key for it get `404 partner_not_found`.

It writes the audit row `partner.delete` with `tenant_id = NULL` and only the `ptn_` ID as its target.
The `audit_log` rows about the partner (`partner.*`, and `key.create`/`key.revoke` of its keys) keep only
IDs and stay like other audit rows of the deployment. Nothing else refers to the partner.

### 6.11 Exports and copies in flight ([I9](../edge-cases.md))

An export ZIP and a backup copy are copies of mail, so an erasure must reach them too.

- **Exports.** Every erasure scope, in its `scrub_control_plane` step, expires each export of the tenant
  that is `completed` and not yet `expired`: it deletes the ZIP from `BLOBS` (and `BACKUP`) and sets
  `status = 'expired'`. All of them, not only the ones that could hold the erased data: an export lives
  7 days and can be made again, so the simple rule is also the safe one. The export's
  `export.completed` event already went out; a later `GET /v1/exports/{export_id}` shows `expired`.
- **An export running during an erasure.** Its `complete` step (section 9.1) first checks
  `SELECT 1 FROM erasure_requests WHERE tenant_id = ?1 AND completed_at > ?2` with the export's
  `created_at`. If an erasure of the tenant completed after the export started, the ZIP may hold what it
  erased: the job deletes the ZIP, aborts nothing (the upload is complete) and restarts at `init`. A
  second such conflict fails the export (`exports.status = 'failed'`, `details.reason =
  "superseded_by_erasure"` in `jobs.result_json`), and the caller asks again.
- **The backup copy.** Section 5.4: after each `put` to `BACKUP` the job checks that `BLOBS` still has the
  key, and deletes its copy when it does not.

### 6.12 Batched deletes in D1

D1 queues the requests to a database behind the ones it is running: a slow query delays every request
behind it, and a queue that grows too long fails with "D1 DB is overloaded" ([Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/),
read 2026-10-10). A query may run for up to 30 seconds ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
read 2026-10-10). A single `DELETE … WHERE tenant_id = ?1` over a large tenant's `event_index` or
`webhook_deliveries` could hold the database for that long, and every tenant's `email()` directory
lookup would fail over to staging meanwhile. So every bulk delete in a job (retention step 4, tenant
step 5, the global steps) deletes at most 1,000 rows per statement:

```sql
DELETE FROM event_index WHERE rowid IN (
  SELECT rowid FROM event_index WHERE tenant_id = ?1 LIMIT 1000);
```

repeated until a statement deletes nothing, with the step's cursor recording the table it is on. Each
statement uses the index on `tenant_id` (or the cutoff column), so it touches only the rows it deletes.
The alarm slice limit (20 seconds or 1,000 items, section 4) bounds how many statements one slice runs.

## 7. Special cases

### 7.1 Counterparty erasure across identities

The JobRunner iterates every identity of the tenant with the same normalised address, so one request
covers every mailbox (FR-PRV-3). `identities_affected` lists the identities where anything was deleted
or held. Only `counterparty_hash` is stored in D1, so the erasure record does not itself retain the
address.

### 7.2 Suppressions after erasure ([I7](../edge-cases.md))

A suppression records an objection to contact (UK and EU GDPR Art. 21) or a delivery failure the sender
must respect. After counterparty erasure it keeps `address_hash`, `address_hint` (masked, for example
`j***@example.com`), `reason`, `created_at` and `expires_at`, and loses `note` and `source_message_id`.
Sends to the address are still refused because the send path hashes each recipient and looks it up.
The integrator can remove it with `DELETE /v1/tenants/{tenant_id}/suppressions/{address}`.

### 7.3 Allow and block lists

`sender_lists` entries are the tenant's own configuration and are not changed by counterparty erasure:
removing a block entry would re-open contact, and the entry is not a message. The privacy guide tells
integrators to remove entries for an erased counterparty with the lists API when appropriate.

### 7.4 What agent assertions and signed requests disclose

An agent assertion is made to be read by its audience ([Agent signing keys §4.2](agent-keys.md#42-token)).
It discloses the identity's ID (`sub`), its primary address (`email`), its display name (`name`), the
workspace name (`org`), whether the identity has an accountable human (`accountable_human`, a boolean),
`ai_agent: true`, the issuer and the times, plus the `nonce` and `ext` the caller chose. It never holds
the accountable owner's name or address (FR-IDN-2 data), and the service never inspects `ext` beyond
its size and claim-name rules: what goes there is the integrator's choice and responsibility. The token
is never stored or logged; `usage_daily` keeps only a count (`assertions`).

A signed HTTP request discloses to the site the deployment's origin (`Signature-Agent`) and the
identity's primary address in the signed `From` header; nothing is stored but a count
(`http_signatures`). The JWKS and the key directory hold public keys only. The JWKS answers an
unknown, deleted, paused or suspended identity with the same `404 identity_not_found`, and identity IDs
are ULIDs never derived from addresses, so it cannot be used to test whether an address exists.

After identity erasure, only `key_tombstones` remains: thumbprints with no link to the identity, its
tenant or any address. Copies of assertions and signed requests that third parties received are
outside the deployment's reach (section 11).

### 7.5 Notifications

Notification emails go to people's console sign-in addresses and never contain content from mail: no
subject, sender, snippet or attachment name. A `new_mail` email names the inbox address and counts
messages; only mail visible in the inbox is counted, never quarantined, hidden, spam, loopback or
test-tenant mail ([Notifications §1](notifications.md#1-kinds), [O15](../edge-cases.md)). The
`Notifier` object holds person, identity and message IDs and counts, never addresses or content.

Each notification is an ordinary `transactional` send from the system identity on the default tenant,
so its composed message (the person's address, counts, inbox addresses, the workspace name and links)
is kept in the system identity's mailbox for 30 days, and `out/{msg}.eml` for 7 days, whatever the default
tenant's policy says (section 5.2). Deleting the person erases it at once (section 6.9, step 5).

## 8. Legal holds

- `POST /v1/identities/{identity_id}/threads/{thread_id}/hold { "reason", "until" }` sets
  `threads.hold_json = { reason, until, set_by, set_at }`; `DELETE …/hold` clears it. Both need
  `erasure:manage` and write `audit_log` rows (`hold.set`, `hold.removed`).
- A hold is active while `hold_json` is set and `until` is `null` or later than now. An expired hold is
  ignored and cleared by the next retention run (audit `hold.expired`).
- A hold covers the whole thread, including messages that arrive after it was set.
- While active: retention skips the thread (raw and messages); every erasure scope skips it and lists
  `{ thread_id, reason }` in `receipt.held`, and the request ends `completed_with_holds` (FR-PRV-4,
  [I2](../edge-cases.md)). Identity deletion behaves as in section 6.5; tenant erasure keeps the held
  threads, their objects and vectors, keeps the tenant `erasing` and finishes after the last hold ends
  (section 6.6, "Holds in a tenant being erased").
- On an `erasing` tenant, the hold routes are the one write that partner keys may still make (platform
  keys too), so a hold can be extended or released; a new hold can only be set on a thread that still
  exists, which on such a tenant means a held one ([Security § 5.2](security.md#52-order-of-checks)).
- Holds do not hide messages: held threads stay readable and searchable within normal scope rules.

## 9. Subject-access export

`POST /v1/exports` (`erasure:manage`) with `scope: "counterparty"` and `counterparty_address`, or
`scope: "identity"` and `identity_id` (FR-PRV-5, [I3](../edge-cases.md)).

### 9.1 Job steps

| # | Step | Does |
|---|---|---|
| 1 | `init` | Stores the target (clear address in JobRunner `meta` for counterparty scope); starts an R2 multipart upload at `t/{ten}/exports/{exp}.zip` and stores its upload ID in `meta.upload_id` |
| 2 | `collect` | For each identity, `ExportBatch`: for each message, read `raw.eml` (inbound) or `out/{msg}.eml` (outbound) from R2. If the raw object is past `raw_days`, rebuild the message with `mail-builder` from the stored fields and attachments (`eml_source: "reconstructed"`). Remove any `Bcc:` header (`bcc_redacted: true`). Append ZIP entries to the current part; upload a part when it reaches at least 5 MiB. The ZIP central-directory entries for each batch are stored in JobRunner `meta` under `zip_cd:{n}` |
| 3 | `finish_zip` | Writes `messages.json`, the central directory and the end record; completes the multipart upload and deletes `meta.upload_id` |
| 4 | `complete` | If an erasure of the tenant completed after the export's `created_at`, delete the ZIP and restart at `init`, at most once (section 6.11). Otherwise `exports`: `status = 'completed'`, `r2_key`, `size`, `expires_at = created_at + 7 days`; emit `export.completed`; audit `export.completed` |
| 5 | `finalise` | Deletes `meta.target_address` and `zip_cd:*`. Also runs when the export fails or is canceled (section 4): if `meta.upload_id` is still set, it aborts that multipart upload (`R2MultipartUpload.abort()`) so no uploaded part is left behind, and it deletes a completed ZIP of a canceled export |

R2 keeps the uploaded parts of an incomplete multipart upload until it is completed or aborted, and
aborts it after 7 days by default ([Upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/),
read 2026-10-10). `pmail setup` adds a lifecycle rule to `BLOBS` that aborts incomplete multipart uploads
after 1 day (`wrangler r2 bucket lifecycle add … --abort-multipart-days 1`), a backstop for an abort that
never ran ([I11](../edge-cases.md)).

Held, quarantined, hidden and throttled messages are included: an export is a read of everything the
deployment holds about the subject. The ZIP is written with a pure-Rust ZIP writer (for example the
`zip` crate with only a pure-Rust deflate backend), pinned at build time.

### 9.2 ZIP layout

```text
exp_01JA4….zip
├── messages.json
└── eml/
    └── idn_01J9Z3K8V4…/
        ├── 20260914T081203Z_msg_01J9….eml
        └── 20260915T093011Z_msg_01JA….eml
```

### 9.3 `messages.json`

```json
{
  "export_id": "exp_01JA4…",
  "tenant_id": "ten_01J9…",
  "scope": "counterparty",
  "counterparty_hash": "5c1e…",
  "generated_at": "2026-10-09T10:20:00Z",
  "generator": "pylota-mail/1.0.0",
  "identities": ["idn_01J9…", "idn_01JA…"],
  "messages": [
    {
      "id": "msg_01J9…", "identity_id": "idn_01J9…", "thread_id": "thr_01J9…",
      "direction": "inbound", "status": "received", "kind": "normal",
      "from": { "address": "jo@example.net", "name": "Jo Rivera" },
      "to": [ { "address": "bookings.acme@agents.example", "name": "" } ],
      "cc": [], "bcc": [], "reply_to": [],
      "subject": "Change of dates for BK-2291",
      "sent_at": "2026-09-14T08:12:00Z", "received_at": "2026-09-14T08:12:03Z",
      "labels": ["booking"], "flags": [],
      "trust": { "verdict": "pass", "spf": "pass", "dkim": "pass", "dmarc": "pass", "arc": "none",
                 "known_sender": true, "quarantined": false },
      "triage": { "category": "customer_request", "summary": "Asks to move pick-up to Friday.",
                  "needs_reply": 0.92, "urgency": 2, "risk_flags": [] },
      "attachments": [ { "id": "att_01J9…", "filename": "licence.jpg", "content_type": "image/jpeg",
                         "size": 81234, "sha256": "9f2c…" } ],
      "deliveries": null,
      "eml_path": "eml/idn_01J9…/20260914T081203Z_msg_01J9….eml",
      "eml_source": "original",
      "bcc_redacted": false
    }
  ]
}
```

- `deliveries` is set for outbound messages: `[{ "address", "field", "status", "smtp_code", "updated_at" }]`.
- In a counterparty export, `bcc` contains the counterparty's own address when present and nothing
  else; other Bcc recipients are never disclosed.
- Messages contain other people's data. The controller reviews the export before disclosing it.

### 9.4 Download link

`GET /v1/exports/{export_id}` returns `download_url`, minted on each read with the current `link` key in
the signed link format of [Security › Signed links](security.md#73-signed-links):

```text
https://mail.example.com/v1/links/{token}
payload = "l1:{kid}:export:{tenant_id}:{export_id}:{expires_unix_s}"     expires = the export's expires_at
```

- The download needs no API key; the MAC authenticates it. A bad MAC, an expired link or an expired
  export returns `404 export_not_found`.
- The response is the ZIP with `Content-Type: application/zip`,
  `Content-Disposition: attachment; filename="exp_….zip"` and the attachment-serving headers of
  [Security](security.md#85-serving-attachments-and-raw-mime).
- `GET /v1/links/{token}` serves both export and large-attachment links
  ([REST API](../../reference/api.md#get-v1linkstoken)).

## 10. Receipt

The receipt matches the [erasure request object](../../reference/api.md#erasure-request-object):

```json
{
  "messages_deleted": 14, "attachments_deleted": 9, "r2_objects_deleted": 38,
  "fts_rows_deleted": 14, "refs_deleted": 51, "vectors_deleted": 63,
  "events_deleted": 31, "identities_affected": ["idn_01J9…", "idn_01JA…"],
  "held": [ { "thread_id": "thr_01JA…", "reason": "PCN dispute WM12345678" } ],
  "probe": { "keyword_hits": 0, "semantic_hits": 0 }
}
```

| Field | Counts |
|---|---|
| `messages_deleted` | `messages` rows deleted (including by `WipeAll`, from `CountAll`) |
| `attachments_deleted` | `attachments` rows deleted |
| `r2_objects_deleted` | R2 objects whose delete succeeded or that were already absent at the planned key |
| `fts_rows_deleted` | Rows deleted from `fts` (one per message) |
| `refs_deleted` | `refs` rows deleted |
| `vectors_deleted` | Vector IDs passed to `deleteByIds` (including the tenant namespace sweep) |
| `events_deleted` | `outbox` rows deleted |
| `identities_affected` | Identities where anything was deleted or held |
| `held` | One entry per held thread skipped |
| `probe` | Section 6.7; `null` values only when the job failed before the probe step |

- `status` is `completed`, `completed_with_holds` (at least one `held` entry) or `failed`.
- A receipt is always produced (NFR-PRV-1): a failed job writes the counts reached so far, and
  `erasure.failed` carries the failed step and error code.
- The receipt is stored in `erasure_requests.receipt_json` and `jobs.result_json`, and sent in
  `erasure.completed`.

## 11. What remains after deletion

| Residual | Duration | Notes |
|---|---|---|
| D1 Time Travel | 30 days (Workers Paid) | A restore within that window brings erased D1 rows back ([I6](../edge-cases.md)) |
| Durable Object point-in-time recovery | 30 days | Covers each SQLite-backed object's whole database |
| R2 | None by default | R2 has no versioning, point-in-time recovery or replication, so a deleted object is gone. The optional backup bucket (section 5.4) is deleted from in the same steps as `BLOBS`, so it holds no erased data. A deployer who copies the bucket any other way must apply erasure to that copy too; `it::erasure::i6_backup_purge` asserts that no object remains under erased prefixes in `BLOBS` or `BACKUP` and that the Worker has no other R2 binding |
| Suppressions | Until expiry or removal | Hash and masked hint only ([I7](../edge-cases.md)) |
| Address tombstones | Permanent | Keyed hash only ([A5](../edge-cases.md)) |
| Erasure records | Life of the deployment | Counterparty hash, reason, counts |
| Cloudflare Email Sending activity log | 30 days | Processor-side; outside the Worker's reach |
| Cloudflare Email Routing activity log and analytics | 31 days | Processor-side: per received message the sender, recipient, subject and Message-ID (the `emailRoutingAdaptive` dataset keeps "the past 31 days"; [Metrics and analytics](https://developers.cloudflare.com/email-service/observability/metrics-analytics/), read 2026-10-10). Outside the Worker's reach |
| Cloudflare Email Sending suppressions at `account` scope, and `read_only` `policy` entries | Complaints and some hard bounces never expire; others 7 days or 24 hours | Clear addresses. Account-scope entries can come from any sending domain of the account and cannot be attributed to one tenant, so counterparty erasure leaves them; Cloudflare-managed `policy` entries cannot be deleted through the API ([Suppression lists](https://developers.cloudflare.com/email-service/concepts/suppressions/), read 2026-10-10). The operator can delete an account-scope entry by hand (`DELETE /accounts/{account_id}/email/sending/suppressions/{suppression_id}`) when a data subject asks; doing so lets mail to the address be sent again where our own suppression has expired ([I10](../edge-cases.md)) |
| Amazon SES account-level suppression list (SES transport) | Until removed | Clear addresses that hard-bounced or complained. Kept for the same reason; the operator can remove one with SES `DeleteSuppressedDestination` ([I10](../edge-cases.md)) |
| R2 `inbound-staging/` objects | At most 15 days | Raw messages that were staged because the directory lookup failed, or that came through SES. Not keyed by tenant; a staged message for an erased address is refused (`550 5.1.1`) when it is routed and its object deleted |
| `tenants` slug and address suffix of an erased tenant | Life of the deployment | Kept so that neither is reused; the basis is in section 3 ("Names kept after tenant erasure") |
| Restore working files | Until `pmail ops restore cleanup`, which the runbook runs at its end | The D1 exports a restore writes on the operator's machine (mode `0600`) hold every D1 row, including addresses ([Observability › Restore from PITR](observability.md#restore-from-pitr)) |
| Email preview | About 7 days | Disabled by onboarding; residual only if re-enabled by hand |
| Amazon S3 inbound objects (SES domains) | Until ingested; never longer than 14 days | Deleted by the consumer once every recipient is done, or by the lifecycle rule; a message erased in that window can still sit in S3 until then |
| Amazon SQS notifications (SES domains) | Until the backstop cron handles them; at most 14 days | Envelope addresses and headers of received mail |
| SES itself (if used) | As configured in the deployer's AWS account | Processor-side |
| `ses_ingest` rows | 30 days | Object key and agent recipient address; not keyed by tenant, so tenant erasure leaves them to the global retention job |
| Scrubbed `users` rows | Life of the deployment | The opaque `usr_` ID only, kept because invitations and audit rows refer to it |
| Invitations to a deleted person's address that were not accepted | Pending: until they expire (7 days). Expired or revoked: 30 days after `expires_at` | The clear address, role and inviting workspace. They belong to the workspaces that sent them; the global retention job deletes them (section 5.3). Accepted invitations keep only the person's `usr_` ID (section 6.9) |
| Stripe (Cloud billing) | As Stripe keeps its customer and invoice records | Processor-side. Tenant erasure's `cancel_billing` step cancels the plan subscription and every top-up subscription at once, with no proration and no refund, right after routing stops and before anything else is removed (section 6.6); it does not delete the Stripe customer or its invoices, which Stripe keeps under its own retention |
| `billing_events` rows of an erased tenant written after the erasure | 400 days | Stripe event IDs of the webhooks that follow the cancellation, recorded `ignored_erased` (or `cancelled_after_erasure` when a late subscription had to be cancelled); deleted by the global retention job (section 5.3) |
| Webhook receivers | The integrator's systems | The integrator must apply erasure to copies it received |
| Verifiers of agent assertions and sites that received signed requests | The third party's systems | They hold what the tokens and `From` headers disclosed (section 7.4): the identity's address, display name and workspace name |
| Key tombstones | Permanent | Thumbprints of deleted identity keys only ([O7](../edge-cases.md)) |
| Workers Logs | 7 days | Pseudonyms only |

**Restores and erasure** ([I6](../edge-cases.md)). A D1 or Durable Object restore can resurrect erased
data. The restore runbook ([Observability](observability.md#restore-from-pitr)) therefore:

1. exports the whole D1 database **before** restoring, while the deployment is frozen, and after the
   restore re-applies every change made after the restore point `T` that the restore is not meant to
   undo, deletions included (`pmail ops restore d1`), so erased D1 rows, suppressions, tombstones, member
   removals and key revocations made after `T` come back as they were;
2. re-applies, after a mailbox restore, every erasure request that completed after `T`:
   `POST /v1/platform/erasure-requests/{erasure_id}/reapply` creates a new request with reason
   `reapply_after_restore:{era_id}` from the stored row alone. Message and thread scope use the stored
   `identity_id` and `target_id`; identity and tenant scope the stored IDs; counterparty scope matches by
   the stored `counterparty_hash` (`CounterpartyHash` target, section 4.1), because the address itself
   is kept nowhere. Erasure requests and their receipts are never lost to a D1 restore, because step 1
   re-inserts the rows written after `T`.

## 12. Logs

Logs follow [Security › Logging rules](security.md#12-logging-rules): no content, no clear addresses,
pseudonyms only, `invocation_logs = false`. Dead-letter records keep pointers in D1 for at most 14 days and
are never returned by `GET /v1/platform/dlq` (`pmail dlq list`): it shows the queue, kind, tenant and
times only. The [I5](../edge-cases.md) test greps the captured output of the whole integration run for
canaries.

## 13. Tests

| Test | Proves | Covers |
|---|---|---|
| `it::erasure::i1_counterparty` | Counterparty erasure across two identities removes rows, attachments, extracted text, FTS (and `fts_next` while a tokenizer reindex runs), refs, vectors, raw and sent copies, outbox events and the contact; surviving threads lose the participant; the counterparty's `rate_windows` rows, the tenant's `dlq_items` naming the address and the `idempotency_records` whose body contains it are gone; receipt counts match the seeded data; probes are zero | [I1](../edge-cases.md), FR-PRV-3 |
| `it::erasure::i2_hold` | Held threads survive retention and every erasure scope; the receipt lists them with reasons; status `completed_with_holds`; hold expiry releases them | [I2](../edge-cases.md), FR-PRV-4 |
| `it::erasure::i2_hold_tenant_scope` | Tenant erasure of a workspace with one held thread: billing, domains, the other identities and every other D1 row are erased; the held thread's messages, R2 objects (both buckets) and vectors survive, its identity stays `deleting` and the tenant stays `erasing`; the receipt is `completed_with_holds`; the partner key reads the held thread and releases the hold (`DELETE …/hold`), while every other partner-key write gets `404`; the next `held_erasures` run creates `hold_released:{era_id}`, which erases the thread, sweeps the namespace and the prefix, and leaves the tenant `erased` | [I2](../edge-cases.md), section 6.6 |
| `it::erasure::f6_probe_empty` | After erasure, keyword, semantic and object probes return nothing; a fake Vectorize that keeps one vector makes the job retry, then fail with `erasure.failed` | [F6](../edge-cases.md), FR-SRCH-11 |
| `it::privacy::system_mail_retention_and_person_delete` | The system identity's mailbox drops messages after 30 days and raw MIME after 7 even when the default tenant keeps mail forever; deleting a person erases the sign-in, invitation and notification mail sent to them at once, through a counterparty erasure whose `identity_ids` is the system identity alone: mail to or from the same address in the default tenant's other identities is untouched, and the receipt's `identities_affected` names only the system identity | FR-PRV-2, FR-PRV-3, section 6.4 |
| `it::erasure::i6_backup_purge` | With `BACKUP` bound, every erasure scope leaves no object under erased prefixes in either bucket; no R2 binding other than `BLOBS` and `BACKUP` | [I6](../edge-cases.md) |
| `it::erasure::i6_reapply_by_hash` | After a simulated mailbox restore to before a counterparty, a message and an identity erasure, `POST /v1/platform/erasure-requests/{id}/reapply` erases the same data again from the stored rows alone: the counterparty one by `counterparty_hash` with no address supplied; the new requests carry reason `reapply_after_restore:{era_id}`; probes are zero | [I6](../edge-cases.md), section 11 |
| `it::erasure::i9_inflight_copies` | An erasure expires the tenant's completed exports (ZIP deleted, status `expired`); an export running across a completed erasure deletes its ZIP and restarts once, and a second conflict fails it; a backup copy written after an erasure deleted its key from both buckets is removed by the backup job's own check (`backup_objects_total{result=revoked}`) | [I9](../edge-cases.md), sections 5.4, 6.11 |
| `it::erasure::i10_provider_suppressions` | With the Cloudflare API fake holding an `account` entry, a `sending_domain` entry on the tenant's domain, one on another tenant's domain and a `read_only` entry for the erased address, counterparty erasure deletes only the tenant's `sending_domain` entry; without `PM_CF_API_TOKEN` it skips and counts `provider_suppressions_skipped`; domain removal deletes every `sending_domain` entry of the domain | [I10](../edge-cases.md), sections 2, 6.4 |
| `it::jobs::i11_finalise_on_fail_and_cancel` | A counterparty erasure failed past its deadline and one canceled by a tenant erasure both end with no `target_address` in the runner's `meta`; a failed and a canceled export leave no open multipart upload (the R2 fake lists none) and no ZIP | [I11](../edge-cases.md), section 4 |
| `it::erasure::batched_deletes` | Tenant erasure and the retention `events` step delete 5,000 `event_index` and `webhook_deliveries` rows of one tenant in statements of at most 1,000 rows each, resuming from the cursor after an injected failure | section 6.12 |
| `it::retention::global_job_steps` | The global job runs its steps in order, resumes after a failed step without repeating a finished one, and writes one audit row per step with its counts; the `idempotency`, `platform_events`, `jobs`, `usage`, `dlq`, `signing_keys` and `staging` steps delete (or, for `staging`, re-queue) exactly the rows past their cutoff | section 5.3 |
| `it::retention::global_console_rows` | The `console` step deletes `login_tokens` 24 hours past expiry, `sessions` 30 days after expiry or revocation, and `invitations` expired or revoked more than 30 days ago; pending and accepted invitations stay | section 5.3 |
| `it::retention::global_billing_events` | The `billing_events` step deletes rows received more than 400 days ago, including those of an erased tenant | section 5.3 |
| `it::retention::global_ses_ingest` | The `ses_ingest` step deletes `done`, `dropped` and `lost` rows 30 days after `done_at`, and never a `queued` or `held` row | section 5.3 |
| `it::retention::global_signup_rows` | The `signup` step deletes `oauth_states` 24 hours past expiry and `waitlist` rows 30 days after their invitation; an uninvited row stays | section 5.3 |
| `it::retention::global_identity_keys` | The `identity_keys` step marks `retiring` keys past `verify_until` `retired` and keeps the rows; the JWKS output is unchanged by the step | section 5.3 |
| `it::retention::backup_copy` | The nightly `backup` job copies new `t/` objects with their metadata, never deletes, and a retention purge removes the key from both buckets | section 5.4 |
| `it::erasure::i7_suppression_kept_hashed` | After counterparty erasure the suppression keeps hash, hint and reason, loses note and source, and still blocks a send | [I7](../edge-cases.md) |
| `it::erasure::message_and_thread_scope` | Message and thread scopes delete exactly their targets | FR-PRV-3 |
| `it::erasure::identity_scope` | Addresses tombstoned (`550 5.1.1` afterwards; on an SES domain, removed from `pm-retired-{n}` and dropped like unknown mail), keys revoked, identity keys deleted with their kids in `key_tombstones`, mailbox wiped and refusing requests, D1 row scrubbed, the tenant's `idempotency_records` and `dlq_items` naming the identity deleted, `identity.deleted` emitted | FR-IDN-4, [A13](../edge-cases.md) |
| `it::assertions::erasure_tombstones_kid` | Identity erasure deletes the identity's keys; their kids are in `key_tombstones` and are never published again, and key generation refuses a tombstoned thumbprint | FR-IDN-9, [O7](../edge-cases.md) |
| `it::erasure::identity_with_hold_continues` | An identity with a held thread ends `completed_with_holds`; removing the hold leads to a continuation request that completes the deletion | section 6.5 |
| `it::erasure::tenant_scope_order` | Routing stops first (inbound rejected while mailboxes still exist), then the `cancel_billing` step runs before any domain or mailbox is removed, then domains, mailboxes, D1 rows and the vector sweep; the tenant ends `erased`; platform endpoints, and for a partner's tenant the partner's endpoints, receive `erasure.completed` | section 6.6 |
| `it::partners::j12_delete_with_tenants` | A partner with a tenant that is not erased cannot be deleted (`409 partner_has_tenants`); after the tenant's erasure, deleting the partner keeps the row with `status: "deleted"` and an empty name, revokes and deletes its keys, deletes its endpoints, their deliveries and its idempotency records, leaves `partner_id` unchanged on the erased tenant, and writes `partner.delete`; `PATCH`, a second `DELETE` and a key mint for it get `404 partner_not_found` | section 6.10, [J12](../edge-cases.md) |
| `it::erasure::i8_erasing_tenant_frozen` | While a tenant is `erasing` and after it is `erased`, every write from its partner key (identity create, send, domain add, key mint, webhook create, `PATCH` of the tenant) gets `404 tenant_not_found` or the resource's `*_not_found`, and the tenant's own keys get `401 key_revoked`; the partner key still reads the tenant and its erasure requests with the receipt; a second tenant-scope erasure returns `200` with the same `era_` while the first is `running`, and `409 tenant_erased` once `erased`; after the job is made to fail past its deadline (the tenant still `erasing`), a new tenant-scope request from the partner key returns `202` with a new `era_` whose `resumes_id` is the failed one and whose `deadline_at` is copied, and its job starts at the failed step (earlier steps are not re-run) and leaves the tenant `erased`; a platform key's `PATCH` with `status` gets `409 tenant_erased`; the tenant's idempotency records, those of the platform and partner keys whose response belongs to the tenant included, are gone after the job | sections 6.1, 6.6, 6.10, [I8](../edge-cases.md) |
| `it::erasure::tenant_cancels_billing` | With the Stripe fake holding a plan subscription and two top-up subscriptions, tenant erasure cancels all three at once, with no proration, as its second step, right after routing stops and before any domain, mailbox or D1 row is removed; a failing Stripe call is retried with backoff and the third failure fires `billing_cancel_failed`; with `PM_BILLING=off`, or no Stripe customer, the step is skipped; a `customer.subscription.deleted` webhook after the erasure is answered `200` and recorded `ignored_erased`, while a live subscription created after the deletion is cancelled (`cancelled_after_erasure`, [Billing › Tests](billing.md#tests)) | section 6.6 |
| `it::erasure::tenant_console_rows` | After tenant erasure no `members`, `invitations`, `sessions`, `notification_prefs`, `identity_keys` or billing rows remain for the tenant, every deleted kid is in `key_tombstones`, and the tenant's `Notifier` holds nothing; a member of another workspace keeps their account; a person left with no workspace is scrubbed and loses `oauth_identities`, `login_tokens` and `waitlist` rows | section 6.6 |
| `it::erasure::tenant_ses_rows` | With the SES fake, tenant erasure of a workspace with an SES domain (`dns_records` or `send_only`) removes every address of that domain from the `pm-retired-{n}` receipt rules, so later mail to them is dropped like unknown mail, and leaves no SES identity for the domain | section 6.6 |
| `it::erasure::person_scope` | Account deletion is refused while the person owns a workspace; otherwise it ends each membership, deletes sessions, tokens, `oauth_identities`, every `notification_prefs` row and the `waitlist` row, scrubs the address of the invitations they accepted, and scrubs the `users` row | section 6.9, [W34](../edge-cases.md) |
| `it::notify::member_removed_drops_pending` | Removing a member deletes their notification preferences in that workspace and drops their pending items | [O19](../edge-cases.md) |
| `core::notify::no_content_in_body`, `it::notify::invisible_mail_never_notifies` | A rendered notification holds no subject, sender, snippet or attachment name from the source message; mail that is not visible in the inbox is never counted | section 7.5, [O15](../edge-cases.md) |
| `it::erasure::step_retry_and_fail` | Injected R2 and Vectorize faults retry with backoff and resume from the cursor without double counting; the third consecutive failure fires `erasure_stalled`; the job keeps retrying hourly past 10 attempts and becomes `failed`, with a partial receipt and `erasure.failed`, only on the first failed attempt after `deadline_at − 4 h`; a non-erasure job fails after 10 attempts and fires `job_failed:{kind}` | NFR-PRV-1 |
| `it::identities::a5_tombstone_blocks_reuse` | A deleted address cannot be assigned to any identity in any tenant | [A5](../edge-cases.md) |
| `it::export::i3_counterparty` | ZIP layout, one `.eml` per message, `messages.json` schema, reconstructed messages after `raw_days`, Bcc redaction, a 7-day signed link that fails when tampered or expired | [I3](../edge-cases.md), FR-PRV-5 |
| `it::retention::i4_raw` | Raw MIME older than `raw_days` deleted, `410 raw_expired` afterwards, audit row written | [I4](../edge-cases.md), FR-PRV-2 |
| `it::retention::i4_messages` | With `message_days` set, messages, attachments, index rows and vectors are purged, except held threads | [I4](../edge-cases.md) |
| `it::retention::i4_events` | Outbox, `event_index` and `webhook_deliveries` older than `events_days` purged; with `events_days` = 10, replay reaches back 10 days, and with `events_days` = 90, still only 30 | [I4](../edge-cases.md), section 5.2 |
| `it::logs::i5_no_content_in_logs` | No content or clear address in captured output, including the dead-letter consumer's log lines | [I5](../edge-cases.md), FR-PRV-6 |
| `it::domains::preview_disabled` | Onboarding a sending domain sets `preview_enabled: false` (Cloudflare API fake) | section 3 |
| `core::jobs::receipt_builder` | Receipt counts and status derived from step counts; `held` forces `completed_with_holds` | section 10 |
| `core::jobs::backoff_schedule` | Step backoff 30 s doubling to a 1-hour cap; a non-erasure job fails after 10 attempts; an erasure job fails only on the first failed attempt after `deadline_at − 4 h`; `erasure_stalled` on the third consecutive failure | section 4 |
