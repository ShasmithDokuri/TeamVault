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

## Initial task boundary

The initial setup task is limited to creating this `AGENTS.md` file. Do not create application code, install packages, initialize Git, or modify any other files as part of that task.
