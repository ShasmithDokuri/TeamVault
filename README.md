# TeamVault

**Secure, multi-tenant team collaboration and project management.**

TeamVault is a full-stack web application where teams can organize workspaces, manage projects and tasks, collaborate through comments, track activity, and share files privately. It focuses on workspace-level access control, secure authentication, and reliable collaboration workflows.

**Live demo:** https://teamvault-unified.onrender.com
**GitHub:** https://github.com/ShasmithDokuri/TeamVault

## Features

- **Authentication:** Email/password registration and login, session management, logout, and optional Google OAuth.
- **Workspaces and roles:** Create workspaces and manage members with Owner, Admin, Manager, and Member roles.
- **Projects and tasks:** Create projects, assign tasks, set priorities and statuses, and track task versions.
- **Collaboration:** Project/task comments and a workspace activity feed.
- **Private file sharing:** Upload and download supported files through authenticated API endpoints without exposing public object URLs.
- **Real-time updates:** Workspace-scoped Socket.IO events with session and membership checks.
- **Reliable event processing:** PostgreSQL transactional outbox and an optional Kafka relay.
- **Testing and CI:** API and frontend tests, PostgreSQL integration tests, browser E2E tests, build checks, and GitHub Actions workflows.

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | React, Vite, JavaScript |
| Backend | Node.js, Express |
| Database | PostgreSQL |
| Authentication | Scrypt password hashing, opaque sessions, Google OAuth |
| Real-time | Socket.IO, optional Redis adapter |
| File storage | S3-compatible private object storage |
| Event processing | PostgreSQL outbox, optional Kafka |
| Testing | Jest, Vitest, Playwright, Supertest |
| Infrastructure | Docker Compose, Terraform, Kubernetes/EKS configuration |
| CI | GitHub Actions, Dependabot |

## Architecture

```text
Browser (React + Vite)
          |
          v
     Express API
          |
    +-----+------------------+
    |          |             |
    v          v             v
PostgreSQL  Private Files  Socket.IO
    |
    v
Transactional Outbox
    |
    v
Optional Kafka Relay
```

The core backend is a modular Express application. Routes handle HTTP concerns, services define application operations, and repositories own database queries and authorization checks. Workspace-scoped access controls are enforced by the API and database queries.

Redis and Kafka are optional integrations. Terraform and Kubernetes/EKS files provide infrastructure configuration; their presence does not mean those resources have been deployed to AWS.

## Security Highlights

- Passwords are hashed using Node.js `scrypt`.
- Session tokens are generated using cryptographically secure randomness; session hashes are stored in PostgreSQL.
- Workspace and project access is scoped to authenticated membership and permitted roles.
- Task assignments are restricted to members of the relevant workspace.
- Private file downloads pass through authenticated API routes.
- Realtime subscriptions validate the session and workspace membership.
- Authentication and collaboration flows have automated tests.

See [SECURITY.md](SECURITY.md) for trust boundaries, implemented controls, and remaining security work.

## Run Locally

### Requirements

- Node.js 20.19+ or 22.12+
- npm 10+
- PostgreSQL 15+

### Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/ShasmithDokuri/TeamVault.git
   cd TeamVault
   npm install
   ```

2. Configure the API environment:

   ```bash
   cp apps/api/.env.example apps/api/.env
   ```

   Set `DATABASE_URL` to your local PostgreSQL database. Keep real credentials in ignored environment files or a secret manager; never commit them.

3. Apply the database migrations:

   ```bash
   npm run db:migrate --workspace @teamvault/api
   ```

4. Start the frontend and API:

   ```bash
   npm run dev
   ```

5. Open the frontend at http://localhost:5173. The API health endpoint is http://localhost:3001/api/health.

Optional integrations such as Google OAuth, Redis, Kafka, and private object storage require their own configuration.

## Testing and Build

Run from the repository root:

```bash
npm test
npm run build
npm audit --omit=dev
```

PostgreSQL integration tests require `TEAMVAULT_TEST_DATABASE_URL` to point to the dedicated local `teamvault_m3_review` database. Follow the database safety checks documented in this repository before running integration or browser E2E tests.

The project's recent local verification completed successfully:

- API: 78 tests passed; 9 skipped.
- Frontend: 6 tests passed.
- Build: API syntax checks and frontend production build passed.

Test counts can change as the project evolves. Skipped integration tests are not counted as passing.

## Project Documentation

- [Portfolio walkthrough](PORTFOLIO.md)
- [Security notes](SECURITY.md)
- [EKS deployment guide](deploy/kubernetes/README.md)

## Roadmap

Potential next improvements include richer notifications, additional collaboration workflows, expanded observability, and validated production deployment automation.

---

Built as a full-stack engineering portfolio project.
