# syntax=docker/dockerfile:1

# Targets:
#   dev         hot-reloading development server (used by compose.yaml)
#   tools       source + all dependencies, for one-off jobs such as migrations
#               (used by compose.prod.yaml's `migrate` service)
#   production  minimal standalone Next.js server, non-root (compose.prod.yaml's
#               `app`; deployed by scripts/deploy.mjs, see docs/homelab-deployment.md)

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# Prisma's schema engine needs OpenSSL, which the slim image does not include.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# The official node image ships a non-root `node` user (uid 1000). Hand it the
# working directory so everything below can run unprivileged.
RUN chown node:node /app
USER node

FROM base AS deps
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

# --- development ---------------------------------------------------------
# Compose bind-mounts the source over /app and mounts named volumes over
# /app/node_modules and /app/.next, so Linux-native dependencies never mix
# with the Windows copies on the host. A named volume is seeded from the image
# on first use, which is why node_modules and .next are created here.
FROM deps AS dev
# NODE_ENV is intentionally unset: `next dev` sets development itself, and a
# forced NODE_ENV=development breaks `next build` inside this container.
RUN mkdir -p /app/.next
EXPOSE 3000
CMD ["npx", "next", "dev", "--hostname", "0.0.0.0", "--port", "3000"]

# --- one-off jobs ----------------------------------------------------------
# Migrations need the Prisma CLI and tsx, which the standalone production image
# leaves out. This image is never the running app and is never published.
FROM deps AS tools
COPY --chown=node:node . .
RUN npx prisma generate
CMD ["npx", "tsx", "scripts/migrate.mts"]

# --- production build ----------------------------------------------------
FROM deps AS build
COPY --chown=node:node . .
RUN npm run build

FROM base AS production
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
