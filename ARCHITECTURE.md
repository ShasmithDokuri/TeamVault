# TeamVault Architecture

## Status and scope

This document records the current architecture and delivery path for TeamVault. The application began as a modular monolith. Milestone 7 defines in-process service APIs and module ownership boundaries while retaining one deployable application and shared PostgreSQL database; it does not introduce networked or independently deployed services.

## Product

TeamVault is a multi-tenant collaboration application. Teams use workspaces to manage members, projects, tasks, comments, private files, and activity. A user may belong to multiple workspaces; membership and role govern access to each workspace's data. The browser app provides these product flows against the existing API. Notifications remain future scope.

## Application architecture

### Frontend

The browser client uses React and provides the workspace-oriented interface for collaboration features through authenticated APIs. Socket.IO provides best-effort live resource-change hints; PostgreSQL-backed APIs remain authoritative.

### Backend: modular monolith first

The backend uses Node.js and Express as one deployable application organized into modules with clear responsibilities, including authentication, workspaces and membership, projects and tasks, comments, files, and activity. Modules interact through defined internal interfaces and share the application's PostgreSQL database. This keeps local development straightforward while preserving boundaries that could support later extraction.

The application remains a single Express deployment. `src/services/create-services.js` composes the in-process APIs consumed by HTTP routes. The service interfaces are injectable, frozen objects that expose only the module operations needed by the routes. They call module repositories directly in the same process; no network or message broker is involved.

#### Milestone 7 module ownership and APIs

- **Authentication** (`auth`): user identity, sessions, OAuth, and authentication audit persistence. The HTTP middleware resolves the bearer token; feature APIs receive the authenticated user ID in their request arguments.
- **Workspaces** (`workspaces`): workspace lifecycle, membership, role changes, and role/membership authorization predicates.
- **Projects and tasks** (`projects`): project/task persistence, workspace-scoped reads and writes, assignment checks, and optimistic task versions.
- **Comments** (`comments`): comment persistence, author/version rules, and comment authorization.
- **Activity** (`activity`): workspace activity feed reads and the `recordActivityInTransaction(client, event)` persistence API. Event writes accept the PostgreSQL transaction client already owned by the calling operation.

Routes own HTTP parsing, validation, and response mapping. Service APIs define the in-process operation boundary. Repositories own SQL and retain authorization and workspace predicates; service separation does not move tenant security out of those queries. The app composition root creates services once and injects them into routers. Tests can inject repository fakes at these boundaries, while end-to-end integration tests use the same composition with the existing local PostgreSQL database.

Writes that produce activity continue to run in a single PostgreSQL transaction. The project/task or comment repository owns that transaction and invokes the activity service API with the same transaction client, so a failed activity insert rolls back the corresponding product change and vice versa. No cross-service transaction protocol is needed while modules share the database and process.

This milestone creates explicit, separable module APIs and ownership boundaries, but modules are not independently deployable yet. They still share a database, process lifecycle, and runtime. Extracting a module into another process would require an explicit data ownership and consistency design, operational deployment, and a transport contract; those are not part of this milestone.

### Milestone 8 event delivery

Project, task, and comment activity writes also append a versioned, sanitized domain-event envelope to `outbox_events` using the caller's existing PostgreSQL transaction client. The API never waits for Kafka to commit a product operation. The outbox relay runs from the same API package as a separately invokable worker process; this is a runtime role in the modular monolith, not an independently deployed service.

The relay claims pending rows with PostgreSQL leases and `FOR UPDATE SKIP LOCKED`, renews leases while sending, publishes messages keyed by workspace ID, then acknowledges only rows with a current, unexpired lease token. Transient publish failures use bounded exponential backoff; after the configured attempt limit, the durable row is marked dead-lettered and retained. Abandoned claims count as attempts and are dead-lettered after their lease expires at the limit. A worker crash after Kafka accepts a message but before the database acknowledgment can cause a duplicate. Every message has a stable event ID for consumer deduplication. Kafka producer idempotence reduces producer retry duplicates but does not provide end-to-end exactly-once delivery; downstream consumers must be idempotent. No business event consumer is introduced in this milestone.

Outbox payloads contain resource and actor IDs, the event type, the activity event ID, and allowlisted changed-field metadata; they do not contain comment text, resource names or descriptions, email addresses, or credentials. Outbox rows are not foreign-key cascaded when a workspace is deleted, so pending events remain publishable; retention and manual dead-letter replay are operational follow-up work. Local API and test runs need PostgreSQL only. Running the relay requires a separately available Kafka broker and pre-created topic; the API can continue storing outbox events while the broker is unavailable.

## Data and asynchronous capabilities

- **PostgreSQL** will hold persistent application data, including users, workspaces, memberships, projects, tasks, comments, notifications, and activity records.
- **Redis** is optional for shared authentication rate limits and cross-instance Socket.IO room coordination. PostgreSQL remains the source of truth; when Redis is unavailable, database operations continue and those capabilities fall back to per-process behavior. During an outage, auth attempt limits are per process and therefore provide a weaker aggregate cap across instances. The Socket.IO adapter carries an internal session verifier only between trusted application instances; Redis requires network isolation, TLS, and least-privilege ACLs.
- **Amazon S3** stores private project/task files. Access is mediated by authenticated API operations; objects receive no public ACL and the bucket must block public access.
- **Kafka** receives sanitized domain events through the PostgreSQL outbox relay. Future consumers can support asynchronous work such as notification delivery and other background processing.
- **Socket.IO** provides workspace-scoped live resource-change hints. Connections authenticate with a current opaque session token, subscriptions are checked against PostgreSQL membership, and recipients are rechecked before delivery. Event payloads contain resource identifiers only; clients reload details through authorized APIs.

Kafka and the private S3 file flow are implemented in the milestones described below; local tests use injected doubles and do not require cloud resources. Socket.IO hints are best-effort, contain no replay cursor, and may be missed while a client is disconnected; clients reload state from PostgreSQL-backed APIs after reconnecting. Redis is optional for local development and is not required to run API tests.

### Milestone 9 private files

Files attach to an authorized project or task. The API authenticates every request, checks current workspace membership and resource scope in parameterized SQL, and permits only the uploader or workspace owner/admin to delete an attachment. Upload bytes are sent through the API with a strict size limit, an allowlisted MIME type, and matching basic file signatures. S3 object keys are generated from server-side random UUIDs; client file names are stored only as download metadata and never form part of an object key.

The S3 adapter uses the AWS SDK credential provider chain and requires `AWS_REGION` plus `S3_BUCKET`; no static credentials are added to application configuration. It omits ACLs, sets server-side encryption, and the bucket must have S3 Block Public Access enabled. Downloads stream through the authenticated API and are marked private/no-store; no public URL is returned.

PostgreSQL file rows move through pending, available, failed, and deleting states. The row is created before the S3 put; only an uploaded object whose metadata transition succeeds is downloadable. Upload tokens fence stale retries, active uploads renew their lease, and abandoned pending uploads can be reclaimed after five minutes. Every retry gets a fresh random object key, so a stale attempt cannot overwrite the current attempt; only available or failed files may be deleted, preventing deletion from racing a live upload. Failed uploads keep a retryable row and can be retried by the uploader using the returned file ID. If metadata finalization fails, the API attempts object cleanup and reports a retryable consistency error. Deletes are also retryable when object deletion succeeds but metadata deletion fails. Project, task, or workspace deletion is restricted while attachments remain, so callers must delete files first and parent deletion cannot orphan S3 objects.

The API buffers each upload up to the configured 10 MiB maximum to validate signatures before storage and admits at most four simultaneous uploads per process by default (`FILE_MAX_CONCURRENT_UPLOADS`, configurable from 1 to 8). This bounds upload-body buffering to at most 80 MiB per process; it is not a fleet-wide limit. Local integration tests use a fake object store and PostgreSQL; no AWS resources or live S3 calls are part of the milestone verification.

## Security and tenant isolation

Passwords are hashed with scrypt. Sessions use opaque random tokens whose hashes are stored in PostgreSQL, with expiration and revocation. Browser sessions use HttpOnly, SameSite cookies; state-changing cookie requests enforce the configured exact web origin. Google OAuth validates state, PKCE, nonce, issuer, audience, verified email, and redirect URI when configured, but live provider integration is not verified. Inputs are validated at API boundaries, errors are safe to return, CORS is restricted to the configured origin, and sensitive endpoints use rate limits. Security-relevant authentication actions are recorded without credentials or email addresses.

RBAC is evaluated in the workspace context. The API checks authenticated membership and role before tenant operations, and SQL predicates scope reads and writes by authorized workspace and resource IDs. Creates derive workspace ownership from the authorized route context. Composite foreign keys and constraints protect related project, task, assignee, and file references.

Client-supplied IDs are never proof of access. Related-record operations verify that records belong to the same authorized workspace. File reads go through the API; socket ticket issuance, subscription, session checks, and event recipients use server-side membership checks. Unauthorized/missing tenant resources use consistent not-found responses where applicable.

Automated tests cover role permissions and cross-workspace reads/writes, including guessed project/file IDs, plus the complete browser workflow against a dedicated local test database. These tests provide evidence for the exercised paths, not a formal security certification or independent penetration test.

## Local development and deployment path

Local development uses Docker Compose for PostgreSQL, Redis, API, and the static web app. Setup and checks are documented in this repository. AWS resources are not part of normal local development.

The local delivery path uses Docker Compose with PostgreSQL, Redis, API, and static web containers. The EKS package remains a single application deployment with API, web, migration Job, and outbox worker workloads. PostgreSQL, Redis, Kafka, and S3 are explicit external service boundaries; this deployment configuration does not split application modules into separate services. Terraform defines a VPC, private RDS PostgreSQL, private S3, ECR, EKS, an ALB, Pod Identity, private ECR/S3/STS/EKS Auth endpoints, and CloudWatch control-plane logs. Kubernetes secrets are references only and must be populated by a protected secret-management system. Terraform is configuration only and has not been applied or verified against AWS.

The browser product uses the existing authenticated APIs for registration, login/logout, workspace membership/roles, projects, tasks, comments, activity, private files, and workspace-scoped Socket.IO hints. The E2E suite covers these flows against the dedicated local test database and an in-memory object store. Browser access uses HttpOnly session cookies and one-time socket tickets; tokens are not persisted in browser storage or URLs.

Milestone 14 adds read-only GitHub Actions CI for pull requests and `main`, including ephemeral PostgreSQL integration tests, browser E2E, production build/dependency checks, local-only Terraform validation, and Kubernetes manifest rendering without a cluster. CI has no deploy credentials and does not publish images or provision infrastructure. The API writes privacy-limited JSON request timing records to stdout; central log collection is not configured. A read-only k6 health smoke scenario is provided, but no load results or capacity targets have been established. EKS, AWS connectivity, and production observability remain unverified.

## Testing approach

Current verification includes:

- **Unit tests** will cover module logic and validation rules.
- **API integration tests** will exercise routes, persistence, and expected error behavior.
- **Authorization and tenant-isolation tests** will verify membership, role checks, and workspace scoping, including attempts to access another workspace's records.
- **Load smoke checks** can exercise liveness/readiness endpoints with k6. Representative authenticated workload benchmarks and capacity targets have not been measured.

## 15-milestone roadmap

Each milestone should implement only its stated scope, run appropriate checks, document actual results, and stop for review. The sequence is a plan, not a claim of completed work.

1. **Repository setup:** establish project requirements and repository guidance.
2. **Application foundation:** set up the React frontend and Node.js/Express modular monolith structure.
3. **Authentication:** implement account authentication, secure password handling, token protections, and planned Google OAuth support.
4. **Workspaces and RBAC:** add workspace membership and roles, with authorization and tenant-isolation tests.
5. **Core collaboration:** add projects and tasks with workspace-scoped access.
6. **Comments and activity:** add comments and workspace activity records.
7. **Service separation:** extract selected modules into services and define their APIs and ownership boundaries.
8. **Kafka and workers:** introduce domain events and background workers for asynchronous processing.
9. **Files:** add private file upload and access flows backed by S3, subject to workspace authorization.
10. **Redis and real-time:** add Redis for selected cache, rate-limit, and presence needs, then Socket.IO for authorized notifications and live updates.
11. **Docker delivery:** containerize the application and dependencies and complete the Docker Compose local development workflow.
12. **AWS infrastructure:** define the VPC, RDS, S3, ECR, ALB, IAM, and CloudWatch foundations with Terraform; this milestone is the first planned AWS provisioning milestone and requires separate authorization before resources are created.
13. **EKS deployment:** deploy containerized workloads to EKS and connect the required AWS services.
14. **Scaling and CI/CD:** add GitHub Actions delivery workflows and address scaling, monitoring, and operational needs. CI and basic request telemetry are implemented; hosted CI execution and production log collection are not verified.
15. **Final testing and documentation:** complete integration, authorization/isolation, and load testing; document setup, deployment, operations, and known limitations. Browser E2E runs locally; a limited load smoke scenario is available but has not been measured.

The roadmap places Docker Compose and local development before AWS deployment. Service separation, Kafka, Redis-backed capabilities, and real-time delivery are later additions and should not be implemented ahead of their milestones.
