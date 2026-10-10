# 0014 Marketing mail only through SES or SMTP

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-10 |
| Deciders | The owner (TREFT LTD) |
| Related | FR-OUT-8, FR-DOM-10, FR-DOM-11; [Outbound › Policy pipeline](../design/outbound.md#policy-pipeline) step 15; [Domains on any DNS host](../design/domain-connections.md); edge row G9; [ADR 0008](0008-domains-on-any-dns-host.md) |

## Context

Every message has a `kind`: `transactional`, `marketing` or `auto_reply` (G9). Marketing mail already
needs consent and RFC 8058 one-click unsubscribe (FR-OUT-8).

The default transport is Cloudflare Email Service. Its FAQ says the service "is intended only for
transactional emails", with marketing support planned later (Cloudflare Email Service FAQ, read
2026-10-10). The platform domain always sends through it, and on Pylota Mail Cloud the account, its
sending reputation and its daily quota are shared with Pylota's own mail. Marketing mail sent through
it would break the provider's terms and could cost every tenant, and Pylota, its ability to send.

Amazon SES and a customer's own SMTP provider (`smtp_relay`) accept marketing mail under their own
terms. Refusing some sends of a documented kind changes a public contract, so it needs an ADR
([Decision records](index.md#when-to-write-one)).

## Decision

1. A `kind: marketing` send **must** be refused unless the domain of its From address uses the `ses` or
   `smtp` transport: `422 transport_unavailable` with `details.reason = "marketing_needs_ses"`, checked
   at policy step 15 once the From address is resolved.
2. The platform domain and every `cloudflare`-transport domain **must** fail this check, whatever the
   plan or key level.
3. A marketing message accepted before its domain moved to `cloudflare`, or that would fall back to the
   platform domain, **must** end `rejected` with the reason `marketing_needs_ses` at transport time,
   before any transport call. It is never sent through Cloudflare Email Service.
4. Notification emails from the system identity stay `transactional`; they carry one-click unsubscribe
   without being marketing mail.

## Consequences

- A tenant that sends marketing mail must connect Amazon SES or its own SMTP provider first. Those
  domain methods depend on spikes S8, S11 and S12; if they all fail, marketing mail is not available in
  v1.0.
- Free workspaces on the platform domain cannot send marketing mail at all. This also keeps the shared
  domain's reputation for sign-in and transactional mail.
- When Cloudflare supports marketing mail, a new ADR can lift the refusal for `cloudflare`-transport
  domains; the platform domain should stay transactional.

## Alternatives considered

- **Accept marketing mail on every transport.** Simplest for tenants, but it uses a provider for mail
  its terms exclude, on an account shared with Pylota. Not chosen.
- **Remove the `marketing` kind.** Tenants would then send promotional mail as `transactional`, without
  the consent and unsubscribe checks. Not chosen.
