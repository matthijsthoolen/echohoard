# syntax=docker/dockerfile:1.7

# Keep base versions explicit. The release pipeline may additionally resolve
# these tags to digests; no deployment values belong in this image.
ARG NODE_VERSION=22.14.0-bookworm-slim
ARG PYTHON_VERSION=3.12.8-slim-bookworm

FROM node:${NODE_VERSION} AS node-base
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.5 --activate

FROM node-base AS dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

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
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PYTHONPATH=/opt/worker-python
ENV ECHOHOARD_ROLE=web
WORKDIR /app
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=worker-dependencies /opt/worker-python /opt/worker-python
COPY --from=build /app/src/delivery/web ./src/delivery/web
COPY --from=build /app/dist ./dist
COPY container/entrypoint.sh /usr/local/bin/echohoard
RUN chmod 0555 /usr/local/bin/echohoard \
    && node --version \
    && python --version
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/echohoard"]
