# Receiving, webhooks and quarantine

This guide explains how inbound mail reaches an identity, what a received message contains, how
quarantine and sender controls work, how to receive events on a webhook endpoint safely, and which
notification emails the people behind your agents get. It ends with `wait`, for agents that need a
verification code.

## How inbound mail arrives

```text
sender ──SMTP──▶ Cloudflare Email Routing ──▶ email() handler
                 (rejects > 25 MiB)              │ 1. look up the recipient in the directory
                                                 │      unknown or erased  → 550 5.1.1
                                                 │      retired            → 550 5.1.6
                                                 │      tenant suspended   → temporary failure (4xx), later 550 5.2.1
                                                 │ 2. write the raw message to R2
                                                 │      write fails        → temporary failure (sender retries)
                                                 │ 3. queue a pointer, accept the message
                                                 ▼
                                       pm-inbound consumer: parse, sanitise, authenticate, classify
                                                 ▼
                                       identity mailbox: dedupe, thread, store, index ─▶ message.received
                                                 ▼                                        or message.quarantined
                                       background: attachment text, embeddings, triage ─▶ message.triaged
```

- **Addresses** are matched case-insensitively. Dots are significant: `jo.rivera@` and `jorivera@` are
  different addresses ([A1](../project/edge-cases.md)).
- **Plus tags** are removed before the lookup, so `bookings.acme+anything@agents.example` reaches
  `bookings.acme@agents.example`. A tag that is a valid thread token (`+t<kid><seq>.<hmac>`) places the
  message in that thread. Any other tag, including a forged token, is ignored and the message threads
  by its headers. A tag never changes which identity receives the message
  ([A2](../project/edge-cases.md)).
- **No acknowledged message is lost.** The raw message is in R2 before the sending server gets its
  acknowledgement. If the write fails, the sender gets a temporary failure and retries
  ([FR-IN-1](../project/prd.md#64-inbound)). If Pylota Mail's own directory is briefly unavailable,
  the message is accepted into a staging area and routed later, never rejected
  ([J7](../project/edge-cases.md)).
- **Paused identities** still receive and store mail ([A7](../project/edge-cases.md)).
- **Duplicates** (the same raw message delivered twice, for example after a sender's timeout) are
  stored once, with no second event ([B14](../project/edge-cases.md)).
- **One message to several identities** of the same tenant (To: bookings, Cc: compliance) gives one
  linked copy per identity. `delivered_to` and `is_primary_recipient` tell each copy apart, so your
  application can act only on the primary recipient's copy ([A9](../project/edge-cases.md)).
- **BCC**: when an identity received the message without being named in its headers, the message has
  the flag `bcc` ([A10](../project/edge-cases.md)).
- Messages larger than 25 MiB are rejected by Cloudflare before Pylota Mail sees them.

### Domains that do not use Email Routing

The diagram shows the platform domain and tenant domains on Cloudflare. A tenant domain connected in
another way ([Custom domains](custom-domains.md#choose-how-to-connect-your-domain)) differs in a few
places:

| Connection method | How mail arrives | What is different |
|---|---|---|
| `dns_records`, and `smtp_relay` with `inbound: ses` | Amazon SES receives the message, keeps it in S3 until the Worker has stored it, and notifies the Worker, which runs the same pipeline from parsing onwards | Mail to an address that does not exist is accepted by SES and then dropped without a bounce, instead of `550 5.1.1`. Mail to a retired address gets a `550 5.1.6` bounce from SES. Messages up to 40 MB are accepted, instead of 25 MiB |
| `send_only`, and `smtp_relay` with `inbound: forward` | The tenant's own mailbox forwards the message to the identity's platform address | `delivered_to` is the address on the tenant's domain when it appears in `To` or `Cc`, so replies come from it. A forwarder that changes the message breaks the sender's DKIM signature, and the message is quarantined (`auth_failed`) |

Mail to a domain that is `failing` or `suspended` is still accepted, whatever the method.

## What a received message contains

Fetch a message with `GET /v1/identities/{identity_id}/messages/{message_id}` (`messages:read`), or a
whole thread with `GET …/threads/{thread_id}`. The full shape is the
[Message object](../reference/api.md#message-object).

| Field | What it is |
|---|---|
| `extracted_text` | The new content of the message, with quoted history and signatures removed. Returned by default |
| `text` | The full plain text, derived from the HTML when the mail is HTML-only ([B4](../project/edge-cases.md)). Returned with `include=quoted` |
| `html` | Sanitised HTML, returned with `include=html`. Remote content is never fetched, and the service never renders it ([B7](../project/edge-cases.md)) |
| `trust` | See below |
| `kind` | `normal`, `automated`, `dsn`, `list`, `calendar` or `mdn` |
| `attachments` | `filename`, `content_type`, `size`, `disposition`, `text_status`, `pages` and `risk` |
| `refs` | Exact references, for example `{ "kind": "uk_plate", "value": "AB12CDE" }` and `{ "kind": "invoice", "value": "88213" }` |
| `triage` | Category, needs-reply, urgency, summary, language and risk flags. See [Triage](triage.md) |
| `flags` | Message-level flags: `parse_degraded`, `encrypted`, `message_id_conflict`, `reprocessed`, `bcc` and others |

### Trust

Every inbound message carries an authentication verdict and trust metadata
([FR-IN-4](../project/prd.md#64-inbound)):

```json
"trust": {
  "verdict": "pass", "spf": "pass", "dkim": "pass", "dmarc": "pass", "arc": "none",
  "known_sender": true, "quarantined": false, "spam_score": 0.02,
  "automated": false, "flags": []
}
```

| Field | Meaning |
|---|---|
| `verdict` | `pass`, `fail`, `softfail`, `none`, `unaligned` or `unverified` (SPF alignment could not be checked yet, because the deployment's `PM_TRUSTED_AUTHSERV_ID` is not set). Computed by Pylota Mail's own DKIM, ARC and DMARC verification, plus Cloudflare's `Authentication-Results` header when its authserv-id is trusted ([D9](../project/edge-cases.md)) |
| `known_sender` | The identity has exchanged mail with this address before |
| `spam_score` | 0 to 1. Above the tenant's `quarantine.spam_threshold` (default 0.8) the message is quarantined |
| `automated` | Auto-reply, mailing list, bounce or read receipt |
| `flags` | `hidden_text`, `display_name_spoof`, `lookalike_domain`, `reply_to_mismatch`, `thread_join_unverified` |

A sender whose domain has no DMARC record gets `none` (alignment is still recorded), and one with `p=none` that fails alignment gets `unaligned`. That alone never
quarantines a message, because much legitimate mail looks like that. But it is not proof of who sent
it: require `verdict: pass` before an automation that acts on authenticity, such as paying an invoice
or contesting a PCN ([D1](../project/edge-cases.md)).

Hidden text (zero-width characters, white-on-white text, `display:none`, tiny fonts, HTML comments) is
removed from `extracted_text`, snippets and the triage input, and raises the `hidden_text` flag
([B11](../project/edge-cases.md)).

### Attachments

- Download bytes with `GET …/attachments/{attachment_id}` (`attachments:read`). The response has
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox`.
- Read extracted text with `GET …/attachments/{attachment_id}/text?pages=1-3`. Text is extracted from
  PDF, Office, text and HTML files, and from images if the tenant enables it.
  `text_status` is `pending`, `ready`, `unavailable` (extraction failed or the type is unsupported)
  or `skipped` (by policy or because of risk).
- An attachment with a `risk` (`executable`, `macro`, `encrypted_archive`, `archive_bomb`,
  `type_mismatch` or `encrypted_document`) quarantines its message. It is never passed to extraction
  or to agents, and downloading it needs `quarantine:review`. The type sniffed from the file's bytes
  wins over the declared type and the extension ([B10](../project/edge-cases.md)).

### Other kinds of mail

| Mail | Behaviour |
|---|---|
| S/MIME or PGP encrypted | Stored with the flag `encrypted`. The body is unavailable ([B9](../project/edge-cases.md)) |
| Calendar invitations | `kind: calendar` with a parsed summary. Never accepted automatically ([B8](../project/edge-cases.md)) |
| Read-receipt requests | Ignored. Pylota Mail never sends read receipts |
| Forwarded messages (`message/rfc822`) | Parsed as a nested message and never merged into the outer thread ([B6](../project/edge-cases.md)) |
| Malformed MIME | Kept raw, parsed as far as possible, flagged `parse_degraded`. Never dropped ([B2](../project/edge-cases.md)) |

## Automated mail

Mail sent by machines is classified and marked so agents never auto-reply to it
([FR-IN-6](../project/prd.md#64-inbound)):

- auto-replies and out-of-office messages (RFC 3834): `kind: automated`;
- mailing lists: `kind: list`;
- bounces (DSNs): `kind: dsn`. A bounce for a message the identity sent updates that message's
  delivery state instead of reaching agents. A bounce for mail the identity never sent (backscatter)
  is dropped and counted ([D4](../project/edge-cases.md));
- read receipts: `kind: mdn`.

`trust.automated` is `true` for all of them. An `auto_reply` send in answer to automated mail is
refused ([D6](../project/edge-cases.md)).

## Quarantine

Quarantined mail is stored, but kept away from agents ([FR-IN-5](../project/prd.md#64-inbound)).
Lists, search results and MCP tools leave it out by default. It appears in a message list only when
the request filters on `status=quarantined` **and** the key holds `quarantine:review`, and in search
only with `include_quarantined` and that permission. A key without `quarantine:review` never sees it.
Its `message.quarantined` event carries no `extracted_text`.

| `quarantine_reason` | Cause | Policy |
|---|---|---|
| `auth_failed` | The message failed authentication | `quarantine.on_auth_fail` (default `true`) |
| `auth_unverified` | The sender's DMARC policy is `quarantine` or `reject`, DKIM did not align, and SPF could not be checked because the deployment has not yet learned Cloudflare's `Authentication-Results` authserv-id (`PM_TRUSTED_AUTHSERV_ID`; `pmail setup` sets it) | `quarantine.on_auth_fail` (default `true`) |
| `spam` | `spam_score` above the threshold | `quarantine.spam_threshold` (default 0.8) |
| `risky_attachment` | An attachment has a `risk` | Always |
| `blocked_sender` | The sender is suppressed or matched a receive-block rule (see [Blocked senders and throttling](#blocked-senders-and-throttling)). These messages get status `hidden`, not `quarantined`: they are never evented, never shown in the quarantine and cannot be released | Tenant lists |
| `otp_unsolicited` | A password-reset or one-time-code message that no `wait` asked for in the previous 30 minutes ([E5](../project/edge-cases.md)) | `quarantine.unsolicited_otp` (default `true`) |

Review and release with a key that holds `quarantine:review`:

```bash
# list quarantined mail, newest first
curl https://mail.example.com/v1/identities/idn_01J9Z3K8V4/quarantine \
  -H "Authorization: Bearer $REVIEWER_KEY"

# release one message
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/messages/msg_01JA9G6M2W/release \
  -H "Authorization: Bearer $REVIEWER_KEY" -H "Content-Type: application/json" \
  -d '{"reason":"Known supplier, DKIM key rotated"}'
```

Releasing moves the message to `received`, emits `message.released`, runs triage and writes an audit
entry. The CLI commands are `pmail quarantine list` and `pmail quarantine release`.

Release is a human decision. Give `quarantine:review` to the people who review mail, not to agents
([Security](security.md#quarantine)).

## Blocked senders and throttling

Each tenant has allow and block lists for receiving and for sending
([REST API › Suppressions and lists](../reference/api.md#suppressions-and-lists--suppressionsmanage)).
Entries are a full address or a whole domain (`@example.com`).

```bash
# block a sender domain for the whole tenant
curl -X PUT https://mail.example.com/v1/tenants/ten_01J9…/lists/receive/block/@spam.example \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY"
```

| Control | Effect |
|---|---|
| Receive-block | Mail is stored `hidden` for audit, never shown to agents, never answered ([D7](../project/edge-cases.md)) |
| Receive-allow | Mail skips spam quarantine. It does **not** skip authentication quarantine |
| Suppressed sender | Treated like receive-block: stored `hidden` |
| Per-sender throttle | More than `inbound.per_sender_per_hour` messages (default 60) from one sender to one identity in an hour: the excess is stored `throttled`, hidden from agents, counted and alerted ([D5](../project/edge-cases.md)) |

`hidden` and `throttled` mail follows the same rule as quarantined mail: lists leave it out unless the
request filters on that `status` and the key holds `quarantine:review`.

## Set up a webhook endpoint

### 1. Create the endpoint

```bash
curl -X POST https://mail.example.com/v1/tenants/ten_01J9…/webhooks \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://api.example.com/webhooks/mail",
       "events":["message.received","message.triaged","message.bounced","message.uncertain"],
       "identity_ids":null,"description":"Production API"}'
```

- `events: ["*"]` subscribes to every type, including types added later.
- `identity_ids` limits the endpoint to some identities.
- Platform keys can create platform-wide endpoints with `POST /v1/webhooks`.
- The response includes `"secret": "whsec_…"`. **It is shown only once.**

The URL must be HTTPS on a public address. Private, loopback and reserved addresses are refused, and
redirects are not followed ([FR-WH-5](../project/prd.md#610-events-and-webhooks)).

### 2. Answer quickly

Return any `2xx` within 15 seconds. Pylota Mail ignores the response body. Do the real work later:
store the event, return `200`, and process it in a background job. Anything else (a timeout, a
`3xx`, a `5xx`, a TLS or DNS error) counts as a failure and is retried.

### 3. Verify every request

Each request carries three headers:

```http
webhook-id: evt_01J9Z5…
webhook-timestamp: 1791540000
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=
```

To verify ([Standard Webhooks](https://www.standardwebhooks.com/)):

1. Build the signed content `{webhook-id}.{webhook-timestamp}.{raw body}`, from the raw request body
   bytes, never from re-serialised JSON.
2. Compute `base64(HMAC-SHA256(secret_bytes, content))`, where `secret_bytes` is the base64-decoded
   part of `whsec_…` after the prefix.
3. Compare it in constant time with each space-separated `v1,` signature in `webhook-signature`.
   Accept if any matches. During a secret rotation there are two.
4. Reject the request if `webhook-timestamp` is more than 5 minutes from your clock.

A Rust implementation, using `hmac =0.13.0`, `sha2 =0.11.0` and `base64 =0.23.1`:

```rust
use base64::prelude::*;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug)]
pub enum VerifyError {
    BadSecret,
    BadTimestamp,
    StaleTimestamp,
    BadSignature,
}

/// Verifies a Pylota Mail webhook request.
///
/// `secret` is the endpoint's `whsec_…` value. The three header values are passed as received.
/// `body` must be the raw request body bytes. `now_unix` is the current time in Unix seconds.
pub fn verify_webhook(
    secret: &str,
    webhook_id: &str,
    webhook_timestamp: &str,
    webhook_signature: &str,
    body: &[u8],
    now_unix: i64,
) -> Result<(), VerifyError> {
    let timestamp: i64 = webhook_timestamp
        .parse()
        .map_err(|_| VerifyError::BadTimestamp)?;
    if (now_unix - timestamp).abs() > 5 * 60 {
        return Err(VerifyError::StaleTimestamp);
    }

    let key = secret
        .strip_prefix("whsec_")
        .ok_or(VerifyError::BadSecret)?;
    let key = BASE64_STANDARD.decode(key).map_err(|_| VerifyError::BadSecret)?;

    for candidate in webhook_signature.split(' ') {
        let Some(encoded) = candidate.strip_prefix("v1,") else { continue };
        let Ok(expected) = BASE64_STANDARD.decode(encoded) else { continue };

        let mut mac = HmacSha256::new_from_slice(&key).map_err(|_| VerifyError::BadSecret)?;
        mac.update(webhook_id.as_bytes());
        mac.update(b".");
        mac.update(webhook_timestamp.as_bytes());
        mac.update(b".");
        mac.update(body);

        // verify_slice compares in constant time.
        if mac.verify_slice(&expected).is_ok() {
            return Ok(());
        }
    }
    Err(VerifyError::BadSignature)
}
```

`pmail webhooks verify` checks a captured request against a secret locally, which helps when your
own verification disagrees.

### 4. Deduplicate and process durably

Delivery is **at least once**, so the same event can arrive twice. Store each `webhook-id` you have
processed and skip repeats. Process events in a durable job, so a failure further down (your database,
a model call) is retried by your job system and never re-runs an agent turn or a send
([K1](../project/edge-cases.md)).

### 5. Test it

```bash
pmail webhooks test whk_01JA…
```

This sends a `webhook.test` event straight away and shows the delivery attempt.

### Rotate the secret

```bash
curl -X POST https://mail.example.com/v1/webhooks/whk_01JA…/rotate-secret \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Content-Type: application/json" \
  -d '{"overlap_hours":24}'
```

The new secret is returned once. For `overlap_hours` (0–168), every delivery carries both signatures,
so you can deploy the new secret without dropping events. CLI: `pmail webhooks rotate`.

## Retries, replay and dead deliveries

- Failed deliveries are retried at about **30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, 8 h, 12 h,
  12 h, 12 h and 19 h** (about 72 hours in total), each with ±10% jitter.
- After the last attempt the delivery is `dead`. A dead delivery can be replayed for 30 days from its
  event's `occurred_at` (or `retention.events_days`, if shorter, because the payloads are then gone).
  The window counts from the event, not from when the delivery went dead.
- After 100 consecutive failures spread over at least 24 hours, the endpoint is disabled
  (`disabled_reason: failing`) and a `webhook.disabled` event goes to the platform's other endpoints.
  A `410 Gone` response disables the endpoint immediately. Re-enable it with
  `PATCH /v1/webhooks/{webhook_id}` and `{"enabled": true}`.

See what happened, then replay:

```bash
# failed and dead attempts for one endpoint
curl "https://mail.example.com/v1/webhooks/whk_01JA…/deliveries?status=dead" \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY"

# replay every dead delivery from one day
curl -X POST https://mail.example.com/v1/webhooks/whk_01JA…/replay \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Content-Type: application/json" \
  -d '{"since":"2026-10-08T00:00:00Z","until":"2026-10-09T00:00:00Z","status":"dead"}'
```

Replay returns `202` with `{ "queued": 42 }`. You can also replay specific events with
`{"event_ids": ["evt_01J…"]}`. Replayed events keep their original `webhook-id`, so your
deduplication still works. CLI: `pmail webhooks deliveries` and `pmail webhooks replay`.

## Ordering with `sequence`

Events are not guaranteed to arrive in order. Each payload has `occurred_at`, and mailbox events have
a per-identity `sequence` that increases strictly. To ignore stale updates, keep the highest
`sequence` you have applied per message, and skip an event with a lower one:

```text
on event e for message m:
    if e.sequence <= last_applied_sequence[m]:  skip        # for example a late message.deferred
    else: apply e; last_applied_sequence[m] = e.sequence
```

So a `message.deferred` that arrives after `message.delivered` does not move the message backwards.

## Payload size

Payloads are thin: IDs, a summary, verdicts, triage and up to `policy.webhook_text_bytes` of
`extracted_text` (default 16 KB, maximum 64 KB), with `extracted_text_truncated` when cut. Fetch the
rest through the API. Lowering `webhook_text_bytes` keeps less mail content in your own logs and
queues. The envelope and every event type are in [Webhook events](../reference/events.md).

## Notifications by email

Webhooks are for your software. The people behind the agents can also get email from the deployment
about their workspace ([Notifications design](../project/design/notifications.md)). Agents keep using
webhooks and the API: notifications change nothing that your endpoints receive.

| Kind | What it says | Default |
|---|---|---|
| `usage` | An allowance reached 80% or 100% of its limit ([Plans › Usage alerts](plans.md#usage-alerts)) | On for the owner and admins |
| `new_mail` | New mail arrived in inboxes the person follows | Off for everyone: opt in |
| `needs_person` | Once a day, what needs a person: quarantined mail, uncertain sends, failing domains and failing webhooks | Daily for the owner and admins |
| `account` | Security and billing events, such as two-step verification turned off or a failed payment | Always sent to the person concerned (the owner, for billing). Cannot be turned off |
| `digest` | Once a day, the items a daily cap held back, as counts | Sent only to a person whose items were held back |

- **Settings.** Each person chooses their own, per workspace, at **Settings › Notifications**
  (`/console/settings/notifications`). There is no API for them: API keys are not people.
- **New-mail notifications** are `instant`, `hourly` or `daily`, for every inbox or chosen ones, and
  optionally only for mail that needs a reply (triage's `needs_reply` score at least 0.5; a message waits
  up to 5 minutes for triage, and counts if triage does not run). `instant` waits 2 minutes and sends one email for
  everything that arrived, then at most one per inbox every 10 minutes. Daily emails, including the
  "needs a person" email, arrive at 09:00 in the workspace's time zone. Only mail that becomes visible in
  the inbox counts: quarantined, hidden and spam mail never does.
- **Counts only, never content.** A notification names the inbox and counts messages ("3 new messages
  in bookings.acme@agents.example, 2 waiting for a reply"). It never includes a subject, a sender, a
  snippet or an attachment name, so it is safe to read on a lock screen.
- **One-click unsubscribe.** Every `usage`, `new_mail`, `needs_person` and `digest` email carries
  `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058), so a mail app's unsubscribe button turns
  that kind off for that person and workspace, without sign-in (for a `digest`, the three kinds it
  summarises). `account` emails link to settings instead.
- **Caps.** At most 50 notification emails per person and 200 per workspace a day, not counting
  `account` emails or the digest. Past a cap, the day's remaining items go into one `digest` email at
  the next 09:00, and the settings page says so.
- If a notification hard-bounces or draws a complaint, that person's notifications pause (only
  `account` emails still go out) until they confirm their address in the console.

## Waiting for a verification code

Agents that sign up for services need the code or link the service emails back. `wait` long-polls
until a matching message arrives ([E4](../project/edge-cases.md)):

```bash
curl "https://mail.example.com/v1/identities/idn_01J9Z3K8V4/wait?from=@service.example&kind=verification&timeout=60" \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY"
```

```json
{
  "message": { "id": "msg_01JAB…", "subject": "Your verification code", "...": "…" },
  "verification": { "code": "481 207", "link": "https://service.example/verify?t=…", "sender_domain": "service.example" },
  "timed_out": false
}
```

| Parameter | Meaning |
|---|---|
| `from` | An address or `@domain`. For verification codes, the expected sender's domain |
| `subject_contains`, `thread_id` | Further filters |
| `kind` | `any`, `reply` or `verification` |
| `since` | Match messages from this time on. The default is when the request started |
| `timeout` | Seconds, default 30, maximum 60. On timeout, `message` is `null` and `timed_out` is `true` |

Rules that keep this safe:

- A code or link is released only when `from` names the expected sender domain **and** the message
  passed authentication (`verdict: pass`).
- Password-reset and one-time-code mail that nobody waited for is quarantined as `otp_unsolicited`
  when no `wait` for that sender domain was active in the previous 30 minutes
  ([E5](../project/edge-cases.md)). So **start the `wait` before you trigger the email** (in parallel
  with the sign-up request), or call it within 30 minutes of an earlier `wait` for the same domain.
- The `verification.received` event says a code arrived, but never contains it. The value is only
  available through `wait`.
- Codes and links are kept for 24 hours, then purged.

`wait` needs `search:read`. The MCP tool is `mail_wait`, and the CLI command is `pmail wait`.
