# Search

Every identity's mailbox is searchable in four modes that return one result shape. This guide shows
when to use each mode, the query language, exact references, filters and pagination, tenant-wide
search, and agentic search with verified citations. It ends with tips for agents and the limits.

## Choose a mode

| Mode | How it works | Use it when |
|---|---|---|
| `keyword` | SQLite FTS5 full-text search (BM25) plus exact reference matching, inside the mailbox | You know words, a sender or a reference: `ref:AB12CDE`, `"brake pads"`, `from:@brightwell.example` |
| `semantic` | The query is embedded (`@cf/baai/bge-m3`) and matched against message and attachment chunks in Vectorize | The words in the mail may differ from yours: "complaint about a dirty car" |
| `hybrid` (default) | Keyword and semantic together, fused by reciprocal rank (k = 60), with the top 50 reranked (`@cf/baai/bge-reranker-base`) | Most searches. Start here |
| `agentic` | A model plans searches, runs them, judges the results, refines and answers, within a budget. Code checks every citation | A question that needs several lookups: "Did the insurer accept the Golf claim after we sent the photos?" |

Keyword search is never behind the mailbox: a message is searchable in the same transaction that
stores it ([FR-SRCH-2](../project/prd.md#68-search)). Semantic indexing runs in the background, and
every result reports how much of the mailbox is embedded (`semantic_coverage`).

## Make a request

```bash
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V4/search \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Content-Type: application/json" \
  -d '{"q":"from:@brightwell.example ref:AB12CDE has:attachment newer_than:45d","mode":"hybrid","limit":10}'
```

The same with the CLI:

```bash
pmail search "from:@brightwell.example ref:AB12CDE has:attachment newer_than:45d" \
  --identity maintenance@acme.example.com --mode hybrid
```

Search needs `search:read`. Agentic mode needs `search:read` and `search:agentic`, at identity or
tenant scope ([Search across a tenant](#search-across-a-tenant)). The MCP tools are `mail_search` and
`mail_deep_search`.

## Query operators

The query is parsed into a typed tree before anything runs, so quotes, FTS5 syntax or column filters
in the input can never reach the search engine ([F1](../project/edge-cases.md)). An unparseable query
fails with `400 invalid_query`, and `details.position` and `details.expected` say where and what.

| Operator | Matches | Example |
|---|---|---|
| words | Words anywhere in the subject, participants, body or attachment text | `brake discs` |
| `"…"` | An exact phrase | `"penalty charge notice"` |
| `from:` | The sender's address or domain | `from:accounts@brightwell.example`, `from:@brightwell.example` |
| `to:` | A recipient | `to:claims@admiral.example` |
| `participant:` | Any of sender, `To` or `Cc` | `participant:@leeds.gov.example` |
| `subject:` | Words or a phrase in the subject | `subject:"change of dates"` |
| `ref:` | An exact reference, after normalisation | `ref:AB12CDE` (plate), `ref:WM12345678` (PCN), `ref:88213` (invoice), `ref:BK-2291` (booking, a custom reference) |
| `label:` | A label | `label:claims` |
| `has:attachment` | Messages with attachments | `has:attachment` |
| `filename:` | An attachment's file name | `filename:INV-88213.pdf` |
| `type:` | An attachment's type | `type:pdf` |
| `after:`, `before:` | Dates, in the tenant's time zone | `after:2026-09-01 before:2026-10-01` |
| `newer_than:`, `older_than:` | Relative age | `newer_than:45d` |
| `in:` | Direction | `in:inbound`, `in:outbound` |
| `thread:` | One thread | `thread:thr_01JA…` |
| `is:` | State | `is:unread`, `is:needs_reply`, `is:quarantined` |
| `category:` | Triage category | `category:billing`, `category:legal_compliance` |
| `OR` | Either side | `ref:WM12345678 OR "penalty charge"` |
| `-` | Negation | `-from:@newsletter.example` |

Some car-rental examples:

```text
ref:AB12CDE has:attachment type:pdf                 every PDF that mentions the plate AB12 CDE
ref:WM12345678 OR subject:"penalty charge"          a PCN by number, or anything titled like one
ref:BK-2291 in:outbound                             what we sent about booking BK-2291
from:@admiral.example ref:CL-77812 newer_than:30d   the insurer's mail about claim CL-77812 this month
from:@brightwell.example ref:88213                  the garage's invoice 88213
category:legal_compliance is:needs_reply            compliance mail waiting for an answer
```

Date filters resolve in the tenant's time zone and results show UTC ([F9](../project/edge-cases.md)).
`is:quarantined` returns results only for a key with `quarantine:review` ([F7](../project/edge-cases.md)).

## Exact references

References are identifiers extracted from the subject, body and attachment text when mail arrives,
normalised, and matched exactly ([FR-SRCH-4](../project/prd.md#68-search)). They are the most reliable
way to find mail about a specific car, booking or invoice.

| Pack | Kinds |
|---|---|
| `core` (on by default) | Amounts, phone numbers, email addresses, domains, dates, invoice and order numbers |
| `uk_vehicle` (optional) | UK vehicle registration plates and penalty charge notice (PCN) numbers |

Normalisation means formatting does not matter: `AB12 CDE`, `ab12cde` and `AB12CDE` in a message all
match `ref:AB12CDE` ([F5](../project/edge-cases.md)). Amounts are stored with their currency
(`GBP:412.80`) and phone numbers in international form (`+447700900123`).

Turn packs on, and add your own patterns, in the tenant policy: on the console's policy page (owners and
admins), or with `PATCH /v1/tenants/{tenant_id}/policy` and a tenant key that holds `policy:write`
(platform and partner keys can also use `PATCH /v1/tenants/{tenant_id}`):

```json
{
  "policy": {
    "search": {
      "refs_packs": ["core", "uk_vehicle"],
      "custom_refs": [
        { "name": "booking", "pattern": "BK-\\d{4,6}", "normalise": "upper" },
        { "name": "claim",   "pattern": "CL-\\d{5}",   "normalise": "upper" }
      ]
    }
  }
}
```

- Up to 20 custom patterns. They use the Rust `regex` crate's syntax: linear-time matching, no
  back-references, compiled size capped at 64 KB.
- A custom reference is stored with the kind `custom:<name>`, for example `custom:booking`.
- References are extracted at ingest, so a pack or pattern applies to mail that arrives after you add
  it. See the [Search design](../project/design/search.md) for re-indexing stored mail.

Each hit's `why` list says where a reference matched, for example `ref:AB12CDE (attachment p.1)`.

## Filters, facets and grouping

The request body takes more than the query string:

```json
{
  "q": "brake discs",
  "mode": "hybrid",
  "filters": { "direction": "inbound", "labels": ["invoice"], "after": "2026-09-01T00:00:00Z", "before": null },
  "group_by": "thread",
  "limit": 10,
  "snippet_chars": 240,
  "facets": true,
  "include_quarantined": false,
  "cursor": null
}
```

| Field | Notes |
|---|---|
| `filters` | `direction`, `labels`, `after`, `before`. The same as the operators, for code that builds queries |
| `group_by` | `message` (default) or `thread`. With `thread`, each hit is one thread with `thread_id`, `subject`, `participants`, `message_count`, `last_at`, the best `snippet` and `why`, and `top_message_id` |
| `limit` | Default 10, maximum 50 |
| `snippet_chars` | Snippet length, 40–1,000, default 240 |
| `facets` | Counts by sender, sender domain, month, label, attachment type and category (`sender`, `sender_domain`, `month`, `label`, `attachment_type`, `category`), to help narrow a search |
| `include_quarantined` | Include quarantined mail, which search leaves out by default. Honoured only for a key with `quarantine:review`; for any other key quarantined mail stays out, with no error |
| `require_mode` | `true` makes the request fail with `503 search_degraded` if the requested mode is unavailable, instead of degrading |

## Read the results

```json
{
  "query": { "parsed": "from:@brightwell.example ref:AB12CDE has:attachment newer_than:45d", "mode": "hybrid" },
  "hits": [{
    "message_id": "msg_01J…", "thread_id": "thr_01J…", "identity_id": "idn_01J…",
    "date": "2026-09-14T08:12:00Z", "direction": "inbound",
    "from": { "name": "Brightwell Leeds", "address": "accounts@brightwell.example" },
    "subject": "Invoice 88213 – AB12 CDE",
    "snippet": "…brake pads and discs, total £412.80 inc VAT…",
    "score": 0.913,
    "why": ["ref:AB12CDE (attachment p.1)", "from:brightwell.example", "type:pdf"],
    "attachment_hits": [ { "attachment_id": "att_…", "filename": "INV-88213.pdf", "page": 1 } ],
    "trust": { "verdict": "pass", "known_sender": true, "quarantined": false }
  }],
  "facets": { "sender": { "accounts@brightwell.example": 3 }, "sender_domain": { "brightwell.example": 3 },
              "month": { "2026-09": 2, "2026-08": 1 }, "label": { "invoice": 3 }, "attachment_type": { "pdf": 3 },
              "category": { "billing": 3 } },
  "next_cursor": null, "truncated": false, "semantic_coverage": 0.998, "degraded": false,
  "as_of": "2026-10-09T10:12:00Z"
}
```

| Field | Meaning |
|---|---|
| `why` | Why each hit matched. If attachment text could not be extracted, `attachment_text_unavailable` appears here ([B12](../project/edge-cases.md)) |
| `trust` | The sender's verdict, so you can prefer verified mail |
| `semantic_coverage` | The share of the mailbox that is embedded. Below 1, semantic results may miss recent mail; keyword results never do ([F4](../project/edge-cases.md)) |
| `degraded` | `true` when part of the search was unavailable (for example Vectorize or the reranker) and the results come from what remained |
| `truncated` | `true` when the response hit the 256 KB cap and was cut. Lower `limit` or `snippet_chars`, or use `group_by: "thread"` ([F8](../project/edge-cases.md)) |

When keyword search finds fewer than three hits, a trigram index over subjects, participants and
references is tried as well, so typos and partial words still find something
([F5](../project/edge-cases.md)).

### How ranking works

- Keyword ranking is BM25 with column weights: references 10, subject 8, participants 4, new body text
  3, attachment text 1.5, full body (including quotes) 1. A match in the new part of a message counts
  more than one in quoted history.
- Hybrid fuses the keyword and semantic lists by reciprocal rank, then reranks the top 50.

## Pagination and `as_of`

Pass `next_cursor` back as `cursor` to get the next page. `next_cursor` is `null` on the last page.

The first page pins a point in time, returned as `as_of`, and every later page uses it. Mail that
arrives while you page through does not shift results between pages
([FR-SRCH-6](../project/prd.md#68-search)). Cursors expire after 24 hours (`410 cursor_expired`);
start again from the first page.

## Search across a tenant

A tenant, partner or platform key can search every identity of a tenant at once
([FR-SRCH-10](../project/prd.md#68-search)):

```bash
curl -X POST https://mail.example.com/v1/tenants/ten_01J9…/search \
  -H "Authorization: Bearer $TENANT_KEY" -H "Content-Type: application/json" \
  -d '{"q":"ref:AB12CDE","mode":"keyword","identity_ids":["idn_01J9Z3K8V4","idn_01J9Z3K8V5"]}'
```

CLI: `pmail search "ref:AB12CDE" --tenant acme`.

- Hits carry `identity_id`.
- Up to 100 identities. A tenant with more needs an `identity_ids` filter, otherwise
  `422 scope_too_large`.
- An identity key asking for tenant scope gets `403 scope_denied` ([F3](../project/edge-cases.md)).
- Every mode works here, `agentic` included: agentic search runs at identity or tenant scope, and at
  tenant scope it needs a tenant, partner or platform key with `search:read` and `search:agentic`. CLI:
  `pmail ask "<question>" --tenant acme`.
- If one identity's mailbox is slow or unavailable, the others are returned after a 900 ms deadline per
  identity, with `partial: true` and the missing ones in `failed_identities[]`
  ([F15](../project/edge-cases.md)).

## Related messages and contacts

- `GET /v1/identities/{identity_id}/messages/{message_id}/related?limit=10` returns semantically
  similar messages from other threads, as search hits (maximum 50). MCP: `mail_find_related`.
- `GET /v1/identities/{identity_id}/contacts?q=admiral` finds contacts by name, address or domain
  prefix, with first and last seen dates, message counts and the last thread. MCP:
  `mail_search_contacts`.

## Agentic search

Agentic search answers a question from the mailbox. It runs a bounded loop: **plan** searches,
**search** (several in parallel), **judge** and **refine**, then **answer**. A deterministic check then
verifies every citation before the answer is returned ([FR-SRCH-8](../project/prd.md#68-search)).

```bash
curl -X POST https://mail.example.com/v1/identities/idn_01J9Z3K8V5/search \
  -H "Authorization: Bearer $PYLOTA_MAIL_KEY" -H "Content-Type: application/json" \
  -d '{"q":"Did the insurer accept the Golf claim after we sent the photos?","mode":"agentic",
       "budget":{"max_steps":6,"max_seconds":8},"stream":false}'
```

```json
{
  "status": "answered",
  "answer": {
    "text": "Yes. Admiral accepted claim 7781 on 2 October, after the photos sent on 28 September [msg_01JA…][msg_01JB…].",
    "sentences": [ { "text": "Yes. Admiral accepted claim 7781 on 2 October…", "citations": ["msg_01JA…", "msg_01JB…"] } ],
    "confidence": 0.86
  },
  "evidence": [ { "message_id": "msg_01JA…", "...": "search hits, with quotes" } ],
  "trace": [
    { "step": 1, "action": "search", "q": "claim Golf photos", "mode": "hybrid", "hits": 7, "ms": 412 },
    { "step": 2, "action": "read_thread", "thread_id": "thr_01JA…", "ms": 38 },
    { "step": 3, "action": "answer", "removed_sentences": 0 }
  ],
  "degraded": false,
  "usage": { "steps": 3, "ms": 2810, "model": "@cf/qwen/qwen3.8-27b" }
}
```

### Statuses

| `status` | Meaning |
|---|---|
| `answered` | An answer whose every remaining sentence has verified citations |
| `insufficient_evidence` | The mail does not answer the question. The `trace` shows what was searched ([F13](../project/edge-cases.md)) |
| `budget_exhausted` | The step or time budget ran out. The evidence so far is returned, with no answer or a partial one ([F12](../project/edge-cases.md)) |
| `degraded` | The model was unavailable. Hybrid search results are returned, with no answer |

Agentic search never returns a fabricated answer ([FR-SRCH-9](../project/prd.md#68-search)).

### Citations

Every answer sentence lists the message IDs it relies on. Before the response is sent, code checks
each sentence: every cited ID must be in the evidence set, and every quoted phrase must appear in its
source. A sentence that fails is removed, and the removal is counted in the trace
(`removed_sentences`) ([F11](../project/edge-cases.md)). Show citations to people, and keep them when
an agent acts on an answer.

### Streaming

With `"stream": true` and `Accept: text/event-stream`, the response is a server-sent event stream:

```text
id: 1
event: evidence
data: {"hits":[{"message_id":"msg_01JA…","thread_id":"thr_01JA…","score":0.913,…}]}

id: 2
event: step
data: {"step":1,"action":"search","q":"claim Golf photos","mode":"hybrid","hits":7,"ms":412}

id: 3
event: answer
data: {"status":"answered","answer":{"text":"Yes. Admiral accepted claim 7781 …","sentences":[…],"confidence":0.86},"degraded":false}

id: 4
event: done
data: {"status":"answered","answer":{…},"evidence":[…],"trace":[…],"degraded":false,"usage":{…}}
```

`evidence` events carry the hits not sent before, `step` events carry each trace entry when it is
complete, `answer` comes once, and `done` is always last. `done` carries the complete response, the same
body as a call without `stream`, so a client may ignore every other event. A keep-alive comment
(`: keep-alive`) is sent after every 10 seconds of silence. Streams cannot be resumed. `pmail ask` uses
the stream to show progress.

### Budgets and costs

| Setting | Default | Where |
|---|---|---|
| Steps per question | 6 | `budget.max_steps` in the request; tenant default `search.agentic_max_steps` |
| Seconds per question | 8 | `budget.max_seconds`; tenant default `search.agentic_max_seconds` |
| Questions per tenant per day | 500 | `search.agentic_daily_cap`. Over it: `429 agentic_budget_exhausted` |
| Questions per key per minute | 20 | Rate limit. Over it: `429 rate_limited` |
| On or off | On | `search.agentic_enabled` |

Each question runs the planner model several times, so it costs far more than a hybrid search. Use it
for questions, not for lookups.

### Safety

The planner's tools are read-only, and it sees mail as fenced, untrusted snippets. It cannot widen
the caller's scope or filters, and mail that tries to steer it is flagged in the trace
([F10](../project/edge-cases.md)). Quarantined mail is never part of the evidence unless the key may
see it.

## Tips for agents

- **Exact first.** If the task names a plate, PCN, booking, invoice or claim number, search for it
  with `ref:` in `keyword` mode before anything else.
- **Narrow, then read.** Search with `group_by: "thread"` and a small `limit`, pick the thread, then
  read it with `mail_get_thread`, which returns `extracted_text` rather than whole quoted histories.
- **Use the operators.** `from:@domain`, `newer_than:` and `has:attachment` cut the result set far
  more than extra words do. Use `facets` to see where results cluster.
- **Ask questions with agentic mode**, and keep its citations when you act on the answer.
- **Check `trust` and `why`.** Prefer `verdict: pass` and known senders for anything that leads to an
  action.
- **Watch the flags.** If `degraded` is `true` or `semantic_coverage` is low, rely on keyword results.
  If `truncated` is `true`, ask for less.
- **Quote user text.** When you put words from a person or an email into a query, wrap them in
  quotes so they are searched as text, not read as operators.
- **Cite message IDs** in what you write, so a person can check.

The MCP server offers the `mail_search_strategy` prompt, which teaches a model these rules.

## Limits

| Limit | Value |
|---|---|
| Search requests (`keyword`, `semantic`, `hybrid`) | 120 per minute per key |
| Agentic search | 20 per minute per key, plus the tenant's daily cap (500 by default) |
| `limit` | 10 by default, 50 maximum |
| Response size | 256 KB, then `truncated: true` |
| Tenant search fan-out | 100 identities |
| Cursor lifetime | 24 hours |
| Custom reference patterns | 20 per tenant |

The targets are p95 ≤ 200 ms for keyword search, ≤ 800 ms for hybrid, ≤ 1 s for a tenant search across
up to 10 identities, and ≤ 8 s for agentic search with first evidence within 1.5 s
([PRD §7](../project/prd.md#7-non-functional-requirements)). All limits:
[Limits](../reference/limits.md).
