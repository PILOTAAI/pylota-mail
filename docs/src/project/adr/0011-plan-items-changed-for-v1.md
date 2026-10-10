# 0011 Plan items that v1.0 defers or does differently

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-10 |
| Deciders | The owner (TREFT LTD) |
| Related | [PRD § 5 and § 13](../prd.md), [MCP § 8](../design/mcp.md#8-oauth-21-plan-v11), [Search › Agentic budgets](../design/search.md), [Privacy § 5.4](../design/privacy.md#54-optional-r2-backup-copy), [Security § 3.6](../design/security.md#36-tb6-operators-of-the-deployment), NFR-OPS-2 |

## Context

The research plan that preceded the design (9 October) promised four things that the design pages
changed without a recorded decision: OAuth 2.1 for the MCP endpoint, a per-tenant cap on the tokens that
agentic search spends, an event-driven copy of every new R2 object with a 15-minute recovery point, and
"logged break-glass" access by the operator to tenants' mail. A coding agent reading the plan and the
design side by side could not tell which one is binding. This record settles each.

Facts read on 2026-10-10: R2 can send an event notification for each `object-create` to a queue
(`wrangler r2 bucket notification create … --event-types object-create --queue …`, Wrangler R2 commands
page); R2 has no versioning or replication (R2 S3 API compatibility page, read 2026-10-09).

## Decision

1. **MCP OAuth 2.1 is deferred to v1.1.** v1.0 authenticates MCP clients with the same API keys as the
   REST API, sent as bearer tokens, with the same scopes and audit. The v1.1 plan is
   [MCP § 8](../design/mcp.md#8-oauth-21-plan-v11). Nothing in v1.0 may depend on it.
2. **No per-tenant token cap in v1.0.** Agentic search's model spend is bounded instead by four limits
   that exist and are tested: the per-key rate limit (`RL_AGENTIC`, 20 a minute), the workspace's
   `search.agentic_daily_cap` (500 a day by default, lower-only), and per request
   `search.agentic_max_steps` (6 model calls) and `search.agentic_max_seconds` (8 s). Together they cap
   the model calls a workspace can cause per day; tokens per call are bounded by the planner's
   `max_completion_tokens` and the fenced context size ([Search](../design/search.md)). A token-based cap
   needs token counts from every model response and a billing decision, and is reconsidered when
   `ai_neurons` usage shows a workspace whose spend the call limits do not bound.
3. **Blob backup is a nightly copy, off by default, on for Cloud.** `PM_BACKUP_BUCKET` enables a nightly
   `backup` job (RPO 24 hours against a bug that deletes objects); Pylota Mail Cloud sets it to
   `pylota-mail-backup`. Infrastructure loss is covered by R2's durability (RPO 15 minutes, NFR-OPS-2).
   An event-driven copy (an `object-create` notification per object, copied by a queue consumer) was not
   chosen: it doubles queue traffic for every inbound and outbound message, and every copy made after
   an erasure's delete would resurrect the object in the backup, which the nightly job prevents with one
   check per copy ([Privacy § 5.4](../design/privacy.md#54-optional-r2-backup-copy)).
4. **Break-glass reads are logged.** Every read of mail content by a platform key or a partner key
   writes a `mail.read` audit row before the response, and fails closed if it cannot
   ([Security § 3.6](../design/security.md#36-tb6-operators-of-the-deployment)). The operator reaches a
   tenant's mail only with a platform key, so every such access is recorded.

## Consequences

- The plan is superseded on these four points; the PRD, the design pages and the build plan follow this
  record.
- v1.0 MCP clients must be given an API key; clients that only speak OAuth wait for v1.1.
- A workspace can spend at most `agentic_daily_cap × agentic_max_steps` agentic model calls a day; the
  per-call token bound keeps that a fixed ceiling, not a token budget.
- Cloud pays one list operation per 1,000 objects a night and one write per new object for the backup.
- Partner keys that read mail (Pylota reads with tenant and identity keys, so rarely) cost one D1 write
  per read.

## Alternatives considered

- **Build MCP OAuth 2.1 in v1.0.** Adds an authorisation server, client registration and token storage
  to a release whose agents already work with keys.
- **A token cap now.** Needs reliable token counts from every model and a policy for what happens
  mid-answer when it is reached.
- **Event-driven blob copy.** Above.
- **No audit of reads.** Leaves operator access to tenants' mail unrecorded.
