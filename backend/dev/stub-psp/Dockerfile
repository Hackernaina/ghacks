# Build from the repo root: docker build -f backend/dev/stub-psp/Dockerfile -t reconcile-stub-psp .
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
COPY backend/dev/stub-psp backend/dev/stub-psp
RUN pnpm --filter @reconcile/shared build \
 && pnpm --filter @reconcile/stub-psp build \
 && pnpm --filter @reconcile/stub-psp deploy --prod /out

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 4001
CMD ["node", "dist/main.js"]
