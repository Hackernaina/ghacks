# Build from the repo root: docker build -f mocks/Dockerfile -t reconcile-mocks .
# Run as PSP:  -e SERVICE=psp -e PSP_ID=psp_a -e PORT=4001 -e BACKEND_URL=... -e BANK_URL=...
# Run as bank: -e SERVICE=bank -e PORT=4003
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY backend/dev/stub-psp/package.json backend/dev/stub-psp/
COPY frontend/package.json frontend/
COPY mocks/psp/package.json mocks/psp/
COPY mocks/bank/package.json mocks/bank/
RUN pnpm install --frozen-lockfile
COPY shared shared
COPY mocks mocks
RUN pnpm --filter @reconcile/shared build \
 && pnpm --filter @reconcile/mock-psp --filter @reconcile/mock-bank build \
 && pnpm --filter @reconcile/mock-psp deploy --prod /out/psp \
 && pnpm --filter @reconcile/mock-bank deploy --prod /out/bank

FROM node:20-slim
ENV NODE_ENV=production SERVICE=psp
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 4001 4002 4003
CMD ["sh", "-c", "node /app/$SERVICE/dist/index.js"]
