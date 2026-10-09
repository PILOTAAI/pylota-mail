# Inbound pipeline

Binding for implementation. This page takes a message from Cloudflare Email Routing, or from Amazon SES
for domains with `inbound = ses`, to a stored, threaded, indexed and evented row in the identity's
mailbox.

| | |
|---|---|
| Requirements | FR-IN-1 … FR-IN-9, FR-THR-1, FR-THR-2, FR-ADR-3, FR-ADR-5, FR-TEN-3, FR-DLV-5, FR-DOM-9, FR-DOM-10, FR-DOM-11, FR-SRCH-2, FR-SRCH-4, NFR-REL-1, NFR-REL-2, NFR-REL-3 |
| Edge cases | [A2](../edge-cases.md), [A6](../edge-cases.md), [A9](../edge-cases.md), [A10](../edge-cases.md), [B1–B14](../edge-cases.md), [D1–D5](../edge-cases.md), [D7](../edge-cases.md), [D9](../edge-cases.md), [E4](../edge-cases.md), [E5](../edge-cases.md), [J1–J3](../edge-cases.md), [J7](../edge-cases.md), [L3](../edge-cases.md), [N1–N7](../edge-cases.md), [N12](../edge-cases.md), [N18](../edge-cases.md), [N19](../edge-cases.md), [N27](../edge-cases.md), [N28](../edge-cases.md) |
| Code | `crates/worker/src/email.rs`, `handlers/wait.rs`, `handlers/hooks_ses.rs`, `crons/ses_backstop.rs`, `inbound/sources/{routing.rs, ses.rs}`, `consumers/inbound.rs`, `consumers/index.rs`, `mailbox/{ingest.rs, threads.rs, messages.rs, attachments.rs, outbox.rs}`; `crates/core/src/{mime/, sanitize.rs, text.rs, quote.rs, refs/, classify.rs, auth.rs, trust.rs, attach.rs, sns.rs}` |
| Related | [Threading](threading.md), [Outbound](outbound.md) (delivery events, loopback), [Search](search.md) (indexing), [Triage](triage.md), [Webhooks](webhooks.md), [Domains on any DNS host](domain-connections.md) (SES receiving, probes, forwarding checks) |

```text
 SMTP ─▶ Email Routing ─▶ email()                                    (Worker, per envelope recipient)
                           1 normalise recipient, strip +tag
                           1b platform domain: journal, probe, forwarding check, role names
                           2 directory lookup (cache 60 s hit / 5 s miss)
                           3 reject 550 5.1.1 / 550 5.1.6 / 550 5.2.1, or temporary failure
                           4 raw → R2  t/{ten}/i/{idn}/m/{msg}/raw.eml   (2 retries, else temporary failure)
                           5 pointer (source: routing) → pm-inbound
                                │
 SMTP ─▶ Amazon SES ─▶ S3 in/{key} + SNS ─▶ POST /hooks/ses/inbound    (and the every-minute SQS backstop)
                           verify SNS (version 2) · ses_ingest ledger, once per object and recipient
                           pointer (source: ses) → pm-inbound
                                │
                                ▼
                       pm-inbound consumer                            (Worker, one message at a time)
                           ses only: S3 → R2, directory lookup, drop unknown recipients (no bounce)
                           parse under caps · classify · DSN routing · authenticate (DoH)
                           sanitise · strip hidden text · derive text · strip quotes · refs
                           attachments: sniff, risk, TNEF, scanner · verification codes
                           D1 facts: suppressions, lists, tenant domains, co-recipients
                                │  MailboxRequest::Ingest
                                ▼
                       IdentityMailbox.ingest                         (one SQLite transaction)
                           dedupe · thread · quarantine decision · insert message, attachments,
                           FTS, refs, contacts, verifications · outbox event
                                │ after commit
                                ▼
                       consumer: attachments → R2 · pm-index jobs (attachment text, embed, triage)
```

## Inbound sources

A domain's `inbound` property decides how its mail arrives
([Domains on any DNS host § 2](domain-connections.md#2-inbound-source-and-outbound-transport-are-separate-choices)).
Both sources queue an `InboundPointer` whose `source` says where the raw message is
([The pm-inbound message](#the-pm-inbound-message)). From "parse" onwards the consumer runs the same
pipeline for both; only the SPF input and the SES verdicts differ.

| | Email Routing (`inbound = routing`) | Amazon SES (`inbound = ses`) |
|---|---|---|
| Domains | The platform domain, `cloudflare_zone`, `nameservers`, `delegated_subdomain` | `dns_records`; `smtp_relay` with `inbound: ses` |
| Entry point | `email()`, once per envelope recipient ([below](#the-email-handler)) | `POST /hooks/ses/inbound` and the every-minute SQS backstop cron; one pointer per recipient ([The SES source](#the-ses-source)) |
| Largest message | 25 MiB; Cloudflare rejects larger ones before the Worker runs ([B1](../edge-cases.md)) | 40 MB including headers, the most a receipt rule stores in S3 ([quotas](https://docs.aws.amazon.com/ses/latest/dg/quotas.html), read 2026-10-09) ([N5](../edge-cases.md)) |
| Unknown recipient | `550 5.1.1` during the SMTP session | Accepted by SES, then dropped by the Worker without a bounce ([N6](../edge-cases.md)) |
| Retired recipient | `550 5.1.6` during the SMTP session | Bounced `550 5.1.6` by an SES receipt rule `pm-retired-{n}` ([N7](../edge-cases.md)) |
| SPF | From the trusted `Authentication-Results` header | From SES's `spfVerdict` |

Mail on `send_only` domains, and on `smtp_relay` domains with `inbound: forward`, reaches the identity's
platform address through the customer's own forwarding rule, so it arrives by Email Routing.

## The email() handler

### Interface

The Cloudflare message object exposes the envelope sender and recipient, the headers, the raw stream
and its size, `setReject` (documented as a **permanent** SMTP error) and `forward`; it does not expose the
client IP ([email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/),
read 2026-10-09). `platform` adapts `worker::ForwardableEmailMessage` (0.8.7) to:

```rust
// crates/platform/src/email.rs
pub trait InboundEmail {
    fn envelope_from(&self) -> String;                 // MAIL FROM, "" for the null sender
    fn envelope_to(&self) -> String;                   // RCPT TO, as received (with +detail)
    fn header(&self, name: &str) -> Option<String>;    // first value of a header, from message.headers
    fn raw_size(&self) -> u64;
    async fn read_raw(&self) -> PResult<JsBuffer>;     // reads the stream once into a JS ArrayBuffer
    fn set_reject(&self, reason: &str);
    async fn forward(&self, to: &str) -> PResult<()>;
}

// crates/worker/src/email.rs
pub enum TempFail { Storage, Queue, TenantSuspended, Forward, Check }
pub async fn handle_email<P: Platform>(p: &P, msg: &impl InboundEmail) -> Result<(), TempFail>;
```

The email entry point (generated by `platform::export_worker!`,
[Rust workspace](rust-workspace.md#2-crate-responsibilities-and-allowed-dependencies)) calls
`handle_email`. `Ok(())` accepts the message (after a `set_reject`, Cloudflare refuses it).
`Err(TempFail)` is raised to the runtime as a thrown exception (logged with the `TempFail` variant, never
with the address). **Spike S2** records what the sending MTA sees in that
case; the design requires a 4xx temporary failure. If S2 shows otherwise, the S2 fallback is **throw
only**: the handler still retries the R2 write inside the handler and then throws, and a "Spike result"
note here records the reply the sender actually sees. Nothing is forwarded to a backup address, because
setup registers no Email Routing destination address
([Design › Spikes](index.md#spikes)).

### Steps

1. **Start.** Generate `req_…`. Record `received_at = clock.now_ms()`.
2. **Normalise the recipient** with `core::address::parse_envelope(envelope_to)`:
   - trim whitespace and surrounding `<>`; split at the **last** `@`;
   - domain: strip a trailing dot, convert to an IDNA A-label, lower-case;
   - local part: if it contains a non-ASCII byte, the address cannot exist (SMTPUTF8 local parts are
     refused at creation, FR-ADR-7), so go to step 5 with "unknown";
   - lower-case the local part (A1: matching is case-insensitive, dots are significant);
   - split at the **first** `+`: `base_local` before it, `detail` after it (empty detail = none).
     Usernames cannot contain `+`, so the first `+` is always the separator. Cloudflare preserves the
     `+detail` part in `message.to` when sub-addressing is enabled
     ([routing addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/),
     read 2026-10-09).
   - `base = base_local@domain`. The `detail` is kept for the thread token check in the consumer.
3. **Platform-domain special addresses** (only when `domain = PM_PLATFORM_DOMAIN`):

   | `base_local` | Handling |
   |---|---|
   | `journal`, with a detail | Outbound Message-ID learning (spike S7 strategy B). Handled entirely here, see [Outbound](outbound.md#message-id-of-outbound-mail-spike-s7). Nothing is stored; the handler returns `Ok` |
   | `pm-probe`, with a detail | The alignment probe of an `smtp_relay` domain ([Domains on any DNS host § 5.3](domain-connections.md#53-proving-alignment-the-probe), [N18](../edge-cases.md)); the detail is the probe token. The handler copies the (small) message into wasm memory, checks that the `From` header still names the domain's `probe_from`, and evaluates DMARC for that domain with steps 1–6 of [Authentication verdict](#authentication-verdict) (an aligned DKIM signature, or SPF on an aligned MAIL FROM). It sends `{ token, from_unchanged, dkim_d, dmarc }` to that domain's `DomainMonitor`, which records the probe result. Nothing is stored or counted, and the handler returns `Ok`, also for an unknown or expired token. If the monitor cannot be reached, `Err(TempFail::Check)`, so the relay retries |
   | An RFC 2142 operational name (`postmaster`, `abuse`, `security`, `hostmaster`, `webmaster`, `noc`) | If `PM_SECURITY_CONTACT` is an email address (bare or `mailto:`), read the raw message and send that address a new message from `postmaster@{PM_PLATFORM_DOMAIN}` through the `EMAIL` binding, with the original attached as `message/rfc822` (only its headers above 4 MiB), as for tenant role mail below; `forward()` is not used, because it reaches only verified Email Routing destinations and setup registers none. A send error returns `Err(TempFail::Forward)`. If it is unset or not an email address, reject `550 5.1.1`. These names are reserved on the platform domain, so no identity can own them ([A4](../edge-cases.md)) |
   | Any other reserved role name (`info`, `sales`, `support`, `marketing` and the rest of the RFC 2142 list) | No special handling: no identity can own them, so the directory lookup (step 4) finds nothing and step 5 rejects `550 5.1.1` |

   **Forwarding check** ([Domains on any DNS host § 4.4](domain-connections.md#44-send_only), [N12](../edge-cases.md)).
   Before the rows above, a message to any platform-domain address whose header `X-Pylota-Mail-Check`
   holds a token is offered to that token's `DomainMonitor`. When the token is pending and the envelope
   recipient is the platform address of the identity that owns the tested address, the monitor sets the
   address's `forwarding` to `ok` and `forwarding_checked_at`; the message is not stored and the handler
   returns `Ok`. An unknown or expired token changes nothing, and the message continues to step 4 like
   any other mail.

   **Check tokens.** Probe and forwarding-check tokens have the form
   `{domain ULID, lower case}.{16 random Crockford base32 characters}` (at most 52 characters with the
   `pm-probe+` prefix). The first part names the `DomainMonitor` that holds the pending token in its
   storage, for 15 minutes (probe) or 10 minutes (forwarding check); the random part is compared in
   constant time. Usernames starting with `pm-probe` or `pm-bounce` are reserved
   ([Identities › Username validation](identity-domains.md#username-validation)), so no address row can
   collide with the probe address or the SES MAIL FROM name.

   **Tenant-domain role addresses** (any other domain, and `base_local` is `postmaster` or `abuse`; both
   are reserved on tenant domains, so no address row can exist): look up the domain's tenant and its owner
   (`SELECT d.tenant_id, u.email FROM domains d LEFT JOIN members m ON m.tenant_id = d.tenant_id AND m.role = 'owner' LEFT JOIN users u ON u.id = m.user_id WHERE d.name = ?1 AND d.kind <> 'platform' AND d.state NOT IN ('removing', 'removed')`).
   With an owner, read the raw message and send the owner a new message from
   `postmaster@{PM_PLATFORM_DOMAIN}` through the `EMAIL` binding (subject
   `"[{domain}] {base_local} mail: " + original subject`, the original attached as `message/rfc822`, or
   only its headers when it is over 4 MiB), then return `Ok` without storing anything. `forward()` is not
   used because it only reaches verified Email Routing destinations. A send error returns
   `Err(TempFail::Forward)`. Without an owner, handle it as the platform-domain row above
   (`PM_SECURITY_CONTACT`, else `550 5.1.1`). The other role names (`support`, `sales`, `info` and the
   rest) are ordinary addresses on tenant domains and go through steps 4 and 5
   ([Identities and domains › Username validation](identity-domains.md#username-validation)).

4. **Directory lookup.** The isolate keeps an LRU cache (`thread_local`, 10,000 entries) keyed by
   `base`: hits are cached for 60 seconds, misses for 5 seconds. On a cache miss it runs, with a
   2-second deadline:

   ```sql
   SELECT a.status AS address_status, a.identity_id, a.tenant_id, i.mailbox_do_id,
          i.status AS identity_status, t.status AS tenant_status, t.mode, t.suspended_at
   FROM addresses a
   JOIN identities i ON i.id = a.identity_id
   JOIN tenants t    ON t.id = a.tenant_id
   WHERE a.address = ?1;
   -- no row:
   SELECT 1 FROM address_tombstones WHERE address_hash = ?1;   -- hex HMAC-SHA256(PM_HASH_KEY, base)
   ```

   A tombstone and an unknown address get the same answer, so an erased address is indistinguishable
   from one that never existed (FR-ADR-5). If D1 errors or the deadline passes, go to
   [Staging when the directory is unavailable](#staging-when-the-directory-is-unavailable) (J7).
5. **Decide** ([A6](../edge-cases.md), FR-IN-2, FR-TEN-3):

   | Condition (first match) | Action |
   |---|---|
   | No row, or tombstoned, or non-ASCII local part | `set_reject("550 5.1.1 Recipient address rejected: user unknown")` |
   | `address_status = 'pending'` | `550 5.1.1` (same text) |
   | `address_status = 'retired'` | `set_reject("550 5.1.6 Recipient address has moved; contact the sender by other means")` |
   | `identity_status IN ('deleting','deleted')` or `tenant_status IN ('erasing','erased')` | `550 5.1.1` |
   | `tenant_status = 'suspended'` and `now - suspended_at < 5 days` | `Err(TempFail::TenantSuspended)` (a temporary failure: `setReject` is permanent only, so the handler throws instead; S2 records the exact reply the sender sees) |
   | `tenant_status = 'suspended'` and `now - suspended_at ≥ 5 days` | `set_reject("550 5.2.1 Mailbox disabled, not accepting messages")` |
   | Otherwise (`active`/`retiring` address, `active`/`paused` identity, `active` tenant) | Accept: continue |

   A paused identity still receives ([A7](../edge-cases.md), FR-IDN-3).
6. **Write raw to R2 before acknowledging** (FR-IN-1, [J1](../edge-cases.md)):
   - `message_id = ids.new_id(Msg)`; key `t/{tenant_id}/i/{identity_id}/m/{message_id}/raw.eml`.
   - `raw = msg.read_raw()` reads the stream once into a JS `ArrayBuffer` (≤ 25 MiB; Cloudflare
     rejects larger messages before the Worker runs, [B1](../edge-cases.md); the SES source allows
     40 MB, [Inbound sources](#inbound-sources)). It is not copied into
     wasm memory. The bytes are buffered, rather than streamed straight to R2, so the write can be
     retried.
   - `blobs.put(key, BlobBody::Js(raw), meta)` with `content_type = "message/rfc822"` and custom
     metadata `tenant`, `identity`, `message`. Up to 3 attempts, waiting 100 ms and then 300 ms.
   - After the third failure return `Err(TempFail::Storage)`. **Never `set_reject` for our own failure.**
7. **Queue the pointer.** Send `InboundJob::Message` (below) to `pm-inbound`, up to 3 attempts (100 ms,
   300 ms). If all fail, delete the R2 object (best effort), increment `inbound_orphan_raw_total` if
   the delete also fails, and return `Err(TempFail::Queue)`: the sender retries, and a later copy is
   processed normally.
8. **Return `Ok(())`.** Log `inbound_accepted` with tenant, identity, message ID, size and the hashed
   recipient (never the clear address).

### Staging when the directory is unavailable

When the D1 lookup in step 4 fails transiently ([J7](../edge-cases.md)), the handler never rejects for
our own outage:

1. Key `inbound-staging/{yyyy}/{mm}/{dd}/{ulid}.eml` (UTC date, a bare ULID), custom metadata
   `envelope_to_hash` = hex `HMAC-SHA256(PM_HASH_KEY, base)`.
2. Write it as in step 6 (same retries; failure → `Err(TempFail::Storage)`).
3. Queue `InboundJob::Staged`; failure → delete the object, `Err(TempFail::Queue)`.
4. Return `Ok(())`. The R2 lifecycle rule deletes `inbound-staging/` objects after 1 day as a backstop.

### The `pm-inbound` message

```rust
// crates/worker/src/consumers/inbound.rs — JSON, "v": 1, never contains content
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InboundJob {
    Message(InboundPointer),
    Staged(StagedPointer),
    Reparse(ReparsePointer),
}

#[derive(Serialize, Deserialize)]
pub struct InboundPointer {
    pub v: u8,                          // 1
    pub source: RawSource,              // where the raw message is (below)
    pub message_id: Option<String>,     // msg_… allocated in email(); None from SES until the consumer resolves it
    pub tenant_id: Option<String>,      // as message_id
    pub identity_id: Option<String>,    // as message_id
    pub r2_key: Option<String>,         // t/{ten}/i/{idn}/m/{msg}/raw.eml; as message_id
    pub raw_size: u64,                  // 0 from SES until the object is fetched
    pub envelope_from: String,          // "" for the null sender; SES: mail.source
    pub envelope_to: String,            // normalised, including +detail; SES: one receipt.recipients entry
    pub received_at: i64,               // Unix ms, our clock when the pointer was queued
    pub request_id: String,
    pub loopback: Option<LoopbackSource>,   // set only by the outbound loopback transport (L3)
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RawSource {
    Routing,                            // {"type":"routing"}: email() (and loopback); raw already at r2_key
    Ses {                               // {"type":"ses", …}: the object in/{key} in the SES bucket
        bucket: String, key: String,    // key = mail.messageId
        spf: SesVerdict, dkim: SesVerdict, dmarc: SesVerdict, spam: SesVerdict, virus: SesVerdict,
        dmarc_policy: Option<String>,   // present when DMARC failed
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SesVerdict { Pass, Fail, Gray, ProcessingFailed }   // the SES verdict "status" values

#[derive(Serialize, Deserialize)]
pub struct LoopbackSource { pub tenant_id: String, pub identity_id: String, pub message_id: String }

#[derive(Serialize, Deserialize)]
pub struct StagedPointer {
    pub v: u8, pub staging_key: String, pub raw_size: u64,
    pub envelope_from: String, pub envelope_to: String, pub received_at: i64, pub request_id: String,
}

#[derive(Serialize, Deserialize)]
pub struct ReparsePointer {
    pub v: u8, pub job_id: String, pub tenant_id: String, pub identity_id: String,
    pub message_id: String, pub parser_version: u32,
}
```

## The SES source

For domains with `inbound = ses` (FR-DOM-9). The set-up, the receipt rules and the ledger are specified
in [Domains on any DNS host § 4.5](domain-connections.md#45-inbound-through-ses); this section is how the
pipeline uses them. **Spike S11** must pass for it to ship in v1.0.

**Arrival.** SES stores the message as `in/{key}` in `PM_SES_INBOUND_BUCKET` (`key` = `mail.messageId`)
and publishes a notification to `PM_SES_INBOUND_TOPIC_ARN`. `POST /hooks/ses/inbound`
(`handlers/hooks_ses.rs`) receives it by push within seconds. The every-minute cron
(`crons/ses_backstop.rs`) drains the SQS backstop `PM_SES_INBOUND_QUEUE_URL` and passes each notification
to the same handler, which:

1. verifies the SNS message with `core::sns`: `SignatureVersion` must be `2` (version 1 is refused), the
   certificate host `sns.{PM_SES_REGION}.amazonaws.com`, the topic `PM_SES_INBOUND_TOPIC_ARN`, and
   `Timestamp` within one hour (14 days on the backstop path). Failure → `403 invalid_signature` and
   `ses_sns_rejected_total` ([N1](../edge-cases.md), [N2](../edge-cases.md));
2. checks that the notification is `Received` with an S3 action on that bucket;
3. for each `receipt.recipients` entry, runs `INSERT OR IGNORE INTO ses_ingest` (status `queued`) and
   queues an `InboundPointer` with `source = ses` only when a row was inserted. Duplicates from SNS
   retries, the backstop, or both stop here ([N3](../edge-cases.md));
4. answers `200` after the enqueue, or `500` on an internal failure (SNS retries `5xx` and `429`).

**Resolution in the consumer.** An SES pointer has no tenant, identity or message ID yet. Before step 1 of
the [consumer](#the-pm-inbound-consumer):

1. **Fetch** the object (`GET https://{bucket}.s3.{region}.amazonaws.com/in/{key}`, SigV4 with service
   `s3`) into R2 as `inbound-staging/ses/{key}`, unless that copy already exists. `NoSuchKey` while the
   ledger row is still `queued` means the lifecycle rule ran: the row becomes `lost` (with `done_at`),
   `ses_object_lost_total` is incremented, the `ses_object_lost` alert fires, and the pointer is acked
   ([N4](../edge-cases.md)).
2. **Resolve** the recipient: normalise it as in `email()` step 2, handle tenant-domain `postmaster` and
   `abuse` as in step 3 (the owner gets a copy; the platform domain never uses SES), and run the directory
   lookup of step 4.
3. **Decide** (first match):

   | Directory result | Action |
   |---|---|
   | No row, tombstoned, non-ASCII local part, `pending` address, identity `deleting`/`deleted`, tenant `erasing`/`erased` | Dropped without a bounce: ledger row `dropped`, `inbound_dropped_total{reason="unknown_recipient",source="ses"}` ([N6](../edge-cases.md)) |
   | `retired` address | SES normally bounces it before this point (rule `pm-retired-{n}`, `550 5.1.6`, [N7](../edge-cases.md)). One that still arrives (the rule is not yet updated, the address is past the 150-rule cap, or tenant policy `inbound.ses_bounce_retired` is `false`) is dropped as above |
   | Tenant `suspended` | Held (FR-TEN-3): the ledger row becomes `held`, the staging copy and the S3 object are kept, and the pointer is acked. The every-minute backstop cron re-sends the pointer once the tenant is active again. After 5 days of suspension (`tenants.suspended_at`) the row becomes `dropped`, without a bounce, and `inbound_dropped_total{reason="tenant_suspended",source="ses"}` is incremented ([Domains on any DNS host § 4.6](domain-connections.md#46-retired-and-unknown-recipients)) |
   | Otherwise | Allocate `message_id`, copy the staging object to `t/{tenant_id}/i/{identity_id}/m/{message_id}/raw.eml`, and continue with the consumer steps, with `envelope_from = mail.source` and `envelope_to` = the recipient. The `source` stays `ses`, so its verdicts are used |

   A bounce sent after SES has accepted a message goes to whatever sender the message claims, which spam
   forges (backscatter), so the Worker never bounces SES mail. Email Routing domains keep the SMTP-time
   answers of `email()` step 5.

**After the commit**, the post-commit steps set the ledger row to `done` with `done_at`. When no row for
the key is still `queued` or `held`, the consumer deletes the S3 object (`DeleteObject`). A pointer whose
ledger row is no longer `queued` is acked without work: the hook inserts the row and then enqueues, which
is not one transaction, so the backstop cron re-sends the pointer of any row still `queued` 15 minutes
after `received_at`, and duplicates must be harmless. The 1-day lifecycle rule
on `inbound-staging/` removes the R2 copy, and the bucket's 14-day lifecycle rule is the backstop for S3.

**Many recipients.** One SES message can name recipients on several domains, of several tenants. Each
recipient is its own pointer and is resolved on its own, so tenants stay isolated ([N28](../edge-cases.md)).
Two recipients in one mailbox give one message (duplicate by hash, [B14](../edge-cases.md)).

**Verdicts.** The notification is signed by our topic, so its verdicts are trusted. They feed SPF
([Authentication verdict](#authentication-verdict)), the [spam score](#trust-signals) and the
[quarantine decision](#quarantine-decision) (virus). SES's own DKIM and DMARC results are only compared.

## The pm-inbound consumer

`pm-inbound` has batch size 10 and 10 retries. The consumer processes messages one at a time (a batch
could otherwise hold 250 MiB of raw mail in a 128 MB isolate) and acks each after its post-commit steps.

### Steps

1. **Re-read scope** from D1 (5-second deadline):

   ```sql
   SELECT i.status, i.mailbox_do_id, i.display_name, t.status AS tenant_status, t.mode,
          t.policy_json, t.timezone, t.name AS tenant_name
   FROM identities i JOIN tenants t ON t.id = i.tenant_id
   WHERE i.id = ?1 AND i.tenant_id = ?2;
   ```

   An SES pointer is resolved first ([The SES source](#the-ses-source)).
   Identity `deleting`/`deleted`, or tenant `erasing`/`erased` (the cache in `email()` may have been
   up to 60 seconds stale): delete the raw object, ack, count
   `inbound_dropped_total{reason="identity_gone",source}` (`source` is `routing` or `ses`).
   For a `Staged` pointer, run the directory query of `email()` step 4 now: unknown, pending or retired
   → delete the staging object, ack, count `inbound_staged_unroutable_total` (the sender already got a
   `250`; no bounce is sent, to avoid backscatter); routable → copy the object to its final key, delete
   the staging object, and continue as a `Message`.
2. **Fetch raw** from R2 into wasm memory. A missing object is either already processed and erased, or
   a bug: ask the mailbox whether `message_id` exists; ack either way and count
   `inbound_raw_missing_total` when it does not.
3. **Hash**: `raw_sha256 = hex(sha256(raw))`.
4. **Parse** under caps (see [Parsing](#parsing)). **Degraded mode:** if the pointer is older than 15
   minutes (`now - received_at > 900_000`), earlier attempts have failed (a parser panic aborts the
   invocation, and `workers-rs` does not expose the attempt count), so the consumer parses headers
   only, stores the message with `parse_degraded`, and never drops it (FR-IN-3).
5. **Effective policy** = built-in defaults ⊕ `PM_DEFAULT_POLICY` ⊕ `tenants.policy_json`
   ([tenant policy](../../reference/configuration.md#tenant-policy)).
6. **Classify** automation ([Automated mail](#automated-mail-and-loops)). A DSN goes to
   [DSN routing](#dsn-routing-and-backscatter) inside `Ingest`.
7. **Authenticate** ([Authentication verdict](#authentication-verdict)), unless `loopback` is set. For
   the SES source, SPF comes from SES's verdict.
8. **Content**: sanitise HTML, remove hidden text, derive text, extract new content, snippet
   ([Sanitising](#sanitising-html), [Hidden text](#hidden-text-b11), [Text](#text-derivation-b4),
   [Quotes](#quote-and-signature-stripping)).
9. **References** ([Reference extraction](#reference-extraction)).
10. **Attachments**: list, sniff, classify risk, unpack TNEF, optional scanner
    ([Attachment safety](#attachment-safety)).
11. **Verification codes and links** ([Verification codes](#verification-codes-and-unsolicited-otp-e5)).
12. **D1 facts** (one `batch`, 5-second deadline):
    - sender suppressed: `SELECT 1 FROM suppressions WHERE tenant_id = ?1 AND address_hash = ?2 AND (expires_at IS NULL OR expires_at > ?3)`;
    - receive lists: `SELECT kind FROM sender_lists WHERE tenant_id = ?1 AND direction = 'receive' AND entry IN (?2, ?3)` with `?2` = sender address, `?3` = `@` + sender domain (block wins over allow);
    - tenant domains (for look-alike checks): `SELECT name FROM domains WHERE (tenant_id = ?1 OR kind = 'platform') AND state <> 'removed'`;
    - co-recipient identities ([A9](#multiple-identities-in-one-tenant-a9)).
13. **Call `MailboxRequest::Ingest`** with an `IngestInput` (30-second deadline).
14. **Post-commit** ([Post-commit](#post-commit-attachments-and-index-jobs)), then ack.

### Failure handling

| Call | Deadline | On failure |
|---|---|---|
| D1 scope / facts | 5 s | `retry(30 s)` |
| R2 `get` raw | 10 s | error → `retry(30 s)`; not found → step 2 |
| R2 copy for a staged pointer | 10 s | `retry(30 s)`; the staging object is deleted only after the copy succeeds |
| S3 `GetObject` for an SES pointer | 60 s | error → `retry(30 s)`; `NoSuchKey` → ledger `lost` ([The SES source](#the-ses-source)) |
| D1 `ses_ingest` update, S3 `DeleteObject` | 5 s, 10 s | `retry(30 s)`; the repeat `Ingest` returns the stored message, and a failed delete is retried by the next recipient's commit or left to the 14-day lifecycle rule |
| DoH lookups | 3 s each, 4 s total | second resolver, then `temperror` in the verdict (never a retry of the message) |
| Scanner (`PM_SCANNER_URL`) | 30 s per attachment, 60 s per message | `scan_status = 'error'`, continue, count `scanner_error_total` |
| `Ingest` RPC | 30 s | `unavailable` or `timeout` → `retry(30 s)`; `ingest` is idempotent on `raw_sha256` ([J2](../edge-cases.md)) |
| R2 `put` attachments, queue `send_batch` | 10 s | `retry(30 s)`; the repeat `Ingest` returns the stored message |
| Unexpected error or panic | – | queue retry up to 10, then `pm-inbound-dlq` ([J8](../edge-cases.md)) |

## Parsing

`core::mime::parse(raw: &[u8], caps: &Caps) -> ParsedMessage` uses `mail_parser::MessageParser::default()`
(every known header parsed) with the `full_encoding` feature for legacy charsets. `mail-parser` 0.11.9
has no configurable depth or part limit and no TNEF support (read from its source, 2026-10-09), so the
caps are applied while walking the parsed tree:

| Cap | Value | When exceeded |
|---|---|---|
| Nesting depth | 32 | Deeper parts are not processed (they stay in the raw MIME); flag `parse_degraded` |
| Parts | 500 | Parts after the 500th are not processed; flag `parse_degraded` |
| Nested `message/rfc822` text extraction | 3 levels | Deeper nested messages are kept as attachments without text |

`ParsedMessage` holds: header fields (`From` list, `Sender`, `To`, `Cc`, `Reply-To`, `Subject`, `Date`,
`Message-ID`, `In-Reply-To`, `References`, `Auto-Submitted`, `List-*`, `Precedence`, `Content-Type`,
`X-Pylota-Mail-Hop`, `Authentication-Results`, `Disposition-Notification-To`), the selected text and HTML
bodies, the attachment parts, and flags.

Rules:

- **Bodies.** The text body is the first `text/plain` part that is not `Content-Disposition: attachment`;
  the HTML body is the first such `text/html` part (in `multipart/alternative`, the last alternative of
  each type wins, per RFC 2046). Every other leaf part is an attachment, including inline images.
- **Charsets ([B5](../edge-cases.md)).** Decoded to UTF-8. When the decoded text contains U+FFFD and the
  raw part did not contain the UTF-8 bytes `EF BF BD`, set `parse_degraded`.
- **`From` ([B13](../edge-cases.md)).** No `From`: `from_address` is `NULL`, flag `parse_degraded`.
  Several `From` mailboxes: the first parseable one is used, flag `parse_degraded`, and
  `auth_json.multiple_from = true` caps the verdict at `unaligned`.
- **`Message-ID` ([B3](../edge-cases.md)).** Normalised as in [Threading](threading.md#32-message-id-normalisation-and-matching).
  Missing or unparseable: `rfc_message_id = "{raw_sha256}@synthetic.invalid"`, `message_id_synthetic = 1`.
- **`Date`.** `sent_at` is the `Date` header when it parses and lies between `received_at − 10 years`
  and `received_at + 1 day`; otherwise `received_at`.
- **Encrypted ([B9](../edge-cases.md)).** `application/pkcs7-mime` with `smime-type=enveloped-data`, or
  `multipart/encrypted`: flag `encrypted`; `text`, `html_sanitized` and `extracted_text` are `NULL`;
  the encrypted part is stored as an attachment. Signed-only (`multipart/signed`,
  `smime-type=signed-data`): content is processed normally and `auth_json.signature` records
  `{ "type": "smime" | "pgp", "status": "present_unverified" }`. v1 never verifies S/MIME or PGP
  signatures (no certificate store or keyring); the signature part is kept as an attachment.
- **TNEF ([B6](../edge-cases.md)).** An `application/ms-tnef` part (or `winmail.dat`) is unpacked by
  `core::mime::tnef::extract`, which reads the TNEF stream (signature `0x223E9F78`) and returns the
  attachments it carries (`attAttachData` with `attAttachTitle`, or the MAPI long filename). The
  extracted files become ordinary attachments. If unpacking fails, `winmail.dat` is kept as an attachment.
- **Nested messages ([B6](../edge-cases.md), FR-THR-2).** See [Threading](threading.md#33-forwarded-and-nested-messages-fr-thr-2-b6).
- **Calendar ([B8](../edge-cases.md)).** A `text/calendar` part sets `kind = 'calendar'` (unless the message
  is a DSN, MDN or list mail) and its first `VEVENT` is summarised in `automated_json.calendar`:
  `{ method, summary, dtstart, dtend, organizer, location }` (strings, each ≤ 256 characters).
  Invites are never answered or accepted by the service.

### Storage caps

Durable Object SQLite allows at most 2 MB per value or row
([limits](https://developers.cloudflare.com/durable-objects/platform/limits/), read 2026-10-09). The full
message always remains in R2, so the stored columns are capped, cutting at a UTF-8 character boundary:

| Column | Cap |
|---|---|
| `subject` | 998 characters |
| `text` | 512 KiB |
| `html_sanitized` | 1 MiB |
| `extracted_text` | 256 KiB |
| `snippet` | 240 characters of `extracted_text`, whitespace collapsed |
| `to_json`, `cc_json` | 200 addresses each |
| `references_json` | 200 msg-ids (the last 200) |
| `from_name`, display names | 256 characters, control characters removed |

When `text`, `html_sanitized` or `extracted_text` is cut, the message gets the flag `body_truncated`.

## Sanitising HTML

Sanitising runs in two passes in `core::sanitize`:

1. **DOM pass** (`html5ever` + `markup5ever_rcdom`): parse the HTML body, remove hidden elements
   ([Hidden text](#hidden-text-b11)), remove `src` from every `<img>` whose source is not `cid:` (remote
   images are never fetched by the service, [B7](../edge-cases.md); the `alt` text stays), record the
   `cid:` references, and serialise.
2. **`ammonia` pass** with this policy, built once:

| Setting | Value |
|---|---|
| `tags` | `a abbr b bdi bdo blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr` |
| `clean_content_tags` (removed with their content) | `script style title noscript template iframe frame frameset object embed applet svg math select textarea button` |
| `generic_attributes` | `lang title dir` |
| `tag_attributes` | `a: href` · `img: src alt width height` · `td, th: colspan rowspan align valign width` · `table: width border cellpadding cellspacing align` · `col, colgroup: span width` · `ol: start type` · `li: value` · `time: datetime` |
| `url_schemes` | `http https mailto tel cid` |
| `attribute_filter` | keep `img src` only when it starts with `cid:`; keep `a href` only for `http`, `https`, `mailto`, `tel` |
| `url_relative` | `Deny` |
| `link_rel` | `Some("noopener noreferrer nofollow")` (`rel` is not an allowed attribute, as `ammonia` requires) |
| `strip_comments` | `true` |
| `style`, `class`, `id`, `on*`, `data-*` | never allowed |

The result is `html_sanitized`. The service never renders it. API responses mark all text fields as
untrusted content.

## Hidden text (B11)

Hidden content is removed from everything an agent reads: `text`, `html_sanitized`, `extracted_text`,
`snippet`, the subject and display names (characters only), attachment text, and triage input (FR-IN-9,
[B11](../edge-cases.md)).

**Hidden elements** (DOM pass). An element and its subtree are removed when any of these hold, from its
inline `style`, its attributes, or a matching rule in a `<style>` block (only simple selectors are
evaluated: `tag`, `.class`, `#id`, `tag.class`, comma lists; rules inside `@media` are ignored):

| Signal | Condition |
|---|---|
| Display | `display:none`; `visibility:hidden` or `collapse`; the `hidden` attribute; `<input type="hidden">` |
| Transparency | `opacity` ≤ 0.05; `color:transparent` |
| Size | `font-size` ≤ 1 px, ≤ 1 pt, or 0 (any unit); `max-height:0`, `height:0`, `width:0` or `max-width:0` together with `overflow:hidden` |
| Position | `position:absolute` or `fixed` with `left`, `top` or `text-indent` ≤ −999 px; `clip:rect(0,0,0,0)`; `clip-path:inset(50%)` or more |
| Same colour | the element's text colour equals its effective background colour, where the background comes from the nearest ancestor `background`, `background-color` or `bgcolor`, defaulting to white (`#ffffff`). Colours are compared after normalising names, `#rgb`, `#rrggbb` and `rgb()` |
| Comments | HTML comments, including conditional comments (`<!--[if mso]>…<![endif]-->`) |

**Hidden characters** are removed from all agent-facing text: U+200B, U+200C, U+2060–U+2064, U+FEFF,
U+00AD, U+034F, U+180E, U+115F, U+1160, U+3164, U+FFA0, bidirectional overrides and isolates
(U+202A–U+202E, U+2066–U+2069), and tag characters (U+E0000–U+E007F). U+200D (zero-width joiner) is
removed except between two `Extended_Pictographic` characters (emoji sequences). U+200E and U+200F
(direction marks) are kept.

**Flag.** `hidden_text` is added to `flags_json`, and the risk flag `hidden_text` is passed to triage,
when any of: a removed element contained at least one non-whitespace character; any tag character or
bidirectional override was removed; or more than two zero-width characters were removed outside emoji
sequences.

## Text derivation (B4)

`text` is the `text/plain` body when present. When the message is HTML-only, `core::text::derive_text`
walks the sanitised DOM:

- block elements (`p div br li tr h1–h6 blockquote pre table hr`) end a line; `p` and headings add a
  blank line;
- `li` is prefixed with `- ` (or `1. ` inside `ol`);
- `blockquote` lines are prefixed with `> ` (so quote stripping recognises them);
- `a` renders as `text (url)` when the URL differs from the text and the scheme is `http`, `https` or
  `mailto`;
- `img` renders as `[image: alt]` when it has non-empty `alt`;
- table cells in a row are joined with ` | `;
- `pre` keeps its whitespace; elsewhere runs of whitespace collapse to one space;
- entities are decoded; at most two consecutive blank lines; trimmed.

`text` is null only for encrypted messages. HTML-only mail always produces text (FR-IN-7).

## Quote and signature stripping

`core::quote::extract_new_content(text, html_dom) -> String` produces `extracted_text`, the new content
of the message (FR-IN-7).

**HTML markers first.** If the HTML body has one of these, the DOM is cut at the first one and the text
is derived from what precedes it: `div.gmail_quote`, `blockquote[type=cite]`, `div#divRplyFwdMsg`,
`div#appendonsend`, `hr#stopSpelling`, `div.yahoo_quoted`, `div#mail-editor-reference-message-container`,
`blockquote.protonmail_quote`.

**Text algorithm** otherwise, on `text` (or derived text):

1. Find the earliest **quote header line** at or after line 1 (a header on line 0 is ignored, so a reply
   whose first line matches is not emptied). A match may span two lines (wrapped headers), so line `i`
   is also tested joined with line `i+1`:

   | Language | Patterns (case-insensitive, whole line) |
   |---|---|
   | English | `^On .{1,200} wrote:$` · `^-{2,} ?Original Message ?-{2,}$` · `^-{2,} ?Forwarded message ?-{2,}$` · `^Begin forwarded message:$` |
   | German | `^Am .{1,200} schrieb .{1,200}:$` · `^-{2,} ?Ursprüngliche Nachricht ?-{2,}$` |
   | French | `^Le .{1,200} a écrit ?:$` · `^-{2,} ?Message d'origine ?-{2,}$` |
   | Spanish | `^El .{1,200} escribió:$` · `^-{2,} ?Mensaje original ?-{2,}$` |
   | Italian | `^Il .{1,200} ha scritto:$` · `^-{2,} ?Messaggio originale ?-{2,}$` |
   | Dutch | `^Op .{1,200} schreef .{1,200}:$` · `^-{2,} ?Oorspronkelijk bericht ?-{2,}$` |
   | Portuguese | `^Em .{1,200} escreveu:$` |
   | Swedish, Danish, Norwegian | `^Den .{1,200} skrev .{1,200}:$` · `^.{1,200} skrev:$` |
   | Polish | `^.{1,200} napisał(a)?:$` |
   | Russian | `^.{1,200} писал(а)?:$` |
   | Japanese | `^.{1,200}(さんは書きました|wrote)[:：]$` |
   | Chinese | `^.{1,200}写道[:：]$` |

   An **Outlook-style header block** also counts: a line `^(From|Von|De|Da|Van|Från|Od) ?:` followed
   within the next 4 lines by a line `^(Sent|Date|Gesendet|Datum|Envoyé|Enviado|Inviato|Verzonden|Skickat|Wysłano|Enviada) ?:`
   and one `^(To|Subject|An|Betreff|À|Objet|Para|Asunto|A|Oggetto|Aan|Onderwerp|Till|Ämne|Do|Temat|Assunto) ?:`.
   A line of 10 or more underscores directly above such a block is included in the cut.
2. Cut the text at that line.
3. Remove every line that starts (after optional spaces) with `>`. Inline replies between quoted lines
   are kept.
4. **Signature.** Cut at the first line that is exactly `-- ` or `--` (RFC 3676), when it is in the last
   15 non-blank lines. Also cut mobile signatures when they are in the last 5 non-blank lines:
   `^Sent from my (iPhone|iPad|Android|mobile device|phone)`, `^Get Outlook for (iOS|Android)`,
   `^Sent from (Mail|Outlook|Yahoo Mail) for`, `^Von meinem (iPhone|iPad|Smartphone) gesendet`,
   `^Envoyé de mon (iPhone|iPad)`, `^Enviado desde mi (iPhone|iPad)`, `^Inviato da (iPhone|iPad)`,
   `^Verzonden (vanaf|met) mijn (iPhone|iPad)`. Sign-offs such as "Kind regards" are kept.
5. Trim. **Fallbacks:** if the result is empty and the cut was at a forward marker, `extracted_text` is
   the text from the forward marker onwards (an inline forward with no comment). If it is empty
   otherwise, `extracted_text` is `text` with only step 4 applied.

The hidden-character rules then run on the result, and `snippet` is its first 240 characters.

## Reference extraction

`core::refs::extract(subject, extracted_text, packs, custom, tz) -> Vec<Ref>` runs at ingest on the
subject and `extracted_text` (not the quoted history, so a quoted invoice number does not make every
reply match), and later on attachment text (FR-SRCH-4). Each `Ref` is `{ kind, value, source }` with
`source` one of `subject`, `body`, `att:{attachment_id}:{page}`. At most 50 refs per kind and 200 per
message; values are at most 64 characters.

**Pack `core`** (always on):

| Kind | Matches | Normalised value |
|---|---|---|
| `amount` | A currency symbol or code next to a number: `£ € $`, `GBP EUR USD`, either side, e.g. `£412.80`, `412,80 €`, `USD 1,200` | `{ISO code}:{amount with two decimals}`, e.g. `GBP:412.80`. A comma is the decimal separator only for `€`/`EUR` amounts of the form `\d+,\d{2}` with no other separator |
| `phone` | `+` or `00` followed by 7–15 digits with optional spaces, dots, dashes or parentheses; national-format numbers of the tenant's country, which is derived from its time zone (default `GB`), the same rule as [Search §3.5](search.md#35-references) | E.164, e.g. `+447700900123` |
| `email` | RFC 5322 `addr-spec` in text | lower case, A-label domain |
| `domain` | Domains of matched emails and of `http(s)` URLs | registrable domain (public suffix list), lower case |
| `date` | ISO `YYYY-MM-DD`; `D/M/YYYY` and `D.M.YYYY` (read as day first when the tenant time zone is in `Europe/`, otherwise only when the first number is > 12); `D Month YYYY` with English month names or three-letter abbreviations | `YYYY-MM-DD` |
| `invoice` | A keyword (`invoice`, `inv`, `rechnung`, `facture`, `factura`, `fattura`), optional `no.`, `number`, `nr.`, `#` or `:`, then `[A-Z0-9][A-Z0-9/-]{2,24}`; or `INV-` followed by digits | upper case; for `INV-` plus digits, the digits only (so `Invoice 88213` and `INV-88213` both give `88213`) |
| `order` | `order`, `ord`, `po`, `purchase order`, `bestellung`, `commande`, `pedido`, optional separator, then `[A-Z0-9][A-Z0-9-]{3,24}` | upper case |

**Pack `uk_vehicle`** (opt-in through `search.refs_packs`):

| Kind | Matches | Normalised value |
|---|---|---|
| `uk_plate` | Current format `[A-Z]{2}\d{2} ?[A-Z]{3}`; prefix format `[A-Z]\d{1,3} ?[A-Z]{3}`; suffix format `[A-Z]{3} ?\d{1,3}[A-Z]`; on word boundaries, case-insensitive | upper case, spaces and dashes removed: `AB12 CDE` → `AB12CDE` ([F5](../edge-cases.md)) |
| `pcn` | `[A-Z]{2}\d{8}` on word boundaries; or, within 20 characters after `PCN` or `penalty charge`, `[A-Z0-9]{8,12}` | upper case, spaces removed |

**`custom_refs`** (up to 20, from policy): each `{ name, pattern, normalise }` is compiled with the
`regex` crate (linear time, no back-references, `size_limit` 64 KB); invalid patterns are refused when
the policy is saved. Matches produce kind `custom:{name}` with the whole match (or capture group 1 if
present), normalised by `normalise`: `upper`, `lower` or `none`, then trimmed.

Refs are inserted into `refs` and their values (normalised plus, for plates, the spaced display form)
into the FTS `refs` column ([Search](search.md)).

## Automated mail and loops

`core::classify::classify(&ParsedMessage) -> Classification { kind, automated, evidence, dsn, mdn }`
(FR-IN-6, [D6](../edge-cases.md), [B8](../edge-cases.md)). The first matching row sets `kind`; evidence
from every row is collected into `automated_json.evidence`.

| Order | Signal | `kind` |
|---|---|---|
| 1 | `Content-Type: multipart/report; report-type=delivery-status` (RFC 3464); or a heuristic bounce: `From` local part `mailer-daemon` or `postmaster`, a subject matching `undeliver|delivery status notification|mail delivery failed|returned mail|failure notice`, and a `message/rfc822` or `text/rfc822-headers` part | `dsn` |
| 2 | `multipart/report; report-type=disposition-notification` (RFC 8098) | `mdn` |
| 3 | `List-Id`, `List-Unsubscribe` or `List-Post` present, or `Precedence: list` or `bulk` | `list` |
| 4 | `Auto-Submitted` present with a value other than `no` (RFC 3834 `auto-generated`, `auto-replied`; RFC 5436 `auto-notified`); `X-Autoreply`, `X-Autorespond`; `X-Auto-Response-Suppress` containing `All` or `OOF`; `Precedence: junk` or `auto_reply`; a subject starting `Out of Office`, `Automatic reply:`, `Auto:`, `Autosvar:`, `Abwesenheitsnotiz`, `Réponse automatique`; `From` local part `noreply`, `no-reply`, `donotreply`, `do-not-reply`; the null envelope sender; `X-Pylota-Mail-Hop` ≥ 20 | `automated` |
| 5 | A `text/calendar` part (and none of the above) | `calendar` |
| 6 | Otherwise | `normal` |

- `trust.automated` is true for `dsn`, `mdn`, `list` and `automated`. Agents must not auto-reply to these;
  the send path refuses `kind: auto_reply` replies to them ([Outbound](outbound.md)).
- `X-Pylota-Mail-Hop: n` is set by our own outbound mail ([Outbound](outbound.md#composition)). Any value
  ≥ 1 adds evidence `pylota_agent`; ≥ 20 makes the message `automated` (a loop breaker).
- `Disposition-Notification-To` adds evidence `mdn_requested`. Read receipts are never sent ([B8](../edge-cases.md)).
- For a DSN, `classify` also parses the `message/delivery-status` part into
  `dsn = { reporting_mta, original_envelope_id, original_message_id, recipients: [{ final_recipient, action, status, diagnostic_code }] }`,
  taking `original_message_id` from the `Message-ID` of the returned `message/rfc822` or
  `text/rfc822-headers` part.

## Authentication verdict

`core::auth` computes the verdict from the trusted `Authentication-Results` header, our own `mail-auth`
DKIM and ARC verification, and our own DMARC evaluation (FR-IN-4, [D1](../edge-cases.md),
[D9](../edge-cases.md)). For Email Routing, Cloudflare's own checks run before the Worker: mail that
fails both SPF and DKIM, or fails the sender's DMARC policy, is rejected by Email Routing
([email lifecycle](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/), read
2026-10-09). Which headers Cloudflare adds before the handler is not documented. Spike S2 records the
authserv-id Cloudflare stamps, setup writes it to `PM_TRUSTED_AUTHSERV_ID` from the mail test
([CLI and setup §6.3](cli.md#63-steps), step 23), and until then the only input that depends on the header,
SPF, is treated as unknown: a sender that could only align through SPF gets `unverified`, never `fail`
(step 7). The SES rule `pm-deliver` refuses nothing for authentication, so SES
mail that fails DMARC reaches the verdict below. The same DKIM, ARC and DMARC code runs for every
source; only the SPF input differs (step 5).

1. **Trusted `Authentication-Results`.** Parse every `Authentication-Results` header (RFC 8601) in order
   from the top. If `PM_TRUSTED_AUTHSERV_ID` is non-empty and the **topmost** header's authserv-id equals
   it, that header is trusted. Every other `Authentication-Results` header is ignored, including lower
   ones with the right authserv-id (a sender can add those).
2. **DNS prefetch.** Collect the TXT names needed: `{s}._domainkey.{d}` for each `DKIM-Signature`
   (at most 10) and for each `ARC-Message-Signature` and `ARC-Seal` (at most 5 instances), plus
   `_dmarc.{from_domain}` and `_dmarc.{organisational domain}` (public suffix list). Query them
   concurrently through `platform::Dns` on the first resolver, and on error or timeout on the second
   (3 s per query, 4 s in total). Each answer is parsed with `mail-auth`'s TXT record parser into the
   cache value type and inserted with `Parameters::with_txt_cache` (verify the parser's public path at
   build time, S4). A record that could not be fetched is cached as a temporary error. A cache miss
   would fall through to `mail-auth`'s own DoH client, which works on Workers but bypasses the
   two-resolver rule; the prefetch list is complete, so misses are counted (`auth_dns_cache_miss_total`)
   and treated as bugs.
3. **DKIM.** `verify_dkim` over the raw message gives one `DkimOutput` per signature: `d=`, `s=`, result
   (`pass`, `neutral`, `fail`, `permerror`, `temperror`, `none`).
4. **ARC.** `verify_arc` (feature `arc`) gives `pass`, `fail` or `none` and the instance count. It is
   recorded; it does not override DMARC in v1.0.
5. **SPF.** Email Workers do not expose the client IP and `mail-auth`'s SPF check needs it. SPF is taken
   from the trusted header's `spf=` result and `smtp.mailfrom` (domain = the part after `@`, or the
   envelope sender's domain). Without a trusted header (`PM_TRUSTED_AUTHSERV_ID` empty, or the topmost
   header from another authserv-id), SPF is `none` and recorded as unchecked
   (`auth_json.spf.source = null`). **SES source:** SPF is SES's
   `spfVerdict` (`PASS` → `pass`, `FAIL` → `fail`, `GRAY` and `PROCESSING_FAILED` → `none`), with
   `mail.source` (the envelope MAIL FROM) as the checked domain. SES saw the connecting IP; the Worker
   did not.
6. **DMARC** (`core::auth::dmarc`, our implementation, because SPF comes from step 5):
   - `from_domain` = domain of the (first) `From` address. Look up `_dmarc.{from_domain}`; if there is
     no record, `_dmarc.{org_domain}`. Parse `v` (must be `DMARC1`, first), `p`, `sp`, `adkim`, `aspf`
     (defaults `r`); `pct` and `t` are parsed and ignored. More than one record, or none: no policy.
   - DKIM-aligned: a `pass` signature whose `d` equals `from_domain` (`adkim=s`) or shares its
     organisational domain (`adkim=r`). SPF-aligned: SPF `pass` with the same rule over the SPF domain
     and `aspf`.
   - Result: `pass` if either is aligned; `fail` if a policy exists and neither is aligned; `temperror`
     if a needed lookup failed and nothing passed; `none` if there is no record.
   - Policy in force: `sp` when the record came from the organisational domain and `from_domain` is a
     subdomain, else `p`.
   - If our result is `temperror` and the trusted header has `dmarc=pass` or `dmarc=fail`, use the
     trusted result.
   - The organisational domain uses the public suffix list (RFC 7489). RFC 7489 is obsoleted by
     RFC 9989 (DMARCbis, 2026), which replaces the list with a DNS tree walk; that change needs an ADR
     and a corpus re-run before adoption.
7. **Verdict** (`messages.verdict`):

   | Condition (first match) | `verdict` |
   |---|---|
   | `loopback` set ([L3](../edge-cases.md)) | `pass` |
   | DMARC `pass` | `pass` |
   | DMARC `fail`, the policy in force is `quarantine` or `reject`, no aligned DKIM `pass`, and SPF unchecked (Email Routing source without a trusted header, step 5) | `unverified`: SPF alignment, which Cloudflare checked before the Worker, could not be read (the authserv-id is recorded by [spike S2](index.md#spikes)) |
   | DMARC `fail` and the policy in force is `quarantine` or `reject` | `fail` |
   | DMARC `fail` with `p=none` | `unaligned` |
   | DMARC `temperror` | `softfail` |
   | No DMARC record | `none`. Alignment is recorded separately: `auth_json.dmarc.aligned_by` is `dkim`, `spf` or `null`, and each DKIM entry has `aligned` |

   Then, if `multiple_from`, the verdict is capped at `unaligned`. Only `fail` and `unverified` can
   quarantine; `none` and `unaligned` never quarantine on their own ([D1](../edge-cases.md)).
8. **`auth_json`**:

   ```json
   {
     "authserv": { "id": "mx.cloudflare.net", "trusted": true },
     "spf":   { "result": "pass", "domain": "mail.brightwell.example", "source": "authserv" },
     "dkim":  [ { "d": "brightwell.example", "s": "s1", "result": "pass", "aligned": true } ],
     "dmarc": { "result": "pass", "policy": "reject", "record_domain": "brightwell.example", "aligned_by": "dkim" },
     "arc":   { "result": "none", "instances": 0 },
     "multiple_from": false,
     "signature": null
   }
   ```

   `dmarc.aligned_by` (`dkim`, `spf` or `null`) is set whatever the result, so alignment is recorded even
   when there is no DMARC record (verdict `none`, [D1](../edge-cases.md)).

   For the SES source, `authserv` is `null`, `spf.source` is `"ses"`, and `ses` holds SES's own verdicts
   (`spf`, `dkim`, `dmarc`, `spam`, `virus`, `dmarc_policy`). When SES's DKIM or DMARC result differs from
   ours, `ses_auth_disagreement_total` is incremented; ours decides.

   The API's `trust.spf`, `trust.dkim`, `trust.dmarc` and `trust.arc` are the summary results (DKIM: `pass`
   if any aligned signature passed, else the first signature's result, else `none`).

## Trust signals

Computed partly in the consumer and finished inside `ingest`, which can see the mailbox's contacts.

| Signal | Rule |
|---|---|
| `known_sender` (FR-IN-4) | True when the sender address is in `contacts` with `outbound_count > 0` (we have written to them), or matches a receive-allow entry, or its domain is one of the tenant's domains and the verdict is `pass` |
| `display_name_spoof` ([D2](../edge-cases.md)) | The display name contains an address-like token different from the `From` address; or its confusable fold equals the fold of the name of a contact with `outbound_count > 0` whose address differs; or it equals the identity's display name or the tenant name while the sender is not this identity |
| `lookalike_domain` ([D2](../edge-cases.md)) | The fold of the sender's registrable domain equals the fold of a tenant domain or of a contact domain with `outbound_count > 0`, while the domains differ. The fold is the UTS #39 skeleton plus the ASCII rules of [Identities › Confusables](identity-domains.md#confusable-detection) |
| `reply_to_mismatch` ([D3](../edge-cases.md)) | `Reply-To` is present and its organisational domain differs from the `From` organisational domain. Who replies go to is decided at reply time ([Outbound](outbound.md#composition)) |
| `thread_join_unverified` ([D10](../edge-cases.md)) | [Threading](threading.md#31-order-fr-thr-1) |
| `hidden_text` ([B11](../edge-cases.md)) | [Hidden text](#hidden-text-b11) |

These are stored in `flags_json`; the API returns `hidden_text`, `display_name_spoof`,
`lookalike_domain`, `reply_to_mismatch` and `thread_join_unverified` as `trust.flags` and the rest as
message `flags`.

**Spam score** (`spam_score`, 0–1, FR-IN-4). The consumer computes a base from deterministic signals and
`ingest` applies the sender adjustments, then clamps to [0, 1]:

| Signal | Weight |
|---|---|
| verdict `softfail` / `none` / `unaligned` / `unverified` / `fail` | +0.20 / +0.10 / +0.10 / +0.20 / +0.50 |
| `display_name_spoof`, `lookalike_domain` | +0.30 each |
| `hidden_text` | +0.20 |
| `reply_to_mismatch` | +0.10 |
| a link whose visible text is a URL or domain different from its `href` domain | +0.20 (once) |
| HTML-only, at least 3 links, under 200 characters of text | +0.10 |
| subject at least 70% upper-case letters (≥ 10 letters) | +0.10 |
| `known_sender` | −0.40 |
| sender in `contacts` with `inbound_count ≥ 3` and no previous quarantine | −0.10 |
| SES source with `spamVerdict` `FAIL` | the final score is at least 0.9 (applied after the adjustments above), so the default threshold of 0.8 quarantines it ([N27](../edge-cases.md)) |

SES `GRAY` and `PROCESSING_FAILED` verdicts are recorded in `auth_json.ses` and change nothing; they are
never a reason to drop mail.

## Quarantine decision

Decided inside `ingest` (first match wins, FR-IN-5):

| Order | Condition | `status` | `quarantine_reason` |
|---|---|---|---|
| 1 | Sender suppressed, or matches a receive-block entry ([D7](../edge-cases.md)) | `hidden` | `blocked_sender` |
| 2 | Per-sender throttle exceeded ([D5](../edge-cases.md)) | `throttled` | – |
| 3 | `verdict = 'fail'` and `quarantine.on_auth_fail` | `quarantined` | `auth_failed` |
| 3a | `verdict = 'unverified'` and `quarantine.on_auth_fail` (no trusted `Authentication-Results` yet, so SPF alignment could not be checked) | `quarantined` | `auth_unverified` |
| 4 | Any attachment has a `risk` that quarantines ([Attachment safety](#attachment-safety)), or `scan_status = 'infected'`, or the SES source's `virusVerdict` is `FAIL` ([N27](../edge-cases.md)) | `quarantined` | `risky_attachment` |
| 5 | Unsolicited OTP ([E5](../edge-cases.md)) and `quarantine.unsolicited_otp` | `quarantined` | `otp_unsolicited` |
| 6 | `spam_score ≥ quarantine.spam_threshold` and the sender is not receive-allowed | `quarantined` | `spam` |
| 7 | Otherwise | `received` | – |

`hidden` and `throttled` messages are stored for audit, never evented, never auto-replied to, never
searched and never counted for notifications. Quarantined messages are visible only to keys with
`quarantine:review`. In mail lists none of the three appears by default: a list shows them only for an
explicit `status` filter from a key holding `quarantine:review`
([Security §5.3](security.md#53-cross-level-read-access)). A receive-allow entry skips rule 6 only, never
rule 3.

**Per-sender throttle ([D5](../edge-cases.md)).** Inside the transaction:

```sql
INSERT INTO rate_windows (sender, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT (sender, window_start) DO UPDATE SET count = count + 1
RETURNING count;
-- ?1 lower-cased From address (or 'env:' || envelope sender when From is missing)
-- ?2 received_at - received_at % 3600000
```

`count > inbound.per_sender_per_hour` (default 60) → `throttled`, `inbound_throttled_total` incremented;
the observability design alerts on it. Rows older than 48 hours are deleted by the mailbox's daily
maintenance alarm.

## Verification codes and unsolicited OTP (E5)

`core::classify::find_verification(subject, extracted_text, links) -> Option<Verification>`:

- **Trigger:** the subject or the first 2,000 characters of `extracted_text` contain a keyword
  (`verification`, `verify`, `code`, `passcode`, `one-time`, `OTP`, `security code`, `confirm`,
  `sign in`, `sign-in`, `log in`, `login`, `password reset`, `reset your password`, `2FA`,
  `authentication`, `Bestätigungscode`, `code de vérification`, `código de verificación`).
- **Code:** the first match within 80 characters after a keyword of `\b\d{4,8}\b`, `\b\d{3}[ -]\d{3}\b`,
  or `\b[A-Z0-9]{6,8}\b` containing at least one digit; the value keeps its original spacing
  (`481 207`).
- **Link:** the first `http(s)` link whose URL or visible text contains `verify`, `confirm`, `activate`,
  `reset`, `magic`, `token`, `login` or `signin`.
- `kind` is `code` when a code was found, else `link`.

Rules:

- **E5.** The mailbox records active `wait` calls in `meta` under `wait:{sender_domain}`: the time until
  which the registration counts (the [`wait` handler](#the-wait-handler-e4) sends
  `MailboxRequest::RegisterWait { from_domain, ttl_ms }` when it starts and every 10 seconds while it
  waits). A message with a verification match is **unsolicited** when no `wait:{d}` exists with a value
  ≥ `received_at − 30 min`, where `d` is the sender's registrable domain.
- A `verifications` row is inserted only when the verdict is `pass` and the status is `received`:
  `(message_rowid, kind, value, sender_domain, received_at + 24 h, NULL)`. The outbox gets
  `verification.received` with `message_id`, `sender_domain` and `kind`; the value itself is released
  only through `wait` ([E4](../edge-cases.md)).

## The `wait` handler (E4)

`GET /v1/identities/{identity_id}/wait` (`search:read`, any key level, bucket `RL_API`), in
`handlers/wait.rs`. The request and response shapes are those of
[REST API › wait](../../reference/api.md#get-v1identitiesidentity_idwait--searchread); MCP's `mail_wait`
calls the same function (its `timeout_seconds` is the API's `timeout`). It is P0, because quarantine
rule 5 (unsolicited OTP, [E5](../edge-cases.md)) depends on its registrations.

1. **Validate.** `timeout` 1–60 seconds (default 30); `from` an address or `@domain`; `subject_contains`
   at most 200 characters; `thread_id` a `thr_` ID; `kind` `any`, `reply` or `verification`; `since`
   RFC 3339, default the request's start. `kind=verification` without `from` is `400 invalid_request`
   (`details.errors[0].path = "from"`), because a code is released only for an expected sender domain.
   `from_domain` is the registrable domain of `from` (the address's domain, or the `@domain`).
2. **Register** (only when `from` is given). Send `MailboxRequest::RegisterWait { from_domain, ttl_ms }`
   with `ttl_ms = (timeout + 10) × 1000`. The mailbox sets
   `meta['wait:{from_domain}'] = max(stored value, now + ttl_ms)` in one transaction. The handler sends
   it again every **10 seconds** while it waits, so a registration always outlives the request by up to
   10 seconds; E5 then counts it for 30 more minutes.
3. **Poll.** Every **1 second** until `deadline = start + timeout`, send
   `MailboxRequest::WaitPoll { since_ms, from, subject_contains, thread_id, kind, release_domain }` and
   stop at the first match. The mailbox returns the oldest inbound message with `received_at > since_ms`
   that the key may see (`received`, or `quarantined` when the key holds `quarantine:review`; never
   `hidden` or `throttled`; `wait` has no `status` filter, so the list rule of
   [Security §5.3](security.md#53-cross-level-read-access) does not apply) and that matches every given
   filter:
   - `from`: the `From` address equals it, or its domain equals the `@domain`;
   - `subject_contains`: a case-insensitive substring of the subject;
   - `thread_id`: the message's thread;
   - `kind = reply`: the message joined an existing thread that holds an outbound message (by token or
     headers, not a new thread);
   - `kind = verification`: a `verifications` row exists for the message with `expires_at > now`.
4. **Release.** With `kind = verification` (or `any` with a match that has a verification row), the
   `verification` object is filled only when the message's verdict is `pass` and the row's
   `sender_domain` equals `from_domain`; otherwise it is `null` and the message is still returned. The
   first release sets `consumed_at = now`. A later `wait` can release the same value for 1 hour after
   `consumed_at` (a client retrying after a lost response); the daily maintenance alarm deletes rows past
   `expires_at` or more than 1 hour past `consumed_at`.
5. **Answer.** `200 { "message": Message, "verification": {…} | null, "timed_out": false }` on a match,
   or `200 { "message": null, "verification": null, "timed_out": true }` at the deadline. A client that
   disconnects stops the polling at the next tick. Waiting spends no CPU between polls, so a 60-second
   wait stays inside the Worker's limits.

Tests (`it::wait::e4_*`):

| Test | Proves |
|---|---|
| `it::wait::e4_code_released_on_pass` | A code mail from the expected domain with `verdict: pass` arriving during the wait is returned within 1 s of commit, with `verification.code`; `consumed_at` is set |
| `it::wait::e4_code_withheld_unauthenticated` | The same mail with `verdict: fail`, or from another domain, returns the message with `verification: null` |
| `it::wait::e4_timeout` | No match: `200` with `timed_out: true` at the deadline (time-controlled harness) |
| `it::wait::e4_registration_refresh` | `RegisterWait` is sent at the start and every 10 s with `ttl_ms = (timeout + 10) × 1000`; an OTP mail from that domain 20 minutes after the wait ended is not quarantined (E5) |
| `it::wait::e4_filters_and_since` | `subject_contains`, `thread_id`, `kind=reply` and `since` each narrow the match; `kind=verification` without `from` is `400 invalid_request` |
| `it::wait::e4_retry_after_release` | A second wait within 1 hour of release returns the same value; after the maintenance purge it returns none |

## Multiple identities in one tenant (A9)

Email Routing calls `email()` once per envelope recipient, and the SES source queues one pointer per
recipient, so a message to two identities of one tenant becomes two independent copies with the same
`raw_sha256`, one per mailbox. To let integrators act once,
each copy computes `is_primary_recipient` deterministically from the headers, without coordination:

1. Header recipients in order: every `To` address, then every `Cc` address.
2. One D1 query:
   `SELECT address, identity_id FROM addresses WHERE tenant_id = ?1 AND status IN ('active','retiring') AND address IN (?2, …)`
   (at most 50 addresses; bound parameters stay under D1's 100).
3. The first header recipient that resolves names the **primary identity**.
4. `is_primary_recipient = 1` when no header recipient resolves (for example, a BCC-only delivery), or
   when the primary identity is this identity; else 0.

`delivered_to` is the envelope recipient without its detail, with one exception: mail for an
`external` domain arrives forwarded to the identity's platform address, so when the envelope recipient
is the platform address and a `To`/`Cc` address belongs to the same identity on an external domain,
`delivered_to` is that external address ([Identities and domains](identity-domains.md#kind-external)).
Such a message proves that forwarding works: after the commit, when that address's `forwarding` is
`unverified` or `failed`, the consumer sets it to `ok` with `forwarding_checked_at`
([Domains on any DNS host § 4.4](domain-connections.md#44-send_only)).
`is_bcc = 1` (flag `bcc`) when `delivered_to` matches none of `To`/`Cc` ([A10](../edge-cases.md)). The value is stored in
`messages.is_primary_recipient` and returned as `is_primary_recipient` in the API.

## IdentityMailbox.ingest

```rust
// crates/worker/src/mailbox/ingest.rs
pub struct IngestInput {
    pub message_id: String, pub received_at: i64, pub raw_r2_key: String, pub raw_size: u64,
    pub raw_sha256: String, pub envelope_from: String, pub delivered_to: String,
    pub detail: Option<String>,                    // +detail of the envelope recipient
    pub parsed: ParsedSummary,                     // headers, bodies (capped), kind, evidence, dsn
    pub auth: AuthSummary,                         // verdict, auth_json
    pub spam_base: f32, pub flags: Vec<String>,
    pub refs: Vec<Ref>, pub attachments: Vec<AttachmentMeta>, pub verification: Option<Verification>,
    pub sender_suppressed: bool, pub receive_list: Option<ListKind>,
    pub tenant_domains: Vec<String>, pub is_primary_recipient: bool, pub is_bcc: bool,
    pub policy: InboundPolicy, pub parser_version: u32, pub loopback: Option<LoopbackSource>,
}

pub enum IngestOutcome {
    Stored { message_id: String, thread_id: String, status: String, duplicate: bool,
             attachments: Vec<AttachmentToStore>, suppress: Vec<SuppressionRequest> },
    Backscatter,                                   // an unmatched DSN: nothing written (D4)
}
pub struct AttachmentToStore { pub attachment_id: String, pub part_index: u32, pub r2_key: String,
                               pub text_pending: bool }
```

`ingest` runs entirely inside one `transaction_sync` (FR-SRCH-2: the message is searchable in the same
transaction that stores it):

1. **Erased check.** `meta.erased = '1'` → `identity_not_found`.
2. **Duplicate by hash ([B14](../edge-cases.md), [J2](../edge-cases.md)):**

   ```sql
   SELECT rowid, id, thread_seq, status FROM messages
   WHERE raw_sha256 = ?1 AND direction = 'inbound' LIMIT 1;
   ```

   Found → return `Stored { duplicate: true, … }` with that message's attachments and, for a stored
   DSN, its suppression requests recomputed from `automated_json.dsn`. No event, no counters.
3. **Duplicate by Message-ID ([B3](../edge-cases.md))**, only when `message_id_synthetic = 0`:

   ```sql
   SELECT rowid, id, subject, text, html_sanitized FROM messages
   WHERE rfc_message_id = ?1 AND direction = 'inbound';
   ```

   For each candidate, compare content: subject, `text`, `html_sanitized` and the sorted list of
   attachment `sha256` values. All equal → duplicate (as step 2). Otherwise the new message is stored
   with flag `message_id_conflict`, and the candidates get the same flag:
   `UPDATE messages SET flags_json = json_insert(flags_json, '$[#]', 'message_id_conflict') WHERE rowid = ?1 AND NOT EXISTS (SELECT 1 FROM json_each(flags_json) WHERE value = 'message_id_conflict')`.
4. **DSN** (`kind = 'dsn'`): [DSN routing](#dsn-routing-and-backscatter). An unmatched DSN returns
   `Backscatter` here, before any write.
5. **Thread token.** If `detail` looks like a token, apply the brute-force limits and verify it
   ([Threading › Verification](threading.md#23-verification)).
6. **Thread** with `resolve_inbound` ([Threading](threading.md#31-order-fr-thr-1)).
7. **Trust and quarantine:** `known_sender`, look-alike and display-name checks against `contacts`, the
   final spam score, the throttle upsert, the E5 check, then the [Quarantine decision](#quarantine-decision).
8. **Insert the thread** if new ([Threading](threading.md#34-effects-on-the-thread-row)).
9. **Insert the message:**

   ```sql
   INSERT INTO messages (
     id, thread_seq, direction, status, rfc_message_id, message_id_synthetic, in_reply_to,
     references_json, raw_sha256, raw_r2_key, raw_size, from_address, from_name, sender_domain,
     reply_to_json, to_json, cc_json, delivered_to, is_bcc, is_primary_recipient, subject, text,
     html_sanitized, extracted_text, snippet, sent_at, received_at, kind, automated_json, auth_json,
     verdict, spam_score, known_sender, quarantine_reason, flags_json, read, triage_status,
     parser_version, metadata_json)
   VALUES (?1, ?2, 'inbound', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
           ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, 0, ?35, ?36, '{}')
   RETURNING rowid;
   -- triage_status ?35: 'pending' for received (triage enabled), NULL for quarantined (triaged on
   -- release), 'skipped' for hidden, throttled, dsn and mdn
   ```

10. **Attachments:** one row each, `id = att_…`, `r2_key = t/{ten}/i/{idn}/m/{msg}/a/{att}`,
    `text_status` = `pending` when eligible for extraction, else `skipped`
    ([Attachment text extraction](#attachment-text-extraction)), `risk`, `sniffed_type`, `scan_status`.
11. **Keyword index:**

    ```sql
    INSERT INTO fts (rowid, subject, participants, body_new, body_full, attachments, refs)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);
    INSERT INTO fts_tri (rowid, subject, participants, refs) VALUES (?1, ?2, ?3, ?7);
    -- the six values come from core::search::fts_doc, the single builder defined in
    -- Search §5.1; at ingest the attachments column holds filenames only (attachment text is
    -- added by AttachmentTextReady)
    ```

12. **Refs:** `INSERT OR IGNORE INTO refs (message_rowid, kind, value, source) VALUES (…)` per ref.
13. **Contacts** (only for `received` and `quarantined`):

    ```sql
    INSERT INTO contacts (address, name, domain, first_seen_at, last_seen_at, inbound_count, last_thread_seq)
    VALUES (?1, ?2, ?3, ?4, ?4, 1, ?5)
    ON CONFLICT (address) DO UPDATE SET
      name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
      last_seen_at = MAX(contacts.last_seen_at, excluded.last_seen_at),
      inbound_count = contacts.inbound_count + 1,
      last_thread_seq = excluded.last_thread_seq;
    ```

14. **Verifications** row when applicable (see above).
15. **Thread counters** ([Threading](threading.md#34-effects-on-the-thread-row)).
16. **Outbox:** `message.received` (status `received`) or `message.quarantined` (status `quarantined`),
    plus `verification.received` when inserted. No event for `hidden`, `throttled` or DSN rows. Payloads
    are built by the builders in [Webhooks](webhooks.md); `extracted_text` is cut to
    `policy.webhook_text_bytes`, and `message.quarantined` carries none.
17. Set `alarm:outbox`.

## Post-commit: attachments and index jobs

After `Stored`:

1. **Attachments.** For each `AttachmentToStore`: on the first ingest, `put` the part's bytes to its
   `r2_key` with custom metadata `tenant`, `identity`, `message`, `sha256`. On a duplicate, `head` the
   key first and `put` only if missing. Attachment bytes therefore appear shortly after the
   `message.received` event; the attachment endpoint answers `503 unavailable` (retryable) for an
   attachment row whose object is missing and whose message is less than 5 minutes old.
2. **Suppressions** from a matched DSN: `INSERT OR IGNORE INTO suppressions …` (see
   [Outbound › Suppressions](outbound.md#suppressions)).
3. **Index jobs** in one `send_batch` to `pm-index`:
   - `AttachmentText { tenant_id, identity_id, message_id }` when any attachment has `text_pending`;
   - `Embed { tenant_id, identity_id, message_id }` for every stored inbound message
     ([Search](search.md));
   - `Triage { tenant_id, identity_id, message_id }` when the status is `received`, the kind is not
     `dsn` or `mdn`, and triage is enabled ([Triage](triage.md)).
4. Count it: `QuotaRequest::RecordUsage { metric: Inbound, n: 1 }` to the tenant's `TenantQuota`, which
   the hourly roll-up flushes to `usage_daily` ([Outbound › TenantQuota](outbound.md#tenantquota)); never
   a D1 write per message.
5. **SES source:** set the `ses_ingest` row to `done`, and delete the S3 object when no row for its key
   is still `queued` ([The SES source](#the-ses-source)).
6. Ack. On a duplicate the same steps run again; every step is idempotent.

## Attachment safety

`core::attach` classifies every attachment before anything else touches it ([B10](../edge-cases.md)).
Risky attachments are never passed to agents or to text extraction, and downloading one needs
`quarantine:review`.

### Sniffing

The type is sniffed from the first 8 KiB (and, for containers, from the structure). The sniffed type
wins over the declared `Content-Type` and the filename extension.

| Magic | Sniffed type |
|---|---|
| `%PDF-` | `application/pdf` |
| `PK\x03\x04` | ZIP; refined by entries: `[Content_Types].xml` with `word/`, `xl/`, `ppt/` → OOXML document, spreadsheet, presentation; `mimetype` entry → ODF; `META-INF/MANIFEST.MF` → JAR; `AndroidManifest.xml` → APK |
| `D0 CF 11 E0 A1 B1 1A E1` | OLE compound file (DOC, XLS, PPT, MSG, MSI); refined by stream names |
| `MZ` | PE executable |
| `7F 45 4C 46` | ELF executable |
| `FE ED FA CE`, `FE ED FA CF`, `CE FA ED FE`, `CF FA ED FE`, `CA FE BA BE` | Mach-O executable |
| `#!` | script |
| `Rar!\x1A\x07` | RAR |
| `7z\xBC\xAF\x27\x1C` | 7z |
| `1F 8B` | gzip |
| `MSCF` | CAB |
| `4C 00 00 00 01 14 02 00` | Windows shortcut (LNK) |
| `CD001` at offset 0x8001 | ISO 9660 image |
| `78 9F 3E 22` | TNEF |
| `{\rtf` | RTF |
| `\x89PNG`, `FF D8 FF`, `GIF8`, `RIFF….WEBP`, `II*\0` / `MM\0*`, `….ftypheic` | images |
| `BEGIN:VCALENDAR` | calendar |
| `<!doctype html` or `<html` within the first 512 bytes after whitespace | HTML |
| none of the above, valid UTF-8 | text |

### Risk classification

| `risk` | Condition | Quarantines |
|---|---|---|
| `executable` | Sniffed PE, ELF, Mach-O, script, MSI, LNK, JAR, APK, ISO; or an extension in `exe dll scr com bat cmd ps1 psm1 vbs vbe js jse wsf wsh hta msi msp lnk jar apk app dmg iso img vhd vhdx reg cpl pif sh scf url` whatever the content; or a ZIP whose entries (or the entries of one nested ZIP) include such a name or type | yes |
| `macro` | OOXML with a `vbaProject.bin` part; OLE with a `VBA` storage or `_VBA_PROJECT` stream; extensions `docm dotm xlsm xltm xlam pptm potm ppam sldm` | yes |
| `archive_bomb` | ZIP central directory: total uncompressed size > 100 MB, or ratio uncompressed/compressed > 100, or more than 10,000 entries, or nested archives deeper than 2; gzip: the trailer's `ISIZE` against the compressed size by the same ratio | yes |
| `encrypted_archive` | A ZIP entry with the encryption bit (general purpose flag bit 0) set; or an archive whose contents cannot be inspected: RAR, 7z, CAB | yes |
| `type_mismatch` | The sniffed family is archive, HTML, script or a macro-capable document while the extension or declared type names a different family (for example `invoice.pdf` that is a ZIP or HTML). A harmless mismatch (declared `application/octet-stream`, image declared as another image type) is not a risk | yes |
| `encrypted_document` | PDF with an `/Encrypt` dictionary; OLE with `EncryptionInfo` and `EncryptedPackage` streams (encrypted OOXML); ODF with `encryption-data` in its manifest | no: text extraction is `skipped`, download needs `quarantine:review` |

When several apply, the first in the table is recorded. Filenames are sanitised before storage: path
components removed, control characters removed, at most 255 bytes.

### Malware scanner hook (`PM_SCANNER_URL`, P1)

When `PM_SCANNER_URL` is set, the consumer scans each attachment that has no `risk` and is at most
20 MB, **before** `ingest`, so the quarantine decision includes the result:

```http
POST {PM_SCANNER_URL}
Content-Type: application/octet-stream
X-Pylota-Attachment-Sha256: 9f86d081884c7d65…
X-Pylota-Sniffed-Type: application/pdf
User-Agent: PylotaMail/1.0

<attachment bytes>
```

```json
{ "verdict": "clean" }                     // or "infected", or "error"
{ "verdict": "infected", "signature": "Eicar-Test-Signature" }
```

- The URL is validated at isolate start and before each request by the SSRF guard of
  [Security § 9](security.md#93-other-outbound-destinations) (HTTPS, a public address). Credentials, if
  any, are part of the URL path chosen by the operator; the URL is never logged.
- Timeout 30 s per attachment, 60 s per message; no redirects; response body read up to 4 KB.
- `clean` → `scan_status = 'clean'`; `infected` → `scan_status = 'infected'` and the message is
  quarantined (`risky_attachment`); `error`, a non-2xx status, a timeout or an unparseable body →
  `scan_status = 'error'`, the message is not quarantined for it, and `scanner_error_total` is incremented.
- Without a scanner, `scan_status` stays `skipped`. The value `pending` is not used in v1.0.

## Attachment text extraction

`pm-index` job `AttachmentText { tenant_id, identity_id, message_id }` processes every attachment of the
message whose `text_status = 'pending'` (FR-IN-8). One job per message keeps the keyword index rebuild to
one transaction.

**Eligibility** (decided at ingest; `skipped` otherwise): no `risk`, or only `encrypted_document` (then
`skipped`); `scan_status` not `infected`; size ≤ 20 MB; the sniffed family is in
`inbound.extract_attachment_text` (`pdf`, `office`, `text`, `html`), or is an image and
`inbound.extract_image_text` is true; inline images under 10 KB (signature logos) are `skipped`.

**Extraction by family:**

| Family | How |
|---|---|
| `text` (`text/plain`, `text/csv`, `text/markdown`, `application/json`, `text/xml`) | Decoded in Rust (declared charset, else UTF-8 with replacement); one page |
| `html` | `core::text::derive_text` after sanitising; one page |
| `message/rfc822` (nested) | `core` parser: a header block (`From`, `Date`, `Subject`), the nested extracted text, the nested attachment filenames; one page |
| `pdf`, `office` (`docx`, `xlsx`, `xlsm`, `xlsb`, `xls`, `ods`, `odt`), images | `Ai::to_markdown` with `[{ name: sanitised filename, blob }]`. Workers AI's converter supports PDF, images, HTML, XML, CSV, these spreadsheet formats, DOCX, ODT and ODS; it does **not** list DOC, PPT or PPTX, which get `unavailable` ([supported formats](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/), read 2026-10-09). Image conversion runs Workers AI models and may cost neurons, which is why `extract_image_text` defaults to false |

**Pages.** The stored text is Markdown with a marker line before each page:

```text
<!-- pm:page 1 -->
INVOICE 88213 …
<!-- pm:page 2 -->
Terms and conditions …
```

For PDFs, a form feed (U+000C) in the converter output is a page boundary. If the output has none, the
whole document is page 1. **Spike S6** records whether `toMarkdown` marks PDF pages; if it does by
another convention, that convention is parsed here instead.

**Limits** ([limits](../../reference/limits.md#mail)): input over 20 MB, more than 200 pages, or more
than 2 MB of text → `text_status = 'unavailable'`. The hidden-character rules are applied to the text.

**Result.** The job writes `t/{ten}/i/{idn}/m/{msg}/a/{att}.md` to R2, then sends
`MailboxRequest::AttachmentTextReady { message_id, items: [{ attachment_id, status, pages, text_r2_key, refs }], fts_text }`.
In one transaction the mailbox sets `text_status`, `text_r2_key` and `text_pages`, inserts the refs with
`source = att:{id}:{page}`, and rebuilds the message's FTS row with `fts_text` (filenames plus attachment
text, at most 1 MiB) in the `attachments` column, as specified in [Search](search.md). It then queues an
`Embed` job for the attachment chunks.

**Failure ([B12](../edge-cases.md)).** A `toMarkdown` error, an `error` result, or no answer within 60 s:
re-enqueue the job with `attempt + 1` after 60 s, then 300 s; after the third attempt, `unavailable`.
The attachment stays fetchable. Search reports `attachment_text_unavailable` in `why` when relevant.

## DSN routing and backscatter

A message classified `dsn` updates delivery state instead of reaching agents (FR-IN-6, FR-DLV-5,
[D4](../edge-cases.md)). Most bounces of our own mail arrive as Email Sending delivery events, because
the provider owns the envelope sender ([Outbound › Delivery events](outbound.md#delivery-events)); DSNs
reach an identity's address only from servers that bounce to the `From` address, or as backscatter.

**Sends through an `smtp_relay`** are the exception: a relay reports no delivery events, and its return
path is the `From` address, so every bounce of such a send is an RFC 3464 DSN that comes back to the
identity through forwarding or SES ([Domains on any DNS host § 5.4](domain-connections.md#54-delivery-events-from-a-relay),
[N19](../edge-cases.md)). The SMTP transport stores the composed `Message-ID` as `rfc_message_id`
([Outbound › SMTP relay](outbound.md#smtp-relay)), so step 1 below finds the original by the DSN's
original `Message-ID`. The recipients' statuses move from `submitted` to `bounced` (`hard` for `5.x.x`,
with a suppression; `soft` for `4.x.x`), and the DSN is stored as in step 4, never shown to agents as new
mail.

Inside `ingest`, before any write:

1. Find the original:

   ```sql
   SELECT rowid, id, thread_seq FROM messages
   WHERE direction = 'outbound' AND (rfc_message_id = ?1 OR provider_message_id = ?1)
   ORDER BY rowid DESC LIMIT 1;           -- ?1 = dsn.original_message_id (normalised)
   ```

2. **No match → backscatter.** Return `Backscatter`. The consumer deletes the raw object, increments
   `backscatter_total`, and acks. Nothing is stored.
3. **Match.** For each `dsn.recipients[]` entry whose `final_recipient` is a recipient of the original,
   apply a delivery event with `event_id = "dsn:{message_id}:{recipient}"` through the same function as
   provider events ([Outbound › Applying an event](outbound.md#applying-an-event-to-a-message)):

   | `Action` | `Status` | Delivery status |
   |---|---|---|
   | `failed` | `5.x.x` | `bounced`, `bounce_type = 'hard'` |
   | `failed` | `4.x.x` | `bounced`, `bounce_type = 'soft'` |
   | `delayed` | any | `deferred` |
   | `delivered`, `relayed`, `expanded` | any | `delivered` |

4. Store the DSN itself as a message with `kind = 'dsn'`, `status = 'hidden'`, `triage_status = 'skipped'`,
   in the original's thread (no token or header threading), with the parsed report in
   `automated_json.dsn`. No `message.received` event; the delivery update emits `message.bounced` (or
   `deferred`, `delivered`). Hard bounces return a `SuppressionRequest`.

## Re-parsing (J3)

When a parser bug is fixed, `parser_version` (a constant in `core::mime`) is incremented and a
`reparse` job is created (`POST` through the operator tooling; `jobs.kind = 'reparse'`, params
`{ tenant_id, identity_id?, before_version }`). Its `JobRunner` steps ([J3](../edge-cases.md)):

1. `list_identities`: the identities in scope, cursor over `identities.id`.
2. `enqueue`: per identity, page through
   `SELECT id FROM messages WHERE direction = 'inbound' AND (parser_version IS NULL OR parser_version < ?1) AND rowid > ?2 ORDER BY rowid LIMIT 50`
   (a `MailboxRequest` read added by [Privacy and erasure](privacy.md)), sending one
   `InboundJob::Reparse` per message to `pm-inbound`, at most 500 per alarm run.
3. `wait`: completes when the per-identity counts reported back reach the totals.

The consumer handles `Reparse` like `Message`, except: the raw object comes from the stored
`raw_r2_key` (if it is past retention, the message is skipped and counted as `raw_expired`), and it calls
`MailboxRequest::Reparse`, which in one transaction updates the parsed columns (`text`,
`html_sanitized`, `extracted_text`, `snippet`, `kind`, `automated_json`, `auth_json`, `verdict`,
`flags_json` with `reprocessed` added, `parser_version`), replaces the message's refs and FTS rows, and
matches attachments to existing rows by `(sha256, part order)` so attachment IDs never change. Thread
membership is never changed. A message whose new decision would quarantine it (for example a newly
detected risk) moves from `received` to `quarantined`; a re-parse never releases a message. The outbox
gets `message.received` or `message.quarantined` again with `data.reprocessed = true`.

## Test-mode loopback (L3)

For a test tenant, the outbound loopback transport delivers mail to identities on the same deployment
by writing the composed MIME to the recipient's raw key and queuing an `InboundPointer` with `loopback`
set ([Outbound › Transports](outbound.md#transports), FR-OUT-12, [L3](../edge-cases.md)). Only the
outbound consumer sets this field. For a loopback pointer the consumer:

- skips the DNS prefetch and authentication; `verdict = 'pass'`, `auth_json = { "source": "loopback", … }`;
- adds the flag `loopback`;
- sets `spam_base = 0` and skips rule 6 of the quarantine decision (risky attachments still quarantine);
- otherwise runs the normal pipeline, so threading, references, events and triage behave as for real mail.

## Open points

1. **Suspended tenants on the SES source (FR-TEN-3): decided.** SES has already accepted the message, so no
   temporary failure can reach the sender, and a later bounce would be backscatter. The consumer holds such
   mail for up to 5 days (ledger `held`, the S3 object kept inside its 14-day lifecycle) and ingests it if
   the tenant is resumed; after that it drops it without a bounce (table above).

## Tests

| Test | Covers |
|---|---|
| `it::inbound::a4_role_mail_routing` | `postmaster@` and `abuse@` the platform domain become a new message to `PM_SECURITY_CONTACT` (nothing stored); with the variable unset they get `550 5.1.1`; `info@` the platform domain gets `550 5.1.1`; `postmaster@` a tenant domain goes to the owner, and to `PM_SECURITY_CONTACT` when the tenant has no owner ([A4](../edge-cases.md)) |
| `it::inbound::a6_reject_codes` | Unknown and erased `550 5.1.1` (indistinguishable), retired `550 5.1.6`, suspended tenant temporary failure for 5 days then `550 5.2.1` ([A6](../edge-cases.md), FR-IN-2, FR-TEN-3) |
| `it::inbound::a2_forged_token_ignored` | A forged `+t…` detail files by headers and never changes the identity ([A2](../edge-cases.md)) |
| `it::inbound::a9_two_identities_two_copies` | Two copies, same `raw_sha256`, exactly one `is_primary_recipient = true` ([A9](../edge-cases.md)) |
| `it::inbound::a10_bcc_copy_flagged` | Envelope recipient not in headers → `is_bcc`, flag `bcc` ([A10](../edge-cases.md); the reply side is `it::send::a10_reply_all_excludes_bcc`) |
| `live::inbound::b1_oversize_rejected` | Cloudflare rejects over 25 MiB before the Worker ([B1](../edge-cases.md)) |
| `conf::mime::b2_*`, `core::mime::b2_caps` | Malformed MIME kept, depth 32 and 500 parts, `parse_degraded` ([B2](../edge-cases.md), FR-IN-3) |
| `it::inbound::b3_missing_message_id`, `it::inbound::b3_same_id_same_body`, `it::inbound::b3_same_id_different_body` | Synthetic ID; dedupe; both kept with `message_id_conflict` ([B3](../edge-cases.md)) |
| `conf::mime::b4_html_only` | Text derived from HTML (FR-IN-7, [B4](../edge-cases.md)) |
| `conf::mime::b5_*` | Charsets and encodings ([B5](../edge-cases.md)) |
| `conf::mime::b6_*` | TNEF unpacked; nested `message/rfc822` not merged ([B6](../edge-cases.md), FR-THR-2) |
| `conf::mime::b7_cid`, `core::sanitize::b7_no_remote_fetch` | `cid:` images kept, remote `src` removed ([B7](../edge-cases.md)) |
| `conf::mime::b8_ics`, `core::classify::b8_mdn_request_ignored` | Calendar summary; MDN request recorded, never answered ([B8](../edge-cases.md)) |
| `conf::mime::b9_*` | Encrypted flagged with no body; signed-only processed ([B9](../edge-cases.md)) |
| `core::attach::b10_*` | Every row of the risk table, sniff wins over extension, quarantine ([B10](../edge-cases.md), FR-IN-5) |
| `core::sanitize::b11_*` | Every hidden-element signal, hidden characters, emoji ZWJ kept, flag rule ([B11](../edge-cases.md), FR-IN-9) |
| `it::index::b12_extraction_failure` | Three failed conversions → `unavailable`, attachment still fetchable ([B12](../edge-cases.md)) |
| `conf::mime::b13_from_anomalies` | No `From`; several `From` cap the verdict ([B13](../edge-cases.md)) |
| `it::inbound::b14_redelivery_deduped` | Same raw twice → one row, one event ([B14](../edge-cases.md)) |
| `core::auth::d1_*` | No DMARC record gives `none` with `aligned_by` recorded; `p=none` gives `unaligned`; neither quarantines; every verdict-table row ([D1](../edge-cases.md)) |
| `core::auth::spf_unchecked_unverified` | With `PM_TRUSTED_AUTHSERV_ID` empty, an SPF-only-aligned sender under `p=reject` gets `unverified` and `auth_unverified`, never `fail`; with the trusted header and `spf=pass` aligned it gets `pass`; the SES source is unaffected |
| `core::trust::d2_*` | Display-name spoof and look-alike domain ([D2](../edge-cases.md)) |
| `it::inbound::d4_backscatter_dropped` | Unmatched DSN dropped and counted ([D4](../edge-cases.md), FR-DLV-5) |
| `it::inbound::d5_sender_throttle` | The 61st message in an hour from one sender is `throttled` ([D5](../edge-cases.md)) |
| `core::classify::d6_*` | RFC 3834, lists, out-of-office, hop counter ([D6](../edge-cases.md), FR-IN-6) |
| `it::inbound::d7_blocked_hidden` | Suppressed and receive-blocked senders stored `hidden`, no event ([D7](../edge-cases.md)) |
| `core::auth::d9_forged_ar_ignored` | A lower header with the trusted authserv-id, and any other authserv-id, are ignored ([D9](../edge-cases.md)) |
| `it::inbound::e5_unsolicited_otp` | OTP mail without a `wait` in 30 minutes is quarantined `otp_unsolicited`; with one it is received and its code is released only to `wait` ([E5](../edge-cases.md), [E4](../edge-cases.md)) |
| `core::refs::f5_*` | Plate normalisation and every pack kind ([F5](../edge-cases.md), FR-SRCH-4) |
| `core::quote::quote_headers_by_language` | Every quote pattern in the table, Outlook blocks, signatures, fallbacks |
| `it::inbound::fts_same_transaction` | A keyword search immediately after the `message.received` event finds the message (FR-SRCH-2) |
| `it::inbound::j1_r2_failure` | R2 put fails three times → the handler errors (temporary failure) and nothing is queued ([J1](../edge-cases.md), FR-IN-1) |
| `it::inbound::j2_retry_idempotent` | The consumer crashes after `ingest`; the retry stores nothing twice and writes the attachments ([J2](../edge-cases.md)) |
| `it::jobs::j3_reparse` | Re-parse updates parsed fields, keeps IDs and thread, re-emits with `reprocessed: true` ([J3](../edge-cases.md)) |
| `it::inbound::j7_d1_transient` | D1 down in `email()` → staged, routed by the consumer, unroutable staged mail dropped ([J7](../edge-cases.md)) |
| `it::ses::push_and_backstop_once`, `it::ses::unknown_recipient_dropped`, `it::ses::cross_tenant_recipients` | One message per object and recipient; unknown recipients dropped with no bounce; recipients of two tenants stay apart ([N3](../edge-cases.md), [N6](../edge-cases.md), [N28](../edge-cases.md)) |
| `it::ses::verdict_mapping`, `it::ses::large_message_40mb` | SPF from SES, DKIM and DMARC recomputed, virus `FAIL` quarantined, spam `FAIL` scores 0.9; a 39 MB message is ingested ([N5](../edge-cases.md), [N27](../edge-cases.md)) |
| `it::inbound::probe_and_forwarding_check` | `pm-probe+{token}` and a forwarding-check token are recorded on the domain's monitor and never stored as messages; an unknown forwarding token is ordinary mail ([N12](../edge-cases.md), [N18](../edge-cases.md)) |
| `it::smtp::dsn_to_bounce` | An RFC 3464 DSN for a relay send → `bounced` (hard), a suppression, the DSN stored `hidden` ([N19](../edge-cases.md)) |
| `it::testmode::l3_loopback` | Test-tenant mail to a local identity arrives with `verdict: pass` and flag `loopback` ([L3](../edge-cases.md)) |
| `it::logs::i5_no_content_in_logs` | No body text, subject or clear address in captured logs ([I5](../edge-cases.md), FR-PRV-6) |
