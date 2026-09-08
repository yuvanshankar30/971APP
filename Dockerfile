# syntax=docker/dockerfile:1

# --- Build stage -------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# zip: node:22-slim (Debian) doesn't ship it by default. Needed by the
# prebuild step (scripts/build-fusion-runner-zip.mjs) to package the Fusion
# Runner add-in into static/downloads/ before the Vite build runs - only
# static/ survives into the runtime stage below, so this has to happen here,
# not at request time.
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# SvelteKit inlines every `$env/static/public` PUBLIC_* var into the client
# bundle at build time (this is a Vite/SvelteKit behavior, not Vercel-specific
# — it just used to be handled for you by Vercel's own build step). Cloud
# Build must pass the real values as --build-arg / substitutions here; a
# missing one fails the build with "X is not exported by
# virtual:env/static/public", not a silent runtime issue. Different
# PUBLIC_* values (e.g. a staging vs prod Supabase project) require separate
# image builds, not just separate Cloud Run deploy-time env vars.
ARG PUBLIC_SUPABASE_URL
ARG PUBLIC_SUPABASE_ANON_KEY
ARG PUBLIC_SENTRY_DSN
ARG PUBLIC_ONSHAPE_ACCESS_KEY
ARG PUBLIC_ONSHAPE_SECRET_KEY
ARG PUBLIC_ONSHAPE_BASE_URL
ARG PUBLIC_AUTOCAM_API_URL
ARG PUBLIC_APP_ORIGIN
ARG PUBLIC_SITE_URL
ARG PUBLIC_ROUTES
ARG PUBLIC_TBA_API_KEY
ARG PUBLIC_AUTO_VENDOR
# Cloud Build injects its commit SHA through this non-secret build argument.
# The Runner zip embeds it as its self-update release version.
ARG FUSION_RUNNER_RELEASE_VERSION
ENV FUSION_RUNNER_RELEASE_VERSION=$FUSION_RUNNER_RELEASE_VERSION

RUN npm run build && npm prune --omit=dev

# --- Runtime stage -------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# adapter-node reads PORT from env; Cloud Run injects PORT=8080 by default.
EXPOSE 8080
CMD ["node", "build/index.js"]
