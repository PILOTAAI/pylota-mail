# 0010 Cloud runs in the operator's existing Cloudflare account with scoped tokens

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-10 |
| Deciders | Owner decision of 2026-10-10 ("shared, tightened"; D10 reaffirmed) |
| Related | FR-DOM-2, FR-DOM-7, FR-DOM-12, FR-DOM-13; [Identities and domains › Cloudflare API token permissions](../design/identity-domains.md#cloudflare-api-token-permissions); [Deploy › Create a Cloudflare API token](../../self-hosting.md#2-create-a-cloudflare-api-token); [ADR 0008](0008-domains-on-any-dns-host.md); edge cases H8, H10, H11 |

## Context

Pylota Mail Cloud (`pylotamail.com`) is run by one person, who also runs Pylota. Pylota's Cloudflare
account already holds `pylota.io`, its website, its own mail and its Workers. The question was whether
Cloud production gets a Cloudflare account of its own, or runs in that existing account.

A review on 2026-10-10 found that the documented tokens were too broad for a shared account:

- the Worker's token (`PM_CF_API_TOKEN`) had Zone, DNS and Email Routing edit on **All zones**, so a bug
  or a stolen token could change every zone in the account, `pylota.io` included;
- the deploy and site tokens used *Workers Scripts · Edit*, which is *Editor at the Workers product scope*:
  it can change every Worker in the account (Cloudflare
  [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/), read
  2026-10-10);
- onboarding read existing objects by name and reused them, so a `nameservers` add of an operator zone's
  name could take that zone over ([H10](../edge-cases.md)), and removal used the zone-wide Email Routing
  disable for a single name ([H11](../edge-cases.md)).

Facts the decision rests on, read 2026-10-10:

- API tokens can be limited to single zones ("a single zone", in the token's zone resources,
  [Create a token via the API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)).
- Workers roles can be granted per Worker. A per-Worker role cannot be granted for a Worker that does not
  exist yet: creating one needs *Admin* at the Workers product scope. Custom Domains do not support
  per-Worker roles yet; adding one needs *Workers Routes Write* on each affected zone, and later deploys
  that leave it unchanged need only *Editor* (same page).
- Creating a zone needs a token that can reach a zone that does not exist yet; Cloudflare does not state
  whether a zone-scoped grant can do it, so the `nameservers` and `delegated_subdomain` methods need All
  zones.
- Cloudflare's Email Sending daily quota is per account (owner decision of 2026-10-10).

## Decision

1. Cloud production **must** run in Pylota's existing Cloudflare account. Staging and the spikes run in a
   separate Cloudflare account, and in a separate AWS account for SES
   ([Build plan › Human prerequisites](../build-plan.md#human-prerequisites)).
2. On Cloud, `domains.allow_create_zone` **must** stay `false`, and no key uses `nameservers` or
   `delegated_subdomain`: the Worker token cannot create zones, and a refused create answers
   `422 transport_unavailable` (`zone_creation_not_allowed`).
3. The Worker token (`PM_CF_API_TOKEN`) **must** list only the zones Cloud needs: `pylotamail.com`, and
   `pylota.io` for Pylota's `notify.` and `reminders.` subdomains (listed in Pylota's tenant policy
   `domains.cloudflare_zones`, which grants names strictly under the zone, never its apex). A zone is added
   to the token before it is listed in any tenant's policy.
4. Every deploy token **must** use per-Worker roles: *Editor* on the one Worker it deploys (`pylota-mail`,
   or `pylota-mail-site` for the site), *Admin* on that Worker only for `destroy`. Creating a Worker and
   attaching its Custom Domains is a one-time step with a short-lived token holding *Admin* at the Workers
   product scope and *Workers Routes · Edit* on the hosts' zones, deleted afterwards. No token holds
   *Workers Scripts · Edit*.
5. Onboarding **must never** adopt, change or delete a provider object that the deployment did not create
   for that tenant's domain, and removal and cleanup act only on the provider IDs recorded for the domain
   (FR-DOM-13).
6. Self-hosted deployments get the same guidance: specific zones and per-Worker roles by default; All zones
   only for a deployment that offers `nameservers` or `delegated_subdomain`, which should then have a
   Cloudflare account of its own.

## Consequences

- Cloud needs no second Cloudflare account, billing relationship or DNS move for `pylotamail.com`.
- Cloud cannot offer `nameservers`. Customers with a new mail-only domain use `dns_records` (SES) instead.
- **Residual risk.** A Worker bug or a stolen `PM_CF_API_TOKEN` can still change DNS and mail settings in
  `pylotamail.com` and `pylota.io`, and the token's account-wide *Queues · Edit* and *Email Sending · Edit*
  reach Pylota's queues and sending settings in the same account. The design limits what its own code does
  there: the zone-permission checks (H8), a listed zone's apex staying platform-only, and the
  provider-ID rule (H10, H11). Detection is the domain health checks and `pmail doctor`.
- **Shared quota.** Cloud and Pylota share the account's daily Email Sending quota. `PM_DAILY_SEND_QUOTA`
  and the `provider_quota` alerts watch it ([G3](../edge-cases.md)); Pylota's own sends count against the
  same figure.
- The first `pmail setup`, and any later change of the API or console host, needs the short-lived
  product-scope token; every other command runs with per-Worker roles.
- Adding a zone for a new Cloud customer subdomain needs a token change first, an owner step.

## Alternatives considered

- **A dedicated Cloudflare account for Cloud.** Clean separation and room for `nameservers`. Not taken now:
  a second account to run, bill and secure for one person, with no tenant asking for `nameservers` yet.
  It stays the path if Cloud ever offers zone creation.
- **The shared account with the old broad tokens.** No setup work, but one bug or leaked token could break
  Pylota's own domain and Workers. Rejected.
- **Per-zone tokens issued by the Worker at runtime.** The Worker would need permission to create tokens,
  which is broader than anything it saves. Rejected.
