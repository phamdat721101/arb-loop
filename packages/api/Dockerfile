# Runtime-only image. Pre-build locally with `npm run build`, then deploy.
# Build context = monorepo root.
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache curl
ENV NODE_ENV=production

# Copy package metadata (workspace lockfile)
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/runtime-utils/package.json packages/runtime-utils/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/openx-mcp/package.json packages/openx-mcp/package.json

# Install RUNTIME deps only (no TS compiler, no @types/*).
# `--omit=dev --ignore-scripts` keeps it lean and fast.
# We need the api workspace's deps; npm install with --workspace=api filters appropriately.
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    --workspace=packages/api \
    --workspace=packages/sdk \
    --workspace=packages/runtime-utils \
    --workspace=packages/ui \
    --workspace=packages/openx-mcp \
    --include-workspace-root

# Copy pre-built dist/ for each workspace (built locally, rsync'd in)
COPY packages/runtime-utils/dist packages/runtime-utils/dist
COPY packages/sdk/dist packages/sdk/dist
COPY packages/ui/dist packages/ui/dist
COPY packages/openx-mcp/dist packages/openx-mcp/dist
COPY packages/api/dist packages/api/dist
COPY packages/shared/migrations packages/shared/migrations

EXPOSE 3001
CMD ["node", "packages/api/dist/server.js"]
