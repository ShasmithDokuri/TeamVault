# TeamVault Architecture

## Status and scope

This document describes the proposed architecture and delivery path for TeamVault. It is a design document; it does not describe features as implemented. The initial application will be a modular monolith for local development. Service separation and cloud infrastructure are later milestones, not part of the initial setup.

## Product

TeamVault is planned as a secure, multi-tenant collaboration platform. Teams will use workspaces to manage members, projects, tasks, comments, files, notifications, and activity. A user may belong to multiple workspaces, and workspace membership and role will govern access to that workspace's data.

## Application architecture

### Frontend

The browser client will use React. It will provide the workspace-oriented interface for collaboration features and communicate with the backend through authenticated APIs. Later, it may receive live notifications and updates through Socket.IO.

### Backend: modular monolith first

The backend will use Node.js and Express. Initially, it will run as one deployable application organized into modules with clear responsibilities, such as authentication, workspaces and membership, projects and tasks, comments, files, notifications, and activity. Modules should interact through defined internal interfaces and share the application's PostgreSQL database. This keeps local development and early delivery straightforward while preserving boundaries that can support later extraction.

The initial architecture is not a set of independently deployed services. Splitting selected modules into services is planned for a later milestone, after core behavior and module boundaries have been established. That transition will require explicit service APIs, data ownership decisions, and operational support; it will not be assumed to happen automatically.

## Data and asynchronous capabilities

- **PostgreSQL** will hold persistent application data, including users, workspaces, memberships, projects, tasks, comments, notifications, and activity records.
- **Redis** is planned for caching, rate limiting, and presence where those capabilities are introduced. PostgreSQL remains the source of truth for persistent product records.
- **Amazon S3** will provide private file storage in a later milestone. Access will be mediated by authorization checks, with no public object access intended.
- **Kafka** will carry domain events to background workers in a later milestone. Events can support asynchronous work such as notification delivery and other background processing.
- **Socket.IO** will provide notifications and live updates in a later milestone. Connections and subscriptions will be authorized against the user's workspace access.

Redis, S3, Kafka, background workers, and Socket.IO are planned capabilities and are not prerequisites for the initial modular monolith.

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
