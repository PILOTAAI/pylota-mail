# 0012 Service sign-up ledger

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-10 |
| Deciders | The owner (TREFT LTD): plan decision D7, and "Design it for v1.0" (2026-10-10) |
| Related | FR-IDN-10, FR-IN-5, FR-CON-6; [Service sign-up ledger](../design/service-accounts.md); [Inbound › Verification codes](../design/inbound.md#verification-codes-and-unsolicited-otp-e5); edge rows E5, E9–E14 |

## Context

Agents use their identity's address to sign up at third-party services, and `wait` hands them the
verification code. Plan decision D7 allows that only with per-account operator approval, through a
ledger. Nothing implemented it: edge row E5 relied on the `wait` registration alone, so any agent that
called `wait` for a domain received that domain's codes. On a shared Cloud, unapproved mass sign-ups would
also spend the reputation of `pylotamail.com` addresses with those services.

The agent can read the whole message with `messages:read`, so withholding only the `verification` object
of `wait` would not stop it: the mail itself must be held.

## Decision

1. A per-identity ledger **must** exist in D1 (`service_accounts`): an agent with `accounts:request`
   requests an entry (service domain, account identifier, purpose, address); a key with `accounts:approve`
   (never an identity key) or a console owner or admin approves or rejects it; entries can be closed and
   deleted; pending entries expire after 7 days.
2. Approval **must** follow the rule for decisions reserved for people (FR-CON-6): an API key may approve
   only where keys may release quarantined mail. Rejection is always allowed.
3. While the tenant's `accounts.require_approval` is `true`, an inbound message with a verification match
   **must** be quarantined with `account_unapproved` unless an approved entry matches it: the organisational
   domain of an authenticated (`verdict: pass`) `From` is one of the entry's sender domains, and the
   message was delivered to the entry's address. Senders on the receive-allow list are exempt. `wait` with
   `kind=verification` **must** refuse a domain without an approved entry (`403 policy_denied`).
4. `accounts.require_approval` **must** be off in the built-in defaults, on in Pylota Mail Cloud's
   `PM_DEFAULT_POLICY`, and lower-only with `false` as the looser value.
5. Changes **must** emit `account.requested`, `account.approved`, `account.rejected` and `account.closed`.

## Consequences

- Codes from unapproved services never reach agents on Cloud; an operator sees every request in the
  console's "Needs a person" and in the events.
- Agents must request and wait for approval before signing up; MCP gets a request tool and a list tool,
  never an approve tool.
- Verification-looking mail from ordinary correspondents can be held, as E5 already does for unsolicited
  codes; operators exempt such senders with the receive-allow list.
- The ledger is read from D1 at consumer step 12, a few seconds before the mailbox decides: a late approval
  fails closed, a late closure can let one message through, and `wait` re-checks before it releases a code.

## Alternatives considered

- **The ledger inside each identity's mailbox.** The gate would be atomic with ingest, but the tenant-wide
  approval queue, which the Overview reads on every render, would need a fan-out across mailboxes, and
  approvals could not share a D1 batch with their audit rows. Not chosen.
- **Gate only `wait`.** The agent reads the message directly. Not chosen.
- **Refuse the `wait` registration only, and rely on E5.** Codes would be held as `otp_unsolicited`, which
  hides the reason from the operator, and tenants that turn off unsolicited-OTP quarantine would lose the
  gate. Not chosen.
