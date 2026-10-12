# TeamVault

TeamVault is a multi-tenant collaboration platform being built milestone by milestone. The initial application foundation is a React frontend and an Express API in a single repository. This milestone does not add authentication or persistent application data.

## Milestone 2 implementation plan

- Keep the frontend and backend in separate npm workspaces under `apps/`.
- Keep the backend a single Express application with routes organized by feature.
- Start with a health route to verify local frontend-to-backend connectivity.
- Read local settings from environment variables and keep `.env` files out of Git.
- Add a small API test and production frontend build; defer later roadmap technologies to their milestones.

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

PostgreSQL, authentication, collaboration features, background processing, files, containerization, and cloud infrastructure remain planned work for their designated milestones.
