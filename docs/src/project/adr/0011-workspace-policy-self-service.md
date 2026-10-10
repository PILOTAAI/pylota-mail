# 0011 Workspace policy self-service

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-10 |
| Deciders | The owner (TREFT LTD), decision of 2026-10-10 ("Owners can edit") |
| Related | FR-TEN-4, FR-KEY-4, FR-CON-6; [Workspace policy](../design/workspace-policy.md); [Configuration › Who may change a field](../../reference/configuration.md#who-may-change-a-field); [Security › Partner keys](../design/security.md#partner-keys) |

## Context

Tenant policy could be changed only with `PATCH /v1/tenants/{tenant_id}`, which needs `tenants:manage`, a
permission only platform and partner keys can hold. Tenant keys and the console could not change it. Yet
the PRD gives tenants choices that live in the policy: retention (FR-PRV-2), triage categories and rules
(FR-TRI-1, FR-TRI-2), booking-number patterns (FR-SRCH-4), signed links for large attachments
(FR-OUT-10) and image text extraction (FR-IN-8), and the guides told customers to "shorten retention". On
Pylota Mail Cloud every such change would have been a support request to the operator, who is one person.

The partner work had already split the fields into classes (platform-only, lower-only with platform
ceilings, free), so that a partner could not spend the shared sending reputation or AI budget.

## Decision

1. A tenant key holding the new permission `policy:write`, and a console owner or admin, **may** write the
   tenant's own policy through `PATCH /v1/tenants/{tenant_id}/policy` (and read the per-field limits through
   `GET …/policy`). `policy:write` **must** be refused on identity keys.
2. Such a **workspace writer** **may** set free fields and **may** lower lower-only fields, never above the
   workspace ceiling: the strictest of the deployment default, the platform ceiling and, for a partner's
   tenant, the partner ceiling (the value the partner's key last set). Platform-only fields and
   `quarantine.key_release` **must** stay out of its reach.
3. A new **guard** class (`send_allowlist_only`, `quarantine.on_auth_fail`, `quarantine.spam_threshold`,
   `quarantine.unsolicited_otp`): a key **may** only tighten these unless API keys may take decisions
   reserved for people on that tenant, the same rule as quarantine release (FR-CON-6); a person in the
   console may set any value.
4. Every policy write, by any writer, **must** be a compare-and-set on `tenants.policy_version`, write a
   `tenant.policy_update` audit row and a `tenant.policy_updated` event in the same D1 batch.
5. The new lower-only field `accounts.require_approval` treats `false` as the looser value.

## Consequences

- Cloud customers change retention, triage, search patterns and their own caps downwards without the
  operator. Partners keep control of their tenants through partner ceilings and receive
  `tenant.policy_updated`.
- A steered agent cannot weaken its own protections: identity keys cannot hold `policy:write`, and a
  tenant key cannot loosen a guard field where people must decide.
- One more column pair on `tenants` (`partner_ceilings_json`, `policy_version`) and one more permission.
- A partner cannot fix a guard field against the people it makes owners or admins of its tenants; it
  controls that by whom it gives those roles and keys.

## Alternatives considered

- **Open `PATCH /v1/tenants/{tenant_id}` to tenant keys for `policy` only.** The router checks
  permissions before it reads a body, and a permission that depends on the fields sent breaks that rule.
  Not chosen.
- **Owner-only.** Admins already hold every other tenant-level permission, including erasure; the controls
  that matter (ceilings, re-authentication, audit, confirmation of deleting changes) bind both. Not chosen.
- **Make every field writable within ceilings, with no guard class.** It would let an agent's tenant key
  turn quarantine off on a deployment where only people may release quarantined mail. Not chosen.
