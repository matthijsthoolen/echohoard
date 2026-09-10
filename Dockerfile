# syntax=docker/dockerfile:1.7

# Keep base versions explicit. The release pipeline may additionally resolve
# these tags to digests; no deployment values belong in this image.
ARG NODE_VERSION=22.14.0-bookworm-slim
ARG PYTHON_VERSION=3.12.8-slim-bookworm
ARG ECHOHOARD_WEB_UID=10001
ARG ECHOHOARD_WEB_GID=10001
ARG ECHOHOARD_WORKER_UID=10002
ARG ECHOHOARD_WORKER_GID=10002

FROM node:${NODE_VERSION} AS node-base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.5 --activate

FROM node-base AS dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS production-dependencies
COPY prisma ./prisma
RUN pnpm exec prisma generate && pnpm prune --prod

FROM node-base AS build
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# The repository keeps incremental TypeScript metadata for fast local checks;
# remove the worker build cache so a clean image always emits /app/dist.
RUN rm -f tsconfig.worker.tsbuildinfo && pnpm build

FROM python:${PYTHON_VERSION} AS worker-dependencies
COPY container/worker-requirements.txt /tmp/worker-requirements.txt
RUN python -m pip install \
      --no-cache-dir \
      --disable-pip-version-check \
      --require-hashes \
      --target /opt/worker-python \
      -r /tmp/worker-requirements.txt \
    && rm /tmp/worker-requirements.txt

# Both roles run from this one artifact. Python is the final base because the
# worker-only cryptography tool must be available without a second service;
# the Node runtime is copied from the pinned Node build image.
FROM python:${PYTHON_VERSION} AS runtime
ARG ECHOHOARD_WEB_UID=10001
ARG ECHOHOARD_WEB_GID=10001
ARG ECHOHOARD_WORKER_UID=10002
ARG ECHOHOARD_WORKER_GID=10002
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PYTHONPATH=/opt/worker-python
ENV ECHOHOARD_ROLE=web
ENV ECHOHOARD_DATA_DIR=/data
ENV ECHOHOARD_WORK_DIR=/work
ENV ECHOHOARD_SECRET_DIR=/run/echohoard/secrets
WORKDIR /app
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=worker-dependencies /opt/worker-python /opt/worker-python
COPY --from=build /app/src/delivery/web ./src/delivery/web
COPY --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY container/entrypoint.sh /usr/local/bin/echohoard
RUN groupadd --gid "${ECHOHOARD_WEB_GID}" echohoard-web \
    && useradd --uid "${ECHOHOARD_WEB_UID}" --gid "${ECHOHOARD_WEB_GID}" \
      --home-dir /nonexistent --shell /usr/sbin/nologin --no-create-home echohoard-web \
    && groupadd --gid "${ECHOHOARD_WORKER_GID}" echohoard-worker \
    && useradd --uid "${ECHOHOARD_WORKER_UID}" --gid "${ECHOHOARD_WORKER_GID}" \
      --home-dir /nonexistent --shell /usr/sbin/nologin --no-create-home echohoard-worker \
    && mkdir -p /data /work /run/echohoard/secrets \
    && chown "${ECHOHOARD_WORKER_UID}:${ECHOHOARD_WORKER_GID}" /data /work /run/echohoard/secrets \
    && chmod 0700 /data /work /run/echohoard/secrets \
    && chmod 0555 /usr/local/bin/echohoard \
    && node --version \
    && python --version
EXPOSE 3000
USER ${ECHOHOARD_WEB_UID}:${ECHOHOARD_WEB_GID}
ENTRYPOINT ["/usr/local/bin/echohoard"]
