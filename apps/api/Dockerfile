# Image de production de plume-api : multi-étapes, non-root, sans gestionnaire de paquets.

ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build
# Certificat d'autorité optionnel (proxy d'entreprise qui intercepte TLS), en PEM : utilisé
# seulement dans cette étape de construction, jamais présent dans l'image finale (D-011).
ARG BUILD_CA_PEM=""
WORKDIR /repo
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
# Dépendances d'abord (cache Docker), puis sources.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/mail/package.json packages/mail/
COPY packages/rules/package.json packages/rules/
COPY packages/shared/package.json packages/shared/
RUN if [ -n "$BUILD_CA_PEM" ]; then printf '%s\n' "$BUILD_CA_PEM" > /tmp/build-ca.pem \
      && export NODE_EXTRA_CA_CERTS=/tmp/build-ca.pem; fi \
 && pnpm install --frozen-lockfile --filter @plume/api...
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN if [ -n "$BUILD_CA_PEM" ]; then printf '%s\n' "$BUILD_CA_PEM" > /tmp/build-ca.pem \
      && export NODE_EXTRA_CA_CERTS=/tmp/build-ca.pem; fi \
 && pnpm --filter @plume/api run build \
 && pnpm --filter @plume/api deploy --prod --frozen-lockfile --config.shamefully-hoist=true /out \
 && cp -r packages/db/migrations /out/migrations \
 && rm -rf /out/src /out/test /out/tsconfig.json /out/tsup.config.ts /out/Dockerfile

FROM ${NODE_IMAGE} AS runtime
# Retire npm, npx, yarn et corepack : inutiles à l'exécution, ils élargissent la surface d'attaque.
# Crée le point de montage du volume de secrets : un volume neuf hérite de son propriétaire
# (UID 10001), ce qui permet au service « secrets » de l'initialiser sans être root.
RUN set -eux \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack /opt/yarn-* \
 && mkdir -p /var/lib/plume/secrets \
 && chown 10001:10001 /var/lib/plume/secrets \
 && chmod 700 /var/lib/plume/secrets
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS="--disable-proto=throw --enable-source-maps" \
    PLUME_CONFIG=/etc/plume/plume.yaml
COPY --from=build --chown=0:0 /out/ ./
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
