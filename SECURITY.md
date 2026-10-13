# Security notes

TeamVault is a portfolio project, not a third-party security certification. Review deployment configuration and threat assumptions before exposing any instance to public traffic.

## Trust boundaries

- The browser is untrusted. It may send arbitrary IDs, roles, file metadata, and realtime subscription requests. The API resolves identity from a server-side session and authorizes every workspace-scoped operation.
- PostgreSQL is the authorization and persistence source of truth. Workspace/project/task references use scoped SQL and database constraints; activity is written with the associated mutation transaction.
- Redis is coordination infrastructure, not the durable source of product data. If unavailable, rate limiting becomes per process and live events may not cross API replicas.
- S3 objects must remain private and downloads pass through the authenticated API. Never return bucket keys or public object URLs to browser clients.
- Kafka receives sanitized outbox events with at-least-once delivery. Consumers must deduplicate by stable event ID.
- Kubernetes Secret objects are references in Git, not a secret delivery solution. A production deployment still needs an explicitly reviewed secret source, IAM, TLS, network routes, and operational ownership.

## Existing controls

- Passwords are hashed; sessions are opaque, expire, and support revocation. Browser session cookies are HttpOnly and SameSite, and state-changing cookie requests enforce the configured exact web origin.
- Socket tickets are short-lived and single use. Socket auth and workspace access are revalidated server-side; room names and event payloads are not treated as authorization.
- Workspace role checks and workspace-scoped queries protect project, task, comment, activity, and file operations. Tests use separate workspaces and attempt guessed/cross-tenant identifiers.
- Upload formats, signature, and byte limit are checked before storage. S3 access uses the AWS SDK credential provider chain, server-generated opaque keys, and no public ACL.
- Errors returned by the API avoid database details. Request telemetry intentionally omits URLs, query values, request/response content, identity, and network address.

These controls are represented in source and automated local tests; they do not prove the safety of an unreviewed production deployment or external account configuration.

## Known security and operations follow-up

- The full npm audit reports 19 moderate `sprintf-js` advisories in Jest's development dependency tree through `argparse`/`js-yaml`; npm reports no compatible automatic fix. Production dependencies currently audit clean. Reassess on normal dependency updates; do not force a Jest downgrade solely to silence the advisory.
- Expired sessions and audit events do not yet have scheduled cleanup. Per-process file-upload concurrency and Redis fallback limits must be included in capacity/security reviews.
- Redis adapter/session verifier deployments need TLS, ACL restrictions, private routing, and log redaction. Cross-instance Redis delivery was not exercised in this review.
- Live S3, Google OAuth, Kafka, EKS, managed secrets, external egress, central logs, backup restore, and rollback remain unverified.
- No independent penetration test or production load test has been run. The supplied k6 health check is a smoke scenario only.

## Reporting

Do not publish credentials, exploit details, or sensitive user data in a public issue. Use GitHub's private vulnerability reporting for this repository if it is enabled; otherwise contact the repository maintainer privately.
