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

PostgreSQL integration tests run when `TEAMVAULT_TEST_DATABASE_URL` is set to the dedicated `teamvault_m3_review` database; they apply the idempotent authentication migration and add uniquely named test records. They do not reset or delete database contents.

## Known dependency advisory

The development dependency tree currently reports 19 moderate `sprintf-js` advisories through Jest. The available `npm audit fix --force` recommendation downgrades Jest to v25, so the dependency has been left unchanged for a compatible fix review. The production dependency audit reports zero vulnerabilities.

## Requirements

- Node.js 20.19+ or 22.12+
- npm 10+

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
    test/
  web/
    src/
```

Workspaces, RBAC, collaboration features, background processing, files, containerization, and cloud infrastructure remain planned work for their designated milestones.
