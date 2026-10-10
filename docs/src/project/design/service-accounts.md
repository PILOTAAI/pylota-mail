# Service sign-up ledger

Binding for implementation. Agents may create accounts at third-party services with their identity's
address only with per-account approval by a person or the operator's own system, through a ledger (plan
decision D7, accepted by the owner, and designed for v1.0 on 2026-10-10;
[ADR 0012](../adr/0012-service-sign-up-ledger.md)). An agent records that it wants an account at a service;
an operator approves or rejects it; and, where the tenant's policy requires approval, a verification code
or link from a service reaches the agent only when an approved ledger entry matches the mail.

| | |
|---|---|
| Requirements | FR-IDN-10 (this page), FR-IN-5, FR-CON-6, FR-PRV-3 |
| Edge cases | [E5](../edge-cases.md), [E9](../edge-cases.md)–[E14](../edge-cases.md) |
| Code | `crates/core/src/accounts.rs` (request normalisation, the match rule, the gate; pure), `crates/worker/src/accounts/{mod.rs, service.rs}`, `handlers/accounts.rs`, the ledger facts in `consumers/inbound.rs` (step 12), the gate in `mailbox/ingest.rs` (quarantine rule 4a), the ledger checks in `handlers/wait.rs`, `console/pages/accounts.rs`, the `service_accounts` steps in `jobs/retention.rs` and `jobs/erasure.rs` |
| Tables | D1 `service_accounts`; the mailbox's `verifications.account_id` and `messages.quarantine_reason` value `account_unapproved` ([Data model](data-model.md)) |
| Contracts | The eight `…/accounts` routes and the permissions `accounts:request` and `accounts:approve` ([REST API › Service accounts](../../reference/api.md#service-accounts)); the events `account.requested`, `account.approved`, `account.rejected`, `account.closed` ([Webhook events](../../reference/events.md#service-accounts)); the policy field `accounts.require_approval` ([Configuration](../../reference/configuration.md#tenant-policy)); `409 account_exists`, `409 account_not_pending`, `422 account_limit_reached`, `404 account_not_found`, and `403 policy_denied` with `details.reason = "account_not_approved"` ([Errors](../../reference/errors.md)) |
| Limits | [Limits › Service sign-up ledger](../../reference/limits.md#service-sign-up-ledger) |
| Built in | [M27](../build-plan.md#m27--service-sign-up-ledger-after-m7-m8-m14-m15-m16-and-m21) |

## 1. Why D1 and not the mailbox

The ledger is a record of an operator's decisions, like keys, domains and members, so it lives in the D1
control plane (`service_accounts`), with `identity_id` on every row: each entry belongs to one identity,
and every list is per identity or per tenant. That keeps the tenant-wide approval queue a single indexed
query (the console's Overview reads it on every render) instead of a fan-out across mailboxes, and lets
approval, its audit row and its event commit in one D1 batch. The mail side still decides inside the
mailbox: the inbound consumer reads the identity's approved entries with its other D1 facts and passes
them in `IngestInput`, and `IdentityMailbox.ingest` applies the gate in its transaction
([§5](#5-the-verification-gate)), the pattern every other inbound decision follows
([Inbound › Steps](inbound.md#steps), step 12).

## 2. The entry

```text
pending_approval ──approve──▶ approved ──close──▶ closed
       │                         ▲
       ├──reject (operator)──▶ rejected
       ├──7 days pass───────▶ rejected (reason expired)
       └──close (withdraw)──▶ closed
```

| Field | Meaning |
|---|---|
| `id` | `sac_` + ULID |
| `identity_id`, `tenant_id` | The identity whose address signs up, and its tenant. Taken from the path and the key's scope, never from the body |
| `service_domain` | The service, as its organisational domain: the request's value converted to an IDNA A-label, lower-cased and reduced to its registrable domain with the public suffix list (`core::accounts::normalise`, the same `psl` function as `messages.sender_domain`) |
| `sender_domains` | Organisational domains the service's mail may come from: `service_domain` always, plus up to 5 more the request names, normalised the same way (for a service that sends from another domain, such as a mail provider of its own) |
| `account_identifier` | The username or account email the agent will use at the service, 1–254 printable characters, trimmed. It is shown to the operator; it decides nothing |
| `address` | The identity's address the service will mail: an `active` or `retiring` address of the identity, by default its primary address when the entry is requested |
| `purpose` | Why the agent needs the account, 1–500 characters, shown to the operator as untrusted text (escaped in the console; it may have been written by an agent that mail steered) |
| `status` | `pending_approval`, `approved`, `rejected` or `closed` |
| `rejected_reason` | `operator` or `expired`, while `rejected` |
| `note` | The operator's note on approval or rejection, or the closer's note, at most 500 characters |
| `requested_by_key_id` | The key that asked |
| `decided_by_key_id`, `decided_by_user_id`, `decided_at` | Who approved or rejected, and when (both actor columns `NULL` for an expiry) |
| `closed_by_key_id`, `closed_by_user_id`, `closed_at` | Who closed it, and when |
| `expires_at` | While `pending_approval`: `created_at` + 7 days. `NULL` otherwise |

**Requesting** (`POST /v1/identities/{identity_id}/accounts`, `accounts:request`, any key level): the handler
validates and normalises the body (`core::accounts::normalise`), then, in one D1 batch, inserts the row
with `INSERT … SELECT … WHERE` guards, so concurrent requests cannot pass the limits:

- not more than 10 `pending_approval` entries for the identity, and not more than 200 entries in any status
  ([Limits](../../reference/limits.md#service-sign-up-ledger)): otherwise `422 account_limit_reached` with
  `details.limit` and `details.status` ([E12](../edge-cases.md));
- no live entry (`pending_approval` or `approved`) with the same `service_domain` and
  `account_identifier` for the identity (the unique partial index `service_accounts_live`): otherwise
  `409 account_exists` with `details.account_id` and `details.status`;

and writes the audit row `account.request` and the event `account.requested`. It answers `201` with the
entry. Refusals before the batch: a suspended tenant gets `403 tenant_suspended` and a paused identity
`409 identity_paused` (checked in that order, as on sends), because a stopped agent must not start new
sign-ups; a `service_domain` or sender domain that is a public suffix, an IP literal or not a DNS name gets
`400 invalid_request` (`details.errors[]`); one whose organisational domain is that of
`PM_PLATFORM_DOMAIN`, `PM_API_HOST` or `PM_CONSOLE_HOST` gets `400 invalid_request` with
`details.reason = "own_deployment"`, so agents cannot open workspaces on the deployment they run on
([E14](../edge-cases.md)); an `address` that is not an `active` or `retiring` address of the identity gets
`400 invalid_request` with `details.errors[0].path = "address"`.

**Closing** (`POST …/accounts/{account_id}/close`, `accounts:request`): the agent no longer uses the
account, or an operator withdraws it. `pending_approval` or `approved` → `closed`, with the audit row
`account.close` and the event `account.closed`. A closed entry matches no mail from then on
([E13](../edge-cases.md)). Closing a `closed` or `rejected` entry changes nothing and answers `200` with it.
Closing the entry does not close the account at the service: the agent or a person does that there.

**Deleting** (`DELETE …/accounts/{account_id}`, `accounts:approve`): removes the row. A live entry is closed
first in the same batch (with its `account.closed` event). The audit row `account.delete` keeps the entry's
ID, `service_domain` and final status, so the decision trail survives the row. Answers `204`.

## 3. Reading

| Route | Permission | Returns |
|---|---|---|
| `GET /v1/identities/{identity_id}/accounts` | `accounts:request` | The identity's entries, newest first; filters `status`, `service_domain` |
| `GET /v1/tenants/{tenant_id}/accounts` | `accounts:request`, tenant, partner or platform key | The tenant's entries; filters `status`, `identity_id`, `service_domain`; an identity key gets `403 scope_denied` ([F3](../edge-cases.md) rule) |
| `GET /v1/identities/{identity_id}/accounts/{account_id}` | `accounts:request` | One entry |

`accounts:approve` includes `accounts:request`, as `webhooks:manage` includes `webhooks:read`, so an approver
reads what it decides. Lists use the standard cursor pagination. An entry outside the key's scope, or of
another identity than the path's, is `404 account_not_found`, the same answer as a missing one
(NFR-SEC-1).

## 4. Approval

`POST …/accounts/{account_id}/approve` and `…/reject`, both `accounts:approve` (platform, partner or tenant
key; never an identity key, so an agent cannot approve its own request), with an optional `note`.

1. **Who.** Rejecting is always allowed: it can only keep codes away from agents. Approving lets codes reach
   an agent, so it is one of the decisions reserved for people
   ([Workspace policy §3](workspace-policy.md#3-decisions-reserved-for-people)): an API key may approve only
   when `PM_QUARANTINE_KEY_RELEASE` is `on`, `PM_CONSOLE` is `off`, or the tenant's policy has
   `quarantine.key_release: true`; otherwise `403 permission_denied` with
   `details.reason = "person_required"` ([E11](../edge-cases.md)). On Pylota Mail Cloud a self-serve
   workspace therefore approves in the console, and Pylota, whose operators' tenants have
   `quarantine.key_release: true`, approves from its own review screen with its partner key.
2. **State.** One D1 batch: `UPDATE service_accounts SET status = …, decided_* = …, note = ?,
   expires_at = NULL WHERE id = ?1 AND status = 'pending_approval' AND expires_at > ?now`, with the audit row
   (`account.approve` or `account.reject`) and the event (`account.approved` or `account.rejected` with
   `reason: "operator"`) guarded by the same condition. When it changed no row, the handler re-reads the
   entry: the same decision already taken (approve on `approved`, reject on `rejected`) answers `200` with
   the entry and writes nothing; a `pending_approval` entry past `expires_at` is set `rejected` with reason
   `expired` (and its event) and the request gets `409 account_not_pending` with `details.status`; any
   other state gets `409 account_not_pending` with `details.status`.
3. **What approval does not do.** It does not release mail already held under rule 4a
   ([§5](#5-the-verification-gate)): those messages stay quarantined with reason `account_unapproved`, and
   a person (or a key under the same rule as above) releases them like any quarantined message, or the
   agent asks the service for a new code. The console's accounts page links to the quarantine list for
   that.

The expected order for an agent is therefore: request the entry; wait for `account.approved` (webhook) or
poll the entry; sign up at the service with the entry's `address`; then `wait(kind=verification,
from=@{service})` for the code.

## 5. The verification gate

The gate applies only while the tenant's effective `accounts.require_approval` is `true`. It is off in the
built-in defaults and on in Pylota Mail Cloud's `PM_DEFAULT_POLICY`
([Cloud commissioning §5](../cloud-commissioning.md#5-the-cloud-default-policy)), where it is lower-only
with `false` as the looser value, so no workspace or partner can turn it off
([Workspace policy §2](workspace-policy.md#2-classes-and-ceilings)).

**The match rule** (`core::accounts::matches(entry, msg) -> bool`, pure). An entry matches an inbound
message when all of these hold:

1. the entry belongs to the receiving identity and its `status` is `approved`;
2. the organisational domain of the message's `From` address (the stored `messages.sender_domain`) is one
   of the entry's `sender_domains`, compared as A-labels: `noreply@mail.github.com` matches `github.com`,
   while `github.com.evil.example` and a confusable look-alike do not;
3. the message's authentication verdict is `pass`, so that domain is proven (DMARC-aligned); a forged or
   unauthenticated `From` never matches ([D1](../edge-cases.md));
4. the message's `delivered_to` (the envelope recipient without its `+detail`, [Inbound › A9](inbound.md#multiple-identities-in-one-tenant-a9))
   equals the entry's `address`, so a code sent to another address of the identity does not match.

Several entries can match one message (one service, two usernames); the oldest approved entry is recorded.

**Quarantine rule 4a.** The consumer computes the verification match as today
([Inbound › Verification codes](inbound.md#verification-codes-and-unsolicited-otp-e5)). When the effective
policy has `accounts.require_approval: true` and the message has a verification match, step 12 of the
consumer adds one D1 query to its facts batch:

```sql
SELECT id, sender_domains_json, address FROM service_accounts
WHERE identity_id = ?1 AND status = 'approved' ORDER BY created_at;
```

and passes the rows as `IngestInput.approved_accounts: Option<Vec<ApprovedAccount>>`, with
`ApprovedAccount { account_id: String, sender_domains: Vec<String>, address: String }` (`None` when the
policy does not require approval or there is no verification match, so the common path reads nothing
more). Inside `ingest`, rule 4a of the
[quarantine decision](inbound.md#quarantine-decision) runs after rule 4 and before rule 5:

- no entry matches, and the sender address or its `@domain` is not on the tenant's receive-allow list
  (`receive_list = allow`, the same fact rule 6 reads) → `status = 'quarantined'`,
  `quarantine_reason = 'account_unapproved'` ([E9](../edge-cases.md));
- an entry matches → the message continues to rule 5 (an unsolicited code from an approved service is
  still `otp_unsolicited`, [E5](../edge-cases.md)), and the `verifications` row, when one is inserted,
  records `account_id` = the matched entry ([E10](../edge-cases.md)).

**Unmatched codes** are held, never dropped: the message is stored, indexed for `quarantine:review`
holders, evented as `message.quarantined` with `quarantine_reason: "account_unapproved"` and its
`extracted_text` withheld, as for every quarantined message (FR-IN-5), and listed in the console's
quarantine page and the Overview's "Needs a person". A person reviews it: releasing it makes it `received`,
so the agent can read it (release follows FR-CON-6), or approving an entry lets the next code through. A
held code expires at the service anyway, and the message follows the tenant's normal retention. The
receive-allow exemption is the operator's tool for correspondents whose ordinary mail looks like a code
("Please confirm booking 12345"); it needs `suppressions:manage`, which identity keys cannot hold, so an
agent cannot exempt a service itself.

**`wait`.** With `accounts.require_approval: true`, `GET …/wait` with `kind=verification` first looks for an
approved entry of the identity whose `sender_domains` contains `from_domain`:

```sql
SELECT 1 FROM service_accounts, json_each(service_accounts.sender_domains_json) d
WHERE identity_id = ?1 AND status = 'approved' AND d.value = ?2 LIMIT 1;
```

None: `403 policy_denied` with `details.reason = "account_not_approved"` and `details.service_domain`,
before anything is registered ([E9](../edge-cases.md)). Then, at release
([Inbound › The wait handler](inbound.md#the-wait-handler-e4), step 4), the `verification` object is filled
only when the `verifications` row has an `account_id` and that entry is still `approved` (one D1 read by
ID when the match is found); a code whose entry was closed after the mail arrived is not released
([E13](../edge-cases.md)). With `accounts.require_approval: false`, `wait` behaves as before and ignores
the ledger.

**Races.** The ledger is read at consumer step 12, a few seconds before the mailbox commits. An approval
that lands in that window leaves the message held (fail closed); a closure that lands in it can let that
one message through, and `wait` still re-checks the entry before releasing its code.

## 6. Events

All four are platform events ([Webhooks › Platform events](webhooks.md#platform-events)), written to
`event_index` in the D1 batch of the change, with `tenant_id` and `identity_id` set and `sequence` `null`.
They reach the tenant's endpoints (an `identity_ids` filter applies), the tenant's partner's endpoints and
platform endpoints. `data.account` is the entry as the API returns it.

| Event | When | `data` |
|---|---|---|
| `account.requested` | An entry was created | `account` |
| `account.approved` | An operator approved it | `account` |
| `account.rejected` | An operator rejected it, or it expired after 7 days | `account`, `reason` (`operator` or `expired`) |
| `account.closed` | It was closed, or deleted while live | `account` |

## 7. Retention and erasure

| What | Rule | Where |
|---|---|---|
| Pending entries | Set `rejected` with reason `expired` 7 days after the request, by the global retention job (with an `account.rejected` event each), or at once by an approval that finds it expired | `service_accounts` step of [Privacy §5.3](privacy.md#53-global-retention-job) |
| `rejected` and `closed` entries | Deleted 90 days after `decided_at` or `closed_at` | The same step |
| `approved` entries | Kept while the identity exists | – |
| Identity scope erasure, and identity deletion | Every entry of the identity is deleted in step `scrub_control_plane` ([Privacy §6.5](privacy.md#65-identity-scope-fr-idn-4)) | `jobs/erasure.rs` |
| Tenant scope erasure | Every entry of the tenant is deleted in step `delete_d1_rows` ([Privacy §6.6](privacy.md#66-tenant-scope)) | `jobs/erasure.rs` |
| Counterparty erasure | Not affected: an entry describes the agent's own account, not a counterparty | – |

An entry holds the agent's own data: its address, a username at a service, and an agent-written purpose. It
holds no counterparty data and no mail content. The audit rows keep IDs and `service_domain` only, never
`account_identifier` or `purpose`.

## 8. Console

`/console/accounts` ([Console › Screens](console.md#screens)), for the active workspace:

- **View** (owner, admin, member): every entry, pending first, then by `created_at`, with the inbox
  address, `service_domain`, `sender_domains`, `account_identifier`, `purpose` (escaped text), status,
  requester key name and times; filters by status and inbox; a link to the quarantine list for the
  `account_unapproved` reason.
- **Approve** (owner, admin): a `POST` form with an optional note; a sensitive action, so it needs a sign-in
  within the last 10 minutes; audit `account.approve` with `actor_user_id`.
- **Reject**, **Close** and **Delete** (owner, admin): `POST` forms with the CSRF token; not sensitive,
  because none of them lets anything reach an agent.
- **Overview.** "Needs a person" ([Cloud sign-up §8](cloud-signup.md#8-the-overview-the-screen-people-land-on))
  lists service sign-ups waiting for approval: the count and the five oldest, from one D1 query
  (`WHERE tenant_id = ?1 AND status = 'pending_approval' ORDER BY created_at LIMIT 5`, and its count). The
  daily "needs a person" email reads the same count.

## 9. MCP and CLI

| Interface | What | Permission |
|---|---|---|
| MCP `mail_request_account` | `POST /v1/identities/{identity_id}/accounts` | `accounts:request` |
| MCP `mail_list_accounts` | `GET /v1/identities/{identity_id}/accounts` | `accounts:request` |
| CLI `pmail accounts request\|list\|get\|approve\|reject\|close\|delete` | The eight routes | As the route |

There is deliberately no MCP tool to approve: approval belongs to people and to the operator's own systems,
not to agents ([MCP › Tools](mcp.md#4-tools)).

## 10. Tests

| Test | Proves | Covers |
|---|---|---|
| `core::accounts::normalise_request` | `service_domain` and sender domains become A-label organisational domains (`Mail.GitHub.com` → `github.com`, `bücher.example` → its A-label); a public suffix (`co.uk`), an IP literal and a non-DNS name are refused; the platform, API and console hosts' organisational domains are refused with `own_deployment`; `sender_domains` gains `service_domain`, loses duplicates and holds at most 6; `account_identifier`, `purpose` and `note` bounds | §2, [E14](../edge-cases.md) |
| `core::accounts::e10_match_rules` | The match rule: org-domain match from a subdomain; no match for a look-alike, a domain that only ends with the service's, a verdict other than `pass`, another recipient address, a `pending_approval`, `rejected` or `closed` entry, or another identity's entry; the oldest of two matching entries is chosen; the receive-allow exemption | [E10](../edge-cases.md) |
| `it::accounts::e9_unapproved_code_held` | With `accounts.require_approval: true`, a verification mail from a service with no approved entry is stored `quarantined` with `account_unapproved` (also when a `wait` for its domain was active, and also with `quarantine.unsolicited_otp: false`), evented as `message.quarantined` without `extracted_text`, and invisible to keys without `quarantine:review`; `wait(kind=verification)` for that domain gets `403 policy_denied` with `reason = "account_not_approved"` and registers nothing; a sender on the receive-allow list is not held by rule 4a; with `require_approval: false` the ledger changes nothing | [E9](../edge-cases.md), [E5](../edge-cases.md) |
| `it::accounts::e10_matched_code_released` | After approval, the service's code mail to the entry's address, with `verdict: pass`, is `received` while a `wait` is active, its `verifications.account_id` is the entry, `verification.received` carries `account_id`, and `wait` releases the code; the same mail to another address of the identity is held | [E10](../edge-cases.md) |
| `it::accounts::e11_key_approval_rule` | With `PM_QUARANTINE_KEY_RELEASE=off` and no `quarantine.key_release`, a tenant key with `accounts:approve` gets `403 permission_denied` (`person_required`) on approve and can reject; with `quarantine.key_release: true`, the tenant's partner key and a tenant key approve; with `PM_QUARANTINE_KEY_RELEASE=on` any key with `accounts:approve` approves; an identity key cannot hold `accounts:approve` (`400 invalid_request`); a console owner approves after re-authentication | [E11](../edge-cases.md) |
| `it::accounts::e12_limits_and_expiry` | The 11th pending request of an identity, and the 201st entry, get `422 account_limit_reached`, also when two requests race for the last place; a second live entry with the same service and identifier gets `409 account_exists` with `details.account_id`; a pending entry 7 days old is set `rejected` (`expired`) by the global retention job with `account.rejected`, and an approval after that time gets `409 account_not_pending` | [E12](../edge-cases.md) |
| `it::accounts::e13_closed_entry_holds_codes` | After close, the service's next code is held as `account_unapproved`; a code that arrived before the close is not released by `wait` after it; closing twice answers `200` with no second event | [E13](../edge-cases.md) |
| `it::accounts::e14_own_deployment_refused` | A request naming the platform domain, the API host's or the console host's organisational domain, as `service_domain` or in `sender_domains`, gets `400 invalid_request` with `reason = "own_deployment"`; nothing is stored | [E14](../edge-cases.md) |
| `it::accounts::lifecycle_events_and_audit` | Request, approve, reject, close and delete each write their audit row (`account.request`, `.approve`, `.reject`, `.close`, `.delete`, with IDs and `service_domain`, never `account_identifier` or `purpose`) and event in the same batch; repeating the same decision answers `200` and writes nothing; the other decision gets `409 account_not_pending`; a suspended tenant gets `403 tenant_suspended` and a paused identity `409 identity_paused` on request; deleting a live entry emits `account.closed` | §2, §4, §6 |
| `it::accounts::scope_matrix` | An identity key reaches only its own identity's entries (another identity's ID or entry is `404`); `GET /v1/tenants/{tenant_id}/accounts` with an identity key is `403 scope_denied`; a key of another tenant, or another partner's key, gets `404 account_not_found` exactly as for a missing ID; the routes join `it::security::cross_tenant_matrix` | NFR-SEC-1 |
| `it::accounts::erasure_and_retention` | Identity-scope erasure and identity deletion delete the identity's entries, tenant-scope erasure the tenant's; the global retention job's `service_accounts` step deletes `rejected` and `closed` entries 90 days after their decision or closure and keeps `approved` ones | §7 |
| `it::console::accounts_page` | Owner, admin and member see the page, viewers get `403`; only owner and admin get the buttons; approve needs re-authentication; the Overview's "Needs a person" shows the pending count and the five oldest; `purpose` is escaped | §8 |
| `it::mcp::accounts_tools` | `mail_request_account` and `mail_list_accounts` are listed only for keys with `accounts:request`, map to their REST routes and return the same errors | §9 |
