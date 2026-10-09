# 0004 Required idempotency

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-09 |
| Deciders | Pylota engineering |
| Related | FR-OUT-1, FR-OUT-2, FR-DLV-4, PRD goal 3; [Outbound](../design/outbound.md); [Errors](../../reference/errors.md); [G1](../edge-cases.md), [G2](../edge-cases.md) |

## Context

Agents and integrators retry. A network error on a send is ambiguous: the request may or may not have
reached the service, and the service's call to the transport may or may not have reached the provider.
Pylota's experience before this product: a failed send re-ran an LLM turn and produced a second email
(PRD section 2). A duplicate email to a customer is worse than a delayed one.

Facts that constrain the design (Cloudflare Email Sending docs, read 2026-10-09): the structured
`send()` returns a `messageId`; `Message-ID`, `Date` and DKIM headers are set by the platform and cannot
be set by the caller, so the provider cannot deduplicate on a client-chosen `Message-ID`. A transport
timeout or a dropped connection after the request was written leaves the outcome unknown.

## Decision

1. **`Idempotency-Key` is required** on `POST …/messages`, `…/reply`, `…/reply-all` and `…/forward`
   (1–255 printable ASCII characters). A missing key is `400 idempotency_key_required`. MCP send tools
   require an `idempotency_key` argument. The key is optional on every other `POST`. (Amended
   2026-10-10 with the exceptions this item omitted; see [Amendments](#amendments).)
2. **Reservation in the mailbox transaction.** The mailbox stores the key with a fingerprint
   (`sha256(operation, target, canonical body)`) in the same transaction that stores the message as
   `queued`. Keys are kept for 30 days, scoped per identity for mail and per tenant for other `POST`s.
3. **Replays.** Same key and same request: the original response, with `"deduplicated": true` and the
   header `Idempotent-Replayed: true`. Same key, different request: `409 idempotency_conflict`. Same key
   while the first request is running: `409 request_in_progress` (retryable).
4. **Uncertain is a state, not a retry.** A transport outcome that cannot be known becomes `uncertain`
   and is never resent automatically. Definitely-not-sent outcomes (validation, quota, rate limits) may
   be retried by the queue.
5. **Reconciliation.** Uncertain sends are matched to provider events by sender, recipient and subject
   within 30 minutes; a match moves the message to its real status with `reconciled: true` and emits
   `message.reconciled` (FR-DLV-4).
6. **Human resolution.** `POST …/messages/{id}/resolve {"outcome": "sent" | "not_sent"}`. `not_sent`
   marks the message `failed` (`resolved_not_sent`); a new send needs a new key.

## Consequences

- Every retry of the same message, by any client, after any failure, returns the same result: zero
  duplicate sends attributed to retries (PRD success metric).
- Clients must generate a key per logical message and keep it across retries. The SDK exposes
  `.idempotency_key(…)`; agent guides tell agents to derive it from their own task identifiers.
- After 30 days a key is forgotten and its reuse is a new send; this is documented.
- Some sends end `uncertain` and need reconciliation or a human. That is the price of never guessing.
- The mailbox stores a response per key for 30 days, which is counted in the privacy inventory.

## Alternatives considered

- **Optional keys.** Lower friction for simple callers. Rejected: the callers most likely to retry
  blindly (LLM agents, generic HTTP tooling) are the least likely to send a key, and one forgotten key
  is one duplicate email.
- **Automatic retry of uncertain sends.** Fewer messages stuck in `uncertain`. Rejected: when the first
  attempt did reach the provider, the retry sends a second email; the provider offers no client-controlled
  deduplication to make that safe.
- **Deriving the key from a hash of the body.** No client work. Rejected: two legitimate identical
  messages (a reminder sent twice on purpose) would be merged, and a corrected retry with a small change
  would send twice.
- **Deduplicating on `Message-ID` at the provider.** The usual SMTP-era answer. Not available: Email
  Sending sets `Message-ID` itself.

## Amendments

- **2026-10-10.** Decision 1 omitted exceptions that the API contract already had
  ([`openapi.yaml`](../../reference/openapi.yaml), `x-idempotency`). A **dry run** (`?dry_run=true` on
  send, reply, reply-all or forward) stores, reserves and sends nothing, so the key is optional there and
  is never looked up or recorded. Four `POST` endpoints **ignore the header and never record it**
  (`x-idempotency: none`): the two signing endpoints (`…/assertions` and `…/http-signatures`), because each
  call signs anew and a replay record would have to store what was signed; and the two Amazon SNS
  endpoints (`/hooks/ses` and `/hooks/ses/inbound`), which SNS calls without the header. The rest of the
  decision is unchanged.
