FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
# Vendored `datavis` (NITRO grid) is a file: dependency — copy it before install.
COPY frontend/vendor ./vendor
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build
EXPOSE 3000
CMD ["pnpm", "start"]
