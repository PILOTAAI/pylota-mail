# 0003 Addressing with catch-all and a directory

| | |
|---|---|
| Status | Superseded in part by [0008](0008-domains-on-any-dns-host.md) (decision 4 and the consequence on tenant domain kinds) |
| Date | 2026-10-09 |
| Deciders | Pylota engineering |
| Related | FR-DOM-1, FR-DOM-2, FR-ADR-1…7, FR-IN-2, FR-OUT-6; [Identities and domains](../design/identity-domains.md); [Threading](../design/threading.md) |

## Context

Every tenant needs addresses on a shared platform domain from the first minute, and on their own domains
later. Addresses change over time (promote, retire, roll back) and must never be reassigned after
deletion. Inbound mail must be routed to exactly one identity, and unknown addresses must be refused.

Cloudflare Email Routing facts (developers.cloudflare.com, pages dated August–September 2026, read
2026-10-09): catch-all rules exist only on a zone apex; each domain allows 200 routing rules; a zone
allows 30 mail domains; sub-addressing (RFC 5233) is supported, and a sub-addressed recipient falls back
to the base rule; inbound messages are limited to 25 MiB.

The Cloudflare Agents SDK offers email resolvers. Its address-based resolver
(`createAddressBasedEmailResolver`, read in the SDK source on 2026-10-09) matches
`local[+sub]@domain` and routes by the local part or sub-address alone; the domain is matched but not
used, so `bookings@a.example` and `bookings@b.example` reach the same agent.

## Decision

1. **The platform domain must be a zone apex** with a catch-all rule that sends every message to the
   Worker. `pmail setup` refuses a non-apex platform domain.
2. **A D1 directory decides.** `email()` normalises the envelope recipient, strips the `+tag`, and looks
   the address up in `addresses` (cached 60 s for hits, 5 s for misses). Unknown and erased addresses get
   `550 5.1.1` (indistinguishable), retired ones `550 5.1.6`, suspended tenants a temporary failure for up to 5
   days, then `550 5.2.1`.
3. **Platform addresses** are `{username}{tenant.address_suffix}@{platform}`, for example
   `bookings.acme@agents.example`. The suffix is `.` + the tenant slug; only the default tenant may have
   an empty suffix. Username plus suffix is at most 40 characters, leaving room for a thread token in a
   64-character local part.
4. **Tenant domains.** Kind `zone` (same Cloudflare account): an apex uses a catch-all; a subdomain uses
   one literal routing rule per address (at most 200), and an address stays `pending` until its rule
   exists. Kind `external` (DNS elsewhere): the tenant's mail system forwards to the identity's platform
   alias; outbound uses the optional SES transport. *Superseded by [0008](0008-domains-on-any-dns-host.md):
   the kind now follows from one of six connection methods, and `external` also covers SES inbound
   (`dns_records`) and the customer's own SMTP relay (`smtp_relay`).*
5. **Sub-addresses carry thread tokens only.** The `Reply-To` of every outbound message is
   `local+t<kid><seq>.<mac>@domain`; a tag never selects an identity.
6. **Addresses are global and permanent.** A retired address keeps its row; a deleted or erased address
   becomes a keyed-hash tombstone and can never be assigned to another identity.

## Consequences

- Creating an address on an apex domain is a D1 insert: instant, no Cloudflare API call, no rule limit.
- The Worker receives mail for every address on catch-all domains, including spam to random local parts;
  the directory lookup and reject happen before any R2 write, and the reject-spike alert watches them.
- Subdomain mail domains are capped at 200 addresses each by the rule limit; apex domains are not.
- Each tenant domain kind has its own onboarding, health checks and failure modes
  ([Identities and domains](../design/identity-domains.md)). *Superseded by
  [0008](0008-domains-on-any-dns-host.md): onboarding and health checks follow the connection method.*
- Tenants share the platform domain's sending reputation; per-identity caps, abuse auto-pause, a DMARC
  ramp and custom domains mitigate that (PRD risks).
- Role names (RFC 2142) and confusables are reserved, and SMTPUTF8 local parts are refused, because
  Email Routing cannot route them (FR-ADR-6, FR-ADR-7).

## Alternatives considered

- **A delegated subdomain zone per tenant** (`acme.agents.example` as its own zone with a catch-all).
  Clean separation and per-tenant reputation. Rejected for v1.0: each tenant would need its own zone
  (subdomain zones are an Enterprise feature), setup would create zones at tenant creation, and the
  30-domains-per-zone limit would still apply. Kept as P2 ("Delegated subdomains").
- **Literal routing rules for every address on the platform domain.** No catch-all needed. Rejected:
  200 rules per domain caps the whole deployment at 200 addresses, and every address change becomes a
  Cloudflare API call that can fail.
- **Agents SDK email resolvers.** Ready-made routing to agents. Rejected: TypeScript only, and the
  address-based resolver ignores the domain, which breaks multi-domain identities and tenant isolation.
- **Plus-addressing per tenant** (`bookings+acme@agents.example`). No per-tenant suffix in the local part.
  Rejected: the sub-address is needed for thread tokens, many senders and forms strip or reject `+`
  tags, and Email Routing falls back to the base rule, so the tenant would be lost silently.
