# Image Caddy contenant la SPA compilée. Tourne en utilisateur non-root.

ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG CADDY_IMAGE=caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
ARG GO_IMAGE=golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c

# Caddy recompilé avec une chaîne Go récente et des dépendances corrigées : le binaire officiel
# embarque des modules Go vulnérables (détectés par Trivy). Mettre à jour les versions ci-dessous
# à chaque nouvelle publication (Renovate).
FROM ${GO_IMAGE} AS caddy
# Certificat d'autorité optionnel (proxy d'entreprise qui intercepte TLS), en PEM : utilisé
# seulement dans cette étape de construction, jamais présent dans l'image finale (D-011).
ARG BUILD_CA_PEM=""
ARG CADDY_VERSION=v2.11.4
ARG XCADDY_VERSION=v0.4.7
ENV CGO_ENABLED=0 XCADDY_GO_BUILD_FLAGS="-trimpath -ldflags=-s -ldflags=-w"
RUN if [ -n "$BUILD_CA_PEM" ]; then printf '%s\n' "$BUILD_CA_PEM" > /tmp/build-ca.pem \
      && export SSL_CERT_FILE=/tmp/build-ca.pem; fi \
 && go install github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION} \
 && xcaddy build ${CADDY_VERSION} --output /out/caddy \
    --replace golang.org/x/crypto=golang.org/x/crypto@v0.55.0 \
    --replace golang.org/x/net=golang.org/x/net@v0.56.0 \
    --replace golang.org/x/text=golang.org/x/text@v0.39.0 \
    --replace google.golang.org/grpc=google.golang.org/grpc@v1.83.2 \
 && /out/caddy version

FROM ${NODE_IMAGE} AS web
# Certificat d'autorité optionnel (proxy d'entreprise qui intercepte TLS), en PEM : utilisé
# seulement dans cette étape de construction, jamais présent dans l'image finale (D-011).
ARG BUILD_CA_PEM=""
WORKDIR /repo
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
RUN if [ -n "$BUILD_CA_PEM" ]; then printf '%s\n' "$BUILD_CA_PEM" > /tmp/build-ca.pem \
      && export NODE_EXTRA_CA_CERTS=/tmp/build-ca.pem; fi \
 && pnpm install --frozen-lockfile --filter @plume/web...
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN pnpm --filter @plume/web run build

FROM ${CADDY_IMAGE}
RUN set -eux \
 && addgroup -S -g 10002 caddy \
 && adduser -S -D -H -u 10002 -G caddy caddy \
 && mkdir -p /data/caddy /config/caddy /srv/web \
 && chown -R 10002:10002 /data /config
# Le binaire recompilé n'a pas la capacité fichier cap_net_bind_service (incompatible avec
# « no-new-privileges » + « cap_drop: ALL ») : Docker autorise déjà les ports < 1024 sans privilège
# (net.ipv4.ip_unprivileged_port_start=0 dans l'espace de noms réseau du conteneur).
COPY --from=caddy /out/caddy /usr/bin/caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /repo/apps/web/dist /srv/web
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
USER 10002:10002
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8081/caddy-health"]
