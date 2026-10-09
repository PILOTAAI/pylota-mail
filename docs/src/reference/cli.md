# CLI

`pmail` is the command-line client for Pylota Mail. It sets up and deploys a deployment on your
Cloudflare account, checks its health, administers tenants, identities, domains, members, keys and
webhooks, and sends, reads and searches mail. Every command can print JSON (`--json`), so scripts and agents can use
it as well as people.

The behaviour behind each command is specified in the [CLI and setup design](../project/design/cli.md).

## Install

Download a prebuilt binary from the project's
[GitHub Releases](https://github.com/PILOTAAI/pylota-mail/releases) (macOS arm64 and x64, Linux x64 and
arm64, Windows x64), or build it with Cargo:

```bash
cargo install pylota-mail-cli --locked
```

Each release lists every file's SHA-256 in `SHA256SUMS`, signed in `SHA256SUMS.sig`, and carries
GitHub build provenance you can check with `gh attestation verify <file> -R PILOTAAI/pylota-mail`.

```bash
pmail --version
```

The CLI's version decides which Worker release `pmail deploy` installs, so keep the CLI and the
deployment on the same version.

## Configuration

`pmail` reads profiles from `~/.config/pylota-mail/config.toml` (`$XDG_CONFIG_HOME/pylota-mail/config.toml`
when `XDG_CONFIG_HOME` is set; `%APPDATA%\pylota-mail\config.toml` on Windows):

```toml
default_profile = "prod"

[profiles.prod]
url = "https://mail.example.com"
key = "pmk_live_…"                 # or key_env = "…", or key_command = "…"
identity = "bookings.acme@agents.example"   # default --identity for mail commands

[profiles.staging]
url = "https://mail-staging.example.com"
key_env = "PYLOTA_MAIL_STAGING_KEY"
```

| Profile key | Meaning |
|---|---|
| `url` | The API host, for example `https://mail.example.com` |
| `key` | An API key (`pmk_live_…` or `pmk_test_…`) |
| `key_env` | The name of an environment variable that holds the key |
| `key_command` | A command whose output is the key, for example `op read op://vault/pylota-mail/key`. It runs once per invocation, with a 10-second timeout |
| `identity` | The default identity for mail commands (an ID or an address) |
| `tenant` | The default tenant for platform keys (an ID or a slug) |

Use only one of `key`, `key_env` and `key_command` in a profile. Unknown keys are an error.

**Precedence**, highest first: command-line flags (`--url`, `--key`, `--profile`), then the
environment (`PYLOTA_MAIL_URL`, `PYLOTA_MAIL_KEY`, `PYLOTA_MAIL_PROFILE`), then the profile. Without
`--profile` or `PYLOTA_MAIL_PROFILE`, the profile is `default_profile`, else one named `default`.

**File permissions.** `pmail` creates the file with mode `0600` (its directory `0700`) and refuses to
read it if other users can read it or if another user owns it. Fix that with `chmod 600` on the file.

**Keys on the command line.** `--key` works, but other users of the machine can see command lines.
Prefer `PYLOTA_MAIL_KEY` or a profile; `pmail` prints a warning when you use `--key`.

**Cloudflare credentials.** `setup`, `setup ses`, `deploy`, `upgrade`, `doctor`, `destroy` and
`secrets` use `CLOUDFLARE_API_TOKEN` from the environment (there is no flag for it) and the account ID
from `--account-id` or `CLOUDFLARE_ACCOUNT_ID`; so does `domains add` when it falls back to your local
token. They are never written to the config file. The token's permissions are listed in
[Self-hosting](../self-hosting.md#2-create-a-cloudflare-api-token). The platform operations (`dlq`,
`keys rotate thread|link|cursor`, `jobs`, `waitlist invite`) need only an API key.

**AWS credentials.** `setup ses`, and the doctor's `ses` check, use your local AWS credentials from the
standard AWS sources: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` in the
environment, or the profile named by `AWS_PROFILE` in `~/.aws/credentials` and `~/.aws/config` (which
other sources are supported, and in what order: verify at build time). They are never stored by
`pmail` or uploaded to the Worker.

The settings are also listed in [Configuration › CLI configuration](configuration.md#cli-configuration).

## Global flags

These work with every command.

| Flag | Environment | Meaning |
|---|---|---|
| `--url <url>` | `PYLOTA_MAIL_URL` | API host. `https://` is required except for `localhost` |
| `--key <key>` | `PYLOTA_MAIL_KEY` | API key |
| `--profile <name>` | `PYLOTA_MAIL_PROFILE` | Profile in the config file |
| `--json` | – | Print exactly one JSON document on stdout: the API response, or the command's result, or the error envelope. Turns off every prompt |
| `--quiet` | – | Print only the essential value (a new ID, a secret, hit IDs) and errors |
| `--yes` | – | Answer yes to confirmations (not to `destroy`'s typed confirmation) |
| `--verbose` | – | Log each HTTP request's method, path, status and duration to stderr (never bodies or keys) |
| `--help` | – | Help for any command |
| `--version` | – | The CLI's version (at the top level only; `deploy --version` is a different flag) |

Colour is used only on a terminal, and never when `NO_COLOR` is set.

## Output

- **Human** (the default): single objects print as indented JSON; lists print as tables; operator
  commands print one line per step.
- **`--json`**: the API's response body, unchanged. Lists print `{ "data": [ … ], "next_cursor": … }`;
  add `--all` to follow every page into one document.
- **`--quiet`**: one value per line, for scripts.

Text that comes from email (subjects, names, snippets, bodies, filenames, answers) is untrusted. In
human and quiet modes `pmail` neutralises terminal control sequences and shows hidden bidirectional and
zero-width characters as markers such as `<U+202E>`, so a message cannot rewrite your terminal. JSON
output keeps the text exactly as the API returned it.

Errors print the API's error envelope: in human mode as `error: <code> (<status>): <message>` with its
`fix` and `request_id` on stderr; with `--json` as the envelope on stdout.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (also `doctor` with only warnings) |
| 1 | Internal error in the CLI |
| 2 | Invalid flags or arguments, or a required answer missing in non-interactive mode |
| 3 | Configuration: no URL or key, an unreadable or insecure config file, a failing `key_env` or `key_command`, missing Cloudflare credentials, no AWS credentials for `setup ses` |
| 4 | The API refused the key: `401` or `403` |
| 5 | Not found: `404` with a Pylota Mail error code |
| 6 | Conflict or state: `409`, `410`, `423` |
| 7 | Invalid request: `400`, `413`, `422` |
| 8 | Limit: `402 billing_limit` or `429` |
| 9 | Service unavailable: `5xx`, a network error, or a `404` that did not come from Pylota Mail |
| 10 | A Cloudflare API call or Wrangler failed, or a prerequisite (Node.js 22+, Wrangler) is missing |
| 11 | Verification failed: a release signature or checksum, or `webhooks verify` |
| 12 | `doctor` found at least one failure |
| 13 | Timed out: `wait` returned nothing, or a polling step passed its deadline |
| 14 | `setup ses`: an AWS API call failed, or the AWS account has no SES production access |
| 130 | Interrupted (Ctrl-C) |

## Naming identities and tenants

- `--identity` (and identity arguments) take an identity ID (`idn_…`) or any active or retiring
  address of the identity, for example `bookings@acme.example.com`. Without it, mail commands use the
  profile's `identity`, or the key's own identity for an identity key.
- `--tenant` takes a tenant ID (`ten_…`) or a slug (`acme`). Without it, a tenant or identity key uses
  its own tenant, and a platform key uses the profile's `tenant`, else the **default tenant** created by
  `pmail setup` (the one whose addresses have no suffix).
- Domain arguments take a domain ID (`dom_…`) or a domain name.
- Times take RFC 3339 (`2026-10-09T10:00:00Z`) or a date (`2026-10-09`, midnight UTC).

## Mail commands that send

`send`, `reply`, `reply-all` and `forward` need an idempotency key. Pass one with `--idempotency-key`;
derive it from your task (`bk-2291-confirm`) and reuse it if you run the command again for the same
message. If you leave it out, `pmail` generates one (`pmail-<id>`), prints it to stderr, and reuses it
for its own retries. See [Sending › Safe retries](../guides/sending.md#safe-retries).

---

## Deployment

### `setup`

Creates every Cloudflare resource, performs the first deploy of the Worker, creates the default tenant
and its console owner, and stores a temporary platform key in a CLI profile. Safe to run again: it
creates only what is missing.

```text
pmail setup --domain <api-host> [--mail-domain <apex>] [--account-id <id>] [--jurisdiction eu|default]
            [--console-host <host>] [--owner-email <email>] [--owner-name <name>]
            [--tenant-name <name>] [--no-console] [--replace-mx] [--daily-send-quota <n>]
            [--backup-bucket <name>] [--version <v>] [--from-source] [--print-secrets]
            [--rotate-pepper] [--profile <name>] [--dir <path>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--account-id` | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `--domain` | required | The API host, where the Worker serves `/v1`, `/mcp` and `/health` (`PM_API_HOST`) |
| `--console-host` | the API host | The host that serves the console (`PM_CONSOLE_HOST`). A different host becomes a second custom domain on the same Worker |
| `--mail-domain` | asked for | The platform mail domain (`PM_PLATFORM_DOMAIN`). It must be a zone apex in the account. Required with `--json` or `--yes` |
| `--jurisdiction` | `eu` | `eu` or `default`, for D1, R2 and Durable Objects. It cannot be changed later |
| `--owner-email` | asked for | The first console owner of the default tenant. Required unless `--no-console` |
| `--owner-name` | – | The owner's name |
| `--tenant-name` | `Default` | The default tenant's name |
| `--no-console` | off | Turn the console off (`PM_CONSOLE = "off"`) |
| `--replace-mx` | off | Delete existing MX records at the mail domain. **Mail to that domain's current provider stops** |
| `--daily-send-quota` | unset | Your account's Email Sending daily quota, copied from the Cloudflare dashboard (`PM_DAILY_SEND_QUOTA`). An alert fires at 80% of it. Without it, `doctor` warns |
| `--backup-bucket` | unset | Create a second R2 bucket with this name in the same jurisdiction, bind it as `BACKUP`, and copy new mail objects into it nightly (`PM_BACKUP_BUCKET`) |
| `--version` | the CLI's | Worker release to deploy |
| `--from-source` | off | Build the Worker locally (needs Rust, the `wasm32-unknown-unknown` target and `worker-build` 0.8.7) |
| `--print-secrets` | off | Print the generated Worker secrets once. Without it they are never written anywhere |
| `--rotate-pepper` | off | Break-glass: replace `PM_KEY_PEPPER` and create a new platform key. **Every existing API key stops working** |
| `--profile` | `default` | Profile that receives the URL and the temporary key |
| `--dir` | `./deploy` | Where `wrangler.toml` and downloaded releases are kept |

What it does, in order: checks Node.js and Wrangler; checks that the mail domain is a zone apex
without another mail provider's MX records; creates D1, R2 (with its lifecycle rule, plus the backup
bucket if you asked for one), the queues and the Vectorize index; enables Email Routing and Email
Sending on the mail domain; writes `deploy/wrangler.toml`; applies D1 migrations; deploys the Worker;
uploads the generated secrets; waits for `/health`; creates the delivery-event subscription; points the
catch-all at the Worker; creates a platform key that expires in 24 hours and saves it in the profile;
and creates the default tenant with its owner. Mail to the platform domain is refused until the Worker
can store it, then accepted. If a step fails, fix the cause and run the same command again.

Setup performs the first deploy itself, so `pmail deploy` run straight after it finds nothing to change
and exits 0.

Billing stays off on a self-hosted deployment, and sign-up stays closed (`PM_SIGNUP = "closed"` is
written into `deploy/wrangler.toml`, with `PM_CONSOLE_HOST`, so you can see both). People join as the
owner you name here, or by invitation. To use Amazon SES for domains whose DNS is elsewhere, run
[`setup ses`](#setup-ses) afterwards.

```bash
pmail setup --account-id <account-id> --domain mail.example.com --jurisdiction eu
```

Without `--mail-domain`, setup asks for it. With every value given:

```bash
pmail setup --account-id <account-id> --domain mail.example.com --mail-domain agents.example \
  --jurisdiction eu --owner-email sam@acmecarhire.example --owner-name "Sam Patel"
```

### `setup ses`

Connects the deployment to Amazon SES, once, so tenants can add domains with the `dns_records` and
`send_only` methods, `smtp_relay` with `--inbound ses`, and so the SES failover is available. It uses
your local AWS credentials. Run it after `setup`.

```text
pmail setup ses --region <aws-region> [--allow-non-eu] [--prefix <prefix>] [--dir <path>] [--yes]
```

| Flag | Default | Meaning |
|---|---|---|
| `--region` | required | The SES region (`PM_SES_REGION`). It must be a region where SES receives mail |
| `--allow-non-eu` | off | Accept a region outside the EU on a deployment with `PM_JURISDICTION = "eu"`. Without it such a region is refused |
| `--prefix` | `pylota-mail-` + your AWS account ID | Prefix of the S3 bucket that holds incoming mail until it is ingested (`{prefix}-inbound`) |
| `--yes` | off | Apply the IAM policy without asking. Without it, the policy is printed and you are asked first |

What it does, reading each resource first and changing only what is missing or different: checks the
region and that your SES account has production access (if it does not, it prints the AWS console steps
to request it and stops, having created nothing); warns if the account is on the Essentials plan; creates
the inbound S3 bucket, the SNS topic, the SQS backstop queue, the receipt rule `pm-deliver` (in your
active rule set if you already have one), the configuration set and its event topic, and the SES
identity of the platform domain; sets `SignatureVersion = 2` on both SNS topics; prints the IAM policy of
the user `pylota-mail-worker` for review and applies it; creates that user's access key and uploads it
with `wrangler secret put` as `PM_SES_ACCESS_KEY_ID` and `PM_SES_SECRET_ACCESS_KEY` (never written to
disk or printed); writes `PM_SES_REGION`, `PM_SES_INBOUND_BUCKET`, `PM_SES_INBOUND_TOPIC_ARN`,
`PM_SES_INBOUND_QUEUE_URL`, `PM_SES_RULE_SET` and `PM_SES_SNS_TOPIC_ARN` into `deploy/wrangler.toml`;
deploys; and subscribes the Worker to both topics. Safe to run again. The full list is in
[Domains on any DNS host](../project/design/domain-connections.md#42-deployment-set-up-for-ses).

Exit codes: 2 for a region that cannot receive mail, a non-EU region on an EU deployment without
`--allow-non-eu`, a deployment on another version than the CLI (run `pmail upgrade` first), or a policy
review you declined; 3 without AWS or Cloudflare credentials; 10 when Wrangler or the Cloudflare API
fails; 13 when the subscriptions are not confirmed within 5 minutes; 14 when an AWS call fails or the
account has no production access.

```bash
pmail setup ses --region eu-west-2
```

### `deploy`

Downloads the Worker release for the CLI's version from GitHub Releases, verifies its signature and
checksum, renders `deploy/wrangler.toml`, applies D1 migrations, and deploys with
`npx --yes wrangler@4.139.0`. Needs Node.js 22 or later.

```text
pmail deploy [--version <v>] [--from-source] [--gradual] [--stages <list>] [--stage-wait <duration>]
             [--force] [--account-id <id>] [--dir <path>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--version` | the CLI's | Deploy this release, for example to roll back. It cannot be newer than the CLI |
| `--from-source` | off | Build from the repository checkout instead of downloading |
| `--gradual` | off | Shift traffic in stages, checking health and alerts at each, and roll back on failure |
| `--stages` | `10,50,100` | Percentages for `--gradual` |
| `--stage-wait` | `10m` | Time at each stage |
| `--force` | off | Deploy even when nothing changed |

Right after `pmail setup`, `deploy` has nothing to do and exits 0: setup performed the first deploy.
`deploy` refuses a release whose signature or checksum does not match (exit 11); there is no option
to skip the check. Operator settings under `[vars]` in `deploy/wrangler.toml` (for example
`PM_TRUSTED_AUTHSERV_ID`) are kept. Changing `PM_EMBED_MODEL` there starts a background re-embed on the
next deploy ([Search design](../project/design/search.md#7-index-lifecycle)).

```bash
pmail deploy
```

```bash
pmail deploy --version 1.0.0
```

### `upgrade`

Deploys the CLI's version when the deployment runs an older one, as a gradual deployment
(10% → 50% → 100%), then runs `doctor`. Install the new CLI first: `upgrade` stops if a newer release
exists than the CLI you are running.

```text
pmail upgrade [--stages <list>] [--stage-wait <duration>] [--no-gradual] [--dir <path>]
```

```bash
pmail upgrade
```

To roll back, deploy the previous version with `pmail deploy --version <previous-version>`.

### `doctor`

Checks DNS, routing, sending, event subscriptions, bindings, secrets, alerts, dead-letter queues,
quota, SES (when configured) and the account's zone count, and prints a fix for each failure.

```text
pmail doctor [--mail-test] [--check <name>]… [--dir <path>]
```

| Flag | Meaning |
|---|---|
| `--mail-test` | Also send a message from the platform domain to itself and check it arrives with `verdict: pass`. Prints the `Authentication-Results` authserv-id to set as `PM_TRUSTED_AUTHSERV_ID`. The test messages are erased afterwards |
| `--check` | Run only the named checks: `dns.platform`, `routing.catch_all`, `sending.domains`, `sending.event_subscriptions`, `bindings`, `secrets`, `observability`, `worker.version`, `health`, `alerts`, `dlq`, `quota`, `ses`, `cloudflare.zones`, `security_txt`, `mail_test` |

```bash
pmail doctor --mail-test
```

```text
pass  dns.platform                 MX, SPF, DKIM, DMARC match on both resolvers
pass  routing.catch_all            catch-all → pylota-mail
warn  security_txt                 PM_SECURITY_CONTACT is not set
pass  mail_test                    delivered in 6 s, verdict pass; authserv-id: <printed value>
…
13 passed, 1 warning, 0 failed
```

Some checks only warn:

- `secrets` warns while `PM_MASTER_KEY_NEXT` is set, which means a `secrets rotate-master` did not
  finish.
- `quota` warns when `PM_DAILY_SEND_QUOTA` is not set.
- `ses` runs only when `PM_SES_REGION` is set and AWS credentials are available. It fails without SES
  production access, when sending is paused, when the active receipt rule set lacks `pm-deliver`, when
  the region cannot receive mail, or at 10,000 SES identities in the region (the SES limit). It warns
  (`ses_identities_90pct`) from 9,000, and when the region is outside the EU on an EU deployment.
- `cloudflare.zones` prints how many zones the Cloudflare account holds and warns above 1,000: ask
  Cloudflare then to confirm the account's limit, because it is not published.

Exit 12 when any check fails. The checks are listed in
[Observability › pmail doctor](../project/design/observability.md#72-pmail-doctor).

### `destroy`

Deletes the deployment: every tenant's data (through erasure), the Worker, the mail domain's routing
and sending set-up, the Vectorize index, the queues, the R2 buckets (including the backup bucket) and
the D1 database. **This deletes
all mail, keys and configuration permanently.**

```text
pmail destroy [--dry-run] [--confirm <platform-domain>] [--skip-erasure] [--keep-dns] [--dir <path>]
```

| Flag | Meaning |
|---|---|
| `--dry-run` | Print what would be deleted, and change nothing |
| `--confirm` | The platform domain, to confirm without a prompt. Required in non-interactive runs; `--yes` does not replace it |
| `--skip-erasure` | Do not erase tenants through the API first (use only when the Worker no longer answers) |
| `--keep-dns` | Leave the mail domain's Email Routing DNS records in place |

Threads under a legal hold stop the erasure step until a person releases the hold. The R2 bucket can
only be deleted when it is empty; if staging objects remain, run `destroy` again a day later.

```bash
pmail destroy --dry-run
pmail destroy --confirm agents.example
```

### `secrets rotate-master`

Rotates `PM_MASTER_KEY` without downtime: uploads a new key as `PM_MASTER_KEY_NEXT`, waits until the
Worker has re-sealed every stored secret with it, then makes it `PM_MASTER_KEY`.

```text
pmail secrets rotate-master [--resume] [--dir <path>]
```

`--resume` continues an interrupted rotation. The thread, link and cursor signing keys are rotated with
[`keys rotate thread|link|cursor`](#keys-rotate-threadlinkcursor). `PM_CF_API_TOKEN` and the SES keys are
rotated with `wrangler secret put`, as described in
[Security](../project/design/security.md#62-rotation-procedures).

```bash
pmail secrets rotate-master
```

---

## Platform operations

Platform keys with `platform:ops`. These commands call the
[platform API](api.md#platform-operations) only; they need no Cloudflare credentials. Every call is
audit-logged.

### `dlq list`

Lists messages that failed every retry and landed in a dead-letter queue. Message bodies are never
returned.

```text
pmail dlq list [--queue <name>] [--status open|redriven] [--tenant <tenant>] [--limit <n>] [--all]
```

`--queue` is one of `pm-inbound`, `pm-outbound`, `pm-delivery-events`, `pm-webhooks`, `pm-index`.
`--status` defaults to `open`. Items are kept for 14 days.

```bash
pmail dlq list --queue pm-inbound
```

### `dlq redrive`

Puts dead-lettered messages back on their queue. Safe to repeat: every consumer is idempotent. Name the
items, or redrive every open item of a queue (you are asked to confirm the count unless `--yes`).

```text
pmail dlq redrive (<dlq-id>… | --queue <name> [--tenant <tenant>]) [--yes]
```

```bash
pmail dlq redrive dlq_01JA9P2T8CW7X2M5N6P8R0T1YZ
pmail dlq redrive --queue pm-inbound --yes
```

### `keys rotate thread|link|cursor`

Rotates one of the keys the Worker uses to sign thread tokens (`thread`), download links, console
tokens and OAuth state (`link`), or search cursors (`cursor`). The Worker generates the new key; no key is ever shown.

```text
pmail keys rotate thread|link|cursor [--revoke-previous] [--yes]
```

| Purpose | The previous key keeps verifying for |
|---|---|
| `thread` | 90 days |
| `link` | 7 days |
| `cursor` | 24 hours |

`--revoke-previous` deletes the previous key at once instead. Use it after a suspected leak, then run
`pmail secrets rotate-master`. Tokens the old key signed stop working: replies to old thread tokens fall
back to header threading; open download and sign-in links, invitations, console sessions and Google or
GitHub sign-ins in progress fail; and open search cursors fail. You are asked to confirm unless `--yes`.

The output shows the purpose, the new key ID (kid), and the previous kid with the time it stops
verifying, or `revoked`:

```text
Rotated thread key: new kid 4 (2026-10-09T10:00:00Z)
Previous kid 3 verifies until 2027-01-07T10:00:00Z
```

An argument that starts with `key_` rotates an API key instead ([`keys rotate`](#keys-rotate)).

```bash
pmail keys rotate link --yes
```

### `jobs start`

Starts a maintenance job over one tenant: `reparse` (parse messages again from the raw MIME, for
example after a parser fix), `reembed` (chunk and embed them again into the vector index) or
`reindex` (rebuild the keyword index).

```text
pmail jobs start reparse|reembed|reindex --tenant <tenant> [--identity <identity>]… [--after <time>]
                 [--before <time>]
```

Without `--identity`, the job covers every identity of the tenant. It prints the job with its ID.

```bash
pmail jobs start reparse --tenant brightwell --after 2026-09-01
```

### `jobs get`

Shows a job's status (`queued`, `running`, `completed`, `failed` or `canceled`) and, once it ends, its
counts.

```bash
pmail jobs get job_01JA9Q3V9DW7X2M5N6P8R0T1Z0
```

### `waitlist invite`

Invites the oldest confirmed people on the waitlist (`PM_SIGNUP = "waitlist"`). Each gets a sign-up link
valid for 7 days. `--count` is 1–500; `--plan` invites only people who chose that plan.

```text
pmail waitlist invite --count <n> [--plan <plan-id>]
```

```bash
pmail waitlist invite --count 50 --plan developer
```

```text
Invited 50; 262 still waiting.
```

---

## Profiles

### `login`

Asks for the API URL and a key, checks the key with `GET /v1/me`, and saves both in a profile.

```text
pmail login [--profile <name>] [--url <url>] [--key-env <NAME> | --key-command <cmd>]
```

```bash
pmail login
pmail login --profile staging --url https://mail-staging.example.com --key-env PYLOTA_MAIL_STAGING_KEY
```

### `config show`

Prints the resolved URL, key (prefix only), profile, identity and tenant, and where each came from.

```bash
pmail config show
```

### `config set`

Sets `url`, `identity`, `tenant`, `key_env`, `key_command` or `default_profile`. To store a key, use
`pmail login`.

```text
pmail config set <setting> <value> [--profile <name>]
```

```bash
pmail config set identity bookings@acme.example.com
```

### `mcp config`

Prints MCP client configuration for the current profile's URL. It never prints the key; the
configuration reads `PYLOTA_MAIL_KEY` from the environment. It also lists the tools the current key
would see.

```text
pmail mcp config [--client generic|claude-code|cursor] [--name <server-name>]
```

```bash
pmail mcp config --client claude-code
```

See [MCP server › Connect a client](mcp.md#connect-a-client).

---

## Tenants

Platform keys with `tenants:manage`. A tenant key can `get` its own tenant.

### `tenants create`

```text
pmail tenants create --slug <slug> --name <name> [--mode live|test] [--timezone <iana>]
                     [--address-suffix <suffix>] [--policy-file <file>]
                     [--owner-email <email>] [--owner-name <name>] [--billing-mode metered|exempt|disabled]
```

| Flag | Meaning |
|---|---|
| `--slug` | `^[a-z0-9][a-z0-9-]{1,31}$` |
| `--mode` | `live` (default) or `test`. A test tenant never sends mail outside the deployment |
| `--address-suffix` | Defaults to `.` + slug |
| `--policy-file` | JSON merged over the policy defaults ([Configuration › Tenant policy](configuration.md#tenant-policy)) |
| `--owner-email`, `--owner-name` | Creates the workspace's console owner and emails a sign-in link |

```bash
pmail tenants create --slug acme --name "Acme Car Hire"
pmail tenants create --slug acme-test --name "Acme Car Hire (test)" --mode test
```

### `tenants list`

```text
pmail tenants list [--status active|suspended|erasing|erased] [--mode live|test] [--limit <n>] [--all]
```

```bash
pmail tenants list --status active
```

### `tenants get`

```bash
pmail tenants get acme
```

### `tenants update`

```text
pmail tenants update <tenant> [--name <name>] [--timezone <iana>] [--policy-file <file>] [--policy <json>]
```

`--policy-file` and `--policy` deep-merge into the tenant's policy; `null` resets a field to its default.

```bash
pmail tenants update acme --policy '{"search":{"agentic_daily_cap":200}}'
```

### `tenants suspend` and `tenants resume`

Suspends a tenant (sends are refused with `tenant_suspended`; inbound mail is deferred) or resumes it.

```bash
pmail tenants suspend acme
pmail tenants resume acme
```

---

## Identities

### `identities create`

```text
pmail identities create --username <name> --display-name <name> [--purpose <tag>]
                        [--owner-name <name>] [--owner-email <email>] [--signature-text <text>]
                        [--domain <domain>] [--client-id <id>] [--metadata <key=value>]… [--tenant <tenant>]
```

| Flag | Meaning |
|---|---|
| `--username` | `^[a-z0-9][a-z0-9._-]{0,23}$`. Reserved and look-alike names are refused |
| `--display-name` | The `From` display name |
| `--owner-name`, `--owner-email` | The accountable human. An identity cannot send without one (`identity_owner_required`) |
| `--domain` | Create the primary address on a healthy tenant domain instead of the platform domain |
| `--client-id` | Makes the create idempotent for your own provisioning |

With a platform key and no `--tenant`, the identity is created in the default tenant.

```bash
pmail identities create --username bookings --display-name "Acme Car Hire"
```

```bash
pmail identities create --username compliance --display-name "Acme Car Hire Compliance" \
  --owner-name "Sam Patel" --owner-email sam@acmecarhire.example --tenant acme
```

### `identities list`

```text
pmail identities list [--tenant <tenant>] [--status active|paused] [--purpose <tag>] [--client-id <id>] [--all]
```

```bash
pmail identities list --tenant acme
```

### `identities get`

```bash
pmail identities get bookings@acme.example.com
```

### `identities update`

```text
pmail identities update <identity> [--display-name <name>] [--purpose <tag>] [--owner-name <name>]
                        [--owner-email <email>] [--signature-text <text>] [--metadata <key=value>]…
                        [--daily-cap <n>] [--auto-reply allowed|denied] [--require-known-recipient true|false]
```

`--daily-cap`, `--auto-reply` and `--require-known-recipient` set the identity's `send_policy`.

```bash
pmail identities update bookings.acme@agents.example \
  --owner-name "Sam Patel" --owner-email sam@acmecarhire.example
```

### `identities pause` and `identities resume`

A paused identity cannot send. Resuming an identity paused for abuse needs a tenant or platform key.

```bash
pmail identities pause bookings@acme.example.com
pmail identities resume bookings@acme.example.com
```

### `identities delete`

Starts an erasure of the whole mailbox (needs `identities:write` and `erasure:manage`). Its addresses
can never be given to another identity. Asks you to type the identity's primary address, or pass
`--confirm <address>`.

```bash
pmail identities delete bookings@acme.example.com --confirm bookings@acme.example.com
```

### `identities lookup`

Finds the identity that owns an address. Unknown, retired or out-of-scope addresses give exit 5.

```bash
pmail identities lookup bookings@acme.example.com
```

---

## Addresses

### `addresses list`

```bash
pmail addresses list --identity bookings.acme@agents.example
```

### `addresses add`

Adds an alias on a tenant domain. It stays `pending` until the domain is healthy.

```text
pmail addresses add --identity <identity> --local-part <name> --domain <domain>
```

```bash
pmail addresses add --identity bookings.acme@agents.example --local-part bookings --domain acme.example.com
```

### `addresses promote`

Makes an address the primary. The previous primary keeps working as a `retiring` alias for
`--retire-previous-after-days` (default 90, 0–365). Promoting a `retiring` address rolls back.

```text
pmail addresses promote <address-id> --identity <identity> [--retire-previous-after-days <n>]
```

```bash
pmail addresses promote adr_01JA8F5L1VW7X2M5N6P8R0T1YP --identity bookings.acme@agents.example
```

### `addresses retire`

```text
pmail addresses retire <address-id> --identity <identity> [--after-days <n>]
```

```bash
pmail addresses retire adr_01J9Z3K8V5W7X2M5N6P8R0T1YQ --identity bookings@acme.example.com --after-days 30
```

### `addresses delete`

Only for a `pending` address that never received mail; otherwise retire it.

```bash
pmail addresses delete adr_01JA8F5L1VW7X2M5N6P8R0T1YP --identity bookings.acme@agents.example
```

### `addresses test-forwarding`

For an address on a domain whose mail reaches the agent through forwarding (`send_only`, or
`smtp_relay` with `--inbound forward`): sends a short test message to the address and checks that your
mailbox's forwarding rule delivers it to the identity. The result appears within 10 minutes as the
address's `forwarding` (`ok` or `failed`) in `pmail addresses list`. Needs `identities:write`.

```text
pmail addresses test-forwarding <address> [--identity <identity>]
```

`<address>` is the address itself, or an address ID with `--identity`.

```bash
pmail addresses test-forwarding bookings@brightwell.example
```

---

## Domains

### `domains add`

Connects a domain to a tenant. The `--method` decides how mail arrives and leaves, and what you change
at your DNS host; [Custom domains](../guides/custom-domains.md) helps you choose, and
[Domains on any DNS host](../project/design/domain-connections.md#2-inbound-source-and-outbound-transport-are-separate-choices)
has the full table.

```text
pmail domains add <name> --method <method> [--tenant <tenant>] [--no-receiving] [--no-sending]
                  [--replace-mx] [--confirm-dedicated]
                  [--inbound forward|ses] [--smtp-host <host>] [--smtp-port 465|587]
                  [--smtp-username <name>] [--smtp-password-stdin] [--probe-from <address>]
```

| `--method` | Use it for | You change at your DNS host | Needs on the deployment |
|---|---|---|---|
| `cloudflare_zone` | A domain already on Cloudflare in the deployment's account | Nothing | `PM_CF_API_TOKEN` (an apex works without it, see below) |
| `nameservers` | A new domain used only for mail | Two NS records at your registrar | `PM_CF_API_TOKEN`; a platform key, or a tenant whose policy allows zone creation |
| `dns_records` | A subdomain (or domain) whose DNS stays where it is, both directions | One MX, three DKIM CNAMEs, a MAIL FROM MX and TXT, an ownership TXT | [`setup ses`](#setup-ses) |
| `send_only` | Sending as your existing addresses; your mailbox forwards to the agent | Three DKIM CNAMEs, a MAIL FROM MX and TXT, an ownership TXT | [`setup ses`](#setup-ses) |
| `smtp_relay` | Sending through your own mail provider's SMTP server | An ownership TXT | Your relay's credentials; a passing alignment probe |
| `delegated_subdomain` | A subdomain delegated to Cloudflare (Enterprise accounts) | NS records for the subdomain | `PM_CF_API_TOKEN`, `PM_CF_SUBDOMAIN_SETUP = "on"` |

| Flag | Methods | Meaning |
|---|---|---|
| `--replace-mx` | `cloudflare_zone` (apex), `dns_records` | The domain already has MX records. For `cloudflare_zone`, they are replaced and **mail to the current provider stops**. For `dns_records`, you confirm you will replace them at your DNS host; until you do, health reports `mx_unexpected` |
| `--confirm-dedicated` | `nameservers` | Confirm the domain serves no website or other mail. Without it, a domain with A, AAAA or MX records, or a `www` record, is refused (`domain_not_dedicated`, exit 6) and the records found are listed |
| `--inbound` | `smtp_relay` (required) | `forward` (your mailbox forwards to the agent) or `ses` (also publish the SES MX and DKIM records; needs `setup ses`) |
| `--smtp-host`, `--smtp-port`, `--smtp-username` | `smtp_relay` (required) | Your provider's SMTP submission server. The port is `465` (TLS) or `587` (STARTTLS); port 25 is not allowed |
| `--smtp-password-stdin` | `smtp_relay` (required) | Read the SMTP password from stdin. **The password is never accepted on the command line.** On a terminal, `pmail` asks for it with hidden input |
| `--probe-from` | `smtp_relay` | The sender address of the alignment probe. Defaults to `postmaster@{domain}` |
| `--no-receiving`, `--no-sending` | all | Onboard only one direction |

A flag that the method does not use is refused (exit 2). Needs `domains:write`.

When the deployment has no `PM_CF_API_TOKEN`, `domains add --method cloudflare_zone` onboards a zone
**apex** with your local `CLOUDFLARE_API_TOKEN` instead (catch-all routing, no per-address rules). A zone
subdomain, `nameservers` and `delegated_subdomain` then need `PM_CF_API_TOKEN` on the deployment.

The result is the domain in `pending`, followed by the records to publish. Each record has a `name`
(the full name) and a `host` (the name relative to your registered domain). Enter `host` if your DNS
host adds the domain itself, and `name` if it wants the full name:

```text
TYPE   NAME                                        HOST                          VALUE                                        PURPOSE
TXT    _pylota-mail.agents.brightwell.example      _pylota-mail.agents           pm-verify=8f2k…                              ownership
MX     agents.brightwell.example                   agents                        10 inbound-smtp.eu-west-2.amazonaws.com      mx
CNAME  4kq…._domainkey.agents.brightwell.example   4kq…._domainkey.agents        4kq….{signing zone}                          dkim
MX     pm-bounce.agents.brightwell.example         pm-bounce.agents              10 feedback-smtp.eu-west-2.amazonses.com     return_path
TXT    pm-bounce.agents.brightwell.example         pm-bounce.agents              v=spf1 include:amazonses.com ~all            spf
…
```

One example per method:

```bash
# cloudflare_zone: brightwell.example is a zone in the deployment's Cloudflare account
pmail domains add brightwell.example --method cloudflare_zone --tenant brightwell

# nameservers: a new domain just for agents; set the two NS records it prints at your registrar
pmail domains add brightwell-agents.example --method nameservers --tenant brightwell

# dns_records: a subdomain at any DNS host; brightwell.example keeps its own mail
pmail domains add agents.brightwell.example --method dns_records --tenant brightwell

# send_only: agents send as bookings@brightwell.example; your mailbox forwards to them
pmail domains add brightwell.example --method send_only --tenant brightwell

# smtp_relay: send through your provider, with the password read from stdin
op read "op://vault/brightwell-smtp/password" | pmail domains add brightwell.example --method smtp_relay \
  --tenant brightwell --inbound forward --smtp-host smtp.provider.example --smtp-port 587 \
  --smtp-username agents@brightwell.example --smtp-password-stdin --probe-from agents@brightwell.example

# delegated_subdomain: add the NS records it prints for agents at your DNS host
pmail domains add agents.brightwell.example --method delegated_subdomain --tenant brightwell
```

### `domains list`

```bash
pmail domains list --tenant acme
```

The platform domain is listed for every key, with no tenant.

### `domains get`

```bash
pmail domains get acme.example.com
```

### `domains update`

Changes how a domain sends. `--transport` switches between Cloudflare Email Sending and Amazon SES (the
Email Sending failover); only platform keys may change it. The `--smtp-…` flags change an `smtp_relay`
domain's server or credentials; settings you leave out keep their current values, but the password must
always be given on stdin, because it is never shown back. The new values are used only after an
alignment probe passes. Needs `domains:write`.

```text
pmail domains update <domain> [--transport cloudflare|ses] [--smtp-host <host>] [--smtp-port 465|587]
                     [--smtp-username <name>] [--smtp-password-stdin] [--probe-from <address>]
```

```bash
pmail domains update brightwell.example --transport ses
op read "op://vault/brightwell-smtp/password" | pmail domains update brightwell.example --smtp-password-stdin
```

### `domains probe`

Runs the alignment probe of an `smtp_relay` domain now (at most once a minute): a message through your
relay to the platform domain, which must pass DMARC for your domain. It prints the probe ID; the result
shows up in `pmail domains health`. Needs `domains:write`.

```bash
pmail domains probe brightwell.example
```

### `domains records`

Re-reads the expected DNS records and checks each against DNS (`ok`, `missing`, `mismatch`,
`unexpected`).

```bash
pmail domains records dom_01JA9G6M2WW7X2M5N6P8R0T1YR
```

### `domains verify`

Runs a check now (at most once a minute per domain).

```bash
pmail domains verify dom_01JA9G6M2WW7X2M5N6P8R0T1YR
```

### `domains health`

Shows the state, the issues with their fixes, recent checks and whether sends are falling back to the
platform address.

```bash
pmail domains health acme.example.com
```

### `domains reprove`

Issues a new ownership record for a `suspended` domain.

```bash
pmail domains reprove acme.example.com
```

### `domains remove`

Removes routing, sending and the event subscription. Refused while any address on the domain is
`active` or `retiring` (`domain_in_use`).

```bash
pmail domains remove acme.example.com --yes
```

---

## Sending

### `send`

```text
pmail send --identity <identity> --to <recipient>… --subject <text>
           (--text <text> | --text-file <file>) [--html <html> | --html-file <file>]
           [--cc <recipient>]… [--bcc <recipient>]… [--attach <file>]… [--kind transactional|marketing|auto_reply]
           [--thread <thread-id>] [--from-address <address>] [--label <label>]… [--header <"X-Name: value">]…
           [--metadata <key=value>]… [--unsubscribe-url <url>] [--unsubscribe-mailto <address>]
           [--consent-basis <basis> --consent-recorded-at <time>] [--allow-large] [--idempotency-key <key>]
```

| Flag | Meaning |
|---|---|
| `--to`, `--cc`, `--bcc` | `addr@example.net` or `"Name <addr@example.net>"`; repeat the flag or separate with commas. At most 10 in total by default (policy) |
| `--text`, `--html` | At least one is required. Text is derived from HTML when missing |
| `--attach` | Attach a file (repeatable). `pmail` refuses before sending when the message would exceed 5 MiB, unless `--allow-large` (for tenants that turn large attachments into links) |
| `--kind` | `marketing` needs `--unsubscribe-url` or `--unsubscribe-mailto` and the consent flags |
| `--thread` | Continue an existing thread |
| `--header` | Only `X-` headers and `Importance`, `Priority`, `Sensitivity`, `Keywords`, `Comments`, `Organization` |
| `--idempotency-key` | 1–255 printable ASCII characters. Generated and printed when omitted |

```bash
pmail send --identity bookings@acme.example.com \
  --to renter@example.org --subject "Your booking BK-2291" \
  --text "Your car is ready at 9:00." \
  --idempotency-key bk-2291-confirm
```

The result is the queued message. Running the same command again returns it with
`"deduplicated": true` and sends nothing.

### `reply`

Replies to the sender of a message, from the address they wrote to, in the same thread.

```text
pmail reply <message-id> --identity <identity> (--text <text> | --text-file <file>) [--html …]
            [--attach <file>]… [--kind transactional|auto_reply] [--idempotency-key <key>]
```

```bash
pmail reply msg_01JA6D3J9SW7X2M5N6P8R0T1YL --identity bookings@acme.example.com \
  --text "Friday works. See you at 10." \
  --idempotency-key bk-2291-reply-1
```

### `reply-all`

As `reply`, to the sender and every `To` and `Cc` recipient except your own addresses. Bcc
recipients of the original are never included.

```bash
pmail reply-all msg_01JA6D3J9SW7X2M5N6P8R0T1YL --identity bookings@acme.example.com \
  --text "Copying everyone: Friday at 10 is confirmed." --idempotency-key bk-2291-reply-all-1
```

### `forward`

```text
pmail forward <message-id> --identity <identity> --to <recipient>… [--text <text>] [--no-attachments]
              [--idempotency-key <key>]
```

```bash
pmail forward msg_01JB2C3D4EW7X2M5N6P8R0T1YM --identity compliance@acme.example.com \
  --to claims@insurer.example --text "Forwarding the photos for claim 7781." \
  --idempotency-key claim-7781-photos-fwd
```

### `cancel`

Cancels a send that is still `queued`. Otherwise exit 6 (`not_cancelable`).

```bash
pmail cancel msg_01JA5D9X2KW7X2M5N6P8R0T1YJ --identity bookings@acme.example.com
```

### `resolve`

Records the outcome of an `uncertain` send after you have checked with the recipient or the provider.
`not_sent` marks it `failed`, after which you can send again with a new idempotency key.

```text
pmail resolve <message-id> --identity <identity> --outcome sent|not_sent
```

```bash
pmail resolve msg_01JA5D9X2KW7X2M5N6P8R0T1YJ --identity bookings@acme.example.com --outcome not_sent
```

---

## Threads and messages

### `threads list`

```text
pmail threads list --identity <identity> [--label <label>] [--category <name>] [--needs-reply-gte <0..1>]
                   [--unread] [--direction inbound|outbound] [--after <time>] [--before <time>]
                   [--archived] [--limit <n>] [--all]
```

```bash
pmail threads list --identity bookings@acme.example.com --needs-reply-gte 0.5
```

### `threads get`

```text
pmail threads get <thread-id> --identity <identity> [--messages-limit <n>] [--include quoted,html,headers]
```

```bash
pmail threads get thr_01JA5C2H8QW7X2M5N6P8R0T1YB --identity bookings@acme.example.com
```

### `threads label`

```text
pmail threads label <thread-id> --identity <identity> [--add <label>]… [--remove <label>]…
                    [--read | --unread] [--archive | --unarchive]
```

```bash
pmail threads label thr_01JA5C2H8QW7X2M5N6P8R0T1YB --identity bookings@acme.example.com --add handled --read
```

### `threads hold` and `threads unhold`

A legal hold keeps a thread out of retention and erasure until it is removed or expires. Needs
`erasure:manage`; both actions are audit-logged.

```text
pmail threads hold <thread-id> --identity <identity> --reason <text> [--until <time>]
pmail threads unhold <thread-id> --identity <identity>
```

```bash
pmail threads hold thr_01JA5C2H8QW7X2M5N6P8R0T1YB --identity compliance@acme.example.com \
  --reason "PCN dispute WM12345678" --until 2027-10-09
```

### `messages list`

```text
pmail messages list --identity <identity> [--thread <thread-id>] [--direction inbound|outbound]
                    [--status <status>] [--label <label>] [--after <time>] [--before <time>] [--all]
```

```bash
pmail messages list --identity bookings@acme.example.com --direction outbound --status bounced
```

### `messages get`

```text
pmail messages get <message-id> --identity <identity> [--include quoted,html,headers]
```

```bash
pmail messages get msg_01JA5C2H8RW7X2M5N6P8R0T1YE --identity bookings@acme.example.com
```

### `messages raw`

Saves the original MIME message (kept for `retention.raw_days`, 90 days by default). Writes to
`--out`, or to stdout when stdout is not a terminal.

```bash
pmail messages raw msg_01JA5C2H8RW7X2M5N6P8R0T1YE --identity bookings@acme.example.com --out message.eml
```

### `messages attachment`

Saves an attachment's bytes. Attachments flagged as risky need `quarantine:review`.

```text
pmail messages attachment <message-id> <attachment-id> --identity <identity> --out <file>
```

```bash
pmail messages attachment msg_01JA4B1G7PW7X2M5N6P8R0T1YC att_01JA4B1G7QW7X2M5N6P8R0T1YF \
  --identity bookings@acme.example.com --out INV-88213.pdf
```

### `messages attachment-text`

Prints an attachment's extracted text by page.

```text
pmail messages attachment-text <message-id> <attachment-id> --identity <identity> [--pages <1-3>]
```

```bash
pmail messages attachment-text msg_01JA4B1G7PW7X2M5N6P8R0T1YC att_01JA4B1G7QW7X2M5N6P8R0T1YF \
  --identity bookings@acme.example.com --pages 1
```

### `messages label`

```text
pmail messages label <message-id> --identity <identity> [--add <label>]… [--remove <label>]… [--read | --unread]
```

```bash
pmail messages label msg_01JA4B1G7PW7X2M5N6P8R0T1YC --identity bookings@acme.example.com --add invoice
```

---

## Search and agents

### `search`

```text
pmail search "<query>" [--identity <identity> | --tenant <tenant> [--identity-ids <id,…>]]
             [--mode keyword|semantic|hybrid|agentic] [--group-by message|thread] [--limit <n>]
             [--snippet-chars <n>] [--direction inbound|outbound] [--label <label>]… [--after <time>]
             [--before <time>] [--no-facets] [--include-quarantined] [--require-mode] [--cursor <cursor>]
```

| Flag | Meaning |
|---|---|
| `--mode` | `hybrid` (default), `keyword`, `semantic`, or `agentic` (the same as `pmail ask --no-stream`) |
| `--tenant` | Search every identity of a tenant (tenant and platform keys); hits show their identity |
| `--group-by thread` | One row per conversation |
| `--require-mode` | Fail with `search_degraded` instead of falling back to keyword search |
| `--include-quarantined` | Needs `quarantine:review` |
| `--cursor` | The `next_cursor` of the previous page |

The query language (`from:`, `ref:`, `has:attachment`, `newer_than:` and the rest) is in
[Search](../guides/search.md).

```bash
pmail search "from:@brightwell.example ref:AB12CDE has:attachment" --identity bookings@acme.example.com
```

```bash
pmail search "damage to the rear bumper" --tenant acme --group-by thread
```

### `ask`

Asks a question and prints an answer in which every sentence cites messages, streaming the progress as
it searches. Needs `search:agentic`.

```text
pmail ask "<question>" --identity <identity> [--max-steps <2-10>] [--max-seconds <3-30>]
          [--include-quarantined] [--no-stream] [--show-trace] [--stream]
```

| Flag | Meaning |
|---|---|
| `--max-steps`, `--max-seconds` | The search budget (defaults 6 steps and 8 seconds, or the tenant's policy) |
| `--no-stream` | Wait for the whole answer instead of showing progress |
| `--show-trace` | Print every step, even when stderr is not a terminal |
| `--stream` | With `--json`: print each event as one JSON line as it arrives |

```bash
pmail ask "Did the insurer accept the Golf claim?" --identity compliance@acme.example.com
```

```text
⋯ step 1  search "claim Golf photos" (hybrid) · 7 hits · 412 ms
⋯ step 2  read thread thr_01JA… · 38 ms

Yes. Admiral accepted claim 7781 on 2 October, after the photos sent on 28 September [1][2].

[1] msg_01JA…  2026-10-02  Admiral Claims <claims@admiral.example>  "Claim 7781 – decision"
[2] msg_01JB…  2026-09-28  Acme Car Hire <compliance@acme.example.com>  "Photos for claim 7781"

answered · confidence 0.86 · 3 steps · 2.8 s
```

The status is `answered`, `insufficient_evidence`, `budget_exhausted` or `degraded`; all exit 0.
`--json` prints the complete response once it is finished; `--json --stream` prints each event as a
JSON line as it arrives.

### `wait`

Waits for a new matching message, for example a reply or a verification code.

```text
pmail wait --identity <identity> [--from <address|@domain>] [--subject-contains <text>]
           [--thread <thread-id>] [--kind any|reply|verification] [--since <time>] [--timeout <1-60>]
```

A verification code or link is shown only when `--from` names the sender's domain and the message
passed authentication. Nothing arriving is exit 13.

```bash
pmail wait --identity signups@acme.example.com --from @service.example --kind verification --timeout 60 --quiet
```

### `triage list`

Lists threads with their triage roll-up (category, needs-reply score, urgency).

```text
pmail triage list --identity <identity> [--category <name>] [--needs-reply-gte <0..1>] [--limit <n>]
```

```bash
pmail triage list --identity bookings@acme.example.com --category customer_request --needs-reply-gte 0.5
```

### `triage rerun`

Runs triage again for one inbound message. A `message.triaged` event follows.

```bash
pmail triage rerun msg_01JA5C2H8RW7X2M5N6P8R0T1YE --identity bookings@acme.example.com
```

### `quarantine list`

```bash
pmail quarantine list --identity bookings@acme.example.com
```

### `quarantine release`

Moves a quarantined message into the mailbox and triages it. Needs `quarantine:review`; audit-logged.

```text
pmail quarantine release <message-id> --identity <identity> --reason <text>
```

```bash
pmail quarantine release msg_01JA8H7N3XW7X2M5N6P8R0T1YS --identity bookings@acme.example.com \
  --reason "Known supplier, DKIM key rotated"
```

---

## Webhooks

### `webhooks create`

```text
pmail webhooks create --url <https-url> --events <type,…> [--identity-ids <id,…>] [--description <text>]
                      [--tenant <tenant> | --platform]
```

`--events '*'` subscribes to every event type, including future ones. `--platform` creates a
platform-wide endpoint (platform keys). The signing secret (`whsec_…`) is printed once.

```bash
pmail webhooks create --url https://api.example.com/webhooks/mail \
  --events message.received,message.bounced
```

### `webhooks list` and `webhooks get`

```bash
pmail webhooks list --tenant acme
pmail webhooks get whk_01JA9J8P4YW7X2M5N6P8R0T1YT
```

### `webhooks update`

```text
pmail webhooks update <webhook-id> [--url <url>] [--events <type,…>] [--identity-ids <id,…>]
                      [--description <text>] [--enable | --disable]
```

```bash
pmail webhooks update whk_01JA9J8P4YW7X2M5N6P8R0T1YT --events message.received,message.triaged
```

### `webhooks delete`

```bash
pmail webhooks delete whk_01JA9J8P4YW7X2M5N6P8R0T1YT --yes
```

### `webhooks rotate`

Issues a new signing secret. During the overlap (0–168 hours, default 24) deliveries carry both
signatures.

```bash
pmail webhooks rotate whk_01JA9J8P4YW7X2M5N6P8R0T1YT --overlap-hours 24
```

### `webhooks test`

Sends a `webhook.test` event now and prints the delivery attempt.

```bash
pmail webhooks test whk_01JA9J8P4YW7X2M5N6P8R0T1YT
```

### `webhooks deliveries`

```text
pmail webhooks deliveries <webhook-id> [--status succeeded|failed|dead] [--event-type <type>] [--after <time>] [--all]
```

```bash
pmail webhooks deliveries whk_01JA9J8P4YW7X2M5N6P8R0T1YT --status dead
```

### `webhooks replay`

Delivers past events again (up to 30 days old).

```text
pmail webhooks replay <webhook-id> (--event-id <evt_…>… | --since <time> [--until <time>] [--status dead])
```

```bash
pmail webhooks replay whk_01JA9J8P4YW7X2M5N6P8R0T1YT --since 2026-10-08 --until 2026-10-09 --status dead
```

### `webhooks verify`

Checks a captured delivery's signature offline, the way your endpoint should. Exit 0 when valid,
11 when not.

```text
pmail webhooks verify --secret-env <NAME> (--headers <file> | --id <id> --timestamp <ts> --signature <sig>)
                      [--body <file>] [--tolerance <seconds>] [--now <unix-seconds>]
```

`--headers` reads `webhook-id`, `webhook-timestamp` and `webhook-signature` from a file of `Name: value`
lines. The body is read unchanged from `--body` or stdin. `--tolerance` defaults to 300 seconds.
`--secret whsec_…` also works, but other users of the machine can see command lines.

```bash
export WEBHOOK_SECRET=whsec_…
pmail webhooks verify --secret-env WEBHOOK_SECRET --headers headers.txt --body body.json
```

---

## API keys

### `keys create`

```text
pmail keys create --level platform|tenant|identity --name <name> [--tenant <tenant>] [--identity <identity>]
                  [--permissions <permission,…>] [--expires-at <time> | --expires-in <duration>]
                  [--save-profile <name>]
```

| Flag | Meaning |
|---|---|
| `--level` | `platform` reaches every tenant; `tenant` one tenant; `identity` one identity |
| `--permissions` | Comma-separated ([API › Permissions](api.md#permissions)). Required for tenant and identity keys. A platform key without it gets every permission |
| `--expires-in` | For example `90d` |
| `--save-profile` | Also store the new key in this CLI profile |

The new key cannot exceed your own key's level, tenant, identity or permissions. The secret
(`pmk_live_…` or `pmk_test_…`) is printed **once**. Run interactively with the temporary key that
`setup` stored, `pmail` offers to save the new platform key in that profile and revoke the temporary
one.

```bash
pmail keys create --level platform --name first-key
```

```bash
pmail keys create --level identity --identity bookings@acme.example.com --name bookings-agent \
  --permissions messages:read,messages:send,search:read,attachments:read
```

### `keys list` and `keys get`

```bash
pmail keys list --tenant acme
pmail keys get key_01JA9K9Q5ZW7X2M5N6P8R0T1YV
```

### `keys revoke`

Revokes a key immediately.

```bash
pmail keys revoke key_01JA9K9Q5ZW7X2M5N6P8R0T1YV --yes
```

### `keys rotate`

Issues a new secret for the same API key; the old one keeps working for the overlap (0–168 hours,
default 24).

```text
pmail keys rotate <key-id> [--overlap-hours <0-168>]
```

```bash
pmail keys rotate key_01JA9K9Q5ZW7X2M5N6P8R0T1YV --overlap-hours 24
```

The first argument decides what is rotated: a `key_…` ID rotates that API key, and `thread`, `link` or
`cursor` rotates a signing key ([`keys rotate thread|link|cursor`](#keys-rotate-threadlinkcursor)).
`--overlap-hours` with a signing key, or `--revoke-previous` with an API key, is refused (exit 2).

---

## Suppressions and lists

Need `suppressions:manage`.

### `suppressions list`

```text
pmail suppressions list [--tenant <tenant>] [--address <address>] [--reason <reason>] [--all]
```

```bash
pmail suppressions list --tenant acme --reason hard_bounce
```

### `suppressions add`

```text
pmail suppressions add <address> [--tenant <tenant>] [--reason manual] [--note <text>]
```

```bash
pmail suppressions add jo@example.net --tenant acme --note "Asked not to be contacted"
```

### `suppressions remove`

Removing a `complaint` suppression needs `--confirm-complaint-removal` and is audit-logged.

```bash
pmail suppressions remove jo@example.net --tenant acme
```

### `lists list`, `lists add` and `lists remove`

Allow and block lists for receiving and sending. `<direction>` is `receive` or `send`; `<kind>` is
`allow` or `block`; an entry is `user@example.com` or `@example.com`.

```text
pmail lists list <direction> <kind> [--tenant <tenant>]
pmail lists add <direction> <kind> <entry> [--tenant <tenant>]
pmail lists remove <direction> <kind> <entry> [--tenant <tenant>]
```

```bash
pmail lists add receive block @spam.example --tenant acme
```

---

## Privacy

Need `erasure:manage`.

### `erasure create`

```text
pmail erasure create --scope message|thread|counterparty|identity|tenant --reason <text> [--tenant <tenant>]
                     [--identity <identity>] [--message <message-id>] [--thread <thread-id>]
                     [--address <counterparty-address>] [--wait]
```

Held threads are skipped and listed in the receipt. `--wait` polls until the request completes and
prints the receipt.

```bash
pmail erasure create --scope counterparty --address jo@example.net --tenant acme \
  --reason "Data subject request DSR-1182" --wait
```

### `erasure get` and `erasure list`

```bash
pmail erasure get era_01JA9M0R6AW7X2M5N6P8R0T1YW
pmail erasure list --tenant acme --status completed --json
```

### `export create`

A subject-access export: one `.eml` per message plus `messages.json`, in a ZIP.

```text
pmail export create --scope counterparty|identity [--tenant <tenant>] [--address <address>] [--identity <identity>]
```

```bash
pmail export create --scope counterparty --address jo@example.net --tenant acme
```

### `export get`

Prints the export, and with `--download <file>` saves the ZIP from its signed link (valid for 7 days).

```bash
pmail export get exp_01JA9N1S7BW7X2M5N6P8R0T1YX --download dsr-1182.zip
```

---

## Members

Console users of a workspace. The console is the main place to manage them; these commands let you
provision people from a script. Need `members:manage` (tenant or platform keys).

### `members list`

Lists members with their roles, pending invitations, and seats granted and used.

```bash
pmail members list --tenant brightwell
```

### `members invite`

Emails an invitation to join the workspace. A pending invitation uses a seat; with none left the
command fails with `billing_limit` (exit 8).

```text
pmail members invite --email <email> [--role admin|member|viewer] [--tenant <tenant>]
```

`--role` defaults to `member`. The owner is set when the workspace is created.

```bash
pmail members invite --email kim@brightwell.example --role member --tenant brightwell
```

### `members remove`

Removes a member and ends their console sessions. Takes a user ID (`usr_…`) or the member's email. The
owner cannot be removed (`owner_required`, exit 6).

```text
pmail members remove <member> [--tenant <tenant>] [--yes]
```

```bash
pmail members remove kim@brightwell.example --tenant brightwell --yes
```

### `invitations revoke`

Cancels a pending invitation, freeing its seat. Takes an invitation ID (`inv_…`) or the invited email.

```text
pmail invitations revoke <invitation> [--tenant <tenant>] [--yes]
```

```bash
pmail invitations revoke kim@brightwell.example --tenant brightwell --yes
```

---

## Plans and billing

### `plans list`

Prints the plan catalog. Needs no key. On a deployment without billing it says so and lists nothing.

```bash
pmail plans list
```

### `billing get` and `billing set`

Read or change a workspace's billing account: its mode (`metered`, `exempt` or `disabled`) and, for a
workspace without a Stripe subscription, a complimentary plan. A plan paid through Stripe changes only
through Stripe (`plan_managed_by_stripe`, exit 6). Platform keys with `tenants:manage`; audit-logged.

```text
pmail billing get [--tenant <tenant>]
pmail billing set [--tenant <tenant>] [--mode metered|exempt|disabled] [--plan <plan-id>]
```

```bash
pmail billing get --tenant brightwell
pmail billing set --tenant brightwell --mode exempt
```

---

## Usage and audit

### `usage`

Shows the workspace's billing mode, plan and every allowance (granted, used, remaining, reset time),
from `GET /v1/usage`. Any key can read its own workspace's usage; another workspace's needs
`usage:read` (platform keys pass `--tenant`).

```text
pmail usage [--tenant <tenant>]
```

```bash
pmail usage
```

### `usage daily`

Prints per-day counts (inbound, outbound, sends, triage, search, agentic, AI neurons, storage), at most
92 days at a time, from `GET /v1/usage/daily`. Needs `usage:read` on a platform or tenant key.

```text
pmail usage daily [--tenant <tenant>] [--from <date>] [--to <date>]
```

```bash
pmail usage daily --from 2026-09-01 --to 2026-09-30 --tenant acme
```

### `audit`

Needs `audit:read`.

```text
pmail audit [--tenant <tenant>] [--action <action>] [--target <id>] [--after <time>] [--limit <n>] [--all]
```

```bash
pmail audit --tenant acme --action quarantine.release
```

---

## Commands at a glance

```text
Deployment   setup · setup ses · deploy · upgrade · doctor · destroy · secrets rotate-master
Platform     dlq list|redrive · keys rotate thread|link|cursor · jobs start|get · waitlist invite
Profiles     login · config show|set · mcp config
Tenants      tenants create|list|get|update|suspend|resume
Identities   identities create|list|get|update|pause|resume|delete|lookup
Addresses    addresses list|add|promote|retire|delete|test-forwarding
Domains      domains add|list|get|update|records|verify|probe|health|reprove|remove
Sending      send · reply · reply-all · forward · cancel · resolve
Reading      threads list|get|label|hold|unhold · messages list|get|raw|attachment|attachment-text|label
Search       search · ask · wait · triage list|rerun · quarantine list|release
Webhooks     webhooks create|list|get|update|delete|rotate|test|deliveries|replay|verify
Keys         keys create|list|get|revoke|rotate
Lists        suppressions list|add|remove · lists list|add|remove
Privacy      erasure create|get|list · export create|get
Members      members list|invite|remove · invitations revoke
Billing      plans list · billing get|set
Usage        usage · usage daily · audit
```

Members, invitations, plans and billing can also be managed in the console.
