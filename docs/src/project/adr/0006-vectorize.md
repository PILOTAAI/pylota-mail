# 0006 Vectorize for semantic search

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-09 |
| Deciders | Pylota engineering |
| Related | FR-SRCH-1, FR-SRCH-7, FR-SRCH-11, NFR-QUAL-1, NFR-PERF-4, NFR-COST-1; [Search](../design/search.md); [Privacy](../design/privacy.md); spike S6 |

## Context

Hybrid search is the default mode and must reach recall@10 ≥ 0.90 on the golden mailbox (NFR-QUAL-1).
Keyword search (FTS5 and exact references) is necessary but misses paraphrases ("did the insurer
accept the claim" against "we are pleased to confirm…"). Semantic retrieval needs a vector index that
filters by identity, thread, date, sender domain, direction and verdict, isolates tenants, deletes by ID
for erasure, and costs nothing when idle.

Vectorize facts (the brief verified 2026-10-09; client API page read 2026-10-09): up to 1,536
dimensions; 20,000,000 vectors and 50,000 namespaces per index; 10 metadata indexes with up to 64 bytes
indexed each; `topK` up to 100 without values or metadata (50 with); vector IDs up to 64 bytes; upserts
of up to 1,000 vectors per call from Workers; mutations are asynchronous and return a mutation ID, and the
index reports `processedUpToMutation` and `processedUpToDatetime`; the binding offers `deleteByIds` but
no way to delete a namespace. There is no documented data-location (jurisdiction) option.
`workers-rs` 0.8.7 has no Vectorize binding ([ADR 0001](0001-rust-on-workers.md)).

## Decision

1. One index per deployment, `pm-mail-chunks`: 1,024 dimensions (`@cf/baai/bge-m3`), cosine metric.
2. **Namespace = tenant ID.** Every query names the caller's tenant namespace and filters on
   `identity_id`; tenant scope requires a tenant-level key (FR-SRCH-10).
3. **Vector ID** `{message_id}:{n}` or `{message_id}:a{k}:{n}`. Metadata: the eight indexed filter fields
   only (`identity_id`, `thread_id`, `sent_at`, `sender_domain`, `direction`, `has_attachment`,
   `verdict`, `kind`). **Never text, subjects or addresses.**
4. Queries use `returnMetadata: "none"`. The message ID is parsed from the vector ID, and text is always
   read back from the mailbox, which applies visibility (quarantine, holds, erasure, scope) and drops any
   ID it does not own.
5. The mailbox's `chunks` table maps every vector ID to its message, so erasure and retention delete
   vectors by ID; tenant erasure ends with a namespace sweep ([Privacy](../design/privacy.md#66-tenant-scope)).
6. Access is through a `wasm-bindgen` extern on the binding, with the REST API as fallback (S6).
7. Writes come from the `pm-index` queue; `semantic_coverage` reports the embedded share of a mailbox
   and a nightly reconciliation compares chunk counts ([F4](../edge-cases.md), [F14](../edge-cases.md)).

## Consequences

- Semantic search with no servers and no idle cost, filtered and tenant-scoped.
- Residency: Vectorize is outside the jurisdiction controls. Because it holds no text, subjects or
  addresses, what leaves the jurisdiction is embeddings, IDs and filter fields. Embeddings are derived
  from content and are treated as personal data: erased with their message. The privacy documentation
  says so.
- Keyword search is never behind; semantic results can lag by seconds to minutes, and the response says
  how much (`semantic_coverage`, FR-SRCH-7). When Vectorize is unavailable, hybrid search falls back to
  keyword with `degraded: true`.
- Erasure must wait for asynchronous deletes before its probe ([Privacy](../design/privacy.md#68-waiting-for-vectorize)).
- At most 50,000 tenants per index; a larger deployment needs a second index and an ADR.
- Changing the embedding model means a background re-embed into the same IDs.

## Alternatives considered

- **pgvector on Postgres through Hyperdrive.** Mature, joins with metadata, a provider region of choice.
  Rejected: an always-on external database (NFR-COST-1), another vendor and credential set, and a second
  store to erase.
- **An external vector database service.** Rich filtering, region choice with some vendors. Rejected:
  another processor holding derived personal data, egress of embeddings over the internet, credentials in
  the Worker, and per-vendor deletion semantics to prove.
- **Vectors inside each mailbox Durable Object** with brute-force similarity in Rust. Inside the
  jurisdiction and erased with the mailbox. Rejected for v1.0: CPU cost grows with mailbox size on every
  query, tenant search would scan up to 100 mailboxes' vectors, and SQLite extensions for vector search
  cannot be loaded in Durable Objects. It remains the fallback if a deployment needs semantic search
  inside the jurisdiction, which would need an ADR.
- **Keyword search only.** Simplest and fully resident. Rejected: it cannot meet the recall gate on
  paraphrased questions, and agentic search depends on semantic recall.
