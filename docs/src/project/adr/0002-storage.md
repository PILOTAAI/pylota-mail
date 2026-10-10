# 0002 Storage layout

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-09 |
| Deciders | The owner (TREFT LTD) |
| Related | FR-TEN-1, FR-SRCH-2, FR-PRV-1, FR-PRV-3, NFR-COST-1; [Data model](../design/data-model.md); [Privacy](../design/privacy.md); spikes S3, S6 |

## Context

The service stores four kinds of data with different needs:

- **Control plane**: tenants, identities, the address directory, domains, keys, webhooks, suppressions,
  jobs, audit. Small, relational, and queried across tenants (inbound routing looks up any address).
- **Mailboxes**: threads, messages, recipients, labels, the keyword index, references, contacts,
  idempotency records and the event outbox. A message, its index rows and its event must commit
  together (FR-SRCH-2, transactional outbox), and one busy tenant must not slow another.
- **Blobs**: raw MIME up to 25 MiB, attachments, extracted text, exports. Large, write-once, deleted by
  prefix on erasure.
- **Vectors**: chunk embeddings for semantic search.

Facts (Cloudflare docs, read 2026-10-09): Durable Object SQLite gives each object a private database of
up to 10 GB with FTS5, transactions and point-in-time recovery for 30 days, and `deleteAll()` is atomic
for SQLite-backed objects. D1 is a managed SQLite database whose jurisdiction (`eu`, `fedramp`, `us`)
can only be set at creation. R2 buckets accept a jurisdiction at creation. In `workers-rs` 0.8.7 a
Durable Object jurisdiction can only be applied through `unique_id_with_jurisdiction`, not to IDs derived
from names ([ADR 0001](0001-rust-on-workers.md)).

## Decision

1. **D1 (`DB`) holds the control plane**, including the address directory used by `email()` and every
   cross-tenant lookup. Every tenant-data query takes `tenant_id` as a required parameter of the
   data-access layer.
2. **One SQLite Durable Object per identity (`IdentityMailbox`) holds the mailbox.** Every write is one
   transaction containing the state change, its index rows and its outbox events. Three other classes
   hold per-domain (`DomainMonitor`), per-job (`JobRunner`) and per-tenant (`TenantQuota`) state.
3. **R2 (`BLOBS`) holds blobs** under tenant-prefixed keys (`t/{tenant}/i/{identity}/…`), so erasure
   can list and delete by prefix.
4. **Vectorize (`VECTORS`) holds vectors** with IDs and filter metadata only ([ADR 0006](0006-vectorize.md)).
5. **Jurisdiction.** `PM_JURISDICTION` is applied at creation to D1, R2 and every Durable Object. Each
   object ID is created with `unique_id_with_jurisdiction(<jurisdiction>)` (or `unique_id()` for
   `default`), stored as a string in D1 (`tenants.quota_do_id`, `identities.mailbox_do_id`,
   `domains.monitor_do_id`, `jobs.runner_do_id`), and always addressed with `id_from_string`. Names are
   never hashed into object IDs.
6. **No KV** for anything correctness-critical: it is eventually consistent.

## Consequences

- A mailbox is strongly consistent: keyword search sees a message in the same transaction that stores
  it, and events are emitted exactly when state changes.
- Tenants do not contend for writes; a mailbox's throughput is bounded by its own object.
- Identity erasure is one atomic `delete_all()` plus an R2 prefix delete and vector deletes by ID.
- The 10 GB per-mailbox limit is a real ceiling: raw MIME and attachments live in R2, a size check
  alerts at 70%, and retention can purge old messages ([Observability](../design/observability.md)).
- Tenant-wide search fans out to up to 100 mailboxes and merges results; a slow mailbox yields partial
  results ([F15](../edge-cases.md)).
- D1 is the only map from identities to their objects. Losing D1 rows would orphan mailboxes, so D1 Time
  Travel (30 days) is part of the restore runbook, and every object also stores its owner IDs in `meta`.
- D1 receives a few writes per inbound message (event index, delivery rows), well inside its limits;
  per-message writes go to the mailbox.
- Durable Object migrations run on wake, guarded by `schema_version` ([J9](../edge-cases.md)).

## Alternatives considered

- **D1 only.** One relational store, simple queries across mailboxes. Rejected: every tenant's mail in
  one 10 GB database with one writer; FTS5 across all tenants makes isolation a query-time property
  instead of a storage boundary; erasure becomes large deletes across shared tables.
- **Postgres through Hyperdrive.** Mature SQL, `tsvector` and `pgvector`, region choice by provider.
  Rejected: an always-on external database contradicts NFR-COST-1 and the 15-minute self-host goal, adds
  a second vendor and credentials, and moves residency outside the Cloudflare jurisdiction controls.
- **Workers KV for mailboxes or the directory.** Cheap and global. Rejected: eventual consistency breaks
  idempotency, routing after deletion (tombstones) and "searchable when stored".
- **One Durable Object per tenant instead of per identity.** Fewer objects and cheap tenant search.
  Rejected: one busy identity would slow its whole tenant, the 10 GB limit would apply to a tenant's
  entire history, and identity erasure could not use `delete_all()`.
