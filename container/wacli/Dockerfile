# syntax=docker/dockerfile:1.7

ARG ALPINE_VERSION=3.22.1
ARG WACLI_VERSION=0.18.2
ARG WACLI_SHA256=d33e8cc4b01acbd4e1ba212e22ac9c6438221e0761112dd3e7a2cc30b3a5946f

FROM alpine:${ALPINE_VERSION} AS fetch
ARG WACLI_VERSION
ARG WACLI_SHA256
RUN apk add --no-cache ca-certificates curl tar \
    && curl --fail --silent --show-error --location \
      "https://github.com/openclaw/wacli/releases/download/v${WACLI_VERSION}/wacli_${WACLI_VERSION}_linux_amd64.tar.gz" \
      --output /tmp/wacli.tar.gz \
    && echo "${WACLI_SHA256}  /tmp/wacli.tar.gz" | sha256sum -c - \
    && mkdir /tmp/wacli \
    && tar --extract --gzip --file /tmp/wacli.tar.gz --directory /tmp/wacli \
    && test -f /tmp/wacli/wacli \
    && test -f /tmp/wacli/LICENSE

FROM debian:bookworm-slim
ARG WACLI_VERSION
ARG SIDECAR_UID=10001
ARG SIDECAR_GID=10001
ENV WACLI_VERSION=${WACLI_VERSION}
ENV WACLI_ACCOUNT_STORE=/var/lib/wacli/account
ENV WACLI_WEBHOOK_SECRET_FILE=/run/secrets/wacli_webhook_key
COPY --from=fetch /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=fetch /tmp/wacli/wacli /usr/local/bin/wacli
COPY --from=fetch /tmp/wacli/LICENSE /usr/share/licenses/wacli/LICENSE
COPY container/wacli/entrypoint.sh /usr/local/bin/echohoard-wacli
RUN groupadd --gid "${SIDECAR_GID}" wacli \
    && useradd --uid "${SIDECAR_UID}" --gid "${SIDECAR_GID}" \
      --home-dir /var/lib/wacli/account --shell /usr/sbin/nologin \
      --no-create-home wacli \
    && mkdir -p /var/lib/wacli/account /run/secrets \
    && chown -R "${SIDECAR_UID}:${SIDECAR_GID}" /var/lib/wacli \
    && chmod 0700 /var/lib/wacli/account /run/secrets \
    && chmod 0555 /usr/local/bin/wacli /usr/local/bin/echohoard-wacli \
    && /usr/local/bin/wacli --version
USER ${SIDECAR_UID}:${SIDECAR_GID}
WORKDIR /var/lib/wacli/account
ENTRYPOINT ["/usr/local/bin/echohoard-wacli"]
