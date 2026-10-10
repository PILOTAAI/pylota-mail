# Privacy, retention and erasure

Pylota Mail stores other people's email, so it is built to keep data where you choose, for as long as
you choose, and to delete it provably. This guide covers the jurisdiction, what is stored where,
retention, erasure with receipts, legal holds, subject-access export, what agent assertions and
notification emails disclose, and the places where data remains after an erasure (and why). The design is in [Privacy and erasure](../project/design/privacy.md).

You, as the operator of the deployment (and your integrators, for their tenants), remain responsible
for your legal obligations. This guide describes what the software does.

## Choosing a jurisdiction

`pmail setup --jurisdiction` takes `eu` (the default) or `default`
([FR-PRV-1](../project/prd.md#612-privacy)):

- `eu` creates D1, the R2 bucket and **every Durable Object** with Cloudflare's EU jurisdiction, so the
  data they hold is stored in the EU.
- `default` applies no jurisdiction restriction.

The choice is made when the resources are created and **cannot be changed later**. Moving a deployment
to another jurisdiction means a new deployment.

The jurisdiction controls where data is stored at rest in D1, R2 and Durable Objects. Request
processing by Workers, Email Routing, Email Sending and Workers AI runs on Cloudflare's network, and
Vectorize has no documented data-location option (see [Vectorize](#vectorize-residency)).

### Amazon Web Services (optional)

AWS is involved only if you connect domains through Amazon SES: the `dns_records` and `send_only`
methods, `smtp_relay` with SES receiving, or a switch to SES as the backup sender
([Custom domains](custom-domains.md)). Then SES sends and receives that mail in the region you set in
`PM_SES_REGION`, and AWS becomes a sub-processor you list in your records. With the `eu` jurisdiction,
`pmail setup ses` refuses a region outside the EU and the UK unless you pass `--allow-non-eu`, and
`/health` shows `ses_region` so anyone can check it. For the SES region, `eu` means "EU or UK": the UK
has an EU adequacy decision under the GDPR, so London (`eu-west-2`) is accepted. Cloudflare's `eu`
jurisdiction for D1, R2 and Durable Objects means the European Union only. Without SES, nothing goes to AWS.

A domain that sends through your own mail provider (`smtp_relay`) sends its messages to that provider,
under your own agreement with them.

## What is stored where

| Store | Holds | Jurisdiction applies |
|---|---|---|
| Durable Object SQLite (one per identity) | Threads, messages (text, sanitised HTML, extracted text), recipients, attachment metadata, labels, the keyword index, references, contacts, triage results, the send ledger, idempotency records, the event outbox, verification codes | Yes |
| D1 | The control plane: tenants, identities, the address directory, domains, hashed API keys, identity signing keys (sealed) and tombstoned key IDs, webhook endpoints and delivery logs, suppressions (hashed), allow and block lists, jobs, erasure requests, the audit log, usage counts, console accounts, memberships, sessions and notification preferences | Yes |
| R2 | Raw `.eml` files, attachments, extracted attachment text, composed outbound messages, subject-access exports | Yes |
| Vectorize | One vector per chunk of message or attachment text, with filter fields: identity, thread, date, sender domain, direction, has-attachment, verdict and chunk kind. **Never text, subjects or addresses** | No documented option |
| Queues | Pointers only, never content. Dead-letter queues keep items at most 14 days | – |
| Amazon S3 (SES domains only) | Raw incoming mail, until Pylota Mail has taken it in. Encrypted at rest, no public access | Your SES region |
| Amazon SQS (SES domains only) | A backup copy of each "mail arrived" notice: sender and recipient addresses and the message headers, including the subject | Your SES region |
| Your webhook endpoints | Event payloads: IDs, a header summary, verdicts, triage and up to `policy.webhook_text_bytes` of extracted text (default 16 KB) | Your systems |

Full schema: [Data model](../project/design/data-model.md).

## Retention

Each tenant's policy sets how long data is kept ([FR-PRV-2](../project/prd.md#612-privacy)):

```json
{ "policy": { "retention": { "raw_days": 90, "message_days": null, "events_days": 30 } } }
```

| Field | Default | What is purged |
|---|---|---|
| `raw_days` | 90 | Raw MIME (`raw.eml`) and composed outbound copies in R2. Afterwards `GET …/raw` returns `410 raw_expired`; the parsed message stays |
| `message_days` | `null` (keep) | When set, messages older than this, with their attachments, extracted text, index rows, references and vectors |
| `events_days` | 30 (1–365) | Event and delivery logs: webhook delivery rows, the event index in D1 and the event payloads kept for replay. Webhook replay reaches back 30 days from an event's `occurred_at`, or `events_days` if shorter |

- Retention sweeps run on a schedule. Every purge writes an audit event
  ([I4](../project/edge-cases.md)).
- **Held threads are never purged** by retention (see [Legal holds](#legal-holds)).
- Shorter `raw_days` means less raw mail to protect, but you lose the ability to re-parse old messages
  if a parser bug is fixed later ([J3](../project/edge-cases.md)).

Some data has a fixed lifetime regardless of policy:

| Data | Kept for |
|---|---|
| Verification codes and links found by `wait` | 24 hours |
| Unrouted inbound mail in R2 staging | At most 15 days (normally seconds) |
| Raw incoming mail in Amazon S3 (SES domains) | Deleted as soon as it is taken in (normally seconds); never more than 14 days |
| "Mail arrived" notices in Amazon SQS (SES domains) | Deleted once handled, normally within a minute; never more than 14 days |
| Subject-access export files | 7 days |
| Idempotency records | 30 days |
| Dead-letter queue items (pointers) | At most 14 days |

## Erasure

An erasure request deletes data from every store together: mailbox rows, attachments, extracted text,
the keyword index, references, vectors and raw R2 objects ([FR-PRV-3](../project/prd.md#612-privacy)).
It needs `erasure:manage`.

| `scope` | Also needs | Deletes |
|---|---|---|
| `message` | `identity_id`, `message_id` | One message and everything derived from it |
| `thread` | `identity_id`, `thread_id` | Every message in the thread |
| `counterparty` | `counterparty_address` | Every message to or from that address, in every identity of the tenant, including sent copies and outbox events ([I1](../project/edge-cases.md)) |
| `identity` | `identity_id` | The whole mailbox and the identity's signing keys. Its addresses and key IDs are tombstoned: the addresses can never be reassigned, and the key IDs are never published again |
| `tenant` | none | Everything in the tenant. The tenant is then marked `erased` |

```bash
curl -X POST https://mail.example.com/v1/erasure-requests \
  -H "Authorization: Bearer $PRIVACY_KEY" -H "Content-Type: application/json" \
  -d '{"tenant_id":"ten_01J9…","scope":"counterparty","counterparty_address":"jo@example.net",
       "reason":"Data subject request DSR-1182"}'
```

The response is `202` with the erasure request. CLI: `pmail erasure create`. Shortcuts exist too:
`DELETE …/messages/{message_id}` starts a `message`-scope erasure, and `DELETE /v1/identities/{id}`
starts an `identity`-scope erasure.

### The receipt

When the request completes, its `receipt` counts what was deleted in each store, and records probe
searches run afterwards:

```json
{
  "id": "era_01J9…", "scope": "counterparty", "status": "completed",
  "receipt": {
    "messages_deleted": 14, "attachments_deleted": 9, "r2_objects_deleted": 38,
    "fts_rows_deleted": 14, "refs_deleted": 51, "vectors_deleted": 63,
    "events_deleted": 31, "identities_affected": ["idn_01J9…", "idn_01JA…"],
    "held": [ { "thread_id": "thr_01JA…", "reason": "PCN dispute WM12345678" } ],
    "probe": { "keyword_hits": 0, "semantic_hits": 0 }
  }
}
```

- `probe` shows that keyword and semantic searches for the erased data returned nothing afterwards
  ([F6](../project/edge-cases.md)).
- `held` lists every thread that was skipped because of a legal hold, with the hold's reason
  ([FR-PRV-4](../project/prd.md#612-privacy)).
- Erasure completes within 24 hours, and always produces a receipt
  ([NFR-PRV-1](../project/prd.md#7-non-functional-requirements)).

Check progress with `GET /v1/erasure-requests/{id}` (`pmail erasure get`). An `erasure.completed`
event carries the request with its receipt. A step that fails is retried automatically until 20 hours
after the request; if it still fails, the request ends `failed` and an `erasure.failed` event names the
step. Restart it with `pmail erasure retry <id>`: a workspace (tenant) erasure then continues from the
step that failed and keeps the original deadline; other scopes run again (a counterparty erasure needs
the address again, because it is never stored). Keep receipts (or the events) outside the deployment: they are
your evidence that the request was carried out, and you need them after a restore (see
[Backups and residual retention](#backups-and-residual-retention)).

### What erasure does not reach

- **Copies outside the deployment**: your application's database, logs, queues and model provider
  logs, and anything your webhook endpoints stored. Erase those when `erasure.completed` arrives.
- **Mail already delivered** to recipients' own mailboxes.
- **Suppressions**, which are kept on purpose, as a hash (see below).
- **Point-in-time backups** for up to 30 days (see below).
- **Provider suppression lists**: the address stays on Amazon SES's account-level list, and on
  Cloudflare's list where the entry is account-wide or managed by Cloudflare; entries for your own
  sending domains on Cloudflare's list are deleted. Your hashed suppression keeps the address from being
  mailed either way. The operator can remove a remaining entry by hand when a person asks.
- **Provider logs**: Cloudflare keeps sender, recipient and subject of received mail in its Email
  Routing logs for 31 days, and its Email Sending activity log for 30 days.
- **Unrouted staged mail**, kept at most 15 days while the address lookup was failing.
- **Mail still waiting in Amazon S3** on an SES domain. It is normally taken in and deleted within
  seconds, and never stays more than 14 days.

## Console accounts

For each person who uses the console, Pylota Mail stores their sign-in address and name, the workspaces
they belong to and their role, their sessions (with the browser family only), their notification
preferences in each workspace, and when they accepted the terms. If they use Google or GitHub, it stores
that provider's account ID and the address at the time of linking. A two-step verification secret and
recovery codes are stored encrypted.

- A person can delete their own account under **Settings** once they own no workspace. That ends their
  memberships and sessions, removes their Google and GitHub links, their notification preferences and
  any waitlist entry, and replaces their address with an opaque ID on the invitations they accepted.
- Removing a member from a workspace deletes their notification preferences there and drops any
  notifications still waiting for them.
- Deleting a workspace erases it like any tenant, and also removes its members, invitations and sessions.
  People left with no workspace are deleted too. With billing on, the step right after the workspace's
  mail stops cancels its plan and top-up subscriptions at once, with no proration and no refund, before
  anything is deleted.
- Invitations that expired or were revoked are deleted 30 days after their expiry date.
- A waitlist entry is written only when its confirmation link is used; an unused confirmation link
  expires after 10 minutes. Entries are deleted 30 days after the person was invited.

## What agents and notifications disclose

**Agent assertions.** An [agent assertion](agents.md#agent-assertions) shows its audience, the service
it was made for, the identity's address, display name and workspace name, and whether a person is
accountable for the identity (`accountable_human`). That is its purpose. It never contains the owner's
name, address or any other personal data of the owner. A
[signed HTTP request](agents.md#signed-http-requests) shows the identity's address to the site, in its
`From` header. Neither tokens nor signatures are stored or logged; only daily counts are kept.

**Notification emails** go to a person's sign-in address and carry counts only: never a subject, a
sender, a snippet or an attachment name from mail
([Receiving › Notifications by email](receiving.md#notifications-by-email)). They are sent from the
deployment's system address with no images and no tracking.

## Legal holds

A legal hold on a thread stops retention and erasure from deleting it
([FR-PRV-4](../project/prd.md#612-privacy), [I2](../project/edge-cases.md)):

```bash
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/threads/thr_01JA…/hold \
  -H "Authorization: Bearer $PRIVACY_KEY" -H "Content-Type: application/json" \
  -d '{"reason":"PCN dispute WM12345678","until":"2027-10-09T00:00:00Z"}'
```

- Placing and removing a hold (`DELETE …/hold`) need `erasure:manage` and are audit-logged. CLI:
  `pmail threads hold` and `pmail threads unhold`.
- Erasure skips held threads and lists them in the receipt. Other operations that would delete held
  data are refused with `423 legal_hold`.
- Deleting a whole workspace keeps its held threads too: everything else is erased, the workspace
  stays `erasing` (no keys, no addresses, no sending) with the held mail readable by the platform
  operator and by the partner that created it, and the erasure finishes by itself the day after the
  last hold is removed or expires.
- A thread's `hold` field shows the current hold.

Place holds before running an erasure that could reach a disputed thread.

## Subject-access export

To answer a subject-access request, export every message to or from an address across all of a
tenant's identities ([FR-PRV-5](../project/prd.md#612-privacy), [I3](../project/edge-cases.md)):

```bash
curl -X POST https://mail.example.com/v1/exports \
  -H "Authorization: Bearer $PRIVACY_KEY" -H "Content-Type: application/json" \
  -d '{"tenant_id":"ten_01J9…","scope":"counterparty","counterparty_address":"jo@example.net"}'
```

When the export is ready, an `export.completed` event is sent with `export_id` and `expires_at`. Then
`GET /v1/exports/{id}` returns a `download_url`: a signed link, valid for 7 days, to a ZIP file with
one `.eml` per message and a `messages.json` index. The file itself is deleted after 7 days. CLI:
`pmail export create` and `pmail export get`.

## Suppressions are kept as hashes

When a counterparty is erased, their suppressions (from a complaint, an unsubscribe or a manual
request) are **not** deleted. Deleting them would let the address be mailed again, ignoring the
person's objection to being contacted (UK and EU GDPR Article 21) ([I7](../project/edge-cases.md)).

So suppressions never store the address itself. They store an HMAC of it, keyed with the deployment
secret `PM_HASH_KEY`, and a masked hint such as `j***@example.net`. The hash lets Pylota Mail check
"is this recipient suppressed?" without keeping the address in a readable form. Address tombstones for
deleted identities work the same way.

## Vectorize residency

Vectorize has no documented option to choose where vectors are stored, so it is not covered by the
jurisdiction setting. Pylota Mail limits what goes there: vectors carry identifiers and a few filter
fields, never message text, subjects or addresses, and search always reads text back from the mailbox.

Be aware that vectors are derived from message text, and that the `sender_domain` filter field can
identify a person when they use a personal domain. Erasure deletes the vectors with everything else.
If your obligations rule out any processing outside the EU, take this into account.

## Backups and residual retention

D1 and Durable Object storage keep 30 days of point-in-time recovery. After an erasure, the erased data
still exists in that recovery history until it ages out, and a restore to a point before the erasure
would bring it back ([I6](../project/edge-cases.md)). Document this as residual retention.

If you ever restore, follow the restore runbook
([Observability › Restore from PITR](../project/design/observability.md#restore-from-pitr)), which
`pmail ops` automates:

1. Freeze the deployment, so nothing is accepted that the restore could lose.
2. Restore to the latest point that fixes the problem. The tooling exports the database first and
   re-applies afterwards every change made after the restore point that the restore is not meant to
   undo, including erasure records, suppressions and removals.
3. Re-apply every erasure request that completed after the restore point, from its stored record (a
   counterparty erasure by the address's keyed hash; the address is not needed). Keep your receipts or
   `erasure.completed` events anyway: they are your own evidence.

R2, which holds raw mail and attachments, has no point-in-time recovery, versioning or replication. An
object deleted by retention or erasure is gone, which is what erasure needs; an object deleted by a bug
is gone too. If you set `PM_BACKUP_BUCKET` (Pylota Mail Cloud does), a nightly job copies new objects to
a second bucket in the same jurisdiction, and every retention and erasure delete removes the copy as
well, including a copy that was being made while the erasure ran
([Privacy design](../project/design/privacy.md#54-optional-r2-backup-copy)). If you copy the bucket any
other way, erasure must purge that copy too.

## Logs

- Logs never contain message bodies, attachment content or clear-text email addresses, at any log
  level ([FR-PRV-6](../project/prd.md#612-privacy)). Where a log needs to refer to an address or a
  query, it uses a keyed hash. A test greps captured logs for test message content and addresses
  ([I5](../project/edge-cases.md)).
- The audit log records actions and targets, never message content or clear addresses.
- If you set `PM_AI_GATEWAY`, model calls (which carry mail content) pass through that AI Gateway.
  Pylota Mail turns off the gateway's log collection and caching on every call that carries mail
  content, so the gateway keeps only request metadata (model, time, tokens) for those calls. Its rate
  limits and other settings still apply.
