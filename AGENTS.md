# TeamVault Project Requirements

## Project goals

- Build a production-minded portfolio project with React, Node.js, Express, PostgreSQL, Redis, Kafka, Socket.IO, Docker, Kubernetes/EKS, Terraform, and GitHub Actions.
- Start as a modular monolith locally. Split into services only at the planned milestone.
- Core features will eventually include authentication, Google OAuth, workspaces, role-based access control, projects, tasks, comments, activity feeds, notifications, private S3 file uploads, and real-time updates.
- Enforce tenant isolation: every tenant-owned query must be scoped to the workspace after membership authorization.
- Use secure password hashing, validated inputs, safe error responses, rate limiting, strict CORS, and automated authorization tests.
- Use Docker Compose for local development. AWS infrastructure comes later, using Terraform.

## Workflow rules

1. Work milestone by milestone; do not implement future milestones early.
2. Explain proposed changes before making significant changes.
3. Never claim a test passed unless it was actually run and passed.
4. Never invent performance metrics or resume achievements.
5. Do not create AWS resources, incur cloud costs, expose secrets, or run destructive commands without explicit approval.
6. Prefer small, testable changes and document how to run them.
7. For each milestone, implement only its scope, run appropriate checks, report changed files and actual results, then stop for review.

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

## Initial task boundary

The initial setup task is limited to creating this `AGENTS.md` file. Do not create application code, install packages, initialize Git, or modify any other files as part of that task.
