# 0001 Rust on Workers

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-09 |
| Deciders | Pylota engineering |
| Related | PRD goals 6–7, NFR-SEC-2, NFR-COST-1; [Rust workspace](../design/rust-workspace.md); spikes S1, S4, S5, S6 |

## Context

Pylota Mail parses hostile input (every byte of inbound mail), holds tenants' correspondence, and must
deploy to a stranger's Cloudflare account with no always-on compute (NFR-COST-1). The REST API, MCP
server, CLI and SDK should share one contract and as much logic as possible (PRD goal 6). Cloudflare's
Workers SDK and most examples are TypeScript; Rust runs on Workers as WebAssembly through `workers-rs`.

What `workers-rs` `worker` 0.8.7 provides (docs.rs item list and type pages, read 2026-10-09):

- `Env` accessors for `ai`, `analytics_engine`, `bucket` (R2), `d1`, `durable_object`, `kv`, `queue`,
  `rate_limiter`, `secret`, `secret_store`, `send_email`, `service`, `hyperdrive`, `assets` and `var`.
- Email: `EmailMessage`, `ForwardableEmailMessage`, `SendEmail` with a builder, attachments with
  disposition and content kinds.
- Durable Objects: `Storage::sql()` (`SqlStorage`), `transaction`, `set_alarm`, `get_alarm`,
  `delete_alarm`, `delete_all`; `ObjectNamespace::unique_id_with_jurisdiction`, whose documentation
  says jurisdiction constraints only apply to IDs created by `unique_id()`.
- Queues: `Queue::send`, `send_batch`; `MessageBatch` and `Message` for consumers. Scheduled events.
- Panic recovery, implemented in 0.6.2 and on by default from 0.6.5 (a panic fails only the in-flight
  request).

Gaps found in the same reading, and the Rust answer to each:

| Gap in 0.8.7 | Answer |
|---|---|
| No Workflows API | Durable Object state machines driven by alarms ([ADR 0005](0005-state-machines.md)) |
| No Vectorize binding | `wasm-bindgen` extern on `env.VECTORS`, REST fallback (S6) |
| `AI.run` options (`gateway`) and `AI.toMarkdown` not wrapped | `wasm-bindgen` externs, REST fallback `/ai/tomarkdown` (S6) |
| `transactionSync` not wrapped | Extern on `Storage::as_raw()` (S1) |
| Durable Object point-in-time recovery (bookmarks) not wrapped | Extern on `Storage::as_raw()` in the restore tooling (P1) |
| `Queue.metrics()` not wrapped | Not used; queue lag is measured by consumers |
| Jurisdiction only on unique IDs | Store every object ID in D1 ([ADR 0002](0002-storage.md)) |
| No tokio, no `SystemTime` on wasm32 | Runtime-agnostic crates; platform clock and RNG; `mail-builder` without `gethostname` |

## Decision

1. The whole repository is Rust: the Worker, the core library, the SDK, the CLI, the conformance
   runner and `xtask`.
2. The Worker uses `worker =0.8.7` and is built with `worker-build` 0.8.7. Upgrades are deliberate and
   pass the S1 smoke checks and the full integration suite.
3. Only `crates/platform` imports `worker`. Every other crate reaches Cloudflare through `platform`
   traits, so the SDK can change in one place and logic runs natively in tests.
4. `crates/core` does no I/O, builds for the host and `wasm32-unknown-unknown`, and holds every rule
   that can be expressed without effects.
5. Missing APIs are reached through `wasm-bindgen` externs in `platform`, never through handwritten
   JavaScript.

Non-Rust artefacts that remain, all of them tools, configuration or data:

- the JavaScript entry shim that `worker-build` generates (a build artefact, never committed);
- `wrangler` 4.139.0 and Node.js 22+, used as tools for local development (`wrangler dev`) and deploy;
- TOML (`wrangler.toml`, Cargo), SQL migrations, CI YAML, Markdown, and the site's HTML and CSS.

## Consequences

- One language and one type system from MIME parsing to the SDK. `mail-parser`, `mail-auth`,
  `mail-builder` and `ammonia` are memory-safe and do no I/O, so they run in the Worker and natively.
- Most logic is tested with `cargo test` without workerd; integration tests drive a local workerd.
- `workers-rs` is pre-1.0: exact pins, one crate to update, and externs to maintain until upstream adds
  the APIs (worth contributing upstream).
- Bundle size and startup are a budget, not a given: NFR-SEC-2 requires ≤ 10 MiB compressed and
  startup under 1 s; spike S4 measures it and `cargo xtask build-worker` enforces it.
- Self-hosters need Node.js for `wrangler`, but no Rust toolchain: `pmail deploy` uses a prebuilt,
  checksum-verified bundle (FR-OPS-2).
- Fewer examples exist for Rust Workers; the design documents compensate with exact signatures.

## Alternatives considered

- **TypeScript Worker.** The best-supported path: every binding, Workflows, the Agents SDK, and
  `vitest-pool-workers`. Rejected because the parsing and authentication libraries we trust are Rust,
  a TypeScript Worker would still need a separate Rust or Node CLI, and the product's main risk is
  hostile input, where memory safety and a fuzzable pure core matter most.
- **Mixed: a Rust core compiled to wasm inside a TypeScript Worker.** Keeps the TypeScript bindings and
  the Rust parsers. Rejected: two toolchains and two test stacks, marshalling across the boundary for
  every message, and a split codebase that breaks the "one contract" goal and the AGENTS.md rule.
- **Cloudflare Containers running a native Rust server.** Any crate, tokio, and a familiar server model.
  Rejected: always-on or cold-started containers cost money when idle (NFR-COST-1), add an operational
  surface, and still need a Worker for email, queues and Durable Objects.
