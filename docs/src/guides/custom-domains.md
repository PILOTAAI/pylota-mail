# Custom domains

Every identity starts on the platform domain, for example `bookings.brightwell@agents.example`. A tenant
can move its identities to its own domain, such as `bookings@brightwell.example` or
`bookings@agents.brightwell.example`, so its mail carries its own brand and builds its own sending
reputation. History and threads move with the identity, and a domain change can be rolled back.

Your domain does not have to be on Cloudflare. It can stay with your registrar, Google, Microsoft,
Route 53 or a web host, and keep the mailboxes it already has. Only the deployment's platform domain
must be on Cloudflare.

This guide helps you choose how to connect your domain, add it, move identities onto it, keep it
healthy and fix it when something breaks.

## Choose how to connect your domain

You pick a **connection method** when you add the domain. It decides what you change at your DNS host
and how mail reaches and leaves your agents.

| Your situation | Method | What you change |
|---|---|---|
| The domain is already on Cloudflare, in the same account as the deployment | `cloudflare_zone` | Nothing: Pylota Mail writes the records |
| You have a new domain just for agents, such as `brightwell-agents.example` | `nameservers` | Two NS records at your registrar |
| You want agents on a subdomain of your main domain, such as `agents.brightwell.example`. The main domain stays at its DNS host and keeps its mail | `dns_records` | One MX, three DKIM CNAMEs, two MAIL FROM records and an ownership TXT, at your DNS host |
| You want agents to answer as your existing addresses (`bookings@brightwell.example`), and Google Workspace or Microsoft 365 stays your mail system | `send_only` (your mailbox forwards to the agent), or `smtp_relay` (the agent sends through your provider) | `send_only`: three DKIM CNAMEs, two MAIL FROM records and an ownership TXT, plus a forwarding rule per address. `smtp_relay`: an ownership TXT, plus SMTP credentials |
| Your deployment runs on a Cloudflare Enterprise account and you want the simplest set-up for a subdomain | `delegated_subdomain` | NS records for the subdomain, at your DNS host |
| You are trying things out | Stay on the platform domain | Nothing |

How the methods compare:

| Method | Mail to your agents arrives through | Mail from your agents is sent by | Addresses on the domain |
|---|---|---|---|
| `cloudflare_zone` | Cloudflare Email Routing | Cloudflare Email Sending | Any on an apex; at most 200 on a subdomain |
| `nameservers` | Cloudflare Email Routing | Cloudflare Email Sending | Any |
| `dns_records` | Amazon SES | Amazon SES | Any |
| `send_only` | Your mailbox, which forwards each message | Amazon SES | Any; each needs a forwarding rule |
| `smtp_relay` | Your mailbox (forwarding), or Amazon SES | Your own provider, over SMTP | Any |
| `delegated_subdomain` | Cloudflare Email Routing | Cloudflare Email Sending | Any |

Not every deployment offers every method. The methods that use Amazon SES need the operator to have
connected SES ([Deploy to Cloudflare › Connect Amazon SES](../self-hosting.md#connect-amazon-ses-optional)).
`delegated_subdomain` needs a Cloudflare Enterprise account and the operator's opt-in, and a tenant key
may use `nameservers` only when the operator allows it. When a method is not available, adding a domain
with it fails with `422 transport_unavailable`, and `details.reason` says why. In v1.0, `dns_records`,
`smtp_relay` and `delegated_subdomain` depend on build-time spikes (S11, S12 and S10).

A Cloudflare zone can have at most 30 mail domains (routing and sending together, including the apex).

## Before you start

- You need a key with `domains:write` (tenant, partner or platform) to add a domain, and `identities:write` to add
  and promote addresses.
- `cloudflare_zone`, `nameservers` and `delegated_subdomain` work through the Cloudflare API, so the
  deployment needs `PM_CF_API_TOKEN`, with the permissions in
  [Deploy to Cloudflare › Create a Cloudflare API token](../self-hosting.md#2-create-a-cloudflare-api-token).
  Without it, the request fails with `422 cf_token_required`. The one exception: an operator can add a
  `cloudflare_zone` **apex** with `pmail domains add --local-token`, which then uses their local
  `CLOUDFLARE_API_TOKEN` ([CLI › Commands that use your Cloudflare token](../reference/cli.md#commands-that-use-your-cloudflare-token)).
  Subdomains, `nameservers` and `delegated_subdomain` always need the token on the deployment.
  `dns_records`, `send_only` and `smtp_relay` need no Cloudflare token.
- With a tenant or partner key, `cloudflare_zone` (and `replace_mx` with it) works only on a zone that
  this deployment created for your workspace with `nameservers` or `delegated_subdomain`, or one the
  operator assigned to it (tenant policy `domains.cloudflare_zones`, which only a platform key sets).
  Another workspace's zone and the zone of the deployment's own hosts are refused with
  `403 scope_denied` and `details.reason: "zone_not_allowed"`, for `nameservers` and
  `delegated_subdomain` too ([Identities and domains › Zone permission](../project/design/identity-domains.md#zone-permission)).
- The records you publish are always read from the provider when you ask for them. Never copy records
  from this page or anywhere else ([FR-DOM-3](../project/prd.md#63-domains)).

### `name` and `host`: which one your DNS host wants

Every record has two forms of its name:

| Field | Example | Use it when |
|---|---|---|
| `name` | `pm-bounce.agents.brightwell.example` | Your DNS host asks for the full name |
| `host` | `pm-bounce.agents` | Your DNS host adds `brightwell.example` itself, as many do |

If you paste the full `name` into a form that adds your domain, the record ends up at
`pm-bounce.agents.brightwell.example.brightwell.example`. The health check notices this and reports
`record_doubled_name` with a fix that tells you to enter the `host` value only.

## Add a domain

Every method follows the same four steps: add, publish, verify, move identities.

1. **Add the domain.**

   ```bash
   pmail domains add agents.brightwell.example --method dns_records --tenant brightwell
   ```

   or with the API:

   ```bash
   curl -X POST https://mail.example.com/v1/tenants/ten_01J9…/domains \
     -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Content-Type: application/json" \
     -d '{"name":"agents.brightwell.example","method":"dns_records"}'
   ```

   The domain is created in state `pending`. The sections below list what each method checks and what
   it asks you to publish.

2. **Publish the records**, if the method needs any:

   ```bash
   pmail domains records dom_01JA…
   ```

   ```json
   {
     "data": [
       { "type": "TXT", "name": "_pylota-mail.agents.brightwell.example", "host": "_pylota-mail.agents",
         "value": "pm-verify=8f2k…", "purpose": "ownership", "required": true, "status": "ok",
         "observed": ["pm-verify=8f2k…"] },
       { "type": "MX", "name": "agents.brightwell.example", "host": "agents",
         "value": "inbound-smtp.eu-west-2.amazonaws.com", "priority": 10, "purpose": "mx",
         "required": true, "status": "missing", "observed": [] }
     ],
     "checked_at": "2026-10-09T10:05:00Z"
   }
   ```

   Each record's `status` is `ok`, `missing`, `mismatch` or `unexpected`. Add any that are `missing`,
   correct any that are `mismatch`, and remove `unexpected` ones, which conflict (a second SPF record,
   for example).

3. **Verify.**

   ```bash
   pmail domains verify dom_01JA…
   ```

   This runs a check now (at most once a minute per domain). Checks use two independent DNS resolvers,
   and the state changes after two consecutive agreeing results, so it can take a few minutes. DNS
   changes can also take time to reach the resolvers. When verification passes and the domain becomes
   `healthy`, a `domain.verified` event is sent. If it passes with a warning, it becomes `degraded`
   (`domain.degraded`), and `domain.recovered` follows once the warning is fixed.

4. **Move identities onto it.** See [Move an identity to the new domain](#move-an-identity-to-the-new-domain).

## A domain already on Cloudflare: `cloudflare_zone`

```bash
pmail domains add brightwell.example --method cloudflare_zone --tenant brightwell
```

Pylota Mail writes the mail records into the zone itself, so there is usually nothing to publish.

- **On an apex** (`brightwell.example`), every address reaches the Worker through one catch-all rule, and
  there is no limit on addresses. If the apex already has MX records, the request is refused with
  `409 existing_mx`, because enabling routing would stop that mail. If you really mean to move the
  domain's mail to Pylota Mail, repeat the request with `"replace_mx": true` (`--replace-mx`)
  ([H5](../project/edge-cases.md)).
- **On a subdomain** (`mail.brightwell.example`), the apex's own MX records and mailboxes are not touched.
  Each address needs its own routing rule, so a subdomain holds at most 200 addresses
  ([Limits](../reference/limits.md#domains-and-addresses)). A new address stays `pending` until its rule
  exists. If creating the rule fails, the address stays `pending` with reason `routing_rule_failed` and
  is retried with backoff. It is never marked active without its rule ([H6](../project/edge-cases.md)).

## A new domain just for mail: `nameservers`

```bash
pmail domains add brightwell-agents.example --method nameservers --tenant brightwell
```

Pylota Mail creates a Cloudflare zone for the domain, and you point the domain's nameservers at it.
**This hands the whole domain to the deployment**, which manages only mail records. Use it for a domain
that has no website and no other mail.

- Before creating the zone, Pylota Mail looks for a website (an A or AAAA record at the name, or a CNAME,
  A or AAAA record at `www`) and for mail (MX records). If it finds any, the request is refused with
  `409 domain_not_dedicated`, and `details.records` lists what it found. Moving the nameservers would
  stop that website or mail. If you are sure, repeat the request with `"confirm_dedicated": true`
  (`--confirm-dedicated`).
- The records returned are two `NS` records. Set them **at your registrar** (where you bought the
  domain), not at a DNS host. Reminders (`domain.reminder`) are sent after 24 hours, 72 hours and 7 days.
- Cloudflare deletes a zone that is not activated within 28 days. A final reminder is sent at day 21.
  If the zone is deleted, the domain becomes `removed` with reason `zone_expired`, and you can add it
  again.
- A tenant key may use this method only if the operator allows it (tenant policy
  `domains.allow_create_zone`); otherwise the request fails with `422 transport_unavailable`. Pylota Mail
  Cloud allows it.
- If Cloudflare limits how many domains the account can add, the request fails with
  `429 upstream_rate_limited`; try again after the time in `Retry-After` (3 hours).

Once the zone is active, the domain works like a `cloudflare_zone` apex: every address works.

## A subdomain at any DNS host: `dns_records`

```bash
pmail domains add agents.brightwell.example --method dns_records --tenant brightwell
```

Mail to and from the subdomain goes through Amazon SES. Your main domain, its website and its mailboxes
stay where they are. Every address on the subdomain works as soon as the domain is healthy; you do not
change DNS when you add an agent.

Publish these records at your DNS host (the values come from `pmail domains records`):

| Record | Purpose |
|---|---|
| TXT `_pylota-mail.agents.brightwell.example` | Proves you control the domain |
| MX `agents.brightwell.example`, priority 10 | Sends mail for the subdomain to Amazon SES |
| Three CNAMEs at `…._domainkey.agents.brightwell.example` | DKIM signing keys |
| MX and TXT at `pm-bounce.agents.brightwell.example` | The MAIL FROM (bounce) domain, so SPF aligns |
| TXT `_dmarc.agents.brightwell.example` (suggested) | Only suggested when no DMARC record exists for the domain yet |

Use a name that receives no mail today. If it already has MX records, the request is refused with
`409 existing_mx`. Pylota Mail cannot change your DNS, so `"replace_mx": true` (`--replace-mx`) here
means "I will replace these". Until the old MX records are gone, the domain is `degraded` with
`mx_unexpected`, because mail is split between two systems.

The local part prefix `pm-bounce` is reserved on these domains. See also
[How SES domains differ](#how-ses-domains-differ).

## Keep your mailbox, forward to the agent: `send_only`

```bash
pmail domains add brightwell.example --method send_only --tenant brightwell
```

Your agents answer as your existing addresses, such as `bookings@brightwell.example`, while your current
mail system (Google Workspace, Microsoft 365 or any other) keeps receiving the mail. Pylota Mail sends
through Amazon SES, signed for your domain.

1. **Publish the records**: the ownership TXT, three DKIM CNAMEs, and the MX and TXT at
   `pm-bounce.brightwell.example`. Your existing MX records stay as they are.
2. **Add a forwarding rule in your mail system** for each agent address, to that identity's platform
   address, for example `bookings@brightwell.example` → `bookings.brightwell@agents.example`. The domain
   response shows the platform address for each address. Use a rule that forwards each message
   unchanged.
3. **Test the forwarding** once the address exists on the identity:

   ```bash
   pmail addresses test-forwarding bookings@brightwell.example
   ```

   or `POST /v1/identities/{identity_id}/addresses/{address_id}/test-forwarding`. Pylota Mail sends a
   short message, from `mailer-daemon@agents.example` with the subject "Pylota Mail forwarding check",
   to `bookings@brightwell.example`. If it comes back through your forwarding rule within 10 minutes,
   the address's `forwarding` becomes `ok`; otherwise `failed`. The test is not stored as a message and
   does not count as a send. Until a test or a real forwarded message arrives, `forwarding` is
   `unverified`.

**The main drawback: forwarders that change the message.** Forwarding breaks SPF for the original
sender, so Pylota Mail decides trust from the sender's DKIM signature and from ARC. A forwarder that
rewrites the body (adds a footer, a disclaimer or a banner) breaks that signature. Such messages fail
authentication and are quarantined by default (`quarantine_reason: auth_failed`), so the agent does not see them until a person
releases them ([Receiving › Quarantine](receiving.md#quarantine)). Prefer a mail system that forwards
messages unchanged and adds ARC.

An agent replying to its own external address, which forwards back to the platform address, is caught
by loop detection.

## Keep your mailbox, send through your provider: `smtp_relay`

```bash
pmail domains add brightwell.example --method smtp_relay --tenant brightwell --inbound forward \
  --smtp-host smtp.provider.example --smtp-port 587 --smtp-username agents@brightwell.example \
  --smtp-password-stdin --probe-from agents@brightwell.example
```

or with the API:

```json
{ "name": "brightwell.example", "method": "smtp_relay", "inbound": "forward",
  "smtp": { "host": "smtp.provider.example", "port": 587, "username": "agents@brightwell.example",
            "password": "…", "probe_from": "agents@brightwell.example" } }
```

The agents' mail leaves through your own provider (Microsoft 365, Google Workspace, Postmark, Mailgun,
SendGrid or any other with SMTP submission), with your provider's reputation and authentication. The
CLI never takes the password as an argument: it asks for it with hidden input, or reads it from standard
input when you pipe it in.

What to set up with your provider:

- **An account that can send by SMTP**, with its user name and password. Port `465` (TLS from the start)
  or `587` (STARTTLS) only; port `25` is refused with `400 smtp_port_not_allowed`. The relay must offer
  TLS: Pylota Mail never sends the credentials without it (`422 smtp_tls_required`). Wrong credentials
  give `422 smtp_auth_failed`. Pylota Mail tries the login once before it stores anything, and keeps the
  credentials encrypted. They are never shown again.
- **Permission to send as the agent addresses.** If your provider limits which `From` addresses an
  account may use, allow the agent addresses and `probe_from`.
- **DKIM for your domain.** Your provider must sign with your own domain (or send with a MAIL FROM on
  your domain), so that DMARC passes.

**The alignment probe.** Pylota Mail cannot see from DNS how your provider signs, so before the first
send, and then every day, it sends a probe message through your relay to the platform domain. The probe
passes when the `From` address arrives unchanged and DMARC passes for your domain. If your provider
re-signs with its own domain the issue is `smtp_unaligned`; if it changes the `From` address,
`smtp_from_rewritten`. After a failed probe, another runs 20 minutes later. Two failed probes in a row
make the domain `failing` (about 40 minutes from the first failure at most), and sends fall back to the
platform address. Run a probe now with `pmail domains probe brightwell.example`
(`POST /v1/domains/{domain_id}/probe`, at most once a minute); the result appears in
`pmail domains health` within 15 minutes.

**Inbound.** With `--inbound forward`, your mailbox forwards to the agents exactly as for
[`send_only`](#keep-your-mailbox-forward-to-the-agent-send_only), with the same forwarding test and the same
drawback. With `--inbound ses`, you also publish the Amazon SES MX and DKIM records, as for
[`dns_records`](#a-subdomain-at-any-dns-host-dns_records); the MX then sends all of the domain's mail to
Pylota Mail, so use it only on a name that has no other mailboxes.

**Delivery statuses.** Your provider does not report deliveries back. A message is `submitted` once
your relay accepts it, and stays `submitted` unless a bounce arrives
([Sending › Delivery status](sending.md#delivery-status-and-events)).

**Changing the password or the relay**: `pmail domains update brightwell.example --smtp-password-stdin`
(or `PATCH /v1/domains/{domain_id}` with `smtp`). The new values are used only after a probe with them
passes; until then sends keep using the old ones.

## A delegated subdomain: `delegated_subdomain`

```bash
pmail domains add agents.brightwell.example --method delegated_subdomain --tenant brightwell
```

The deployment gets its own Cloudflare zone for the subdomain, and you delegate the subdomain to it with
`NS` records at your DNS host. The parent domain stays where it is. After that, the subdomain works like
a `cloudflare_zone` apex: every address works and Pylota Mail writes the mail records.

- Available only when the deployment's Cloudflare account is on Enterprise and the operator has set
  `PM_CF_SUBDOMAIN_SETUP = "on"`. Otherwise the request fails with `422 transport_unavailable`. Without
  it, use `dns_records`.
- A zone hold on your own Cloudflare account can block the zone; the request then fails with
  `409 zone_hold`. Release the hold for subdomains and try again.
- The delegation is checked every week. If the `NS` records at the parent change, the domain is
  `suspended` (`nameservers_changed`) until you restore them and re-prove ownership.

## How SES domains differ

Domains whose mail arrives through Amazon SES (`dns_records`, and `smtp_relay` with `inbound: ses`) behave
differently from Cloudflare domains in three ways:

| Situation | Cloudflare domain | SES domain |
|---|---|---|
| Mail to an address that does not exist | Refused with `550 5.1.1` | Accepted by SES, then dropped without a bounce. A bounce sent after acceptance would go to whatever sender the message claims, which spam forges |
| Mail to a retired address | Refused with `550 5.1.6` | SES sends a bounce, `550 5.1.6`, from `mailer-daemon@` the platform domain |
| Largest message accepted | 25 MiB | 40 MB |

So on an SES domain, someone who mistypes an address gets no bounce. Tell your contacts the exact
addresses your agents use.

## What happens when a domain fails

Whatever the method, Pylota Mail never sends as a domain whose authentication is broken. When a domain
is `failing` (or `suspended`), sends go out from the identity's platform address instead, for example
`bookings.brightwell@agents.example`, with the same display name, and replies still come back into the
same thread ([Fix a failing domain](#fix-a-failing-domain)). The platform address always sends through
the platform domain on Cloudflare, so fallback works for every method, including `smtp_relay` and SES
domains.

## Move an identity to the new domain

```text
 bookings.brightwell@agents.example   primary, active ──── promote ───▶ alias, active (kept for fallback)
 bookings@brightwell.example          alias, pending ─ healthy ─▶ active ─ promote ─▶ primary, active
```

The platform address (`bookings.brightwell@agents.example`) is never retired: it is where sends go when
the domain fails ([When the domain fails](#domain-health)). A later move between two of your own domains
retires the old one as usual.

1. **Add the address.**

   ```bash
   curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/addresses \
     -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Content-Type: application/json" \
     -d '{"local_part":"bookings","domain_id":"dom_01JA…"}'
   ```

   CLI: `pmail addresses add`. The new address is an `alias` with status `pending`. It becomes `active`
   when its domain is healthy, and `identity.address_activated` is sent. It already receives mail
   once it is active. On a `send_only` domain (or `smtp_relay` with `inbound: forward`), add the
   forwarding rule and run the forwarding test now.

2. **Promote it** when you are ready for new mail to come from it:

   ```bash
   curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/addresses/adr_01JA…/promote \
     -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Content-Type: application/json" \
     -d '{"retire_previous_after_days":90}'
   ```

   CLI: `pmail addresses promote`. The address becomes the primary. The previous primary becomes an
   alias with status `retiring`, and its `retire_at` is set (default 90 days, range 0–365); if the
   previous primary is the platform address, it becomes an `active` alias instead and is never retired.
   Promotion needs the domain to be `healthy` or `degraded`, otherwise `409 domain_not_ready`.
   `identity.address_promoted` is sent.

What changes after a promotion ([FR-ADR-2](../project/prd.md#62-identities-and-addresses)):

- **New threads** send from the new primary.
- **Existing threads** keep replying from the address the other party wrote to, until it retires. A
  customer who answers an old message to `bookings.brightwell@agents.example` is answered from that
  address ([C3](../project/edge-cases.md)).
- A **retiring address keeps receiving** into the same identity until `retire_at`. Then it becomes
  `retired`, `identity.address_retired` is sent, and mail to it is refused with `550 5.1.6` (on an SES
  domain, SES sends that bounce). The platform address keeps receiving for good.

**To roll back**, promote the previous address again (the retiring one, or the platform address). Any
retirement is cancelled and it is the primary once more
([FR-ADR-4](../project/prd.md#62-identities-and-addresses)).

**To retire an alias early**, use `POST …/addresses/{address_id}/retire` with `{"after_days": 0}`
(CLI `pmail addresses retire`). The primary cannot be retired (`409 address_is_primary`), and the
platform address can never be retired or deleted (`409 address_in_use`). Only a `pending` address that
never received mail can be deleted; any other gets `409 address_in_use`.

## Domain health

Every domain is checked every 15 minutes and after every change, with two independent DNS-over-HTTPS
resolvers. One resolver's error or disagreement never changes the state
([H7](../project/edge-cases.md)); a change needs two consecutive agreeing results.

| State | What it means | Sending | Events |
|---|---|---|---|
| `pending` | Newly added; records not checked yet | No. Addresses stay `pending` | `domain.created` |
| `verifying` | Checks are running | No | – |
| `healthy` | Every required record is correct | Yes | `domain.verified` (verification passed), `domain.recovered` (on return from `degraded` or `failing`) |
| `degraded` | An issue was found that does not break authentication | Yes | `domain.degraded` with `issues[]` |
| `failing` | A required authentication record is missing or wrong, or (for `smtp_relay`) the alignment probe failed twice | **No.** Sends fall back to the identity's platform address | `domain.failing` with `issues[]` and `fallback_active` |
| `suspended` | Failing for 14 days, or the domain's ownership signals changed | No | `domain.suspended` with `reason` |

While a domain is `pending`, `verifying`, `degraded`, `failing` or `suspended`, `domain.reminder` events
are sent after 24 hours, 72 hours and 7 days in that state. Each issue carries a `code`, the `record`
and an exact `fix`. Relay these to the person who manages the domain's DNS: the integrator owns how the
operator is told ([H1](../project/edge-cases.md)).

See the current state and the history of checks:

```bash
pmail domains health dom_01JA…
```

```json
{
  "state": "failing", "reason": "dkim_missing", "since": "…",
  "issues": [ { "code": "dkim_missing", "record": "cf-bounce._domainkey…", "fix": "Add TXT … with value …" } ],
  "checks": [ { "at": "…", "resolver": "cloudflare-doh", "outcome": "fail" } ],
  "fallback_active": true
}
```

Issues you may meet with the methods that keep DNS at your host:

| Issue | Methods | What it means | What to do |
|---|---|---|---|
| `record_doubled_name` (degraded) | `dns_records`, `send_only`, `smtp_relay` | A record was entered with the full name in a form that adds your domain | Enter the `host` value instead ([`name` and `host`](#name-and-host-which-one-your-dns-host-wants)) |
| `mx_unexpected` (degraded) | `dns_records`, `smtp_relay` with `inbound: ses` | Another MX record still points elsewhere, so mail is split | Remove the old MX records |
| `mx_missing` (fail) | `dns_records`, `smtp_relay` with `inbound: ses` | The MX record to Amazon SES is missing | Publish it as the `fix` says |
| `dkim_missing`, `ses_dkim_failed` (fail) | `dns_records`, `send_only`, `smtp_relay` with `inbound: ses` | A DKIM CNAME is missing or wrong, or SES could not verify it | Publish the three CNAMEs exactly as the `fix` says |
| `mail_from_failed` (degraded) | `dns_records`, `send_only` | The `pm-bounce` MX or TXT is missing. DKIM still aligns, so sending continues | Publish both `pm-bounce` records |
| `smtp_unaligned`, `smtp_from_rewritten` (degraded the first time, then fail) | `smtp_relay` | Your provider signs with its own domain, or changes the `From` address | Turn on DKIM for your domain at your provider; allow the agent addresses as senders |
| `smtp_probe_timeout` (fail before the first pass; after it, degraded, then fail after three in a row) | `smtp_relay` | No probe arrived within 15 minutes | Check that the relay accepts and sends mail from `probe_from` |
| `smtp_auth_failed`, `smtp_tls_required` (fail) | `smtp_relay` | The relay refused the login, or offered no TLS | Update the credentials with `pmail domains update` |

The full list, per method, is in
[Domains on any DNS host › Health checks per method](../project/design/domain-connections.md#6-health-checks-per-method).

## Fix a failing domain

1. Read the issues: `pmail domains health dom_01JA…` (or the `issues` in the `domain.failing` event).
2. Apply each `fix` at your DNS host (or, for `smtp_relay`, at your mail provider), exactly as given.
   Run `pmail domains records dom_01JA…` to confirm each record is `ok`.
3. Run `pmail domains verify dom_01JA…` (for `smtp_relay`, `pmail domains probe` too). After two
   consecutive passing checks the domain returns to `healthy` and `domain.recovered` is sent.

While the domain is failing, nothing is sent as it. Sends go out from the identity's platform address
with the same display name, flagged `sent_via_fallback`, and replies still thread correctly. Threads
that fell back stay on the platform address until the domain is healthy and the thread has had no
messages for 72 hours, so a conversation does not switch addresses back and forth ([Sending › When a domain fails](sending.md#when-a-domain-fails)). If the
tenant set `domain_fallback: false`, those sends failed instead (`domain_failing_no_fallback`) and must
be sent again with new idempotency keys.

## Re-prove ownership

A domain is `suspended` after 14 days of failing, or when its ownership signals change: its
nameservers moved, the ownership TXT record disappeared, or its registration changed (checked weekly
through RDAP) ([H4](../project/edge-cases.md)). `domain.suspended` gives the reason:
`failing_14_days`, `nameservers_changed`, `ownership_record_missing` or `registration_changed`.

Pylota Mail never sends as a domain whose ownership may have changed hands. To restore it:

```bash
pmail domains reprove dom_01JA…
```

This issues a **new** ownership TXT value for `_pylota-mail.<domain>`. Publish it, fix any other
issues, then run `pmail domains verify`.

## Change domains again

You can repeat the move from one custom domain to another at any time: add an address on the new
domain, wait for it to become active, promote it. The previous primary retires as before.

Only one pending address per identity and domain is allowed. If you start a second change while the
first address is still pending, the newer request replaces the older pending address
([A11](../project/edge-cases.md)).

## Remove a domain

```bash
pmail domains remove dom_01JA…
```

Removal fails with `409 domain_in_use` while any address on the domain is `active` or `retiring`.
Retire them first. Once removal starts (`202`), what Pylota Mail set up for the domain is deleted (the
routing rules, the Email Sending onboarding and the event subscription, or the SES identity), and
`domain.removed` is sent. Records you published at your own DNS host, and forwarding rules in your
mailbox, stay until you remove them.

## DMARC alignment

DMARC passes when either SPF or DKIM passes **and** is aligned with the domain in `From`.

| Transport | DKIM | SPF |
|---|---|---|
| Cloudflare Email Sending (`cloudflare_zone`, `nameservers`, `delegated_subdomain`) | Signed for the domain itself (selector `cf-bounce`), so aligned under relaxed and strict (`adkim=s`) alignment | The Return-Path is on `cf-bounce.<domain>`, which aligns under relaxed SPF alignment (the default), but not under `aspf=s` |
| Amazon SES (`dns_records`, `send_only`) | Easy DKIM signs for the domain, so aligned under relaxed and strict alignment | The MAIL FROM is `pm-bounce.<domain>`, which aligns under relaxed SPF alignment |
| Your SMTP relay (`smtp_relay`) | Depends on your provider. The alignment probe proves that DKIM or SPF aligns before the first send and every day | Depends on your provider |

So DKIM alignment carries DMARC on Cloudflare and SES, and the probe checks it on a relay. Before
onboarding, a preflight checks the domain's DMARC alignment tags against the transport's DKIM domain and
reports combinations that would fail ([H3](../project/edge-cases.md)). Ramp the domain's own DMARC
policy as described in
[Deploy to Cloudflare › DNS authentication and the DMARC ramp](../self-hosting.md#dns-authentication-and-the-dmarc-ramp).

## FAQ

**Can a tenant use its main company domain?**
Yes. If it already has mailboxes, use `send_only` or `smtp_relay`: the agents answer as addresses on
that domain and the mailboxes keep working. Or put the agents on a subdomain with `dns_records`. Only a
`cloudflare_zone` apex and `nameservers` take over the domain's mail, and both refuse a domain with
existing mail unless you confirm.

**Does my domain have to be on Cloudflare?**
No. Only the deployment's platform domain does. `dns_records`, `send_only` and `smtp_relay` work with
any DNS host.

**What happens to old threads after a domain change?**
They continue. Replies to the old address arrive in the same identity and are answered from the
address the other party used, until it retires.

**Can I undo a domain change?**
Yes, while the old address is still `retiring`: promote it again. Once it is `retired`, it can no
longer receive mail and cannot be given to anyone else. The platform address never retires, so a move
away from it can always be undone.

**Why the limit of 200 addresses on a subdomain?**
It applies only to a `cloudflare_zone` subdomain. Cloudflare allows catch-all routing only on a zone
apex, so each address on such a subdomain needs its own routing rule, and Cloudflare allows 200 rules per
domain. A zone apex, a `dns_records` subdomain and a delegated subdomain have no such limit.

**Does Pylota Mail ever send as a broken domain?**
No. A `failing` domain falls back to the platform address. A `suspended` domain sends nothing as
itself until ownership is proved again.

**Can operators delegate a subdomain to the deployment instead?**
On a Cloudflare Enterprise account, yes, with `delegated_subdomain` once the operator turns it on.
Otherwise use `dns_records`.

**Do I need `PM_CF_API_TOKEN`?**
For `cloudflare_zone`, `nameservers` and `delegated_subdomain` added through the API, yes; its
permissions are in [Deploy to Cloudflare](../self-hosting.md#2-create-a-cloudflare-api-token). Without it,
an operator can still add a zone apex with `pmail domains add --local-token` and their local token; subdomains,
`nameservers` and `delegated_subdomain` need the token on the deployment. `dns_records`, `send_only` and
`smtp_relay` do not use it.

**Do I need an AWS account?**
The operator does, for `dns_records` and `send_only` (and `smtp_relay` with `inbound: ses`). Tenants do
not.
