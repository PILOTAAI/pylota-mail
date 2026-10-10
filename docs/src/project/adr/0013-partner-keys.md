# 0013 Partner keys as a fourth key level

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-10 |
| Deciders | The owner (TREFT LTD) |
| Related | FR-KEY-1, FR-KEY-4, FR-BILL-1; [Security › Creating keys](../design/security.md#46-creating-keys-fr-key-1) and [Partner keys](../design/security.md#partner-keys); [REST API › Partners](../../reference/api.md#partners); edge rows J10–J18 |

## Context

Pylota Mail Cloud is public: anyone can sign up for a workspace. Pylota itself is one integrator on that
same deployment. It provisions a tenant and identities for each car-rental operator it serves, through
the API, without a person in the console.

With three key levels (`platform`, `tenant`, `identity`), an integrator that creates tenants needs a
platform key. A platform key reaches every tenant on the deployment, including every public workspace,
and can change billing modes, lift suspensions and read deployment-wide routes. Giving one to an
integrator would let a bug or a leaked secret in the integrator's systems read and send mail for every
customer of the deployment.

The other option, one tenant key per customer minted by a person, does not work for an integrator that
creates customers automatically.

Adding a key level changes a public contract (the `level` values of `POST /v1/keys` and the tenant
reach of every route), so it needs an ADR ([Decision records](index.md#when-to-write-one)).

## Decision

1. API keys **must** have one of four levels, from widest to narrowest: `platform`, `partner`, `tenant`
   and `identity` (FR-KEY-1). A key **must never** create a key wider than itself.
2. A **partner** is a row in `partners`, created, suspended and deleted only by platform keys with
   `partners:manage`. Only a platform key mints, rotates or revokes a partner key.
3. A partner key **must** reach only the tenants whose `partner_id` equals its own, and everything in
   them. Any other tenant, including one no partner created, **must** answer it as a missing one does.
   A `NULL` `partner_id` **must** match nothing.
4. A partner key **must never** mint a partner or platform key, hold `platform:ops`, `partners:manage` or
   `identities:sign`, change a tenant's billing mode (it comes from the partner's
   `default_billing_mode`), raise a limit above the deployment's or the platform's value, lift a
   platform suspension or resume an abuse pause.
5. A partner **must** be bounded by `max_tenants` and a tenant-creation rate (`RL_PARTNER`). Its tenants
   are ramped like new Free workspaces unless a platform key sets the partner's `ramp_exempt`.
6. A suspended partner **must** be contained (its keys and its tenants' API keys refused, deliveries
   held, inbound mail still stored), and a partner row is soft-deleted only when it has no tenant that
   is not erased.

## Consequences

- An integrator runs its customers on the public deployment with a key that cannot reach anyone else's
  workspace. A leaked partner key exposes that partner's customers only.
- Every owner check compares a tenant's `partner_id` with the key's. The cross-tenant suite gains a
  `foreign_partner` column, and `it::partners::j10_foreign_partner_not_found` covers the unpartnered case.
- Webhook endpoints gain a `partner` scope, which receives only that partner's tenants' events.
- The operator has one more kind of customer to support: partners are created by hand with a platform
  key, and their limits are set per partner.

## Alternatives considered

- **Give the integrator a platform key.** Simple, and it works today. It hands one integrator every
  tenant on a public deployment. Not chosen.
- **A separate deployment per integrator.** Full isolation, but each one needs its own Cloudflare
  resources, platform domain and operation, which a solo operator cannot run for each integrator. Not
  chosen for v1.0; a large integrator can still self-host.
- **Tenant keys minted by a person for each customer.** No new level, but every new customer waits for
  a person in the console. Not chosen.
