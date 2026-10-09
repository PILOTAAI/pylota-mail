# Contributing

Thanks for helping. Pylota Mail is published under the [Functional Source License 1.1 (FSL-1.1-ALv2)](LICENSE.md).

By contributing you agree that your contribution is licensed to TREFT LTD, the company behind Pylota, under the Apache License 2.0, so that
Pylota can distribute it under FSL-1.1-ALv2 now and under Apache-2.0 when each release converts. Sign off every
commit (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org).
There is no separate CLA.

## Before you start

- Read [AGENTS.md](AGENTS.md) for the language, runtime and testing rules (they apply to humans too).
- For anything larger than a bug fix, open an issue first describing the change. Changes to a public
  contract (REST API, webhook events, MCP tools, CLI commands) need a short ADR in `docs/src/project/adr/`.

## Development setup

```bash
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
cargo install mdbook --version 0.5.4 --locked
npm i -g wrangler@4.114.0      # local runtime and deploy tool (Node CLI); no JS is written in this repo
cargo test --workspace
cargo xtask itest
```

## Pull requests

- One logical change per PR, with a test that fails without it.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass.
- New edge cases go into `docs/src/project/edge-cases.md` with the test that covers them.
- Do not commit secrets, real email addresses or real message content. Test fixtures use `example.com`,
  `example.org` and `example.net` (RFC 2606).

## Releases

Semantic versioning. The REST API is versioned by path (`/v1`). Breaking changes to `/v1` are not allowed;
deprecations are announced in the changelog at least one minor release ahead.
