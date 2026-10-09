# Instructions for coding agents

This file is the entry point for any AI coding agent (Claude Code, Codex, Cursor, etc.) working in this
repository. Humans should read it too.

## Read first, in this order

1. `docs/src/project/prd.md` — what we are building and why. Requirements have IDs (FR-*, NFR-*).
2. `docs/src/project/architecture.md` — components, data flow, Cloudflare primitives.
3. `docs/src/project/design/*.md` — the detailed design for each subsystem. These are binding.
4. `docs/src/reference/api.md` and `docs/src/reference/openapi.yaml` — the public contract.
5. `docs/src/project/build-plan.md` — the order of work, file by file, with acceptance tests.
6. `docs/src/project/edge-cases.md` — every row must end up covered by a named test.

If the code and the design disagree, the design wins until a design change is written down in
`docs/src/project/adr/`. Do not silently change a public contract (API, events, CLI, MCP tool names).

## Language and runtime rules

- **Rust only.** The whole product is Rust (plus Markdown, TOML, SQL, YAML, and HTML/CSS for the site).
  Do not add TypeScript or JavaScript source files. There is one exception:
  `site/public/assets/app.js`, the landing page's progressive-enhancement script (tabs, copy buttons,
  theme toggle). It has no build step and no dependencies, and the page works fully without it. The
  JavaScript shim emitted by `worker-build` is a build artifact and is never committed.
- Target: Cloudflare Workers via [`workers-rs`](https://github.com/cloudflare/workers-rs), crate `worker`,
  pinned to an exact version in `Cargo.toml` (`=0.8.7` at the time of writing). Upgrade deliberately.
- **Only `crates/platform` may import `worker`.** Every other crate talks to Cloudflare through traits in
  `platform`, so the SDK can change in one place and logic can be tested natively.
- `crates/core` does no I/O and has no `worker` dependency. It must build for both the host target and
  `wasm32-unknown-unknown`.
- No tokio in the crates compiled into the Worker (`core`, `api-types`, `platform`, `worker`); use
  runtime-agnostic crates there. Native-only crates (`cli`, `sdk`, `conformance`, `xtask`) may use it, and
  `rmcp`, which needs tokio, is a native dev-dependency only. No `std::time::SystemTime::now()` in wasm code
  (use the platform clock). No `gethostname`.
- Pin every dependency to an exact version (`=x.y.z`). Prefer crates with no I/O.

## Commands

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                       # native unit tests (core, api-types, sdk, cli, conformance)
cargo xtask build-worker                     # worker-build --release, wasm-opt, size budget check
cargo xtask itest                            # integration tests against a local workerd (wrangler dev)
cargo xtask fuzz --target mime_parse --time 60
mdbook build docs                            # builds docs into site/public/docs
```

## Non-negotiables (each is tested)

- Tenant isolation: every Durable Object and every D1 query is scoped by tenant and identity taken from the
  authenticated key, never from the request body.
- `Idempotency-Key` is required on send, reply, reply-all and forward. Same key + same body returns the
  original result. Same key + different body returns `409 idempotency_conflict`. A transport outcome that
  is unknown becomes `uncertain` and is never resent automatically.
- Raw mail is written to R2 before an inbound message is acknowledged.
- Webhooks use Standard Webhooks signing with a per-endpoint secret. No secret is derived from another.
- Content from email is untrusted. It is never interpreted as instructions by the agentic search planner
  or by triage. Planner tools are read-only.
- Logs never contain message bodies or clear-text email addresses.
- Every error uses the envelope in `docs/src/reference/errors.md`, with `retryable` set correctly.

## Definition of done for any change

- A test that fails without the change and passes with it.
- `fmt`, `clippy -D warnings`, native tests and integration tests green.
- Docs updated when a contract or behaviour changes.
- Edge-case rows touched by the change still map to passing tests.
