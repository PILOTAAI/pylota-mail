# 0005 State machines instead of Workflows

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-09 |
| Deciders | Pylota engineering |
| Related | FR-DOM-4, FR-DOM-5, FR-ADR-2, FR-PRV-2, FR-PRV-3, NFR-PRV-1; [Privacy](../design/privacy.md); [Identities and domains](../design/identity-domains.md); [ADR 0001](0001-rust-on-workers.md) |

## Context

Several processes run for minutes to weeks and must survive restarts, retry with backoff, and leave an
auditable history: domain verification and health (checks every 15 minutes, reminders at 24 h, 72 h and
7 days, suspension after 14 days failing), address retirement (default 90 days), erasure (within
24 hours, NFR-PRV-1), retention sweeps, exports, re-embedding and re-parsing, outbox drains and outbound
reconciliation.

Cloudflare Workflows provides durable steps for this in JavaScript and Python. `workers-rs` 0.8.7 has
no Workflows API: the crate's item list contains no Workflow type (docs.rs, read 2026-10-09). Durable
Object alarms, Queues with delays up to 24 hours, and cron triggers are all available from Rust.

Durable Object facts (Cloudflare docs, read 2026-10-09): an object has one alarm; alarms are delivered
at least once and a failed handler is retried with exponential backoff; for compatibility dates from
2026-02-24, `deleteAll()` also deletes the alarm.

## Decision

1. Long-running processes are **explicit state machines inside Durable Objects**, driven by the object's
   alarm: `DomainMonitor` (domain verification and health), `JobRunner` (erasure, retention, export,
   re-embed, re-parse, re-index, domain removal), and purpose-tagged alarms in `IdentityMailbox` (outbox
   drain, thread locks, reconciliation) and for address retirement.
2. Each machine has a state table (for jobs, `steps` with `status`, `cursor`, `counts_json`, `attempts`,
   `last_error`), idempotent steps that resume from their cursor, a bounded retry budget with backoff,
   and an event or audit record per transition.
3. The pure transition rules live in `core` (for example `core::domain_fsm`, job step planners, the
   receipt builder); the objects perform the effects.
4. One alarm per object serves many purposes: pending wake-ups are kept in `meta` under
   `alarm:{purpose}` and the alarm is set to the earliest one ([Design conventions](../design/index.md#4-durable-object-transactions)).
5. Cron triggers (`* * * * *`, `*/15 * * * *`) only schedule and repair: they start jobs, enqueue domain
   checks and restart anything stuck. They never carry the state.
6. Queues carry fan-out work and retries with delays; they never hold a process's state.

## Consequences

- Everything stays in Rust, in one Worker, with no second deployable.
- The state machines are plain code: their rules are unit-tested natively, and integration tests run an
  object's alarm on demand under a fake clock ([Testing](../design/testing.md#65-time-control)).
- We own what Workflows would provide: retries, backoff, step journals, timeouts and visibility. Each
  design specifies them, and the alert evaluator watches for stuck or failed jobs.
- Alarms are at least once, so every step is idempotent and every count comes from committed work.
- If `workers-rs` gains a Workflows API, moving a machine to it needs a new ADR; the step model maps
  directly onto Workflows steps.

## Alternatives considered

- **Workflows through a TypeScript sidecar Worker** called over a service binding. Durable steps, sleeps
  and retries for free, with Cloudflare's own tooling. Rejected: it breaks the Rust-only rule
  ([ADR 0001](0001-rust-on-workers.md)), adds a second deployable and binding to self-hosting, and splits
  every process's logic across two languages and two test stacks.
- **Cron-only sweeps** that scan tables every few minutes. Simple, no per-entity state. Rejected: coarse
  latency (erasure and domain reactions wait for the next sweep), a thundering herd over every domain and
  job, no durable per-step progress, and hard resumption after partial failure.
- **Queues alone**, re-enqueuing the next step with a delay. Durable hand-offs. Rejected as the only
  mechanism: no place to keep a step journal and counts, no single owner to serialise a process, and
  dead-lettered steps would lose the process's context. Queues are still used for fan-out.
