# syntax=docker/dockerfile:1
# Ritrovo: one container serves the API, the web app (PWA) and the Outlook add-in pages.
# Behind a TLS-inspecting corporate proxy, pass the proxy CA as an optional build secret:
#   docker build --secret id=extra_ca,src=/path/to/proxy-ca.pem -t ritrovo:latest .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/addin/package.json packages/addin/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund
COPY packages ./packages
RUN npm run build -w @ritrovo/web && npm run build -w @ritrovo/server

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/addin/package.json packages/addin/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY packages/shared packages/shared
COPY packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY packages/addin/manifest.template.xml packages/addin/manifest.template.xml
WORKDIR /app/packages/server
ENV PORT=8080 \
    WEB_DIST_DIR=/app/packages/web/dist \
    ADDIN_MANIFEST_TEMPLATE=/app/packages/addin/manifest.template.xml
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health > /dev/null || exit 1
CMD ["node", "dist/index.js"]
