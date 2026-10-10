# 0015 One person builds and operates Pylota Mail Cloud

| | |
|---|---|
| Status | Accepted |
| Date | 2026-10-10 |
| Deciders | The owner (TREFT LTD), owner decision of 2026-10-10 |
| Related | NFR-OPS-1, NFR-OPS-3, NFR-PRV-1, [Observability § 5](../design/observability.md#5-alerts), [Security § 3.6 and § 11](../design/security.md#36-tb6-operators-of-the-deployment), [Build plan › M0 and M20](../build-plan.md), [Testing § 10](../design/testing.md#10-live-end-to-end-suite-live) |

## Context

The owner of TREFT LTD is the only developer of Pylota Mail and also the operator of Pylota Mail Cloud.
There is no second person and no on-call rota. Several controls in the design assumed one: a person who
did not build the service timing the deploy rehearsal (NFR-OPS-1), a "required reviewer" on the staging
and release environments, release signing gated by reviewers, alerts that reach "a person" through a
single dashboard-created Custom Alert, and runbooks that end with "the operator is told". Each of these
either cannot be met or is met only on paper.

Facts this decision rests on, read on 2026-10-10:

- A GitHub environment's required reviewers can include the person who triggered the run unless
  "Prevent self-review" is selected, which is off by default; on Free, Pro and Team plans, environment
  protection rules apply only to public repositories ([Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
- Notifications of scheduled workflow runs go to the user who created the workflow or last changed its
  cron; scheduled workflows in a public repository are disabled after 60 days without repository
  activity ([Notifications for workflow runs](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs),
  [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)).
- Cloudflare Custom Alerts are created in the dashboard; no creation API was found, so `pmail doctor`
  cannot check that they exist (Cloudflare Notifications docs, read 2026-10-09).

## Decision

Every control that relied on a second person is replaced by a mechanical one:

1. **Deploy rehearsal (NFR-OPS-1).** A fresh agent session, with no repository checkout, memory or
   context but `self-hosting.md` and a new Cloudflare account's credentials, deploys from that page
   alone. The hands-on time it reports must be at most 15 minutes; its transcript and timings are
   recorded in the release notes; every point it had to guess is fixed in the page before the release.
   A paid external tester is optional.
2. **Environments.** The owner is the required reviewer of `staging` with self-review allowed; `release`
   and `ops` are limited to `v*` tags and `main`. The protection that matters is the branch and tag
   restriction and the CI gate, not the approval click.
3. **Release signing.** The minisign key never enters CI. CI builds and attests; the owner signs offline
   with `cargo xtask release sign` only after the tool has checked every file's provenance
   ([Security § 11](../design/security.md#11-supply-chain)).
4. **Alerting (NFR-OPS-3).** Two independent channels: alert email sent by the deployment through its
   system identity, and an external GitHub Actions heartbeat that fails when the deployment does not
   answer or a page alert fires. The Worker watches the heartbeat in return (`heartbeat_missing`). No
   page condition relies on a Custom Alert alone ([Observability § 5.5](../design/observability.md#55-alert-email-and-the-external-heartbeat)).
5. **Automatic containment.** Conditions that need a safe action at once act on their own and fail
   closed: read-only mode on `rpc_owner_mismatch`, partner suspension on defined anomalies, tenant
   suspension well above the reputation alert and identity auto-pause thresholds, a `free_sending` switch, an emergency prune near D1's
   limit, and erasure retries until 20 hours after the request
   ([Observability § 5.6](../design/observability.md#56-automatic-containment)).
6. **Recovery.** A break-glass record lists where every recovery credential is kept, in two places
   ([Observability § 5.7](../design/observability.md#57-break-glass-record)).
7. **Review of high-risk changes.** "Human sign-off" means the owner. It comes after the CI gates and an
   independent adversarial agent review of the change, never instead of them.
8. **System boundaries still hold.** Pylota's servers never hold a Pylota Mail platform key.

## Consequences

- Release does not wait on a person who does not exist; every control can be checked by CI or by a
  test (`live::ops::fresh_deploy_rehearsal`, `it::ops::j32_alert_channels`, `it::ops::j33_auto_containment`,
  `live::ops::heartbeat_workflow`).
- Containment can stop legitimate traffic (a partner's whole fleet, a tenant's sends). Every rule pages,
  writes an audit row and is undone by one platform-key call; the thresholds sit above the alert
  thresholds (and the tenant's burst pause above the identity auto-pause thresholds) so that a page, or a
  narrower action, normally comes first.
- The owner remains a single point of failure for decisions. The break-glass record and the alert
  channels make recovery possible, not automatic.
- A fresh agent session is a weaker test of the docs' clarity for people than a human tester; it is a
  stronger test of completeness, because it cannot fill gaps from memory.

## Alternatives considered

- **Keep "a person who did not build it".** Not available; the release would block forever.
- **Pay an on-call service.** Possible later; it would not remove the need for mechanical containment
  at 03:00, and it adds a party with access to production.
- **Cloudflare Custom Alerts as the only channel.** Cannot be created or checked by code, are in beta,
  and stop with the account they watch.
