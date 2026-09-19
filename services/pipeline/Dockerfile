# syntax=docker/dockerfile:1
# One image for the batch workloads. Build context: the REPOSITORY ROOT (the pipeline shares no code with the
# app, but the context keeps one build command for CI):
#   docker build -f services/pipeline/Dockerfile -t <region>-docker.pkg.dev/<project>/<repo>/pipeline:<tag> .
#
# Cloud Run Jobs choose their workload with the container command:
#   screening : node src/jobs/screening.mjs   (default)
#   buy-setup : node src/jobs/buy-setup.mjs
#   fome      : node src/jobs/fome.mjs
#
# Schema migrations and the system seed are NOT in this image and never run in the cloud: the operator applies
# them from a checkout through the Cloud SQL Auth Proxy (docs/gcp/runbooks/qa-deployment.md).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY services/pipeline/package.json services/pipeline/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app services/pipeline/package.json ./package.json
COPY --chown=app:app services/pipeline/src ./src
USER 10001:10001
CMD ["node", "src/jobs/screening.mjs"]
