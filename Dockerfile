FROM node:24.15.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json prettier.config.mjs oxlint.json ./
COPY apps ./apps
COPY modules ./modules
COPY adapters ./adapters
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--conditions=production
WORKDIR /app
RUN corepack enable
COPY --from=build /app /app
USER node
CMD ["node","apps/app-api/dist/main.js"]
