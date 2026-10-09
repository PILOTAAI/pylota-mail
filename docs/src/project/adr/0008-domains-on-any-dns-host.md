# 0008 Domains on any DNS host

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-09 |
| Deciders | Pylota engineering, owner direction of 2026-10-09 |
| Related | FR-DOM-7 to FR-DOM-12, U4; [Domains on any DNS host](../design/domain-connections.md); [Identities, addresses and domains](../design/identity-domains.md); spikes S10, S11, S12 |

## Context

Until now a tenant domain had to be a zone on Cloudflare DNS in the deployment's account (`zone`), or use
forwarding plus SES sending (`external`). Cloudflare Email Routing and Email Sending both require
Cloudflare DNS ("You must be using Cloudflare DNS to use Email Service", read 2026-10-09). Most operators
keep their DNS elsewhere, and often already run mail on their main domain. The owner asked that domains
hosted anywhere be usable, so that the product serves more customers.

The research of 2026-10-09 found:
- Cloudflare's partial (CNAME) setup is Business or Enterprise only, is not authoritative, and is not
  documented for Email Service.
- Subdomain delegation to a child zone is Enterprise only. Whether Email Service works on a child zone is
  undocumented.
- Cloudflare for SaaS has no email support.
- Amazon SES receives mail for any verified domain in 22 regions. It stores up to 40 MB per message in S3
  and signs its notifications through SNS. It sends with DKIM aligned to the customer domain and
  supports a custom MAIL FROM.
- Workers can open outbound TCP sockets with STARTTLS on any port except 25.
- Running our own MX gateway would need servers and IP reputation, and outbound port 25 is blocked by
  default on the major clouds.

## Decision

1. Separate a domain's **inbound source** (`routing`, `ses`, `forward`) from its **outbound transport**
   (`cloudflare`, `ses`, `smtp`). Users pick one of six **connection methods**, which fix both:
   `cloudflare_zone`, `nameservers`, `dns_records`, `send_only`, `smtp_relay` and `delegated_subdomain`.
2. **`dns_records` (SES in both directions) is the any-DNS-host default.** The customer publishes one MX,
   three DKIM CNAMEs, a MAIL FROM MX and TXT, and an ownership TXT at any DNS host. It works on an apex or a
   subdomain and has no per-domain address limit.
3. SES inbound uses **S3 as the store and SNS as the doorbell**, with two subscriptions: HTTPS push for
   speed and SQS as a 14-day backstop. A D1 ledger makes ingestion exactly once per object and recipient.
4. On SES domains, unknown recipients are **dropped without a bounce** (no backscatter). Retired addresses
   are bounced with `5.1.6` by receipt rules that the Worker maintains.
5. **`smtp_relay`** sends through the customer's own provider from a Worker socket. It may send only after
   an **alignment probe** proves DMARC passes for the domain, and again every day. A failed probe moves
   the domain to `failing`, and sends fall back to the platform address, so U4 holds for a relay we do
   not control.
6. **`nameservers`** opens zone creation to tenants by policy, for dedicated mail domains. It refuses a
   domain that already serves a website or mail unless the user confirms.
7. **`delegated_subdomain`** ships behind `PM_CF_SUBDOMAIN_SETUP=on`, for Enterprise accounts, once spike
   S10 passes.
8. Mailgun and SendGrid inbound webhooks are designed as later `InboundSource` implementations (v1.1).
   Postmark and CloudMailin are not supported, because their raw-MIME webhooks are not signed.

## Consequences

- Any operator can connect a domain without moving DNS, and can keep their existing mailbox
  (`send_only`, `smtp_relay`).
- Amazon Web Services becomes an optional dependency and, where used, a sub-processor. EU deployments must
  pick an EU SES region.
- SES domains behave differently from routing domains for unknown and retired recipients. The custom
  domains guide documents the difference.
- Three spikes gate three methods: S10 for `delegated_subdomain`, S11 for `dns_records`, S12 for
  `smtp_relay` (whose `inbound: ses` option also needs S11). `cloudflare_zone`, `nameservers` and `send_only` do not depend on them.
- New surface to secure: the SNS endpoint (signature version 2 only, one topic), sealed SMTP credentials,
  an SES IAM user limited to one policy, and the S3 bucket policy bound to the receipt rule.
- Cost per message falls for SES domains ($0.10 per 1,000 sent against $0.35 on Email Sending).

## Alternatives rejected

| Alternative | Reason |
|---|---|
| Require Cloudflare DNS (status quo) | Excludes most operators |
| Partial (CNAME) zones | Plan-gated, not authoritative, undocumented for Email Service |
| Own MX gateway (Postfix, Stalwart) | Servers, reputation, port 25 blocks, licence; breaks "nothing to keep running" |
| Unsigned inbound webhooks (Postmark, CloudMailin) | Mail that agents act on must arrive authenticated |
