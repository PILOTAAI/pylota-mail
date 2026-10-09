# Introduction

Pylota Mail is an email and identity service for AI agents. It gives every agent its own
**identity**: a stable mailbox with one or more addresses, authenticated sending, verified inbound
mail, threads, attachments with extracted text, triage and search. It is source available under the
Functional Source License (FSL-1.1-ALv2; each release becomes Apache-2.0 two years after it ships),
written entirely in Rust, and runs as one Cloudflare Worker on **your own Cloudflare account**.

It was built for [Pylota](https://pylota.io), a platform for independent car-rental operators, where
each operator has four agents (bookings, inquiry, compliance and maintenance) that email customers,
garages, insurers and councils. Nothing in it is specific to car rental.

## What you get

| | |
|---|---|
| **An identity per agent** | Each agent has a mailbox, a primary address and aliases, a display name, a signature and an accountable human. Move the identity to another domain and its history and threads move with it |
| **Your own domains, at any DNS host** | Every identity has an address on the deployment's platform domain, which is on Cloudflare. Tenants can add their own domains without moving their DNS: six connection methods cover a domain on Cloudflare, a subdomain at any DNS host, and agents that answer as existing Google Workspace or Microsoft 365 addresses ([Custom domains](guides/custom-domains.md)) |
| **Three ways in** | A REST API (OpenAPI 3.1), an MCP server at `/mcp` and the `pmail` CLI. There is also a Rust SDK. Signed webhooks tell your application what happened |
| **Inbound you can trust** | Every message is stored before it is acknowledged, parsed, and given an authentication verdict (SPF, DKIM, DMARC, ARC), a spam signal and trust metadata. Mail that fails authentication, looks like spam or carries an unsafe attachment is quarantined |
| **Triage** | Every inbound message gets a category, a needs-reply score, an urgency from 0 to 3, a short summary and risk flags such as a payment-change request or suspected prompt injection |
| **Safe retries** | Send, reply, reply-all and forward require an `Idempotency-Key`. A retry returns the first result instead of sending a second email. A send whose outcome cannot be known is marked `uncertain` and is never resent automatically |
| **Four search modes** | `keyword` (full-text plus exact references such as plates and invoice numbers), `semantic`, `hybrid` (the default) and `agentic`, which plans searches and returns an answer whose citations are checked by code |
| **Agents that can prove who they are** | Each identity can sign short-lived agent assertions that any service verifies against the identity's published key set. Where the operator and the workspace turn it on, agents can also sign their web requests with Web Bot Auth. Private keys never leave the Worker ([Using it from an agent](guides/agents.md#agent-assertions)) |
| **Email for the people behind the agents** | Usage alerts at 80% and 100% of an allowance, opt-in new-mail notifications that carry counts and never content, and a daily list of what needs a person ([Notifications by email](guides/receiving.md#notifications-by-email)) |
| **Your account, your data** | D1, Durable Objects, R2, Queues, Vectorize and Workers AI in the Cloudflare account you deploy to. D1, Durable Objects and R2 can be pinned to the EU |
| **Privacy tools** | Retention policies, erasure with receipts, legal holds and subject-access export |

## Who it is for

- **Integrators**: developers building an agent product who need to provision mailboxes per
  customer, send and receive reliably, react to events and erase data through a stable API.
- **Agents**: LLMs that use mail through MCP tools or an integrator's tool layer. Tools are small,
  reads fit a context window, sends are safe to retry and mail content is marked untrusted.
- **Self-hosters**: anyone who wants agent mail on infrastructure they control. A fresh deployment
  takes about 15 minutes of hands-on time ([NFR-OPS-1](project/prd.md#7-non-functional-requirements)).

## How the pieces fit

```text
                 ┌────────────────────── your Cloudflare account ──────────────────────┐
 sender ── SMTP ─▶ Email Routing ──▶ Pylota Mail Worker (Rust, WebAssembly)            │
                 │  (catch-all or      │                                               │
                 │   literal rules)    ├─ raw mail ─────────▶ R2                       │
                 │                     ├─ one mailbox per identity ─▶ Durable Objects  │
                 │                     │    (threads, messages, full-text index)       │
                 │                     ├─ tenants, keys, domains ─▶ D1                 │
                 │                     ├─ vectors (no text) ─▶ Vectorize               │
                 │                     ├─ triage, embeddings, agentic search ─▶ Workers AI
                 │                     └─ background work ─▶ Queues                    │
                 │                              │                                      │
 recipient ◀──── Email Sending ◀── send ────────┘                                      │
                 └──────────────────────────────┬──────────────────────────────────────┘
                                                │
          REST /v1 · MCP /mcp · pmail CLI ──────┤  you call it
          signed webhooks ◀─────────────────────┘  it calls you
```

1. Mail for every address on the platform domain, and on tenant domains whose DNS is on Cloudflare,
   reaches the Worker through Email Routing. The raw message goes to R2 before the sender gets an
   acknowledgement. Tenant domains whose DNS is elsewhere receive through Amazon SES, which hands each
   message to the same pipeline, or through the tenant's own mailbox, which forwards it.
2. The Worker parses and authenticates it, finds its thread and stores it in the identity's mailbox
   (one Durable Object per identity). It is searchable in the same transaction.
3. Triage and semantic indexing run in the background. Each step emits an event, which is delivered
   to your webhook endpoints, signed.
4. Your agent reads, searches and replies through the API, MCP or CLI. Outbound mail leaves through
   Cloudflare Email Sending, or, depending on how a tenant domain is connected, through Amazon SES or the
   tenant's own SMTP provider. Delivery events come back on a queue.

The [Architecture](project/architecture.md) page has the full picture.

## What it is not

Pylota Mail v1.0 deliberately does not include ([PRD §4](project/prd.md#4-goals-and-non-goals)):

- a mail client or webmail UI for humans. It is API-first;
- IMAP, POP3 or SMTP submission access;
- bulk marketing campaigns or list management. Marketing mail is supported one message at a time,
  with consent and one-click unsubscribe;
- scheduled send or server-side drafts (planned for v1.1);
- OAuth 2.1 for the MCP endpoint (planned for v1.1; v1.0 uses API keys as bearer tokens);
- running anywhere other than Cloudflare Workers.

## Where to go next

- [Quickstart](quickstart.md): create an identity, send with an idempotency key, receive a reply,
  search, and connect an MCP client.
- [Deploy to Cloudflare](self-hosting.md): run your own deployment with `pmail setup` and
  `pmail deploy`.
- [Concepts](concepts.md): tenants, identities, addresses, domains, threads, triage, search, events,
  keys and idempotency in one place.
- Guides:
  [Using it from an agent](guides/agents.md) ·
  [Sending and safe retries](guides/sending.md) ·
  [Receiving, webhooks and quarantine](guides/receiving.md) ·
  [Search](guides/search.md) ·
  [Triage](guides/triage.md) ·
  [Custom domains](guides/custom-domains.md) ·
  [Security](guides/security.md) ·
  [Privacy, retention and erasure](guides/privacy.md) ·
  [Plans and billing](guides/plans.md)
- Reference:
  [REST API](reference/api.md) ·
  [Webhook events](reference/events.md) ·
  [Errors](reference/errors.md) ·
  [MCP server](reference/mcp.md) ·
  [CLI](reference/cli.md) ·
  [Configuration](reference/configuration.md) ·
  [Limits](reference/limits.md)
- Project documents, for contributors and coding agents:
  [Product requirements](project/prd.md) ·
  [Architecture](project/architecture.md) ·
  [Design](project/design/index.md) ·
  [Edge-case register](project/edge-cases.md) ·
  [Build plan](project/build-plan.md) ·
  [Decision records](project/adr/index.md)

Pylota Mail is pre-release. The design is complete and the implementation follows the
[build plan](project/build-plan.md). To report a vulnerability, see
[SECURITY.md](https://github.com/PILOTAAI/pylota-mail/blob/main/SECURITY.md).
