# syntax=docker/dockerfile:1
# Web app image for Cloud Run. Build context: the app/ directory.
#   docker build -t <region>-docker.pkg.dev/<project>/<repo>/app:<tag> app/
# The image is environment-agnostic: only PUBLIC web identifiers are baked in at build
# time (Firebase web config); every secret and every environment-specific value
# (database, buckets, job names) is injected by Cloud Run at runtime.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Public web configuration (identifiers, not secrets): required by the browser bundle.
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_SIGNUP_MODE=invite_only
ENV NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_SIGNUP_MODE=$NEXT_PUBLIC_SIGNUP_MODE \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# Non-root runtime user.
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER 10001:10001
EXPOSE 8080
# Cloud Run sends SIGTERM on scale-down; `node` (PID 1 via exec form) handles it.
CMD ["node", "server.js"]
