# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting on
`https://github.com/PILOTAAI/pylota-mail` ("Security" tab → "Report a vulnerability"). Do not open a
public issue.

Include what you found, how to reproduce it and the impact you believe it has. We aim to acknowledge
reports within 3 working days and to agree a fix and disclosure date with you.

## Scope

In scope: the Worker (`crates/worker`), the core library, the CLI, the SDK, the default configuration
written by `pmail setup`, and the documentation where following it would leave a deployment insecure.

Especially interesting:

- crossing tenant or identity boundaries;
- API key scope escalation;
- sending mail as an address or domain you do not control;
- bypassing quarantine or getting unverified mail labelled as verified;
- server-side request forgery through webhooks or attachments;
- prompt injection that makes the agentic search planner or triage take an action or leak data across scopes;
- erasure that reports success while data remains.

Out of scope: denial of service by volume against your own deployment, findings that need a compromised
Cloudflare account, and issues in Cloudflare's platform itself (report those to Cloudflare).

## Supported versions

Until 1.0, only the latest release receives fixes.
