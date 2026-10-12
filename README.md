# TeamVault

TeamVault is a multi-tenant collaboration platform being built milestone by milestone. The repository contains a React frontend and an Express API in a single repository. Milestone 3 adds database-backed account authentication and optional Google sign-in to the API.

## Milestone 2 implementation plan

- Keep the frontend and backend in separate npm workspaces under `apps/`.
- Keep the backend a single Express application with routes organized by feature.
- Start with a health route to verify local frontend-to-backend connectivity.
- Read local settings from environment variables and keep `.env` files out of Git.
- Add a small API test and production frontend build; defer later roadmap technologies to their milestones.

## Milestone 3 authentication

The API provides `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, and `POST /api/auth/logout`. Sessions use random opaque bearer tokens with a 15-minute lifetime; only their SHA-256 hashes are stored in PostgreSQL. Passwords are hashed with Node.js scrypt. Registration, successful and failed logins, Google login, and logout are recorded in the auth audit table without storing credentials or email addresses. Authentication attempts use an in-memory limiter, so limits are per process and are not shared across multiple API instances. A shared rate-limit store is deferred until the planned Redis milestone.

Google sign-in is available at `GET /api/auth/google` when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` are all configured. The callback validates browser-bound one-time state, PKCE, the signed ID token's issuer, audience and expiry, verified email, and nonce. Redirect URIs must use HTTPS except for localhost development and must point to the callback route. The API returns a bearer token as JSON; a browser client should keep it out of URLs and use HTTPS outside local development. No browser login UI or refresh-token flow is included in this milestone.

Copy `apps/api/.env.example` to `apps/api/.env`, set `DATABASE_URL` to a PostgreSQL database, then run `npm run db:migrate --workspace @teamvault/api` before registering or logging in. Google credentials are optional and belong only in the ignored `.env` file or deployment secret configuration.

PostgreSQL integration tests run when `TEAMVAULT_TEST_DATABASE_URL` is set to the dedicated `teamvault_m3_review` database; they apply the numbered idempotent migrations and add uniquely named test records. They do not reset existing database contents. The workspace authorization test removes only a workspace created by that test, and leaves its uniquely named fixture users in place.

## Milestone 4 workspaces and RBAC

Authenticated users can create and list workspaces, read a workspace they belong to, and manage its members through `/api/workspaces`. The creator becomes the workspace owner in the same database transaction as workspace creation. Owners and admins can rename a workspace; only owners can delete it. Owners can add members as admins or members and change non-owner roles. Admins can add or remove members, but cannot grant admin access, manage admins, or remove the owner. Members can read workspace details and membership only. The owner role cannot be assigned or removed through the member-management API.

Workspace and membership reads and writes bind both the workspace ID and the authenticated user ID in SQL authorization predicates. Nonmembers and callers without the required role receive the same not-found response, which avoids exposing whether another workspace or member exists. The migration enforces valid roles, workspace/user foreign keys, exactly one owner per workspace, and unique membership per user and workspace. PostgreSQL integration tests use the isolated `teamvault_m3_review` database, apply all numbered migrations, and leave uniquely identified fixtures in place without resetting database contents.

## Milestone 5 projects and tasks

Projects are available at `/api/workspaces/:workspaceId/projects`; tasks are nested under `/api/workspaces/:workspaceId/projects/:projectId/tasks`. Workspace members can read projects and tasks. Owners and admins can create, update, and delete projects and delete tasks. All members can create and update tasks. Project names and task titles are required; task status is `todo`, `in_progress`, or `done`, and priority is `low`, `medium`, `high`, or `urgent`. Task updates require the current integer `version`; stale updates return `409` so concurrent edits do not silently overwrite each other. Task assignees must be current members of the project workspace; removing a member clears their task assignments.

Migration `003_projects_tasks.sql` scopes task-project references and task assignees with composite foreign keys, and indexes workspace/project task lists and assignments. PostgreSQL integration tests use generated fixture IDs and remove only their own workspaces and users after the test. PostgreSQL 15 or newer is required for the composite assignee foreign key's column-specific `ON DELETE SET NULL` behavior.

## Known dependency advisory

The development dependency tree currently reports 19 moderate `sprintf-js` advisories through Jest. The available `npm audit fix --force` recommendation downgrades Jest to v25, so the dependency has been left unchanged for a compatible fix review. The production dependency audit reports zero vulnerabilities.

## Requirements

- Node.js 20.19+ or 22.12+
- npm 10+
- PostgreSQL 15+

## Local development

1. Install dependencies from the repository root with `npm install`.
2. Optionally copy `apps/api/.env.example` to `apps/api/.env` to override the API port or allowed web origin. The web development proxy reads that API port setting too.
3. Start both applications with `npm run dev`.
4. Open <http://localhost:5173>. The API health endpoint is <http://localhost:3001/api/health>.

The web development server proxies `/api` requests to the API. The API defaults to port `3001` and allows the web origin at `http://localhost:5173`. Do not put secrets in the example environment file.

## Checks

- `npm test` runs API route tests.
- `npm run build` checks the API entry points and builds the frontend.

## Project layout

```text
apps/
  api/
    src/
      routes/
      services/
    test/
  web/
    src/
```

## Milestone 6 comments and activity

Workspace members can create and list comments on projects and tasks. Comment authors can edit their comments using the returned version; owners and admins can delete any comment, while authors can delete their own. Removing a workspace member clears their comment author attribution while preserving the comment history.

Workspace members can read a paginated activity feed at `/api/workspaces/:workspaceId/activity`, using `limit` (1–100) and an optional `before` event ID. Project and task creation, updates, assignment changes, deletion, and comment activity write activity records in the same transaction as the change. Events contain actor and resource IDs plus changed field names; they exclude comment text, task or project text, email addresses, and credentials. Activity access is workspace-scoped and requires current membership.

Migration `004_comments_activity.sql` adds workspace-scoped comment references, versioning, activity event constraints, and feed indexes. PostgreSQL 15+ remains required for column-specific `ON DELETE SET NULL` foreign keys.

## Milestone 7 service boundaries

The API remains a single Express application and deployment. Its app composition root creates in-process service interfaces for workspaces, projects/tasks, comments, and activity, then injects them into the routers. Authentication remains in the auth module. Routes retain input validation and HTTP response mapping; repositories retain SQL, membership/role checks, and workspace scoping. Service interfaces are injectable so tests can substitute repository dependencies, while PostgreSQL integration tests continue to exercise the full local app and database.

Activity event persistence is owned by the activity module through `recordActivityInTransaction(client, event)`. Project/task and comment repositories pass their existing PostgreSQL transaction client to this service API, keeping each event atomic with its corresponding change. This milestone establishes module APIs and ownership boundaries; it does not create separately deployed services or introduce network communication. Shared process/database lifecycle is a deliberate trade-off until a later extraction has a concrete deployment and data-ownership design.

Background processing, notifications, file storage, containerization, and cloud infrastructure remain planned work for their designated milestones.
