# Sending and safe retries

This guide covers everything about outbound mail: sending, replying and forwarding, who a reply goes
to, attachments, the kinds of mail, and how to retry without ever sending an email twice. It ends with
delivery events, bounces and suppressions, caps, domain fallback and testing.

All four send operations need the `messages:send` permission and an `Idempotency-Key` header. They
return `202 Accepted` with the [Message object](../reference/api.md#message-object)
(`direction: "outbound"`, `status: "queued"`) and `"deduplicated": false`. The CLI equivalents are
`pmail send`, `pmail reply`, `pmail reply-all` and `pmail forward`.

## Send a new message

```bash
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/messages \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" \
  -H "Idempotency-Key: bk-2291:confirm" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{
  "to": [ { "address": "jo@example.net", "name": "Jo Rivera" } ],
  "subject": "Your booking BK-2291 is confirmed",
  "text": "Hi Jo, your Golf is booked for Friday 10:00.",
  "html": "<p>Hi Jo, your Golf is booked for <b>Friday 10:00</b>.</p>",
  "kind": "transactional",
  "labels": ["booking"],
  "headers": { "X-Booking-Ref": "BK-2291" },
  "metadata": { "booking_id": "bk_2291" }
}
EOF
```

| Field | Notes |
|---|---|
| `to`, `cc`, `bcc` | Strings (`"jo@example.net"`) or objects with `address` and `name`. Duplicates are removed |
| `subject` | At most 998 characters |
| `text`, `html` | At least one. Text is derived from HTML when it is missing. The identity's signature and the tenant's AI-disclosure footer are appended according to policy |
| `kind` | `transactional` (default), `marketing` or `auto_reply`. See [Kinds of mail](#kinds-of-mail) |
| `thread_id` | Continue an existing thread without quoting. `References` are set from the thread |
| `from_address` | An active address of the identity, or a retiring one on a thread that already uses it. The default is the primary. See [Who a reply goes to](#who-a-reply-goes-to) |
| `attachments` | See [Attachments](#attachments) |
| `labels`, `metadata` | Your own labels and key-value data on the stored message |
| `headers` | Custom headers. See [Custom headers](#custom-headers) |

Full request and response: [REST API › Sending](../reference/api.md#sending).

## Reply, reply-all and forward

```bash
# reply to the sender
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/messages/msg_01JA6D3J9S/reply \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Idempotency-Key: bk-2291:reply-dates" \
  -H "Content-Type: application/json" \
  -d '{"text":"Friday works. See you at 10."}'

# forward, with the original attachments
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/messages/msg_01JA7E4K0T/forward \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Idempotency-Key: claim-7781:forward-photos" \
  -H "Content-Type: application/json" \
  -d '{"to":["claims@insurer.example"],"text":"Forwarding the photos for claim 7781.","include_attachments":true}'
```

| Operation | Goes to | Notes |
|---|---|---|
| `reply` | The sender, or their `Reply-To` under the rules below | Subject gets one `Re:` prefix. `In-Reply-To` and `References` are set |
| `reply-all` | The reply target plus every `To` and `Cc` recipient, except this identity's own addresses | BCC recipients of the original are never included, and the reply never reveals that the identity was BCC'd ([A10](../project/edge-cases.md)) |
| `forward` | The `to` you give | Subject gets `Fwd:`. Keeps `References` and adds a transfer note, so a hand-off between identities stays traceable ([C6](../project/edge-cases.md)) |

When a thread is very long, replies keep the first `References` entry plus the 19 most recent
([C2](../project/edge-cases.md)).

Two sends into the same thread at the same time are serialised. The second waits up to 10 seconds for
the thread lock, then fails with `409 thread_busy` (retryable, after `details.retry_after`)
([C4](../project/edge-cases.md)).

## Recipients and limits

- At most `policy.max_recipients` recipients across `to`, `cc` and `bcc` (default 10, hard maximum
  49). More fails with `400 too_many_recipients`.
- Addresses must be valid RFC 5321 addresses (`400 address_invalid`). Non-ASCII local parts are refused
  (`400 address_unsupported`).
- Recipients on the tenant's **send-block** list are not sent to: the send is accepted and their
  deliveries end `suppressed`. With `policy.send_allowlist_only: true`, only recipients on the
  **send-allow** list are sent to; the others are `suppressed` the same way.
- With the identity's `send_policy.require_known_recipient: true`, the identity only delivers to
  addresses it has already exchanged mail with; other recipients are `suppressed`
  (`policy: unknown_recipient`), not refused with an error. Use it for agents that could be talked into sending
  data to a new address ([E2](../project/edge-cases.md)).
- Suppressed recipients are skipped and the rest are delivered. See
  [Bounces, complaints and suppressions](#bounces-complaints-and-suppressions).

All limits: [Limits › Mail](../reference/limits.md#mail).

## Attachments

```json
"attachments": [
  { "filename": "BK-2291.pdf", "content_type": "application/pdf",
    "content_base64": "JVBERi0xLjcK…", "disposition": "attachment" },
  { "filename": "logo.png", "content_type": "image/png",
    "content_base64": "iVBORw0KGgo…", "disposition": "inline", "content_id": "logo" }
]
```

Reference an inline image from the HTML as `<img src="cid:logo">`.

**The 5 MiB limit.** The whole composed message, after encoding, must fit Cloudflare Email Sending's
5 MiB limit. The same limit applies on every transport, including Amazon SES and SMTP relays. Attachments are base64-encoded inside the message, which makes them about a third
larger (plus a line break every 76 characters), so in practice the attachments' original sizes must add
up to about 3.6 MiB, less the size of the body. A larger message fails with `413 message_too_large`. The request body itself can be at
most 7 MiB (`413 payload_too_large`).

**Signed links for large files.** If the tenant's policy sets `large_attachments: "link"`, attachments
that do not fit are replaced by expiring signed download links in the message, valid for
`link_ttl_hours` (default 72, range 1–168). The default, `"refuse"`, returns the `413`
([G5](../project/edge-cases.md)).

## Who a reply goes to

Pylota Mail chooses the recipient and the `From` address of every reply. It does not trust the
original message's headers blindly.

**The recipient** ([D3](../project/edge-cases.md)):

1. By default, a reply goes to the original message's `From` address.
2. It goes to the `Reply-To` address instead only when the sender is a known sender of the identity,
   or the `Reply-To` address shares the `From` address's organisational domain, or the identity has
   already written to that address.
3. Otherwise the reply goes to `From`, and the inbound message carries the trust flag
   `reply_to_mismatch`. This stops a stranger from steering replies to an address of their choosing
   with a forged `Reply-To`.

**The `From` address:**

| Situation | `From` |
|---|---|
| A reply, reply-all or a send with `thread_id` | The address the other party last wrote to in that thread ([FR-OUT-5](../project/prd.md#65-outbound)) |
| That address is `retiring` | Still that address, until it retires. A customer who writes to the old address after a domain change gets an answer from the address they used ([C3](../project/edge-cases.md)) |
| That address is `retired` | The identity's primary address |
| A new message | The primary address, or `from_address` if you set it. A retiring address can only be used on threads that already use it ([G7](../project/edge-cases.md)) |
| The address's domain is `failing` | The identity's platform address, as described in [When a domain fails](#when-a-domain-fails) |

The display name is always the identity's. Outbound messages have a `Reply-To` sub-address with
the thread token, for example `bookings+t03k.9f2mq7xa@acme.example.com`, so the answer threads
correctly even if the other party's client drops the headers. The exception is a domain whose inbound
mail arrives by forwarding (`send_only`, or `smtp_relay` with `inbound: forward`): its own mail system
may not keep sub-addresses, so its messages carry no `Reply-To`, and replies thread by
`In-Reply-To` and `References`.

## Kinds of mail

Every message has a `kind` ([G9](../project/edge-cases.md)):

| Kind | Use | Requirements |
|---|---|---|
| `transactional` | The default. Booking confirmations, answers, invoices, anything the recipient expects | None |
| `marketing` | Promotional mail, one message at a time | An `unsubscribe` object (`{ "url": "https://…", "mailto": "…" }`) and the tenant's consent attestation (`"consent": { "basis": "opt_in", "recorded_at": "…" }`). Without them: `400 marketing_requirements_missing`. The sending domain must use the `ses` or `smtp` transport: Cloudflare Email Service is for transactional mail only, so marketing from the platform domain or a `cloudflare`-transport domain gets `422 transport_unavailable` |
| `auto_reply` | An automatic answer the agent sends without a human | Allowed only in reply to a non-automated message. Sets `Auto-Submitted: auto-replied` |

Marketing mail gets RFC 8058 one-click unsubscribe headers (`List-Unsubscribe` and
`List-Unsubscribe-Post`) and a visible unsubscribe link ([FR-OUT-8](../project/prd.md#65-outbound)).
Your application handles the unsubscribe URL. Record each unsubscribe as a suppression with reason
`unsubscribe` so the address is never mailed again. Pylota Mail has no list or campaign features.

Automatic replies are limited so two agents cannot answer each other for ever
([D6](../project/edge-cases.md)):

- an auto-reply to automated mail (auto-responders, out-of-office, mailing lists, bounces) is refused;
- each thread allows `auto_reply.max_automatic_exchanges` automatic replies (default 2) before a
  person must act;
- both fail with `409 auto_reply_not_allowed`.

## AI disclosure

The tenant policy's `ai_disclosure` adds a disclosure to every outbound message
([E8](../project/edge-cases.md)):

| `ai_disclosure.mode` | Effect |
|---|---|
| `none` (default) | Nothing added |
| `footer` | `ai_disclosure.text` appended to the text and HTML bodies |
| `header` | The header `X-AI-Generated: true` |

Your own disclosure rules stay authoritative. If your product already adds a disclosure, keep the
mode at `none`.

## Custom headers

`headers` accepts `X-` headers whose name uses only letters, digits, `-` and `_` (`X-Booking-Ref`), plus
`Importance`, `Priority`, `Sensitivity`, `Keywords`, `Comments` and `Organization`, spelled exactly so.
Anything else fails with `400 header_not_allowed`. `Importance` takes `high`, `normal` or `low`,
`Priority` `normal`, `non-urgent` or `urgent`, and `Sensitivity` `personal`, `private` or
`company-confidential`; another value fails with `400 invalid_request`. Both are checked when you send, so
a bad header never turns into a rejected message later. The service sets threading,
`Reply-To`, `Auto-Submitted` and unsubscribe headers itself, and Cloudflare sets `Message-ID`, `Date`
and the DKIM signature. Custom headers can total 16 KB, with values of at most 2,048 bytes.

## Safe retries

A request can fail in a way that leaves you not knowing whether it worked: the connection drops, a
proxy times out, your process restarts. Retrying blindly could send a customer two booking
confirmations, or two payment reminders. Pylota Mail makes retries safe instead.

### The rules

- `Idempotency-Key` is **required** on `POST …/messages`, `…/reply`, `…/reply-all` and `…/forward`.
  Without it the request fails with `400 idempotency_key_required`.
- The key is 1–255 printable ASCII characters, spaces included (`^[\x20-\x7E]{1,255}$`), scoped to
  the identity, and kept for **30 days**. Any other key fails with `400 invalid_idempotency_key`. The
  MCP send tools apply the same rule to their `idempotency_key` argument.
- **Same key, same request:** you get the original response, with `"deduplicated": true` and the
  header `Idempotent-Replayed: true`. No second email.
- **Same key, different request:** `409 idempotency_conflict`, with `details.original_message_id`
  when known. The body is compared in canonical form, so whitespace and key order do not matter, but
  every value must be the same.
- **Same key while the first request is still running:** `409 request_in_progress`, retryable.

Choose the key **before the first attempt** and derive it from what the message is for, not from
the attempt: `bk-2291:confirm`, or `<task-id>:<step>` for an agent's task. Never generate a fresh
random key per attempt; that defeats the point.

### A retry loop

```text
key  = "bk-2291:confirm"          # fixed for this message
body = build_body()               # fixed too; do not rebuild it between attempts

for attempt in 1, 2, 3, …:
    send POST …/messages with Idempotency-Key: key and body
    network error or timeout        → wait backoff(attempt), retry      # safe: same key
    2xx                             → record response.id, stop          # deduplicated may be true
    409 request_in_progress         → wait backoff(attempt), retry
    409 thread_busy                 → wait details.retry_after, retry
    429 rate_limited                → wait Retry-After seconds, retry
    429 daily_cap_reached           → stop for now; retry after details.resets_at
    5xx                             → wait backoff(attempt), retry
    409 idempotency_conflict        → stop: a bug (one key, two different messages)
    any other error                 → if error.retryable is false, stop and fix the request

backoff(n) = min(0.5 s × 2^(n-1), 60 s) plus random jitter; give up after about 10 minutes
```

If you give up, keep the key and the body with the task. A retry an hour later with the same key and
body is still safe, for 30 days. The general retry rules are in
[Errors › How a client should retry](../reference/errors.md#how-a-client-should-retry).

### Network errors and timeouts

A network error on a send is always safe to retry with the same key. You get the original result
back whether or not the first attempt reached the server. A `504 timeout` from Pylota Mail happens
before the message is queued, so a retry with the same key is safe too.

### The `202` is not the end

`202 Accepted` means the message is stored and queued. Problems after that do not come back as HTTP
errors. They arrive as the message's status and as events: `message.rejected`, `message.failed`,
`message.uncertain` and `message.bounced`, with a reason code in `data.reason`
([Errors › Send failures after 202](../reference/errors.md#send-failures-after-202)). A
`rejected` or `failed` message was definitely not sent. To try again, change what caused it and send
with a **new** key ([K3](../project/edge-cases.md)).

### Uncertain sends

Sometimes the transport gives no answer: it times out, or the connection drops after the request was
written. The email may or may not have left. Pylota Mail then:

1. sets the message to `uncertain`, with reason `transport_timeout` or `transport_connection_lost`,
   and emits `message.uncertain` with a `fix` sentence;
2. **never resends it automatically** ([FR-OUT-2](../project/prd.md#65-outbound));
3. tries to **reconcile** it for 30 minutes: if a provider delivery event arrives whose sender,
   recipient and subject match, the message moves to its real status, gets the flag `reconciled` and
   emits `message.reconciled`.

If reconciliation does not settle it, a person decides:

```bash
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/messages/msg_01JA8F5L1V/resolve \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Content-Type: application/json" \
  -d '{"outcome":"not_sent"}'
```

- `{"outcome": "sent"}` records that the email did go out.
- `{"outcome": "not_sent"}` marks the message `failed` with reason `resolved_not_sent`. You may then
  send again, with a **new** Idempotency-Key.

`resolve` needs `messages:write`, works only on `uncertain` messages (otherwise `409 not_uncertain`)
and is audit-logged. The CLI command is `pmail resolve`.

What *not* to do with an uncertain send:

- Do not resend automatically, and do not re-run the agent turn that produced it. If the first copy
  did arrive, the customer gets two.
- Do not resolve it as `not_sent` because a few seconds passed. Wait for reconciliation, or check
  with a person (for example, ask the recipient, or look for their reply).

### A worked example

A bookings agent confirms a booking. The first response is lost; the retry is deduplicated:

```text
10:00:00.000  agent   POST …/messages   Idempotency-Key: bk-2291:confirm
10:00:00.180  server  stores the message as queued and returns 202
              network the response is lost (connection reset)
10:00:00.700  agent   retries with the same key and the same body
10:00:00.760  server  202, the same msg_01JA5C2H8R, "deduplicated": true, Idempotent-Replayed: true
10:00:03      queue   transport accepts it          → message.sent       (status submitted)
10:00:05      event   recipient's server accepts it → message.delivered  (status delivered)
```

Later, a compliance agent replies to a council about PCN WM12345678, and the transport does not
answer:

```text
14:20:00  agent   POST …/reply   Idempotency-Key: pcn-wm12345678:appeal   → 202 queued
14:20:01  queue   calls the transport; no answer before the deadline
14:20:31  server  status uncertain (transport_timeout) → message.uncertain
case A    14:21:10  a delivery event matches sender, recipient and subject
                    → status delivered, flag reconciled, message.reconciled
case B    14:50:01  30 minutes pass with no match; the message stays uncertain
          15:05     a person confirms with the council that nothing arrived
                    POST …/resolve {"outcome":"not_sent"} → failed (resolved_not_sent)
          15:06     agent sends again with a new key: pcn-wm12345678:appeal:2
```

## Delivery status and events

The message `status` is a roll-up of its recipients. Each recipient's own outcome is in `deliveries`
(`address`, `field`, `status`, `smtp_code`, `bounce_type`, `updated_at`).

| Status | Meaning | Event |
|---|---|---|
| `queued` | Accepted, waiting for the transport | – |
| `submitted` | The transport accepted it | `message.sent` (with `provider`, `provider_message_id`, `sent_via_fallback`) |
| `delivered` | Every recipient's server accepted it | `message.delivered`, one per recipient |
| `deferred` | A temporary failure; the provider is retrying | `message.deferred` |
| `bounced` | At least one recipient bounced and none remains in flight | `message.bounced` (`bounce_type` `hard` or `soft`, `suppressed`) |
| `complained` | A recipient reported spam (can follow `delivered`) | `message.complained` |
| `rejected` | The transport refused it, at submission or, for some recipients, when the recipient's server rejected it after submission | `message.rejected` (`reason`, `detail`) |
| `failed` | It could not be sent | `message.failed` (`reason`) |
| `uncertain` | The outcome is unknown | `message.uncertain` |
| `suppressed` | Every recipient is suppressed; nothing was sent | `message.suppressed` |
| `canceled` | Cancelled while queued | `message.canceled` |

Events can arrive out of order. Use each event's per-identity `sequence` to ignore stale updates, such
as a `message.deferred` that arrives after `message.delivered`
([Webhook events › Ordering](../reference/events.md#ordering)).

**Domains connected with `smtp_relay`.** The tenant's own provider does not report deliveries back. A
message from such a domain ends at `submitted` once the relay accepts it, unless a bounce comes back.
A bounce becomes `message.bounced` (`hard` for a `5.x.x` code, `soft` for `4.x.x`), and a hard bounce
creates a suppression as usual
([Custom domains › `smtp_relay`](custom-domains.md#keep-your-mailbox-send-through-your-provider-smtp_relay)).

## Cancel a queued message

`POST …/messages/{message_id}/cancel` (`messages:send`, CLI `pmail cancel`) stops a message while it
is still `queued`. It returns the message with `status: "canceled"`. Once the message has gone to the
transport, cancel fails with `409 not_cancelable`. Use it as the last step of an approval flow: if a
person rejects a message that was queued, cancel it ([E7](../project/edge-cases.md)).

## Bounces, complaints and suppressions

| Event | What Pylota Mail does ([G6](../project/edge-cases.md)) |
|---|---|
| Hard bounce | Marks the recipient `bounced` and creates a suppression (`hard_bounce`) |
| Soft bounce | The provider retries (`deferred`). If retries run out, `bounced` with `bounce_type: soft` |
| Complaint | Marks the recipient `complained`, creates a **permanent** suppression (`complaint`), and counts towards the identity's complaint rate |
| Provider suppression | The provider's own list refused a recipient. The entry is copied into the tenant's suppressions (`provider`) and the send is repeated to the other recipients, which is safe because that refusal is definitive ([G4](../project/edge-cases.md)) |
| Late bounce | Matched to the message by its provider message ID, whenever it arrives |

A send skips suppressed recipients and delivers to the rest, with an outcome for each
([FR-OUT-4](../project/prd.md#65-outbound)). If **every** recipient is suppressed, the send is still
accepted and ends `suppressed`. It does not return an HTTP error. A dry run (`?dry_run=true`) reports
`422 all_recipients_suppressed` or `422 recipient_blocked` without sending
([Errors › Policy and limits](../reference/errors.md#policy-and-limits)).

Manage suppressions with `suppressions:manage` (CLI `pmail suppressions`):

```bash
# add one
curl -X POST https://mail.example.com/v1/tenants/ten_01J9…/suppressions \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Content-Type: application/json" \
  -d '{"address":"jo@example.net","reason":"manual","note":"Asked not to be contacted"}'

# look one up
curl "https://mail.example.com/v1/tenants/ten_01J9…/suppressions?address=jo@example.net" \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY"
```

Listings show a masked `address_hint` (for example `j***@example.net`), never the address. You can
remove `manual`, `unsubscribe`, `hard_bounce` and `provider` suppressions. Removing a `complaint`
suppression needs `"confirm_complaint_removal": true` and is audit-logged: only do it when the person
has asked to receive mail again. A suppression created by mail you sent (a hard bounce, a complaint, an
unsubscribe or the provider's list) emits `suppression.created`. Suppressions you add through the API do
not, because you made them.

## Caps and automatic pausing

| Limit | Default | When exceeded |
|---|---|---|
| Sends accepted per identity | 120 per minute | `429 rate_limited` with `Retry-After` |
| Sends per identity per day | `identity_daily_send_cap` 500 (or the identity's `send_policy.daily_cap`) | `429 daily_cap_reached` with `details.resets_at` |
| Sends per tenant per day | `tenant_daily_send_cap` 5,000 | `429 daily_cap_reached` |
| Cloudflare's daily sending quota for the account | Set by Cloudflare | Not your error: the queue backs off and retries for up to 24 hours, then `failed` with `quota_exhausted` ([G3](../project/edge-cases.md)) |

Daily caps count in the tenant's time zone. A `quota.warning` event is sent at 80% and at 100% of a
cap.

An identity is **paused automatically** with reason `abuse_threshold` when its complaint rate exceeds
0.3% over its last 1,000 sends, or its bounce rate exceeds 5% over its last 200
([FR-DLV-3](../project/prd.md#66-delivery); policy `abuse.complaint_rate_pause` and
`abuse.bounce_rate_pause`). It keeps receiving mail. An `identity.paused` event carries the metrics.
Find out why the rates rose (a stale address list, an agent writing to strangers) before resuming:
setting `status: "active"` on an identity paused for abuse needs a platform or tenant key and is
audit-logged.

## When a domain fails

Pylota Mail never sends as a domain whose authentication records are broken
([FR-DOM-5](../project/prd.md#63-domains)). When an identity's domain becomes `failing`:

- sends **fall back** to the identity's platform address (for example `bookings.acme@agents.example`);
- the display name stays the same, and `Reply-To` carries the thread token, so replies come back
  into the same thread;
- each such message has the flag `sent_via_fallback`, and `message.sent` reports
  `sent_via_fallback: true`;
- a thread that fell back stays pinned to the platform address after the domain recovers, so one
  conversation does not switch addresses back and forth. It returns to the domain's address once the
  domain is `healthy` and the thread has had no messages for 72 hours
  ([Threading design](../project/design/threading.md)).

Fallback works the same whatever the domain's connection method, because the platform address always
sends through the platform domain. On an `smtp_relay` domain, two failed alignment probes in a row also
make the domain `failing`.

If the tenant sets `domain_fallback: false`, sends from a failing domain fail instead, with reason
`domain_failing_no_fallback`. Fixing a failing domain is covered in
[Custom domains](custom-domains.md#fix-a-failing-domain).

## Test with the simulator

Test tenants send to a simulator instead of the internet. Mail to `*@simulator.invalid` produces a
scripted outcome by local part: `delivered@`, `bounce@`, `softbounce@`, `complaint@`, `deferred@`,
`reject@` and `timeout@`. `timeout@` produces an `uncertain` send, which is the best way to test your
handling of [uncertain sends](#uncertain-sends) ([L2](../project/edge-cases.md)). Mail to identities on
the same deployment is delivered internally; every other recipient is refused with
`403 test_mode_recipient`. See
[Quickstart › Try it without sending real mail](../quickstart.md#try-it-without-sending-real-mail).
