# Build from the repo root: docker build -f frontend/Dockerfile -t reconcile-frontend .
# Serves the production build with `vite preview`, which proxies API and mock
# calls to BACKEND_URL / PSP_A_URL / PSP_B_URL / BANK_URL (see vite.config.ts).
FROM node:20-slim
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY backend/dev/stub-psp/package.json backend/dev/stub-psp/
COPY frontend/package.json frontend/
COPY mocks/psp/package.json mocks/psp/
COPY mocks/bank/package.json mocks/bank/
RUN pnpm install --frozen-lockfile --filter @reconcile/frontend...
COPY shared shared
COPY frontend frontend
RUN pnpm --filter @reconcile/shared build && pnpm --filter @reconcile/frontend build
WORKDIR /repo/frontend
# vite writes its bundled config into node_modules/.vite-temp at startup
RUN chown -R node:node /repo/frontend
USER node
EXPOSE 5173
CMD ["./node_modules/.bin/vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
