# Pylota Mail

Email and identity for AI agents. Source available (Fair Source), written in Rust, runs on your own Cloudflare account or on Pylota Mail Cloud.

Pylota Mail gives every agent an **identity**: a stable mailbox with one or more addresses, DKIM-aligned
sending, verified inbound mail, threads, attachments, triage and search. You talk to it through a
**REST API**, an **MCP server** or the **`pmail` CLI**, and it tells you what happened through signed
**webhooks**.

It was built for [Pylota](https://pylota.io) (an agentic operating system for car-rental operators). The source
is published under the [Functional Source License 1.1 (FSL-1.1-ALv2)](LICENSE.md): you can self-host it for free for
your own agents, and each release becomes Apache-2.0 two years after it ships. Pylota also runs it as a hosted
service, **Pylota Mail Cloud**, on the plans below.

## Why it is different

1. **Answers you can check.** Agentic search answers with message IDs, and code (not the model) verifies every
   citation; unsupported sentences are removed and recorded in the trace.
2. **One email per intent.** `Idempotency-Key` is required on every send. An outcome the transport cannot confirm
   becomes `uncertain` and is never resent automatically.
3. **Identities outlive domains.** An agent keeps its mailbox while its address moves between domains; threads
   keep the address the other side used; retired addresses bounce with `550 5.1.6`.
4. **Never sends mail that fails authentication.** Domains are checked every 15 minutes from two resolvers; a
   broken record moves sending to an aligned fallback in the same thread.
5. **Built for untrusted input.** SPF/DKIM/DMARC verdicts and trust flags on every message, hidden text stripped,
   content fenced for models, risky attachments held for a person.
6. **Your account, your receipts.** Mail stays in the Cloudflare account that runs it (EU jurisdiction optional);
   erasure returns a receipt with per-store counts and empty probe queries.
7. **Real team seats.** Workspaces have members with roles, enforced seat counts and an audit log, on Cloud and
   when self-hosted.
8. **Tested against the edge cases.** A public register of edge cases, each mapped to a named test, plus a MIME
   conformance corpus and search-quality gates in CI.

## What it does

| Area | What you get |
|---|---|
| Identities | One mailbox per agent, several addresses over time (primary, alias, retiring), display name, signature, accountable human |
| Domains | A platform domain with catch-all routing, plus customer domains with DNS records read from the API, verification and continuous health checks |
| Inbound | Mail parsed by a Rust MIME parser, DKIM/ARC/DMARC verdicts, loop and auto-reply detection, quarantine for failed authentication, spam or unsafe attachments |
| Outbound | Send, reply, reply-all, forward. `Idempotency-Key` is required, a retry returns the original result, an uncertain send is never resent automatically |
| Delivery | Delivered, deferred, bounced, complained, rejected and failed events, automatic suppression |
| Triage | Category, needs-reply score, urgency 0–3, risk flags (payment-change request, suspected prompt injection, phishing) |
| Search | Keyword (FTS5 + exact references), semantic (Vectorize), hybrid (fusion + reranking) and agentic (plan, search, refine, cited answer) |
| Integrations | REST API with OpenAPI 3.1, MCP server (Streamable HTTP), `pmail` CLI, Rust SDK, Standard Webhooks |
| Privacy | EU jurisdiction for D1, Durable Objects and R2, retention policies, erasure with receipts, subject-access export |
| Console | Passwordless sign-in, workspaces with members and roles, inbox views, quarantine review, keys, domains, plan and usage |
| Plans | Metered allowances with atomic holds, `402 billing_limit` with safe retry after upgrade, Stripe checkout and billing portal (Cloud, or any deployment that turns billing on) |

## Deploy in a few minutes

You need:

- a Cloudflare account on the Workers Paid plan;
- one domain on Cloudflare DNS whose apex becomes the shared mail domain (for example `agents.example`).
  Tenant domains can stay at any DNS host ([Custom domains](docs/src/guides/custom-domains.md));
- Node.js 22+ (for `wrangler`).

You do not need a Rust toolchain unless you build from source.

```bash
cargo install pylota-mail-cli --locked     # or download a prebuilt pmail from GitHub Releases
export CLOUDFLARE_API_TOKEN=...            # permissions listed in docs/src/self-hosting.md
pmail setup --account-id <account-id> --domain mail.example.com --mail-domain agents.example --jurisdiction eu
pmail keys create --level platform --name first-key
```

`--domain` is the API host. `--mail-domain` is the shared mail domain, and it must be a zone apex,
because Cloudflare catch-all routing only works on an apex.

`pmail setup` creates every Cloudflare resource:

- D1, R2, Queues and Vectorize;
- Email Routing catch-all and Email Sending onboarding;
- the delivery-event subscription.

It also applies migrations, generates secrets, writes `deploy/wrangler.toml` and performs the first deploy of
a prebuilt, signature-verified Worker bundle. It stores a 24-hour bootstrap key in your CLI profile, which the
`pmail keys create` line above uses to make your first platform key. Later releases go out with
`pmail deploy`. The full guide is in
[docs/src/self-hosting.md](docs/src/self-hosting.md).

## Repository layout

```
crates/core          pure logic: MIME, authentication, sanitising, threading, references, triage rules, query parser
crates/platform      the only crate that touches workers-rs (Cloudflare bindings)
crates/api-types     request/response types and OpenAPI generation
crates/worker        the Cloudflare Worker: HTTP, email, queue and cron handlers, Durable Objects, MCP endpoint
crates/sdk           Rust client
crates/cli           the pmail CLI (setup, deploy, admin, mail)
crates/conformance   MIME corpus and RFC conformance runner
docs/                product, architecture, design and user docs (mdBook)
site/                landing page, deployed as an assets-only Worker together with the built docs
```

## Documentation

- Product requirements: [docs/src/project/prd.md](docs/src/project/prd.md)
- Architecture: [docs/src/project/architecture.md](docs/src/project/architecture.md)
- Detailed design: [docs/src/project/design/](docs/src/project/design/)
- Build plan: [docs/src/project/build-plan.md](docs/src/project/build-plan.md)
- API reference: [docs/src/reference/api.md](docs/src/reference/api.md) and [openapi.yaml](docs/src/reference/openapi.yaml)

Build the docs site locally:

```bash
cargo install mdbook --version 0.5.4 --locked
mdbook serve docs
```

## Status

Pre-release. The design is complete and the implementation follows [the build plan](docs/src/project/build-plan.md).
See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Plans

Self-hosting is free under FSL-1.1-ALv2, with no plan limits. Pylota Mail Cloud plans:

| | Free | Developer | Team |
|---|---|---|---|
| Price (excl. VAT) | £0 | £10 a month | £49.50 a month |
| Inboxes (identities) | 5 | 10 | 100 |
| Sends per month | 1,000 | 10,000 | 100,000 |
| Triage analyses per month | 500 | 10,000 | 100,000 |
| Custom domains | none | 5 | 50 |
| Storage | 1 GB | 10 GB | 100 GB |
| Seats | 1 | 2 | 10 |
| Top-ups | none | £1 per unit | £1 per unit |
| Support | GitHub issues | email | priority email |

A top-up unit is one inbox, 1,000 sends or 1,000 triage analyses for the month. Details:
[docs/src/guides/plans.md](docs/src/guides/plans.md).

## License

[Functional Source License, Version 1.1, ALv2 Future License](LICENSE.md) (FSL-1.1-ALv2). You may use, modify
and redistribute the software for any purpose except offering a competing commercial product or service; each
version becomes available under the Apache License 2.0 on the second anniversary of its release. FSL is a
[Fair Source](https://fair.io) licence, not an OSI-approved open-source licence. The licensor is TREFT LTD, the
company behind Pylota.
