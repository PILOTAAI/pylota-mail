# 0009 Local MCP protocol types

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-09 |
| Deciders | Pylota engineering |
| Related | FR-MCP-1; spike S5 ([Design › Spikes](../design/index.md#spikes)); [MCP server §2.7](../design/mcp.md#27-protocol-types-rmcp-and-spike-s5); `AGENTS.md` ("No tokio") |

## Context

Spike S5 asks whether the Worker can serve MCP over Streamable HTTP using the protocol types of `rmcp`
3.5.1 without a tokio runtime. Its pass criterion is "using `rmcp` 3.5.1 protocol types (no tokio)".

The crates.io index entry for `rmcp` 3.5.1 (read 2026-10-09 from `index.crates.io`) lists `tokio`
(`^1`, features `sync`, `macros`, `rt`, `time`) and `tokio-util` (`^0.7`) as normal dependencies with
`optional: false`. Any build that depends on `rmcp` therefore compiles tokio into the Worker, which
`AGENTS.md` forbids. The pass criterion cannot be met as written, whatever the spike measures.

Taking a spike's fallback needs an ADR ([Decision records](index.md#when-to-write-one)).

## Decision

1. The S5 fallback is taken now, before M1: the Worker **must** implement the JSON-RPC envelope and the
   MCP messages it serves as its own `serde` types in `crates/worker/src/mcp/schemas.rs`, following
   `schema.ts` of the `2026-07-28` and `2025-11-25` revisions.
2. `rmcp` **must not** be a dependency of the Worker build. It is a native dev-dependency of
   `crates/worker` (pinned `=3.4.1`; amended 2026-10-10, see [Amendments](#amendments)), used by a round-trip test that serialises every local type and
   reads it back with `rmcp::model`, and by the live MCP client test.
3. M1 still runs S5 against the local types and records the result: MCP Inspector and Claude Code
   connect, list tools and call one, and the bundle stays inside the S4 budget.

## Consequences

- The Worker carries a few hundred lines of protocol types. The round-trip test against `rmcp` keeps them
  from drifting from the official SDK.
- A new MCP revision needs the local types updated by hand; the round-trip test fails until they are.
- If a later `rmcp` release makes tokio optional, a new ADR may switch the Worker to its types.

## Alternatives considered

- **Depend on `rmcp` and never start a runtime.** Tokio's `sync`, `macros`, `rt` and `time` features
  compile for wasm, but timers panic where the platform has none, and the dependency itself breaks the
  "No tokio" rule and adds to the bundle. Not chosen.
- **Fork `rmcp` with tokio made optional.** A fork is a maintained dependency with no upstream. Not
  chosen.

## Amendments

- **2026-10-10.** The pin in decision 2 is `=3.4.1`, not `=3.5.1`. 3.5.1 was published on 2026-10-05,
  inside the two-week age rule for dependencies
  ([Rust workspace §3](../design/rust-workspace.md#3-workspace-dependencies)). 3.4.1, published on
  2026-09-23, lists the same features and the same non-optional tokio dependency (crates.io sparse index,
  read 2026-10-10), so the context and the decision are unchanged.
