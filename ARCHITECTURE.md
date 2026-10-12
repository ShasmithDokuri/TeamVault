# TeamVault Architecture

## Status and scope

This document records the current architecture and delivery path for TeamVault. The application began as a modular monolith. Milestone 7 defines in-process service APIs and module ownership boundaries while retaining one deployable application and shared PostgreSQL database; it does not introduce networked or independently deployed services.

## Product

TeamVault is planned as a secure, multi-tenant collaboration platform. Teams will use workspaces to manage members, projects, tasks, comments, files, notifications, and activity. A user may belong to multiple workspaces, and workspace membership and role will govern access to that workspace's data.

## Application architecture

### Frontend

The browser client will use React. It will provide the workspace-oriented interface for collaboration features and communicate with the backend through authenticated APIs. Socket.IO provides best-effort live resource-change hints; PostgreSQL-backed APIs remain authoritative.

### Backend: modular monolith first

The backend will use Node.js and Express. Initially, it will run as one deployable application organized into modules with clear responsibilities, such as authentication, workspaces and membership, projects and tasks, comments, files, notifications, and activity. Modules should interact through defined internal interfaces and share the application's PostgreSQL database. This keeps local development and early delivery straightforward while preserving boundaries that can support later extraction.

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

Authentication will establish a verified user identity. Password-based authentication will use a secure password-hashing algorithm; token handling will avoid exposing credentials and will use appropriate expiration, storage, and transport protections. Google OAuth is a planned authentication option. Inputs will be validated at API boundaries, errors will be safe to return to clients, CORS will be restricted to approved origins, and rate limits will protect sensitive and abuse-prone endpoints. Security-relevant actions will be recorded in an audit log.

Role-based access control (RBAC) will be evaluated in the context of a workspace. Before accessing tenant-owned data, the backend will establish that the authenticated user is a member of the requested workspace and has the required role or permission. Tenant-owned records will carry a workspace association, and every read, update, and delete query for those records will include the authorized workspace identifier. Create operations will derive or validate that identifier from the authorized workspace context rather than trusting an arbitrary client-supplied workspace identifier.

Cross-workspace access will be prevented by applying authorization before data access and by including the authorized workspace scope in the database operation itself. Object identifiers supplied by a client will never be treated as proof of access. Related-record operations will verify that both records belong to the same authorized workspace. The same authorization context will be applied to file access, background jobs, and real-time subscriptions as those capabilities are added. Responses should not reveal whether another workspace's inaccessible record exists.

Automated authorization and isolation tests will create records in separate workspaces and attempt reads and mutations from users who lack membership or sufficient role. They will cover direct identifiers, nested resources and relationships, and cross-workspace combinations; unauthorized requests must not return or alter another workspace's data. Tests will also check that membership is required before tenant-scoped queries run.

## Local development and deployment path

Development will begin locally with Docker Compose for the application dependencies. Local setup and checks will be documented as milestones add components. No AWS resources are part of this architecture-document milestone.

Later deployment milestones are planned to use Terraform to define AWS infrastructure, including a VPC, RDS PostgreSQL, private S3 storage, ECR for container images, EKS for Kubernetes workloads, an ALB for ingress, IAM for least-privilege access, and CloudWatch for logs and monitoring. GitHub Actions will support CI/CD. Cloud infrastructure will be introduced only in its designated roadmap milestones; this document does not provision it.

## Testing approach

Testing will grow alongside implementation:

- **Unit tests** will cover module logic and validation rules.
- **API integration tests** will exercise routes, persistence, and expected error behavior.
- **Authorization and tenant-isolation tests** will verify membership, role checks, and workspace scoping, including attempts to access another workspace's records.
- **Load tests**, planned for a later milestone, will exercise the implemented system under representative usage and help guide scaling work.

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
14. **Scaling and CI/CD:** add GitHub Actions delivery workflows and address scaling, monitoring, and operational needs.
15. **Final testing and documentation:** complete integration, authorization/isolation, and load testing; document setup, deployment, operations, and known limitations.

The roadmap places Docker Compose and local development before AWS deployment. Service separation, Kafka, Redis-backed capabilities, and real-time delivery are later additions and should not be implemented ahead of their milestones.
