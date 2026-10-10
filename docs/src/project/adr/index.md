# Decision records

An architecture decision record (ADR) captures one significant decision: the forces behind it, what was
decided, what follows from it, and what else was considered. ADRs are binding in the same way as the
[design documents](../design/index.md): if code and an accepted ADR disagree, the ADR wins until a new
ADR supersedes it (AGENTS.md).

## Index

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-rust-on-workers.md) | Rust on Workers | Accepted | 2026-10-09 |
| [0002](0002-storage.md) | Storage layout | Accepted | 2026-10-09 |
| [0003](0003-addressing.md) | Addressing with catch-all and a directory | Accepted | 2026-10-09 |
| [0004](0004-idempotency.md) | Required idempotency | Accepted | 2026-10-09 |
| [0005](0005-state-machines.md) | State machines instead of Workflows | Accepted | 2026-10-09 |
| [0006](0006-vectorize.md) | Vectorize for semantic search | Accepted | 2026-10-09 |
| [0007](0007-agentic-search.md) | Agentic search with verified citations | Accepted | 2026-10-09 |
| [0008](0008-domains-on-any-dns-host.md) | Domains on any DNS host | Accepted | 2026-10-09 |
| [0009](0009-local-mcp-protocol-types.md) | Local MCP protocol types | Accepted | 2026-10-09 |
| [0010](0010-workspace-policy-self-service.md) | Workspace policy self-service | Accepted | 2026-10-10 |
| [0011](0011-service-sign-up-ledger.md) | Service sign-up ledger | Accepted | 2026-10-10 |

## When to write one

Write an ADR before merging a change that:

- changes a public contract: the REST API, webhook events, MCP tool names, or CLI commands
  (CONTRIBUTING.md);
- moves a `P1` requirement out of v1.0 ([PRD](../prd.md) section 5) or takes a spike's fallback
  ([Design › Spikes](../design/index.md#spikes));
- adds a Cloudflare product, an external service, a new language or runtime, or a dependency that does
  I/O;
- changes how data is stored, where it lives (jurisdiction), or how it is deleted;
- reverses or narrows an accepted ADR.

Small, local choices belong in the design document that owns the area, not in an ADR.

## Process

1. Copy the template below to `NNNN-short-name.md`, using the next free number. Numbers are never
   reused.
2. Open a pull request with the ADR at status `Proposed`. Link it from the issue that prompted it.
3. When it is merged, set the status to `Accepted` and the date to the merge date, and add it to the
   index. Update every design document the decision changes in the same pull request.
4. An accepted ADR is not edited except to fix typos or add a `Superseded by` link. To change a
   decision, write a new ADR that supersedes it, and set the old one to `Superseded by NNNN`.

Statuses: `Proposed`, `Accepted`, `Rejected`, `Superseded by NNNN`, `Deprecated`.

## Template

```markdown
# NNNN Title in sentence case

| | |
|---|---|
| Status | Proposed |
| Date | YYYY-MM-DD |
| Deciders | Pylota engineering |
| Related | PRD IDs, design documents, spikes, other ADRs |

## Context

The problem, the forces and constraints, and the facts the decision rests on. Facts about external
systems name their source and the date they were read, or the spike that settles them.

## Decision

What we will do, stated so that a reader can check the code against it. Use "must" for the binding
parts.

## Consequences

What becomes easier and what becomes harder. Risks, with their mitigations. Follow-up work.

## Alternatives considered

Each serious alternative, why it was attractive, and why it was not chosen.
```
