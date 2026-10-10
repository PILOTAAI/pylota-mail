# Threading

Binding for implementation. This page defines how messages are grouped into threads, the thread token
carried in `Reply-To`, subject normalisation, participants, and the address a reply is sent from.

| | |
|---|---|
| Requirements | FR-THR-1, FR-THR-2, FR-OUT-5, FR-OUT-6, FR-ADR-2, FR-DOM-6 |
| Edge cases | [A2](../edge-cases.md), [A10](../edge-cases.md), [B6](../edge-cases.md), [C1–C9](../edge-cases.md), [D10](../edge-cases.md) |
| Code | `crates/core/src/thread_token.rs`, `crates/core/src/thread.rs` (pure), `crates/worker/src/mailbox/threads.rs` (SQL) |
| Tables | `threads`, `messages`, `rate_windows` in [Data model](data-model.md#2-identitymailbox-durable-object-sqlite); the keyring in D1 `signing_keys` ([Data model](data-model.md#1-d1-control-plane)) |

Threading runs inside the `IdentityMailbox` Durable Object, inside the same SQLite transaction as the
message insert (see [Inbound pipeline](inbound.md#identitymailboxingest)). It never crosses identities:
the same raw message delivered to two identities is threaded independently in each mailbox
([A9](../edge-cases.md)).

## 1. Principles

1. **Headers and tokens join threads. Subjects never do** (FR-THR-1). A changed subject never splits a
   thread, and an identical subject never merges two.
2. **A thread token is a filing hint, not a credential.** A valid token files an inbound message into a
   thread. It never grants read access, never changes the identity, and never bypasses quarantine.
3. **Tokens bind to the identity, not to an address**, so they survive promotion, retirement of the
   address they were sent from, and domain fallback.
4. **Nested messages stay nested.** A forwarded `message/rfc822` part is content of the outer message,
   never a separate thread member (FR-THR-2, [B6](../edge-cases.md)).

## 2. Thread token

### 2.1 Format

The token is the sub-address (RFC 5233 detail part) of the `Reply-To` address on every outbound message
whose sending domain has `reply_token = 'subaddress'` (FR-OUT-6):

```text
{local}+t{K}{S}.{M}@{domain}

local   the From address's local part, e.g. bookings.acme
K       kid of the thread key that minted the token: one Crockford base32 character, lower case
        (signing_keys.kid, purpose 'thread')
S       thread seq (threads.seq, AUTOINCREMENT: never reused), Crockford base32, lower case, no leading
        zeros, 1–12 chars
M       first 40 bits of the HMAC, Crockford base32, lower case, exactly 8 chars

example bookings.acme+t03k.9f2mq7xa@agents.example     (kid "0", seq "3k" = 3 × 32 + 19 = 115)
```

The alphabet is Crockford base32 in lower case, the same family as ULIDs:

```text
0123456789abcdefghjkmnpqrstvwxyz        (no i, l, o, u)
index: '0'=0 … '9'=9, 'a'=10 … 'h'=17, 'j'=18, 'k'=19, 'm'=20, 'n'=21, 'p'=22 … 't'=26, 'v'=27 … 'z'=31
```

Length budget: `username + tenant suffix ≤ 40` ([A12](../edge-cases.md)), plus `+t` (2), `K` (1),
`S` (≤ 12), `.` (1) and `M` (8) gives at most 64 octets, the RFC 5321 local-part limit. Twelve base32
characters hold any seq below 2^60; the mailbox never creates a thread with a seq at or above 2^60 (it
would need 2^60 threads), so the budget always holds. A seq needs more than three characters only above
32,767, so in practice the detail after `+` is 12–14 characters.

### 2.2 MAC input (exact byte layout)

```text
offset  length  content
0       6       ASCII "pm-thr"
6       1       0x01                     token version
7       1       K, ASCII                 the kid character, lower case
8       30      identity_id, ASCII       "idn_" + 26-char ULID, upper case as stored
38      8       seq, unsigned 64-bit big-endian
total   46 bytes

mac  = HMAC-SHA256(key = the 32-byte thread key with kid K, message = the 46 bytes)
M    = crockford_lower(mac[0..5])        40 bits → 8 characters, most significant 5 bits first
```

The kid is inside the MAC input, so a token cannot be moved to another key by editing `K`.

`crockford_lower(b: [u8; 5])` reads the five bytes as one 40-bit big-endian integer `n` and emits
`ALPHABET[(n >> (35 - 5*i)) & 31]` for `i = 0..8`. `S` is the minimal base32 rendering of the seq, most
significant digit first (`seq = 1` → `"1"`, `seq = 32` → `"10"`).

```rust
// crates/core/src/thread_token.rs
pub const TOKEN_VERSION: u8 = 0x01;

pub struct ThreadKey<'a> { pub kid: u8, pub key: &'a [u8; 32] }   // kid: one ASCII Crockford character

pub struct ThreadKeyring<'a> {
    pub current: ThreadKey<'a>,                  // signing_keys row with verify_until IS NULL
    pub verifying: &'a [ThreadKey<'a>],          // older kids whose verify_until is still in the future
}

pub fn mint(ring: &ThreadKeyring, identity_id: &str, seq: u64) -> String;     // "t03k.9f2mq7xa"
pub fn reply_to_local(local: &str, token: &str) -> String;                    // "bookings.acme+t03k.9f2mq7xa"

#[derive(Debug, PartialEq, Eq)]
pub enum TokenCheck {
    Absent,                                  // no detail part, or detail does not look like a token
    Valid { seq: u64, kid: u8, current: bool },
    Invalid,                                 // looks like a token; unknown kid or MAC does not verify
}

pub fn verify(ring: &ThreadKeyring, identity_id: &str, detail: &str) -> TokenCheck;
```

### 2.3 Verification

`verify` receives the detail part of the **envelope recipient** (`message.to` in `email()`, everything
after the first `+`, already lower-cased by address normalisation, see
[Inbound pipeline](inbound.md#the-email-handler)). Header recipients are never used for tokens.

1. If the detail does not match
   `^t([0-9a-hjkmnp-tv-z])([0-9a-hjkmnp-tv-z]{1,12})\.([0-9a-hjkmnp-tv-z]{8})$`, return `Absent`.
   Other sub-addresses (for example `+invoices`) are ordinary tags: they are ignored for threading and
   never change the identity ([A2](../edge-cases.md)).
2. Decode `S`. Return `Invalid` if it has a leading `0`, decodes to 0, or is 2^60 or more.
3. Find the key with kid `K`: `ring.current` or an entry of `ring.verifying`. None → `Invalid`.
4. Compute `M'` with that key. Compare `M'` and `M` in constant time (compare all 8 bytes, accumulate
   with XOR/OR, no early exit). Equal → `Valid { seq, kid, current }`, where `current` says whether it
   was the current key. Otherwise `Invalid`.

The mailbox, which verifies tokens during ingest ([Inbound](inbound.md#identitymailboxingest)), loads the
keyring from D1 `signing_keys` (purpose `thread`), opens each key with `PM_MASTER_KEY`, and caches it in
the isolate for 5 minutes. A token whose kid is not in the cached ring triggers one re-read (at most once
a minute per isolate) before `verify` runs, so a key rotated in another isolate is picked up at once.
Keys past `verify_until` are left out of the ring. If no thread key exists yet, the first one is created
on first use ([Data model › Notes](data-model.md#notes)).

### 2.4 Key rotation

- Thread keys are generated by the Worker and never leave it: no API, CLI command or log returns them
  ([Security › Secrets](security.md#6-secrets)).
- New tokens are always minted with the current key and carry its kid.
- `POST /v1/platform/keys/thread/rotate` (platform key with `platform:ops`) makes a new current key and
  gives the old one `verify_until = now + 90 days`. Tokens with the old kid keep verifying until then;
  after it they are `Invalid`, and replies to those old messages thread by headers only (FR-THR-1 step 2).
- With `?revoke_previous=true` (after a suspected leak), the old kid is deleted in the same D1 batch, so
  tokens under it are `Invalid` at once and replies carrying them fall back to header threading the same
  way.
- A message that verified with a non-current kid is threaded normally. The metric
  `thread_token_previous_key_total` counts them, so the operator can see how much old mail still
  arrives before the window ends.

### 2.5 Brute-force limits ([D10](../edge-cases.md))

A token is 40 bits. Guessing is made impractical by rate-limiting failed verifications, using the
mailbox's `rate_windows` table with prefixed keys and hourly windows
(`window_start = received_at - received_at % 3_600_000`):

| Key in `rate_windows.sender` | Limit per hour | When exceeded |
|---|---|---|
| `tok:{sender_address}` | 10 failed verifications | Tokens from this sender are not verified for the rest of the window (treated as `Invalid` without computing the MAC) |
| `tok:*` | 100 failed verifications across all senders | Tokens are not verified for any sender for the rest of the window |

In both cases the message is still accepted and threads by headers. Each failure increments
`thread_token_invalid_total`. `sender_address` is the normalised `From` address, or the envelope sender
when `From` is missing. These rows are pruned with the D5 throttle rows (older than 48 hours).

## 3. Resolving the thread of an inbound message

### 3.1 Order (FR-THR-1)

```rust
// crates/core/src/thread.rs
pub struct InboundThreadInputs<'a> {
    pub token: TokenCheck,                    // from thread_token::verify, after rate limiting
    pub in_reply_to: Option<&'a str>,         // normalised msg-id, see 3.2
    pub references: &'a [String],             // normalised msg-ids, header order
    pub sender: &'a str,                      // normalised From address
}

pub trait ThreadLookup {                      // implemented over the mailbox SQLite connection
    fn thread_exists(&self, seq: i64) -> bool;
    fn thread_of_message_id(&self, msg_id: &str) -> Option<i64>;
    fn is_participant(&self, seq: i64, address: &str) -> bool;
}

pub enum JoinVia { Token, InReplyTo, References }
pub enum ThreadDecision { Join { seq: i64, via: JoinVia }, New }

pub struct ThreadResolution {
    pub decision: ThreadDecision,
    pub join_unverified: bool,                // trust flag thread_join_unverified
}

pub fn resolve_inbound(inp: &InboundThreadInputs, db: &impl ThreadLookup) -> ThreadResolution;
```

`resolve_inbound`:

1. **Token.** If `token` is `Valid { seq }` and `db.thread_exists(seq)`, the decision is
   `Join { seq, via: Token }`. A valid token for a seq that no longer exists (the thread was erased)
   is ignored, and resolution continues at step 2. Because `threads.seq` is `INTEGER PRIMARY KEY
   AUTOINCREMENT`, SQLite never hands out a seq again, not even after the newest thread is erased, so an
   old valid token can never join a new, unrelated thread ([C1](../edge-cases.md)).
2. **In-Reply-To.** If present and `db.thread_of_message_id(in_reply_to)` returns a seq, join it
   (`via: InReplyTo`).
3. **References.** Walk `references` from the **last** entry to the first (most recent first), at most
   50 lookups. The first hit is joined (`via: References`).
4. **New.** Otherwise `New`. The subject is never consulted ([C1](../edge-cases.md)).

`join_unverified` is set when any of these holds:

- `token` is `Invalid` (a token-shaped tag failed, or was not checked because of the rate limit);
- the decision is `Join { via: Token }`, the sender is not already a participant
  (`!db.is_participant(seq, sender)`), and neither `In-Reply-To` nor any `References` entry resolved
  to the same seq;
- the decision is `Join { via: InReplyTo }` or `Join { via: References }` and the sender is not already a
  participant of that thread. A `Message-ID` is in every copy of a message, so anyone who saw one (a
  recipient, a forwardee, a list) can write a header join into the thread ([C9](../edge-cases.md)).

The flag is stored in `messages.flags_json` and exposed in `trust.flags`. It is advisory for the message
itself: integrators show it to the agent and to humans, and the message still joins the thread. One
behaviour depends on it: a message with the flag never satisfies `wait` with `kind=reply`
([Inbound › The `wait` handler](inbound.md#the-wait-handler-e4)), so an agent waiting for a reply is not
woken by a stranger's header join.

### 3.2 Message-ID normalisation and matching

A msg-id from `Message-ID`, `In-Reply-To` or `References` is normalised by:

1. taking the content between the first `<` and the following `>` (or the whole trimmed value when
   there are no angle brackets);
2. removing CFWS (whitespace, folded line breaks, RFC 5322 comments in parentheses);
3. lower-casing **only the part after the last `@`** (domains are case-insensitive, local parts are
   compared exactly);
4. rejecting values longer than 998 bytes, empty values, and values without `@` (except synthetic IDs).

`References` is split into msg-ids by RFC 5322 `1*msg-id`. Malformed tokens between valid ones are
skipped. At most 200 entries are kept in `messages.references_json`.

`thread_of_message_id(id)` runs, in order, and returns the first hit:

```sql
-- 1. any stored message whose header Message-ID matches (inbound, or outbound with a learned header)
SELECT thread_seq FROM messages WHERE rfc_message_id = ?1 ORDER BY rowid DESC LIMIT 1;
-- 2. outbound messages whose provider ID matches, for providers whose header is not yet learned
SELECT thread_seq FROM messages
 WHERE direction = 'outbound' AND provider_message_id = ?1 ORDER BY rowid DESC LIMIT 1;
```

Lookup 2 covers the case in [C7](../edge-cases.md) where the header form is derivable from, or equal
to, the provider message ID (spike S7, see [Outbound](outbound.md#message-id-of-outbound-mail-spike-s7)).
Messages in status `hidden` or `throttled` still match: they belong to their thread even though agents
cannot see them.

### 3.3 Forwarded and nested messages (FR-THR-2, [B6](../edge-cases.md))

- Only the **outer** message's `Message-ID`, `In-Reply-To` and `References` are used for threading.
- A `message/rfc822` part (and the message inside a TNEF `winmail.dat`, when unpacked) is stored as an
  attachment of the outer message with `content_type = 'message/rfc822'` and a filename derived from its
  subject (`{subject}.eml`, sanitised, or `forwarded.eml`). Its text is extracted by the core parser into
  the attachment's `.md` text (see [Inbound pipeline](inbound.md#attachment-text-extraction)), so it is
  searchable, but it never becomes a row in `messages`, its Message-ID is never stored in
  `rfc_message_id`, and its headers never join or split threads.
- An inline forward (`---------- Forwarded message ---------` in the body) is ordinary body text of
  the outer message. It joins whatever thread the outer headers say.

### 3.4 Effects on the thread row

A thread's summary columns describe **visible** mail only: a message counts when its status is not
`quarantined`, `hidden` or `throttled` (every outbound message counts). So a thread list never shows a
count, a date, a subject or a participant that comes from mail an agent cannot see, and a thread whose
messages are all invisible has `message_count = 0` and is never listed
([Inbound › Read path and release](inbound.md#read-path-and-release)).

When the decision is `New`, the mailbox inserts:

```sql
INSERT INTO threads (id, subject, first_at, last_at, last_inbound_at, message_count, unread_count,
                     participants_json, reply_from_address)
VALUES (?1, ?2, ?3, ?3, NULL, 0, 0, '[]', ?4)
RETURNING seq;
-- ?1 thr_ id from the platform ID generator, ?2 normalise_subject(subject) when the message is visible,
-- else '' (filled by the first visible message), ?3 received_at, ?4 the delivered-to address without its
-- tag (NULL for a BCC copy, and for a message that is not visible)
```

Then, for both new and joined threads, after the message row is inserted, and only when the new message
is visible, the visible columns are recomputed by one statement (the same one runs when a message is
released, and when an erasure or retention purge deletes a message of the thread):

```sql
UPDATE threads SET
  message_count   = (SELECT COUNT(*) FROM messages
                     WHERE thread_seq = ?1 AND status NOT IN ('quarantined','hidden','throttled')),
  unread_count    = (SELECT COUNT(*) FROM messages
                     WHERE thread_seq = ?1 AND direction = 'inbound' AND status = 'received' AND read = 0),
  last_at         = COALESCE((SELECT MAX(received_at) FROM messages
                     WHERE thread_seq = ?1 AND status NOT IN ('quarantined','hidden','throttled')), first_at),
  last_inbound_at = (SELECT MAX(received_at) FROM messages
                     WHERE thread_seq = ?1 AND direction = 'inbound' AND status = 'received'),
  subject         = CASE WHEN subject = '' THEN ?2 ELSE subject END,
  participants_json  = ?3,                                           -- recomputed in Rust (section 6)
  reply_from_address = COALESCE(?4, reply_from_address)              -- section 5
WHERE seq = ?1;
-- ?2 normalise_subject of the earliest visible message, ?3 the participants list of section 6
```

The subqueries use `messages_thread (thread_seq, received_at)`. A quarantined, hidden or throttled
message changes none of the columns (its `thread_seq` still records where it belongs, so a later release
recomputes them).

## 4. Outbound threading

| Operation | Thread | `In-Reply-To` | `References` | Subject |
|---|---|---|---|---|
| `send`, no `thread_id` | New thread | – | – | As given |
| `send` with `thread_id` | That thread (`404 thread_not_found` if absent) | The latest message in the thread with a known header ID | Built from that message | As given |
| `reply`, `reply-all` to message M | M's thread | M's header ID | Built from M | `Re: ` + normalised subject of M |
| `forward` of message M | M's thread ([C6](../edge-cases.md)) | – (not set on forwards) | Built from M | `Fwd: ` + normalised subject of M |

"Header ID" means `messages.rfc_message_id`. For our own outbound messages it is known only once
learned (spike S7). When M's header ID is unknown, the anchor becomes the most recent earlier message in
the same thread whose header ID is known; if there is none, `In-Reply-To` and `References` are omitted
and threading at the other end relies on the subject and on our thread token for replies.

### 4.1 Building `References` ([C2](../edge-cases.md))

```rust
// crates/core/src/thread.rs
pub const MAX_REFERENCES: usize = 20;

/// RFC 5322 §3.6.4: parent's References (or its In-Reply-To when it has no References)
/// followed by the parent's Message-ID, then trimmed.
pub fn build_references(parent_refs: &[String], parent_in_reply_to: Option<&str>,
                        parent_id: &str) -> Vec<String> {
    let mut v: Vec<String> = if !parent_refs.is_empty() { parent_refs.to_vec() }
        else { parent_in_reply_to.map(|s| vec![s.to_string()]).unwrap_or_default() };
    v.push(parent_id.to_string());
    dedupe_keep_last(&mut v);                 // keep the LAST occurrence of a repeated id
    if v.len() > MAX_REFERENCES {             // keep the first, plus the 19 most recent
        let first = v[0].clone();
        let tail = v.split_off(v.len() - (MAX_REFERENCES - 1));
        v = std::iter::once(first).chain(tail).collect();
    }
    v
}
```

The header is written as `<id>` values separated by a single space and folded at 78 characters by the
MIME builder. We always send with `send()` (structured) or raw MIME, never with `message.reply()`, so
Cloudflare's 100-entry `reply()` limit never applies.

### 4.2 The outbound message row

The outbound message is inserted with `thread_seq` of its thread, the thread's visible columns are
recomputed as in 3.4 (an outbound message is always visible), `last_outbound_at` is set and, for a new
thread, `subject` and `reply_from_address` are set from it. Recipients are added to `participants_json`
(section 6). The Reply-To token is minted
from the thread's `seq` at composition time (see [Outbound](outbound.md#reply-to-and-the-thread-token)).

## 5. Which address a reply is sent from ([C3](../edge-cases.md), FR-OUT-5)

`threads.reply_from_address` records the identity address the counterparty last wrote to.

**Updated on inbound** (value `?5` in 3.4):

| Inbound situation | `reply_from_address` becomes |
|---|---|
| Envelope recipient is one of the identity's `active` or `retiring` addresses and is in `To`/`Cc` | That address, without its `+tag` |
| BCC copy (`is_bcc = 1`, envelope recipient not in headers, [A10](../edge-cases.md)) | Unchanged |
| The message arrived at the identity's **platform** address with a valid token, on a thread with `fallback_pinned = 1` | Unchanged (the thread is on the platform address only because of fallback, see 5.1) |
| Message status is `quarantined`, `hidden` or `throttled` | Unchanged (released messages update it at release time) |

**Read at reply time** (`select_reply_from`, used by reply, reply-all, forward and `send` with
`thread_id`):

1. If the thread has `fallback_pinned = 1`, use the identity's platform address (5.1).
2. Else, if `reply_from_address` is set and its status is `active` or `retiring`, use it.
3. Else use the identity's primary address (the address may have retired, [C3](../edge-cases.md)).
4. The chosen address's domain state then decides whether fallback applies
   ([Identities, addresses and domains](identity-domains.md#fallback-behaviour)).

An explicit `from_address` in a `send` with `thread_id` overrides steps 1–3, subject to the retiring
rule in [G7](../edge-cases.md): a `retiring` address may only be used on a thread whose
`reply_from_address` is that address or that already has an outbound message from it.

### 5.1 Fallback-pinned threads

When a message in a thread is sent through domain fallback (`sent_via_fallback`), the thread's
`fallback_pinned` is set to 1 in the same transaction. While pinned, every send in that thread uses the
platform address, even after the domain recovers, so a counterparty never sees the From address flip
mid-conversation. Sends through fallback do **not** change `reply_from_address`, so the thread returns
to the custom-domain address when it unpins.

A thread unpins (`fallback_pinned = 0`) when both hold: the original domain is `healthy`, and the
thread has had no message in either direction for 72 hours (`last_at < now - 72 h`). The check runs
lazily in `select_reply_from` (and in the daily mailbox maintenance alarm), so no cross-object fan-out
is needed when a domain recovers.

## 6. Participants

`threads.participants_json` is `[{ "address": "...", "name": "..." }]`, at most 50 entries, ordered by
first appearance, built from visible messages only. When a visible message is inserted or released, its
addresses are added to the stored list in Rust; after an erasure or retention purge deletes a message of
the thread, the list is rebuilt from the thread's 1,000 most recent visible messages, so an erased
counterparty leaves it. The rules for each message:

- **Inbound:** add `From`, then every `To` and `Cc` entry.
- **Outbound:** add every `To` and `Cc` recipient.
- Never add BCC recipients, in either direction ([A10](../edge-cases.md)).
- Never add the identity's own addresses (any status) or the hidden journal address
  ([Outbound](outbound.md#message-id-of-outbound-mail-spike-s7)).
- Addresses are compared normalised (lower case, A-label domain). When an existing entry gets a new
  non-empty display name, the latest name wins. Names are truncated to 78 characters and stripped of
  control characters.
- When the list holds 50 entries, new addresses are not added. `is_participant` checks the stored list
  first and falls back to `SELECT 1 FROM messages WHERE thread_seq = ?1 AND from_address = ?2 LIMIT 1`,
  so a thread with many participants still recognises earlier senders.

## 7. Subject normalisation ([C8](../edge-cases.md))

`normalise_subject(s)` is used for `threads.subject` (display) and for building reply and forward
subjects. It never affects thread membership.

1. Decode RFC 2047 encoded words (done by the MIME parser), replace control characters with spaces,
   collapse runs of whitespace, trim.
2. Repeatedly (at most 10 times) remove a leading prefix matching, case-insensitively:

   ```text
   ^\s*(?:\[[^\]]{1,40}\]\s*)?               an optional list tag such as [acme-ops] is kept, see below
      (re|fwd?|aw|wg|sv|vs|vb|antw|doorst|tr|rif|i|r|enc|res|rv|odp|pd|ynt|ilt|atb|πληρ|σχετ|ответ|回复|回覆|答复|转发|轉寄)
      \s*(?:\[\d{1,4}\]|\(\d{1,4}\))?        counters such as Re[2]: or Re(3):
      \s*[:：]\s*                             ASCII colon or full-width colon
   ```

   Single-letter prefixes (`I:`, `R:`, Italian) are removed only when followed by a colon and a space,
   so subjects such as `R: drive` lose `R: ` while `R2D2` is untouched. A leading list tag in square
   brackets is preserved in the output and prefixes after it are removed (`[acme-ops] Re: Fwd: x` →
   `[acme-ops] x`).
3. If the result is empty, use `(no subject)` for display.

| Language | Reply | Forward |
|---|---|---|
| English | `Re:` | `Fwd:`, `Fw:` |
| German | `AW:` | `WG:` |
| Swedish, Norwegian, Danish | `SV:` | `VS:`, `VB:` |
| Dutch | `Antw:` | `Doorst:` |
| French | `RE:` | `TR:` |
| Italian | `R:`, `RIF:` | `I:` |
| Spanish, Portuguese | `RE:`, `RES:` | `RV:`, `ENC:` |
| Polish | `Odp:` | `PD:` |
| Turkish | `YNT:` | `İLT:` |
| Greek | `ΣΧΕΤ:` | `ΠΛΗΡ:` |
| Russian | `Ответ:` | – |
| Chinese | `回复：`, `回覆：`, `答复：` | `转发：`, `轉寄：` |

Our own reply subjects are `Re: ` + `normalise_subject(original)` (exactly one `Re:`), and forwards are
`Fwd: ` + `normalise_subject(original)`. A subject longer than 998 characters after prefixing is
truncated at a character boundary.

## 8. Edge cases

| Row | Behaviour | Where |
|---|---|---|
| [C1](../edge-cases.md) | No `In-Reply-To`/`References`: joined only by a valid token, else a new thread | 3.1 steps 1 and 4 |
| [C2](../edge-cases.md) | Our replies keep the first reference plus the 19 most recent | 4.1 |
| [C3](../edge-cases.md) | Reply to an old thread after the address moved: we reply from the retiring address the counterparty wrote to, then from the primary once it retires | 5 |
| [C4](../edge-cases.md) | Concurrent sends into one thread are serialised by the thread lock | [Outbound](outbound.md#thread-lock-c4) |
| [C5](../edge-cases.md) | Integrator-side; `threads.last_inbound_at` and the per-identity event `sequence` are exposed | 3.4, [Webhooks](webhooks.md) |
| [C6](../edge-cases.md) | Forward stays in the thread and keeps `References` | 4 |
| [C7](../edge-cases.md) | Replies to our mail match by token first, then by learned header ID or provider ID | 3.1, 3.2 |
| [C8](../edge-cases.md) | Localised prefixes are stripped for display only | 7 |
| [C9](../edge-cases.md) | A header join by a sender who is not a participant is flagged `thread_join_unverified` and never satisfies `wait` with `kind=reply` | 3.1 |
| [A2](../edge-cases.md) | Forged or unrelated sub-address tags never change the identity; a token-shaped tag that fails is ignored | 2.3 |
| [B6](../edge-cases.md) | Forwarded `message/rfc822` parsed as nested content | 3.3 |
| [D10](../edge-cases.md) | Failed verifications rate-limited and flagged | 2.5, 3.1 |

## 9. Tests

| Test | Covers |
|---|---|
| `core::thread_token::a2_round_trip` (property) | Mint then verify returns `Valid` for random identities, kids and seqs; every single-bit flip of `K`, `S` or `M` returns `Invalid` or `Absent` (build plan M2) |
| `core::thread_token::a2_layout_vectors` | Fixed vectors: key, kid, identity, seq → exact 46-byte MAC input and exact token string |
| `core::thread_token::a2_non_token_tags` | `+invoices`, `+t`, `+T03K.9F2MQ7XA` (upper case, lower-cased first), leading-zero seq, a seq of 13 characters |
| `core::thread_token::a2_rotated_kid` | A token minted under an older kid verifies with `current: false` while that kid is in the ring, and is `Invalid` once it leaves; an unknown kid is `Invalid` |
| `core::thread_token::a12_budget` | The longest username plus suffix (40) with a 12-character seq gives a 64-octet local part |
| `it::send::reply_to_carries_token` | A send from a `subaddress` domain has a `Reply-To` sub-address whose thread token ([§2](#2-thread-token)) verifies for that thread; a send from a domain with `reply_token = 'none'` has no `Reply-To` (FR-OUT-6) |
| `it::inbound::a2_forged_token_ignored` | A forged token files by headers, flags `thread_join_unverified`, identity unchanged (A2) |
| `it::inbound::d10_token_bruteforce` | Eleventh failure in an hour from one sender is not verified; the 101st failure across senders suspends verification; mail still accepted (D10) |
| `core::thread::c1_token_only` / `core::thread::c1_no_headers_new_thread` / `core::thread::c1_subject_never_joins` | C1; the resolution order of FR-THR-1 (token, then headers, then a new thread; the subject never joins) |
| `it::thread::seq_never_reused` | Erase the newest thread of a mailbox, create a new one: its `seq` is higher than the erased one's, and a reply carrying the erased thread's valid token starts a new thread instead of joining the new one (C1; an integration test because the guarantee is SQLite's `AUTOINCREMENT`) |
| `core::thread::c9_header_join_non_participant` / `it::inbound::c9_header_join_flagged` | `resolve_inbound` sets `join_unverified` for an `In-Reply-To` or `References` join by a sender who is not a participant, and not for a participant; through `email()`, such a message joins the thread with `thread_join_unverified` in `trust.flags` and does not end a `wait` with `kind=reply` (C9) |
| `it::messages::thread_counts_visible_only` | A quarantined first message leaves the thread unlisted with `message_count = 0`; a throttled reply changes neither `last_at` nor `participants`; after release the counts, subject and participants include the released message; after a counterparty erasure the counterparty leaves `participants` |
| `core::thread::c2_trim_references` | 150 references → first + 19 most recent, order kept, duplicates removed (C2) |
| `core::thread::c2_rfc5322_parent_rules` | Parent without References uses its In-Reply-To |
| `it::addresses::c3_reply_from_retiring` | After a promote, replies go from the retiring address the counterparty used; after retirement, from the primary (C3) |
| `it::send::c6_forward_keeps_refs` | Forward stays in the thread with `References` built from the original (C6) |
| `it::thread::c7_reply_to_cloudflare_message_id` | An inbound reply whose `In-Reply-To` is our learned header ID (or provider ID) joins the thread without a token (C7) |
| `live::thread::c7` | Real Gmail and Outlook replies to our mail thread on both sides (C7) |
| `core::thread::c8_prefixes` | Every prefix in the table, counters, full-width colons, list tags, `R2D2` untouched (C8) |
| `conf::mime::b6_forwarded_rfc822` | Nested message stored as an attachment; its Message-ID never threads (B6, FR-THR-2) |
| `core::thread::references_walk_order` | References are matched newest first, capped at 50 lookups |
| `it::thread::fallback_pinned_unpins_after_quiet` | A fallback-pinned thread keeps the platform address after recovery and returns to the custom address after 72 quiet hours |
| `core::thread::participants_never_bcc` | BCC recipients and own addresses never enter `participants_json`; cap at 50 (A10) |
