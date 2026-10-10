# Summary

[Introduction](introduction.md)

# Getting started

- [Quickstart](quickstart.md)
- [Deploy to Cloudflare](self-hosting.md)
- [Concepts](concepts.md)

# Guides

- [Using it from an agent](guides/agents.md)
- [Sending and safe retries](guides/sending.md)
- [Receiving, webhooks and quarantine](guides/receiving.md)
- [Search](guides/search.md)
- [Triage](guides/triage.md)
- [Custom domains](guides/custom-domains.md)
- [Security](guides/security.md)
- [Privacy, retention and erasure](guides/privacy.md)
- [Plans and billing](guides/plans.md)

# Reference

- [REST API](reference/api.md)
- [Webhook events](reference/events.md)
- [Errors](reference/errors.md)
- [MCP server](reference/mcp.md)
- [CLI](reference/cli.md)
- [Configuration](reference/configuration.md)
- [Limits](reference/limits.md)

# Project

- [Product requirements (PRD)](project/prd.md)
- [Architecture](project/architecture.md)
- [Design](project/design/index.md)
  - [Rust workspace and platform](project/design/rust-workspace.md)
  - [Data model](project/design/data-model.md)
  - [Inbound pipeline](project/design/inbound.md)
  - [Outbound and safe retries](project/design/outbound.md)
  - [Threading](project/design/threading.md)
  - [Identities, addresses and domains](project/design/identity-domains.md)
  - [Domains on any DNS host](project/design/domain-connections.md)
  - [Agent signing keys and signed requests](project/design/agent-keys.md)
  - [Search](project/design/search.md)
  - [Triage](project/design/triage.md)
  - [Webhooks and events](project/design/webhooks.md)
  - [MCP server](project/design/mcp.md)
  - [CLI and setup](project/design/cli.md)
  - [Security](project/design/security.md)
  - [Privacy and erasure](project/design/privacy.md)
  - [Console and workspaces](project/design/console.md)
  - [Cloud sign-up, sign-in and first run](project/design/cloud-signup.md)
  - [Plans, metering and billing](project/design/billing.md)
  - [Notifications and usage alerts](project/design/notifications.md)
  - [Observability and SLOs](project/design/observability.md)
  - [Testing](project/design/testing.md)
- [Edge-case register](project/edge-cases.md)
- [Build plan](project/build-plan.md)
- [Decision records](project/adr/index.md)
  - [0001 Rust on Workers](project/adr/0001-rust-on-workers.md)
  - [0002 Storage layout](project/adr/0002-storage.md)
  - [0003 Addressing with catch-all and a directory](project/adr/0003-addressing.md)
  - [0004 Required idempotency](project/adr/0004-idempotency.md)
  - [0005 State machines instead of Workflows](project/adr/0005-state-machines.md)
  - [0006 Vectorize for semantic search](project/adr/0006-vectorize.md)
  - [0007 Agentic search with verified citations](project/adr/0007-agentic-search.md)
  - [0008 Domains on any DNS host](project/adr/0008-domains-on-any-dns-host.md)
  - [0009 Local MCP protocol types](project/adr/0009-local-mcp-protocol-types.md)
  - [0013 Partner keys as a fourth key level](project/adr/0013-partner-keys.md)
  - [0014 Marketing mail only through SES or SMTP](project/adr/0014-marketing-needs-ses.md)
