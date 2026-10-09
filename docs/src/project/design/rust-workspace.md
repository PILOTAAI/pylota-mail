# Rust workspace and platform

Binding for implementation. This page defines the Cargo workspace, what each crate may depend on, the
exact dependency pins, the build profile, the wasm32 rules, the `platform` trait set that isolates
`workers-rs`, the generated `wrangler.toml`, the `xtask` commands and the CI pipeline.

| | |
|---|---|
| Requirements | NFR-SEC-2, NFR-COST-1, FR-OPS-2, FR-PRV-1, FR-API-1 |
| ADRs | [0001 Rust on Workers](../adr/0001-rust-on-workers.md), [0002 Storage layout](../adr/0002-storage.md), [0005 State machines](../adr/0005-state-machines.md) |
| Build plan | M0 (skeleton), M4 (platform), M19 (release) |

Facts about external crates and Cloudflare on this page were read on 2026-10-09 from the crates'
published sources on crates.io/docs.rs, the `workers-rs` repository at tag `v0.8.7`, and
developers.cloudflare.com. Anything that could not be confirmed is marked "verify at build time" with
the spike that settles it.

## 1. Workspace layout

```text
Cargo.toml                 workspace, [workspace.dependencies], profiles
rust-toolchain.toml        stable channel, exact version pinned at build time (≥ 1.91, worker 0.8.7's MSRV)
.cargo/config.toml         target-specific rustflags (none required), alias `xtask = "run -p xtask --"`
deny.toml                  cargo-deny: licences, advisories, bans, sources
crates/
  core/                    package pylota-mail-core        lib pylota_mail_core
  platform/                package pylota-mail-platform    lib pylota_mail_platform
  api-types/               package pylota-mail-api-types   lib pylota_mail_api_types
  worker/                  package pylota-mail-worker      cdylib + rlib (the Worker)
  sdk/                     package pylota-mail             lib pylota_mail
  cli/                     package pylota-mail-cli         bin pmail
  conformance/             package pylota-mail-conformance (corpus, runners; publish = false)
xtask/                     package xtask (publish = false)
fuzz/                      cargo-fuzz project (outside the workspace members, nightly only)
migrations/d1/             D1 SQL migrations, 0001_init.sql …
deploy/wrangler.toml.tmpl  template rendered by `pmail setup`
spikes/                    M1 spike programs (not shipped)
```

Package names carry the `pylota-mail-` prefix because a package named `core` would shadow Rust's `core`
and one named `worker` would clash with the `worker` dependency. Commands use the package names, for
example `cargo test -p pylota-mail-api-types`.

All crates use edition 2024, `rust-version` equal to the toolchain pin, and
`#![forbid(unsafe_code)]` except `platform` (which needs `wasm-bindgen` glue).

## 2. Crate responsibilities and allowed dependencies

| Crate | Responsibility | May depend on | Must not depend on |
|---|---|---|---|
| `core` | Pure logic: MIME parsing and caps, sanitising, text derivation, quote stripping, references, classification, authentication verdicts, trust, attachment sniffing, thread tokens and threading rules, subject normalisation, address validation and confusables, query parser, fusion, citation verifier, triage rules, policy evaluation, DNS record parsing, the domain state machine, the connection-method matrix (`core::connect`), the SMTP client state machine (`core::smtp`), SNS message verification (`core::sns`), SigV4 and SES notification parsing (`core::ses`), TOTP codes (`core::totp`) | `api-types`; pure crates (`mail-parser`, `mail-auth`, `mail-builder`, `ammonia`, `html5ever`, `regex`, `sha2`, `hmac`, `base64`, `serde`, `serde_json`, `idna`, `psl`, `unicode-normalization`) | `worker`, `wasm-bindgen`, `js-sys`, `web-sys`, `platform`, `reqwest`, `tokio`, anything doing I/O, reading the clock or reading randomness |
| `platform` | Traits for every Cloudflare capability, their Cloudflare implementations (wasm32 only), and in-memory fakes (`platform::fakes`, native) | `worker`, `wasm-bindgen`, `wasm-bindgen-futures`, `js-sys`, `web-sys`, `getrandom`, `serde`, `serde_json`, `api-types` | `core` business rules (it is a capability layer), `tokio`, `reqwest` |
| `api-types` | Request, response, object and event types; `ErrorCode`; OpenAPI generation | `serde`, `serde_json`, `utoipa` | everything else |
| `worker` | HTTP router and handlers, `email`/`queue`/`scheduled` handlers, the four Durable Object classes, consumers, transports, MCP endpoint, agentic loop | `core`, `api-types`, `platform`, pure crates | `worker` (the dependency), `wasm-bindgen`, `js-sys`, `web-sys` directly; `tokio`, `reqwest` |
| `sdk` | Rust client for the REST API | `api-types`, `reqwest`, `serde`, `serde_json` | `worker`, `platform`, `core` |
| `cli` | `pmail` | `sdk`, `api-types`, `core` (address validation, DNS record parsing for `doctor`), `clap`, `reqwest` | `worker`, `platform` |
| `conformance` | MIME corpus, expected outputs, RFC conformance runner, golden-set generators | `core`, `api-types`, `sdk`; dev: `rmcp` (native) | `worker` (the dependency) |
| `xtask` | Build, size budget, layering check, itest, fuzz, release, OpenAPI, evals, Unicode table generation | anything native | – |

**Only `platform` imports `worker`.** `cargo xtask check-layering` enforces the table with
`cargo metadata`:

1. For every workspace package except `pylota-mail-platform`, no **direct** normal or build dependency
   named `worker`, `worker-sys`, `worker-macros`, `wasm-bindgen`, `js-sys` or `web-sys` (transitive ones,
   such as `wasm-bindgen` under `getrandom`, are allowed).
2. `pylota-mail-core` has no direct dependency on `pylota-mail-platform`, `reqwest` or `tokio`.
   (`mail-auth`'s `dns-doh` feature brings `reqwest`'s wasm backend in transitively; it is never
   called, because DNS answers are pre-filled, see section 3.)
3. The normal dependency graph of `pylota-mail-worker` for `--filter-platform wasm32-unknown-unknown`
   contains no `tokio`, no `gethostname` and no `hickory-resolver` (`rmcp`, which needs tokio, is a
   native dev-dependency only; see [S5](index.md#spikes)).
4. Every entry in `[workspace.dependencies]` is an exact `=x.y.z` pin.

**Entry points.** The `#[event(...)]` and `#[durable_object]` attribute macros of `workers-rs` 0.8.7
expand to absolute `::worker::…` paths (read from `worker-macros/src/event.rs` and `durable_object.rs`
at tag `v0.8.7`, 2026-10-09), so they compile only in a crate that depends on `worker` directly. They are
therefore not used in `crates/worker`. Instead `platform` provides one `macro_rules!` macro that
generates the same JavaScript glue with `$crate` paths:

```rust
// crates/worker/src/lib.rs
pylota_mail_platform::export_worker! {
    app: crate::App,                                   // impl platform::cf::WorkerApp (fetch, email, queue, scheduled)
    durable_objects: {
        IdentityMailbox => crate::mailbox::MailboxObject,   // impl platform::cf::ObjectApp (new, fetch, alarm)
        DomainMonitor   => crate::domains::MonitorObject,
        JobRunner       => crate::jobs::RunnerObject,
        TenantQuota     => crate::quota::QuotaObject,
    }
}
```

The expansion contains only `#[wasm_bindgen(…, wasm_bindgen = $crate::cf::glue::wasm_bindgen)]` exports
(the `fetch`, `email`, `queue` and `scheduled` functions and the four classes with their constructor,
`fetch` and `alarm` methods), each a one-line call into an ordinary function in
`pylota_mail_platform::cf::glue` that converts the JS values and invokes the trait. The glue mirrors what
`worker-macros` 0.8.7 generates, including its `Result`-to-exception behaviour. Spike S1 proves it
(including async exports through the re-exported `wasm-bindgen-futures`). If it cannot be made to work,
the fallback is an ADR allowing exactly one file, `crates/worker/src/entry.rs`, to use the `worker`
macros, with `check-layering` extended to fail on any other mention of `worker::` in that crate.

## 3. Workspace dependencies

```toml
[workspace.dependencies]
# Cloudflare (platform only). worker features: d1 and queue are not default and must be enabled.
worker               = { version = "=0.8.7", features = ["d1", "queue"] }
wasm-bindgen         = "=0.2.129"      # worker 0.8.7 requires ^0.2.129; worker-build matches the lockfile
wasm-bindgen-futures = "=0.4.79"
js-sys               = "=0.3.106"
web-sys              = { version = "=0.3.106", features = ["AbortController", "AbortSignal", "Blob",
                         "BlobPropertyBag", "Headers", "ReadableStream", "RequestRedirect"] }
getrandom            = { version = "=0.4.3", features = ["wasm_js"] }   # platform, wasm32 target only

# Mail
mail-parser  = { version = "=0.11.9", features = ["full_encoding"] }   # encoding_rs decoders (B5)
mail-auth    = { version = "=0.13.3", default-features = false,
                 features = ["dns-doh", "rust-crypto", "arc"] }        # arc is needed for verify_arc
mail-builder = { version = "=1.0.0", default-features = false }       # drops gethostname
ammonia      = "=4.2.1"

# Serialisation, IDs, crypto
serde      = { version = "=1.0.229", features = ["derive"] }
serde_json = "=1.0.151"
ulid       = { version = "=3.0.0", default-features = false }         # Ulid::from_parts only; no rand
sha2       = "=0.11.0"
hmac       = "=0.13.0"
base64     = "=0.23.1"

# API description, MCP, native clients
utoipa  = "=6.0.0"
rmcp    = "=3.5.1"                     # native dev-dependency only (worker tests, conformance); see S5 and the MCP design
clap    = { version = "=4.6.7", features = ["derive", "env"] }
reqwest = { version = "=0.13.5", default-features = false, features = ["json", "rustls"] } # sdk, cli

# Console (worker): server-rendered HTML, no JavaScript
maud   = "=0.27.0"                                                     # templates: console/layout.rs, pages/*.rs
qrcode = { version = "=0.14.1", default-features = false, features = ["svg"] }   # TOTP enrolment QR code, inline SVG
```

Crates used without a verified version in this document are added with an exact pin chosen **at build
time** (the newest release at least two weeks old), and recorded in `Cargo.toml`: `html5ever` and
`markup5ever_rcdom` (DOM walk for hidden-text removal and text derivation; same versions `ammonia`
resolves), `regex` (custom references; `default-features = false`, features `std`, `unicode-perl`),
`idna`, `psl`, `unicode-normalization`, `aes-gcm` (webhook secrets at rest), `rsa` and `x509-cert` (SNS
signature verification, SHA256withRSA), `sha1` (TOTP's HMAC-SHA1), `thiserror`, `futures-util`, and for
native code only: `rusqlite` with a bundled SQLite that has FTS5 (fakes), `proptest`, `libfuzzer-sys`,
`tar`, `flate2`, `toml`.

Notes on specific crates (all read 2026-10-09):

- **`mail-auth` 0.13.3.** `dns-hickory` and `dns-doh` are mutually exclusive and `dns-hickory` is a
  default feature, so default features must be off. The crate README documents
  `--no-default-features --features dns-doh,rust-crypto` as its WebAssembly configuration. On wasm32
  it adds `getrandom` 0.2 (`js`) and 0.4 (`wasm_js`) itself. DNS answers are supplied through
  `Parameters::with_txt_cache(...)`; the caches are consulted before any lookup, so the platform DoH
  resolver pre-fills them (see [Inbound › Authentication verdict](inbound.md#authentication-verdict)).
  `verify_spf` needs the client IP, which Email Workers do not expose, so SPF comes from the trusted
  `Authentication-Results` header only.
- **`mail-builder` 1.0.0** calls `std::time::SystemTime::now()` when a `Date` or `Message-ID` header
  is missing and when generating MIME boundaries; on `wasm32-unknown-unknown` that panics. Every
  builder call in wasm code sets `Date` and `Message-ID` explicitly and builds multiparts through
  `.body(MimePart)` with an explicit `boundary` parameter taken from `platform::Rng`. A unit test runs
  the composer under a clock-less shim to prove it.
- **`mail-parser` 0.11.9** has no configurable depth or part-count limit (its only limit is three
  levels of transfer-encoded nested messages) and no TNEF support. The caps from
  [limits](../../reference/limits.md#mail) are enforced in `core::mime` after parsing.
- **`ulid` 3.0.0** renamed `Ulid::new()` to `Ulid::generate()`. With default features off it has no
  `rand` dependency; IDs are built with `Ulid::from_parts(timestamp_ms, random)`.
- **`hmac` 0.13.0** needs `use hmac::{Hmac, KeyInit, Mac};` for `new_from_slice`.
- **`ammonia` 4.2.1** panics in `clean()` if `link_rel` is set while `rel` is an allowed attribute, if a
  tag is in both `clean_content_tags` and `tags`, or if `attribute_filter` is set twice. The sanitiser
  builder in `core::sanitize` is constructed once and covered by a test that calls `clean("")`.
- **`maud` 0.27.0** (published 2025-02-02, MIT OR Apache-2.0) has no default features; its `actix-web`
  and `axum` features stay off.
- **`qrcode` 0.14.1** (published 2024-07-05, MIT OR Apache-2.0, MSRV 1.67.1) enables `image`, `svg` and
  `pic` by default. `default-features = false` with `svg` keeps the SVG renderer and leaves out the
  optional `image` dependency.
- **`rmcp` 3.5.1** depends on `tokio` unconditionally, so it is only a native dev-dependency (MCP client tests); the Worker implements the MCP JSON-RPC types itself ([MCP server](mcp.md), [S5](index.md#spikes)).

## 4. Release profile

```toml
[profile.release]
opt-level     = "s"
lto           = "fat"
codegen-units = 1
panic         = "abort"
strip         = "symbols"
debug         = false
incremental   = false

[profile.dev]
opt-level = 1                  # native tests parse large corpus messages
```

- **`opt-level = "s"` rather than `"z"`.** The hot paths (MIME decoding, base64, quoted-printable,
  SHA-256 and RSA for DKIM, HTML parsing) are CPU-bound, and CPU time is both billed and capped.
  `"z"` gives up inlining and loop optimisation to save a further few percent of size. The size budget
  (NFR-SEC-2: 10 MiB compressed, start-up under 1 s) is our own target: since 2026-09-04 Cloudflare checks
  only the uncompressed size, 64 MiB on all plans
  ([changelog](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/),
  read 2026-10-09), while the 1-second start-up limit still applies. S4 measures both levels; if
  `"s"` exceeds 8 MiB compressed, switch to `"z"` and record the result here.
- **`lto = "fat"`, `codegen-units = 1`** give the smallest and fastest wasm at the cost of build time,
  which only release builds pay.
- **`panic = "abort"`.** Unwinding on wasm32 needs nightly and `-Zbuild-std`. With abort, `worker-build`
  0.8.7 enables panic recovery by default (it passes `--experimental-reset-state-function
  --force-enable-abort-handler` to `wasm-bindgen`): a panic aborts the current invocation, the panic hook
  logs it, and the instance is re-initialised on the next request. Panic recovery first shipped in
  `workers-rs` 0.6.2 (release notes, read 2026-10-09). Code still treats a panic as a bug: `core` is fuzzed,
  and handlers never `unwrap()` on input-derived data.
- **`strip = "symbols"`** removes the name section. `worker-build` then runs `wasm-opt` (binaryen 132)
  on the output.

## 5. wasm32 rules

These hold for every crate compiled into the Worker (`core`, `api-types`, `platform`, `worker`):

1. **No tokio, no threads, no blocking.** The Worker is single-threaded. Futures are `!Send`; platform
   traits use `async fn` in traits without `Send` bounds.
2. **No `SystemTime::now()` or `Instant::now()`**, directly or through a dependency. Time comes from
   `platform::Clock`. Known dependency traps: `mail-builder` (section 3), `ulid::Ulid::generate`.
3. **Randomness** comes from `platform::Rng`, backed by `getrandom` 0.4.3 with the `wasm_js` feature
   (sufficient since `getrandom` 0.3.4; no `--cfg getrandom_backend` flag is needed). `mail-auth`
   brings `getrandom` 0.2 with its `js` feature on wasm32. Only `platform` enables these features.
4. **No `gethostname`, no filesystem, no `std::net` sockets, no environment variables** (`std::env`).
   Configuration comes from bindings, read once per isolate into `platform::Config`. The one outbound TCP
   use, the `smtp_relay` transport, goes through `platform::TcpConnect` (the Workers `connect()` API).
5. **Memory.** An isolate has 128 MB. The inbound path holds at most one raw message (≤ 25 MiB through
   Email Routing, ≤ 40 MB through SES) at a time, keeps it in a JS `ArrayBuffer` until parsing, and drops
   parsed parts as soon as they are written (see [Inbound](inbound.md)).
6. **CPU.** The Worker sets `[limits] cpu_ms = 120000` (2 minutes) in `wrangler.toml` so that a
   25 MiB inbound message can be parsed, verified and sanitised in one queue invocation. S4 records the
   measured CPU time; the value is lowered to twice the measured p100 on the corpus. Spike S11 adds a
   30 MB message received through SES.
7. **`core` builds for both targets**, checked in CI with
   `cargo build -p pylota-mail-core --target wasm32-unknown-unknown`.

## 6. The `platform` crate

### 6.1 Errors and configuration

```rust
// crates/platform/src/lib.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformErrorKind { Unavailable, Timeout, Upstream, NotFound, Conflict, Invalid, Corrupt, Internal }

#[derive(Debug, Clone)]
pub struct PlatformError {
    pub kind: PlatformErrorKind,
    pub binding: &'static str,       // "DB", "BLOBS", "MAILBOX", "AI", "cf-api", …
    pub detail: String,              // machine text; never content or clear-text addresses
}
pub type PResult<T> = Result<T, PlatformError>;

/// Read and validated once per isolate. A missing required var or a secret of the wrong length
/// makes every handler return 503 `unavailable` and logs `config_invalid` with the variable name.
pub struct Config {
    pub platform_domain: String, pub api_host: String, pub jurisdiction: Jurisdiction,
    pub env: DeployEnv, pub embed_model: String, pub rerank_model: Option<String>,
    pub agent_model: String, pub triage_model: String, pub ai_gateway: Option<String>,
    pub trusted_authserv_id: Option<String>, pub doh_resolvers: [String; 2],
    pub ses_region: Option<String>, pub ses_sns_topic_arn: Option<String>, pub scanner_url: Option<String>,
    pub security_contact: Option<String>, pub log_level: LogLevel,
    pub default_policy: serde_json::Value, pub cf_account_id: Option<String>,
    pub daily_send_quota: Option<u32>, pub backup_bucket: Option<String>,
    pub ses_inbound: Option<SesInbound>,   // PM_SES_INBOUND_{BUCKET,TOPIC_ARN,QUEUE_URL}; Some only when all three are set
    pub ses_rule_set: String,              // PM_SES_RULE_SET
    pub cf_subdomain_setup: bool,          // PM_CF_SUBDOMAIN_SETUP = "on"
    pub console: Option<ConsoleConfig>,    // None when PM_CONSOLE = off. PM_CONSOLE_HOST, PM_SIGNUP, PM_SYSTEM_FROM,
                                           // PM_TERMS_*, PM_PRIVACY_URL, PM_DPA_URL, PM_SIGNUP_BLOCKED_DOMAINS,
                                           // PM_OAUTH_{GOOGLE,GITHUB}_CLIENT_ID, PM_QUARANTINE_KEY_RELEASE
    pub billing: BillingConfig,            // PM_BILLING, PM_PLAN_CATALOG, PM_BILLING_GRACE_DAYS
    pub secrets: Secrets,
}
pub struct Secrets {                 // each decoded from base64; 32 bytes for the PM_* keys
    pub master_key: [u8; 32], pub master_key_next: Option<[u8; 32]>,
    pub key_pepper: [u8; 32], pub hash_key: [u8; 32],
    pub cf_api_token: Option<String>, pub ses: Option<SesCredentials>,
    pub stripe: Option<StripeSecrets>,                   // PM_STRIPE_SECRET_KEY, PM_STRIPE_WEBHOOK_SECRET
    pub oauth_google_secret: Option<String>, pub oauth_github_secret: Option<String>,
}
```

`cf_account_id` comes from the variable `PM_CF_ACCOUNT_ID`, which `pmail setup` writes. It is needed
by the Cloudflare REST calls the Worker makes (zone creation, event subscriptions, the Email Sending
suppression list, the REST fallbacks below). `ses_sns_topic_arn` comes from `PM_SES_SNS_TOPIC_ARN`, the
only SNS topic whose notifications the SES event endpoint accepts ([Outbound › Amazon SES](outbound.md#amazon-ses)).
`daily_send_quota` (`PM_DAILY_SEND_QUOTA`) and `backup_bucket` (`PM_BACKUP_BUCKET`) are optional; all
are listed in [Configuration › Variables](../../reference/configuration.md#variables). `PM_SIGNUP` other
than `closed` without `PM_TERMS_URL`, `PM_PRIVACY_URL`, `PM_DPA_URL` and `PM_TERMS_VERSION` is
`config_invalid`, because those four are then required.

The thread, link and cursor keys are not secrets of the Worker: they live sealed in D1 `signing_keys`
([Data model](data-model.md#1-d1-control-plane)). `worker::keyring` loads and opens them with
`master_key` (or `master_key_next`, by the envelope's kid), caches the opened ring per isolate for
5 minutes, and creates the first key of a purpose on first use with `Rng`.

### 6.2 Trait set

Every trait has a Cloudflare implementation in `platform::cf` (compiled only for `wasm32`) and a fake
in `platform::fakes` (native). Signatures are binding; helper methods may be added.

```rust
// Time, randomness, IDs ---------------------------------------------------------------
pub trait Clock { fn now_ms(&self) -> i64; }                       // Date.now()
pub trait Rng   { fn fill(&self, buf: &mut [u8]); }                 // crypto.getRandomValues
pub trait Ids   { fn new_id(&self, prefix: IdPrefix) -> String; }   // "msg_01J9…", monotonic per isolate

// D1 (binding DB) ---------------------------------------------------------------------
#[derive(Clone, Debug)]
pub enum SqlValue { Null, Int(i64), Real(f64), Text(String), Blob(Vec<u8>) }
pub struct Stmt { pub sql: &'static str, pub params: Vec<SqlValue> }
pub struct ExecMeta { pub changes: u64, pub last_row_id: Option<i64> }

pub trait ControlDb {
    async fn query<T: DeserializeOwned>(&self, stmt: Stmt) -> PResult<Vec<T>>;
    async fn first<T: DeserializeOwned>(&self, stmt: Stmt) -> PResult<Option<T>>;
    async fn execute(&self, stmt: Stmt) -> PResult<ExecMeta>;
    async fn batch(&self, stmts: Vec<Stmt>) -> PResult<Vec<ExecMeta>>;  // one SQL transaction
}

// Durable Objects: calling them (bindings MAILBOX, DOMAINS, JOBS, QUOTA) ---------------
#[derive(Clone, Copy)] pub enum DoClass { Mailbox, Domain, Job, Quota }
pub trait ObjectClient {
    fn new_object_id(&self, class: DoClass) -> PResult<String>;        // section 6.4
    async fn call<Req: Serialize, Resp: DeserializeOwned>(
        &self, class: DoClass, object_id: &str, envelope: &RpcEnvelope<Req>,
    ) -> PResult<RpcResult<Resp>>;
}
/// The name used by the designs for mailbox calls.
pub trait MailboxStub {
    async fn call<Resp: DeserializeOwned>(&self, mailbox_do_id: &str,
        envelope: &RpcEnvelope<MailboxRequest>) -> PResult<RpcResult<Resp>>;
}

// Durable Objects: inside an object ----------------------------------------------------
pub trait Sql {                                                      // ctx.storage.sql
    fn exec(&self, sql: &str, params: &[SqlValue]) -> PResult<ExecMeta>;
    fn query<T: DeserializeOwned>(&self, sql: &str, params: &[SqlValue]) -> PResult<Vec<T>>;
    /// ctx.storage.transactionSync: commits if `f` returns Ok, rolls back if it returns Err.
    fn transaction_sync<R, E: From<PlatformError>>(&self, f: impl FnOnce(&Self) -> Result<R, E>) -> Result<R, E>;
    fn database_size(&self) -> u64;
}
pub trait ObjectState {
    async fn get_alarm(&self) -> PResult<Option<i64>>;
    async fn set_alarm(&self, at_ms: i64) -> PResult<()>;           // absolute time
    async fn delete_all(&self) -> PResult<()>;                       // also deletes the alarm (compat date ≥ 2026-02-24)
}

// R2 (binding BLOBS) ------------------------------------------------------------------
pub enum BlobBody { Bytes(Vec<u8>), Js(JsBuffer) }   // JsBuffer: opaque handle to bytes kept in the JS heap
pub struct BlobMeta { pub content_type: Option<String>, pub custom: Vec<(String, String)> } // ≤ 8,192 bytes total
pub struct Blob { pub body: BlobBody, pub size: u64, pub custom: Vec<(String, String)> }
pub struct BlobPage { pub keys: Vec<(String, u64)>, pub cursor: Option<String> }
pub trait BlobStore {
    async fn put(&self, key: &str, body: BlobBody, meta: &BlobMeta) -> PResult<()>;
    async fn get(&self, key: &str) -> PResult<Option<Blob>>;
    async fn get_range(&self, key: &str, offset: u64, len: u64) -> PResult<Option<Vec<u8>>>;
    async fn head(&self, key: &str) -> PResult<Option<u64>>;
    async fn delete(&self, keys: &[String]) -> PResult<()>;           // ≤ 1,000 keys per call
    async fn list(&self, prefix: &str, cursor: Option<&str>, limit: u32) -> PResult<BlobPage>; // limit ≤ 1,000
}

// Queues ------------------------------------------------------------------------------
#[derive(Clone, Copy)] pub enum QueueName { Inbound, Outbound, Delivery, Webhooks, Index }   // producers; Delivery only for DLQ redrive
pub trait QueueProducer {
    async fn send<T: Serialize>(&self, q: QueueName, body: &T, delay_s: u32) -> PResult<()>;      // delay ≤ 86,400
    async fn send_batch<T: Serialize>(&self, q: QueueName, bodies: &[T], delay_s: u32) -> PResult<()>; // ≤ 100, ≤ 256 KB
}
pub struct Incoming<T> { pub id: String, pub timestamp_ms: i64, pub body: T, /* private handle */ }
impl<T> Incoming<T> { pub fn ack(&self); pub fn retry(&self, delay_s: Option<u32>); }

// Workers AI (binding AI) ---------------------------------------------------------------
pub struct AiOptions {
    pub gateway: Option<String>,     // PM_AI_GATEWAY
    pub collect_log: bool,           // false for every call that carries mail content (Security § 3.5)
    pub skip_cache: bool,            // true for every call that carries mail content
}
pub struct MarkdownInput { pub name: String, pub mime_type: String, pub bytes: Vec<u8> }
pub struct MarkdownOutput { pub name: String, pub format: MarkdownFormat /* Markdown|Text|Error */,
                            pub mime_type: String, pub tokens: u32, pub data: String, pub error: Option<String> }
pub trait Ai {
    async fn run<I: Serialize, O: DeserializeOwned>(&self, model: &str, input: &I, opts: &AiOptions) -> PResult<O>;
    async fn run_bytes<I: Serialize>(&self, model: &str, input: &I, opts: &AiOptions) -> PResult<Vec<u8>>;
    async fn to_markdown(&self, docs: &[MarkdownInput]) -> PResult<Vec<MarkdownOutput>>;
}

// Vectorize (binding VECTORS) -----------------------------------------------------------
pub struct VectorRecord { pub id: String, pub namespace: String, pub values: Vec<f32>,
                          pub metadata: serde_json::Map<String, serde_json::Value> }
pub struct VectorMatch { pub id: String, pub score: f32 }
pub trait VectorIndex {
    async fn upsert(&self, vectors: &[VectorRecord]) -> PResult<String>;             // ≤ 1,000; returns mutationId
    async fn query(&self, namespace: &str, vector: &[f32], top_k: u32,
                   filter: &serde_json::Value) -> PResult<Vec<VectorMatch>>;         // returnMetadata "none", topK ≤ 100
    async fn delete_by_ids(&self, ids: &[String]) -> PResult<String>;
    async fn get_by_ids(&self, ids: &[String]) -> PResult<Vec<String>>;              // IDs that still exist (erasure probe)
}

// Email Sending (binding EMAIL) ---------------------------------------------------------
pub struct OutAttachment { pub filename: String, pub content_type: String, pub bytes: Vec<u8>,
                           pub inline_content_id: Option<String> }
pub struct StructuredEmail {
    pub from: (String, String),                       // (address, display name)
    pub to: Vec<String>, pub cc: Vec<String>, pub bcc: Vec<String>,
    pub reply_to: Option<String>, pub subject: String,
    pub text: Option<String>, pub html: Option<String>,
    pub headers: Vec<(String, String)>, pub attachments: Vec<OutAttachment>,
}
pub enum SendError {
    Coded { code: String, message: String },          // thrown Error with a `code` property
    Exception { message: String },                    // thrown without a code
    Timeout,                                          // our deadline expired before the promise settled
}
pub trait MailSender {
    async fn send(&self, msg: &StructuredEmail, deadline_ms: u32) -> Result<String /*messageId*/, SendError>;
    async fn send_raw(&self, from: &str, to: &str, mime: &[u8], deadline_ms: u32) -> Result<String, SendError>;
}

// Rate limiting (bindings RL_*) ---------------------------------------------------------
#[derive(Clone, Copy)] pub enum RlBucket { Api, Search, Agentic, Send, SignIn }   // SignIn: RL_SIGNIN, keyed by client IP
pub trait RateLimiter { async fn allow(&self, bucket: RlBucket, key: &str) -> PResult<bool>; }

// DNS over HTTPS ------------------------------------------------------------------------
#[derive(Clone, Copy)] pub enum Resolver { First, Second }           // PM_DOH_RESOLVERS order
#[derive(Clone, Copy)] pub enum RType { A, Aaaa, Cname, Mx, Ns, Txt }
pub struct DnsRecord { pub name: String, pub rtype: RType, pub ttl: u32, pub data: String }
pub enum DnsStatus { NoError, NxDomain, ServFail, Refused, Other(u16) }
pub struct DnsAnswer { pub status: DnsStatus, pub ad: bool, pub records: Vec<DnsRecord> }
pub enum DnsError { Timeout, Http(u16), Malformed }
pub trait Dns {
    async fn query(&self, r: Resolver, name: &str, rtype: RType) -> Result<DnsAnswer, DnsError>;
}

// Outbound HTTP ------------------------------------------------------------------------
pub enum Redirect { Manual, Follow }
pub struct HttpRequest { pub method: &'static str, pub url: String, pub headers: Vec<(String, String)>,
                         pub body: Option<Vec<u8>>, pub timeout_ms: u32, pub redirect: Redirect,
                         pub max_body_bytes: usize }
pub struct HttpResponse { pub status: u16, pub headers: Vec<(String, String)>, pub body: Vec<u8>,
                          pub body_truncated: bool }
pub enum HttpError { Timeout, Dns, Tls, Connect, Other(String) }
pub trait HttpClient { async fn send(&self, req: HttpRequest) -> Result<HttpResponse, HttpError>; }

// Outbound TCP (Workers connect(); used only by the smtp_relay transport) ---------------------
#[derive(Clone, Copy)] pub enum TlsMode { Implicit, StartTls }   // port 465 | port 587; never plain text
pub enum SocketError { Timeout, Connect, Tls, Closed, Other(String) }
pub trait TcpConn: Sized {
    async fn read(&mut self, buf: &mut [u8], timeout_ms: u32) -> Result<usize, SocketError>;  // 0 = closed
    async fn write_all(&mut self, bytes: &[u8], timeout_ms: u32) -> Result<(), SocketError>;
    async fn start_tls(self) -> Result<Self, SocketError>;      // TlsMode::StartTls only, at most once
    async fn close(self);
}
pub trait TcpConnect {
    type Conn: TcpConn;
    async fn connect(&self, host: &str, port: u16, tls: TlsMode, timeout_ms: u32) -> Result<Self::Conn, SocketError>;
}
```

Implementation notes:

- **`Clock`** uses `js_sys::Date::now()`. **`Ids`** keeps the last `(ms, random)` in a `thread_local`
  `Cell` and implements the monotonic rule in [Design › Time, randomness and IDs](index.md#3-time-randomness-and-ids).
- **`ControlDb`** wraps `worker::D1Database`. Integer parameters are bound as JS numbers; values
  outside ±2^53−1 are refused with `Invalid` (D1 and DO SQL both go through JS numbers). The
  tenant-scoped data-access layer that makes `tenant_id` a required parameter lives in
  `worker::db`, not here. D1 allows 100 bound parameters per statement.
- **`Sql`** wraps `worker::SqlStorage`. It never calls `SqlCursor::one()`, because the underlying JS
  `one()` throws on zero or several rows and the 0.8.7 import is not marked `catch`; it uses
  `to_array()` and checks the length. `transaction_sync` is an extern (section 7).
- **`BlobStore::put`** with `BlobBody::Js` passes the `ArrayBuffer` straight to R2 without copying it
  into wasm memory. The `email()` handler uses it for raw messages.
- **`Incoming`** is built from `worker::MessageBatch`. `timestamp_ms` comes from `Message::timestamp()`.
  `retry(Some(d))` uses `QueueRetryOptionsBuilder::new().with_delay_seconds(d)`.
- **`MailSender`** uses `SendEmail::send_with_builder(&SendEmailBuilder)` for structured mail and
  `SendEmail::send(&EmailMessage)` for raw MIME (`workers-rs` 0.8.7 has both). The promise is raced
  against `worker::Delay` for `deadline_ms` (default 30,000); losing the race returns `SendError::Timeout`
  and abandons the promise. A thrown `js_sys::Error` is inspected with `Reflect::get(&err, "code")`.
- **`RateLimiter`** calls `RateLimiter::limit(key)` on the binding for the bucket. The binding counts
  per Cloudflare location and is eventually consistent; exact daily caps live in `TenantQuota`.
- **`Dns`** sends `GET {resolver}?name={name}&type={TYPE}` with `accept: application/dns-json` to each
  configured URL (Cloudflare's `cloudflare-dns.com/dns-query` and Google's `dns.google/resolve` both
  answer the JSON format with `Status`, `AD` and `Answer[{name, type, TTL, data}]`; read 2026-10-09).
  Timeout 3 seconds, no retries inside the platform. TXT `data` is unquoted and its character-strings
  concatenated. The fake is a zone map that tests can mutate per resolver (H1, H7).
- **`HttpClient`** builds `RequestInit` with `RequestRedirect::Manual` (or `Follow`), aborts through an
  `AbortController` when `timeout_ms` passes (raced against `worker::Delay`), and reads at most
  `max_body_bytes` from the body stream before cancelling it.
- **`TcpConnect`** wraps `worker::Socket`. `Implicit` opens with `SecureTransport::On`, `StartTls` with
  `SecureTransport::StartTls`; `start_tls()` is called at most once, after the server advertises
  `STARTTLS`, because the 0.8.7 method panics on a socket not opened with `StartTls`
  ([Domains on any DNS host › The client](domain-connections.md#52-the-client)). Port 25 is refused,
  and the host passes the [SSRF rules](security.md#9-ssrf-controls), before any connect. Every open
  socket counts against the six connections an invocation may have waiting, so the outbound consumer
  runs at most four SMTP sends at once. Certificate and host-name checking is spike S12. The fake is a
  scripted SMTP peer.

### 6.3 Durable Object classes

`worker` defines four classes, each a thin shell around a logic module that only sees platform traits:

```rust
// crates/platform/src/cf/glue.rs
pub trait ObjectApp: Sized + 'static {
    fn new(state: CfObjectState, platform: CfPlatform) -> Self;
    async fn fetch(&self, req: HttpRequestIn) -> HttpResponseOut;   // decodes RpcEnvelope, checks the owner,
                                                                    // dispatches the request enum, encodes RpcResult
    async fn alarm(&self);                                          // runs the due purposes (Design conventions, rule 5)
}
// crates/worker: MailboxObject, MonitorObject, RunnerObject, QuotaObject implement ObjectApp and wrap
// mailbox::Mailbox<CfPlatform>, domains::Monitor<CfPlatform>, jobs::Runner<CfPlatform>, quota::Quota<CfPlatform>.
```

The logic modules (`mailbox::Mailbox<P>`, `domains::Monitor<P>`, …) are generic over a `P: Platform`
bundle of traits, so the same code runs against `platform::fakes` in native tests (with `rusqlite`
standing in for DO SQLite) and against Cloudflare in workerd.

### 6.4 Durable Object IDs and jurisdiction

- `new_object_id(class)` calls `unique_id_with_jurisdiction("eu")` on the class's namespace when
  `PM_JURISDICTION = eu`, otherwise `unique_id()`, and returns `ObjectId::to_string()` (hex).
- The string is stored in D1 when the owning row is created, in the same `INSERT`: `tenants.quota_do_id`,
  `identities.mailbox_do_id`, `domains.monitor_do_id`, `jobs.runner_do_id`. The first RPC to the object
  is `Init`, which writes the owner into `meta`.
- Objects are always addressed with `id_from_string(stored)`. Cloudflare preserves the jurisdiction on
  every ID-construction path, including `idFromString`
  ([Durable Object IDs](https://developers.cloudflare.com/durable-objects/api/id/), read 2026-10-09).
- `id_from_name` is never used: in `workers-rs` 0.8.7 jurisdiction is only reachable through unique
  IDs ([ADR 0002](../adr/0002-storage.md)). S6 confirms that an object created this way reports the EU
  jurisdiction.

## 7. `wasm-bindgen` externs

`workers-rs` 0.8.7 lacks four APIs the design needs (read from the v0.8.7 source on 2026-10-09):
`transactionSync`, the Vectorize binding, `AI.run` options (the `gateway` field) and `AI.toMarkdown`.
`platform::cf::externs` declares them. The binding objects are taken from the `Env` JS object with
`js_sys::Reflect::get` and `unchecked_into`; S6 verifies each call.

```rust
// crates/platform/src/cf/externs.rs
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    // ctx.storage — obtained from worker::Storage::as_raw()
    pub type DurableObjectStorageExt;
    #[wasm_bindgen(method, catch, js_name = transactionSync)]
    pub fn transaction_sync(this: &DurableObjectStorageExt, f: &js_sys::Function) -> Result<JsValue, JsValue>;

    // env.VECTORS
    pub type VectorizeIndex;
    #[wasm_bindgen(method, catch)]
    pub fn upsert(this: &VectorizeIndex, vectors: &js_sys::Array) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch)]
    pub fn query(this: &VectorizeIndex, vector: &js_sys::Float32Array, options: &JsValue)
        -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = deleteByIds)]
    pub fn delete_by_ids(this: &VectorizeIndex, ids: &js_sys::Array) -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = getByIds)]
    pub fn get_by_ids(this: &VectorizeIndex, ids: &js_sys::Array) -> Result<js_sys::Promise, JsValue>;

    // env.AI
    pub type AiBinding;
    #[wasm_bindgen(method, catch, js_name = run)]
    pub fn run_with_options(this: &AiBinding, model: &str, inputs: &JsValue, options: &JsValue)
        -> Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = toMarkdown)]
    pub fn to_markdown(this: &AiBinding, files: &js_sys::Array, options: &JsValue)
        -> Result<js_sys::Promise, JsValue>;
}
```

- **`transaction_sync`** wraps the Rust closure in a `Closure<dyn FnMut() -> Result<JsValue, JsValue>>`
  that runs it once. If the Rust closure returns `Err(e)`, the wrapper stores `e` in a `RefCell` and
  returns `Err(JsValue)`, which `wasm-bindgen` throws; `transactionSync` rolls back and re-throws; the
  platform catches it and returns the stored typed error. Cloudflare documents that the callback must
  complete synchronously and that a thrown exception rolls the transaction back
  ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
  read 2026-10-09).
- **Vectorize** query options are `{ topK, namespace, filter, returnValues: false, returnMetadata: "none" }`.
  The result is `{ count, matches: [{ id, score }] }`. Mutations return `{ mutationId }` and become
  visible after a few seconds ([Vectorize client API](https://developers.cloudflare.com/vectorize/reference/client-api/),
  read 2026-10-09).
- **`AI.run`** passes `{ gateway: { id, collectLog, skipCache } }` when `PM_AI_GATEWAY` is set, and `{}`
  otherwise. Calls that carry mail content (triage, the agentic planner, embeddings of mail text,
  reranking) set `collectLog: false` and `skipCache: true`. Both options are documented for the AI
  binding's gateway object ([Worker binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/),
  read 2026-10-09); S6 confirms them from Rust.
- **Vectorize `getByIds`** returns the vectors that still exist; the erasure probe only needs their IDs
  ([Privacy](privacy.md#68-waiting-for-vectorize)).
- **`AI.toMarkdown`** receives `[{ name, blob }]`, where `blob` is a `web_sys::Blob` built from the bytes
  with the sniffed MIME type. Each result has `name`, `format` (`markdown`, `text` or `error`),
  `mimetype`, `tokens`, `data` and `error`
  ([toMarkdown binding](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/),
  read 2026-10-09).

**REST fallbacks** (taken only if S6 fails for that call; they need `PM_CF_API_TOKEN` and
`PM_CF_ACCOUNT_ID`, and use `HttpClient` with `Authorization: Bearer …`):

| Call | REST endpoint |
|---|---|
| Vectorize query | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/vectorize/v2/indexes/pm-mail-chunks/query` |
| Vectorize upsert | `POST …/vectorize/v2/indexes/pm-mail-chunks/upsert` (NDJSON body, `Content-Type: application/x-ndjson`) |
| Vectorize delete | `POST …/vectorize/v2/indexes/pm-mail-chunks/delete_by_ids` with `{ "ids": [...] }` |
| Vectorize get | `POST …/vectorize/v2/indexes/pm-mail-chunks/get_by_ids` with `{ "ids": [...] }` |
| toMarkdown | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/tomarkdown`, multipart, one `files` part per document (the REST response spells the field `mimeType`) |

## 8. Generated `wrangler.toml`

`pmail setup` renders `deploy/wrangler.toml` from `deploy/wrangler.toml.tmpl`. The bindings are exactly
those in [Configuration › Bindings](../../reference/configuration.md#bindings), including the `METRICS`
Analytics Engine dataset that the [Observability](observability.md) design requires and the optional
`BACKUP` bucket. Values in `{…}` are filled by setup. Syntax checked against the Wrangler configuration reference on 2026-10-09; the pinned
Wrangler is `4.139.0` (2026-09-24; it bundles workerd 1.20260923.1, which runs the `2026-09-01` compatibility date locally, and needs Node.js 22 or later; checked with `npm view` on 2026-10-09).

```toml
name               = "pylota-mail"
main               = "build/index.js"          # worker-build 0.8.7 output
compatibility_date = "2026-09-01"              # ≥ 2026-02-24: deleteAll() also deletes the alarm

routes = [ { pattern = "{PM_API_HOST}", custom_domain = true } ]
# plus { pattern = "{PM_CONSOLE_HOST}", custom_domain = true } when PM_CONSOLE_HOST differs from PM_API_HOST

[vars]
PM_PLATFORM_DOMAIN     = "{agents.example}"
PM_API_HOST            = "{mail.example.com}"
PM_JURISDICTION        = "eu"
PM_ENV                 = "production"
PM_CF_ACCOUNT_ID       = "{account-id}"
PM_EMBED_MODEL         = "@cf/baai/bge-m3"
PM_RERANK_MODEL        = "@cf/baai/bge-reranker-base"
PM_AGENT_MODEL         = "@cf/qwen/qwen3.8-27b"
PM_TRIAGE_MODEL        = "@cf/openai/gpt-oss-20b"
PM_TRUSTED_AUTHSERV_ID = ""
PM_DOH_RESOLVERS       = "https://cloudflare-dns.com/dns-query,https://dns.google/resolve"
PM_LOG_LEVEL           = "info"
PM_DEFAULT_POLICY      = "{}"
PM_CONSOLE_HOST        = "{mail.example.com}"  # always written; the API host unless --console-host
PM_SIGNUP              = "closed"              # always written
# optional, written only when set: PM_AI_GATEWAY, PM_SCANNER_URL, PM_SECURITY_CONTACT, PM_DAILY_SEND_QUOTA,
# PM_BACKUP_BUCKET,
#   SES (both directions): PM_SES_REGION, PM_SES_SNS_TOPIC_ARN, PM_SES_INBOUND_BUCKET, PM_SES_INBOUND_TOPIC_ARN,
#   PM_SES_INBOUND_QUEUE_URL, PM_SES_RULE_SET; domains: PM_CF_SUBDOMAIN_SETUP,
#   console and sign-up: PM_CONSOLE, PM_QUARANTINE_KEY_RELEASE, PM_SYSTEM_FROM, PM_TERMS_URL, PM_PRIVACY_URL,
#   PM_DPA_URL, PM_TERMS_VERSION, PM_SIGNUP_BLOCKED_DOMAINS, PM_OAUTH_GOOGLE_CLIENT_ID, PM_OAUTH_GITHUB_CLIENT_ID,
#   billing: PM_BILLING, PM_PLAN_CATALOG, PM_BILLING_GRACE_DAYS

[[d1_databases]]
binding       = "DB"
database_name = "pylota-mail"
database_id   = "{d1-id}"                      # jurisdiction is fixed when the database is created

[[r2_buckets]]
binding      = "BLOBS"
bucket_name  = "pylota-mail-blobs"
jurisdiction = "eu"                            # omitted when PM_JURISDICTION = default

# only when PM_BACKUP_BUCKET is set:
# [[r2_buckets]]
# binding      = "BACKUP"
# bucket_name  = "{PM_BACKUP_BUCKET}"
# jurisdiction = "eu"

[[durable_objects.bindings]]
name = "MAILBOX"
class_name = "IdentityMailbox"
[[durable_objects.bindings]]
name = "DOMAINS"
class_name = "DomainMonitor"
[[durable_objects.bindings]]
name = "JOBS"
class_name = "JobRunner"
[[durable_objects.bindings]]
name = "QUOTA"
class_name = "TenantQuota"

[[migrations]]
tag                = "v1"
new_sqlite_classes = ["IdentityMailbox", "DomainMonitor", "JobRunner", "TenantQuota"]

[[queues.producers]]
binding = "Q_INBOUND"
queue   = "pm-inbound"
[[queues.producers]]
binding = "Q_OUTBOUND"
queue   = "pm-outbound"
[[queues.producers]]
binding = "Q_DELIVERY"                         # used only to redrive dead-lettered delivery events
queue   = "pm-delivery-events"
[[queues.producers]]
binding = "Q_WEBHOOKS"
queue   = "pm-webhooks"
[[queues.producers]]
binding = "Q_INDEX"
queue   = "pm-index"

[[queues.consumers]]
queue = "pm-inbound"
max_batch_size = 10
max_retries = 10
dead_letter_queue = "pm-inbound-dlq"
[[queues.consumers]]
queue = "pm-outbound"
max_batch_size = 10
max_retries = 100
dead_letter_queue = "pm-outbound-dlq"
[[queues.consumers]]
queue = "pm-delivery-events"
max_batch_size = 10
max_retries = 20                               # ≥ 11 needed by the G8 race schedule (outbound.md)
dead_letter_queue = "pm-delivery-events-dlq"
[[queues.consumers]]
queue = "pm-webhooks"
max_batch_size = 20
max_retries = 13
dead_letter_queue = "pm-webhooks-dlq"
[[queues.consumers]]
queue = "pm-index"
max_batch_size = 10
max_retries = 10
dead_letter_queue = "pm-index-dlq"
# One consumer per dead-letter queue (pm-inbound-dlq, pm-outbound-dlq, pm-delivery-events-dlq,
# pm-webhooks-dlq, pm-index-dlq), max_batch_size = 100. Behaviour: Observability design.

[[vectorize]]
binding    = "VECTORS"
index_name = "pm-mail-chunks"
# only while a re-embed runs (Search § 7.3), with PM_EMBED_MODEL_PREVIOUS in [vars]:
# [[vectorize]]
# binding    = "VECTORS_NEXT"
# index_name = "{new index}"

[ai]
binding = "AI"

[[send_email]]
name = "EMAIL"                                 # no address restrictions; the Worker enforces policy

[[ratelimits]]
name = "RL_API"
namespace_id = "{1001}"
simple = { limit = 600, period = 60 }
[[ratelimits]]
name = "RL_SEARCH"
namespace_id = "{1002}"
simple = { limit = 120, period = 60 }
[[ratelimits]]
name = "RL_AGENTIC"
namespace_id = "{1003}"
simple = { limit = 20, period = 60 }
[[ratelimits]]
name = "RL_SEND"
namespace_id = "{1004}"
simple = { limit = 120, period = 60 }
[[ratelimits]]
name = "RL_SIGNIN"                             # keyed by client IP (CF-Connecting-IP); console sign-in routes
namespace_id = "{1005}"
simple = { limit = 10, period = 60 }

[triggers]
crons = ["* * * * *", "*/15 * * * *"]

[limits]
cpu_ms = 120000

[observability]                                # as required by the Observability design
enabled = true
head_sampling_rate = 1

[observability.logs]
invocation_logs = false                        # invocation logs carry URLs and recipients (FR-PRV-6)

[observability.traces]
enabled = false                                # staging: true, head_sampling_rate = 0.1

[[analytics_engine_datasets]]                  # METRICS (Configuration › Bindings)
binding = "METRICS"
dataset = "pylota_mail_metrics"
```

- Secrets (`PM_MASTER_KEY`, `PM_KEY_PEPPER`, `PM_HASH_KEY`, and the optional `PM_MASTER_KEY_NEXT`
  (during a master-key rotation only), `PM_CF_API_TOKEN`, `PM_SES_ACCESS_KEY_ID`,
  `PM_SES_SECRET_ACCESS_KEY`, `PM_STRIPE_SECRET_KEY`, `PM_STRIPE_WEBHOOK_SECRET`,
  `PM_OAUTH_GOOGLE_CLIENT_SECRET`, `PM_OAUTH_GITHUB_CLIENT_SECRET`) are uploaded with `wrangler secret`,
  never written to the file. Thread, link and cursor keys are not secrets: the Worker generates them into
  D1 `signing_keys`.
- `pm-delivery-events` is fed by Email Sending event subscriptions. Its `Q_DELIVERY` producer binding
  exists only so `POST /v1/platform/dlq/{dlq_id}/redrive` can republish dead-lettered delivery events.
- Durable Object classes use the `[[migrations]]` form named in the configuration reference. Cloudflare
  now also documents a declarative `exports` form and calls `migrations` legacy; a Worker deployed with
  `exports` cannot go back
  ([DO migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/),
  read 2026-10-09). Moving to `exports` needs an ADR.
- There is no `[build]` section. A prebuilt bundle already contains `build/`. With `--from-source` the CLI
  runs `cargo install worker-build --version 0.8.7 --locked` and `worker-build --release` in
  `crates/worker` before `wrangler deploy`.
- The rate-limiting `namespace_id` values are positive integers unique within the account; setup picks
  five unused ones and keeps them across re-runs. Rate-limit bindings need Wrangler 4.36.0 or later.

## 9. `xtask`

| Command | Does |
|---|---|
| `cargo xtask build-worker` | Runs `worker-build --release` (0.8.7) in `crates/worker`. Then measures `build/index.js` + `build/index_bg.wasm`: gzip level 9 total must be ≤ 10,485,760 bytes (NFR-SEC-2) and uncompressed ≤ 64 MiB, else it fails. Prints a size table by crate (from `twiggy`-style name-section data in a non-stripped copy) and warns above 8 MiB compressed |
| `cargo xtask check-layering` | The `cargo metadata` checks in section 2 |
| `cargo xtask itest` | Builds the Worker with the `itest-hooks` cargo feature, renders `deploy/wrangler.itest.toml` (same bindings, local resources, `PM_ENV = "local"`, test secrets, the fake-server URL and test token), starts the fake server on `127.0.0.1:8798`, applies D1 migrations with `--local --persist-to target/itest/state`, starts `npx --yes wrangler@4.139.0 dev --local --port 8799 --persist-to target/itest/state --test-scheduled --config deploy/wrangler.itest.toml`, waits for `GET /health`, then runs `cargo test -p pylota-mail-worker --features itest-hooks --test it -- --test-threads=1` with `PM_ITEST_URL`. Email events are injected through the local email-event endpoint that `wrangler dev` provides, and cron and alarm time through its scheduled-event endpoint and the `/__test/alarm` hook. Fault injection (R2 failure, D1 failure, transport outcomes) uses `PM_ENV = "local"`-only test hooks compiled behind `itest-hooks`, never in release bundles. The full sequence and the fakes are in [Testing › What cargo xtask itest does](testing.md#61-what-cargo-xtask-itest-does) |
| `cargo xtask live` | Runs `cargo test -p pylota-mail-worker --features live --test live -- --test-threads=1` against staging ([Testing › Live suite](testing.md#10-live-end-to-end-suite-live)) |
| `cargo xtask trace` | Checks the edge-case register and the PRD against the test names and `Covers:` lines, and prints the traceability matrix ([Testing](testing.md#112-cargo-xtask-trace)) |
| `cargo xtask fuzz --target <t> --time <s>` | Runs `cargo +nightly fuzz run <t> -- -max_total_time=<s>` in `fuzz/` |
| `cargo xtask openapi` | Generates `openapi.json` from `api-types` and compares it semantically with `docs/src/reference/openapi.yaml` |
| `cargo xtask gen-unicode` | Regenerates `crates/core/src/address/confusables_table.rs` from the pinned UTS #39 data files checked into `crates/core/data/` |
| `cargo xtask eval-search`, `eval-agentic`, `eval-triage` | Quality gates on the golden set (build plan M18) |
| `cargo xtask release --version <v>` | Builds the Worker, then writes `dist/pylota-mail-worker-<v>.tar.gz` containing `build/index.js`, `build/index_bg.wasm`, `build/worker/shim.mjs`, `migrations/d1/*.sql`, `deploy/wrangler.toml.tmpl` and `VERSION`; collects the CLI binaries built by the CI matrix; writes `dist/SHA256SUMS` (`<sha256 hex>␠␠<filename>` per line) and its detached signature `SHA256SUMS.sig` made with the release signing key held in CI secrets. Verification by `pmail deploy` is specified in [CLI and setup](cli.md) |

Fuzz targets (each a `fuzz_target!` over `&[u8]` calling one `core` entry point):

| Target | Entry point |
|---|---|
| `mime_parse` | `core::mime::parse` with caps |
| `query_parse` | `core::query::parse` |
| `address_parse` | `core::address::{parse, validate_username}` |
| `sanitize` | `core::sanitize::{sanitize_html, derive_text, strip_hidden}` |
| `dsn_parse` | `core::classify::parse_dsn` and `parse_mdn` |
| `quote_strip` | `core::quote::extract_new_content` |
| `refs_extract` | `core::refs::extract` with every pack |
| `thread_token` | `core::thread_token::verify` |
| `auth_results` | `core::auth::parse_authentication_results` |
| `dns_records` | `core::dns::{parse_spf, parse_dmarc, parse_dkim_key}` |
| `attachment_sniff` | `core::attach::{sniff, classify_risk}` including ZIP and OLE inspection |
| `tnef_parse` | `core::mime::tnef::extract` |
| `webhook_url` | `core::ssrf::validate_url` |
| `sns_message` | `core::sns::parse_sns_envelope` |

The first five run for 60 seconds each in CI on every pull request (build plan M2); all run nightly for
10 minutes each.

## 10. CI pipeline

`.github/workflows/ci.yml`, on every pull request and on `main`:

| Job | Runs | Fails when |
|---|---|---|
| `fmt` | `cargo fmt --all --check` | any diff |
| `clippy` | `cargo clippy --workspace --all-targets -- -D warnings` | any warning |
| `test` | `cargo test --workspace` (native: core, api-types, platform fakes, worker logic, sdk, cli, conformance corpus) | any failure |
| `layering` | `cargo xtask check-layering` | a forbidden dependency |
| `wasm` | `cargo build -p pylota-mail-core --target wasm32-unknown-unknown`, then `cargo xtask build-worker` | build error or size budget exceeded |
| `itest` | `cargo xtask itest` (Node.js 22 and Wrangler 4.139.0 installed) | any failure |
| `fuzz-smoke` | `cargo xtask fuzz --target {mime_parse,query_parse,address_parse,sanitize,dsn_parse} --time 60` | a crash |
| `deny` | `cargo deny check` (licences compatible with FSL-1.1-ALv2 and its Apache-2.0 future licence, RustSec advisories, banned crates, sources limited to crates.io) | any finding |
| `audit` | `cargo audit` (RustSec) | any advisory |
| `trace` | `cargo xtask trace` | a named test missing, or a `P0` requirement without a test |
| `openapi` | `cargo xtask openapi` | a contract drift |
| `docs` | `mdbook build docs` (mdBook 0.5.4) and a link check over `site/public` | a broken build or link |

CodeQL (`.github/workflows/codeql.yml`): CodeQL for Rust on every pull request and weekly. Its job is a
required check ([Testing › CI workflows](testing.md#12-ci-workflows-and-required-checks)).

Nightly (`.github/workflows/nightly.yml`): all fuzz targets for 10 minutes each, `eval-search`,
`eval-agentic` and `eval-triage` against real Workers AI with a CI API token (build plan M18), `cargo
audit` on `main`, and the `live::` suite against staging when staging credentials are configured.

Release (`.github/workflows/release.yml`, on a `v*` tag): the full CI gate; CLI binaries for macOS
(arm64, x64), Linux (x64, arm64) and Windows (x64); `cargo xtask release`; an SBOM for the Worker and
the CLI (`cargo cyclonedx --format json`); signed `SHA256SUMS` and build provenance (`actions/attest@v4`,
[Security › Supply chain](security.md#11-supply-chain)); a GitHub Release with the bundle, the binaries,
the SBOMs, `SHA256SUMS` and `SHA256SUMS.sig`; then `cargo publish` for `pylota-mail` and
`pylota-mail-cli` (and the crates they depend on).

## 11. Tests

| Test | Covers |
|---|---|
| `xtask::check_layering_rejects_worker_dep` | A fixture crate depending on `worker` fails the check (AGENTS.md rule) |
| `platform::ids::monotonic_within_ms` | IDs generated in one millisecond sort strictly; random overflow moves to the next millisecond |
| `platform::cf::sql::transaction_rolls_back` (itest) | An `Err` from the closure leaves no rows (S1) |
| `platform::cf::queues::timestamp_stable_across_retry` (itest) | `Message::timestamp()` is unchanged after `retry_with_options` (S1) |
| `platform::dns::parse_canned_answers` | TXT, MX, NS and CNAME, NXDOMAIN and SERVFAIL from both resolvers (build plan M4) |
| `platform::http::timeout_and_body_cap` | A slow server times out at the deadline; bodies are cut at `max_body_bytes` |
| `core::compose::no_system_time_on_wasm` | The MIME composer never calls `SystemTime::now()` (explicit Date, Message-ID, boundaries) |
| `core::sanitize::builder_does_not_panic` | The ammonia builder's `clean("")` succeeds |
| `xtask::size_budget` (CI `wasm` job) | NFR-SEC-2 |
| `it::mailbox::j9_migration_on_wake` | Schema-on-wake under `schema_version` ([J9](../edge-cases.md)) |
| `it::platform::eu_jurisdiction_ids` (S6, staging) | Objects created with `unique_id_with_jurisdiction("eu")` report `eu` (FR-PRV-1) |
