FROM node:24.20.0-alpine3.24

ENV NODE_ENV=production
WORKDIR /workspace

# Install only the API's production dependency tree from the committed lockfile.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace=@teamvault/api

COPY apps/api/src apps/api/src
COPY apps/api/migrations apps/api/migrations

WORKDIR /workspace/apps/api
USER node
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
