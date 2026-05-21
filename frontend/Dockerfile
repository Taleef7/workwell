FROM node:20-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:20-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
ARG NEXT_PUBLIC_API_URL=https://workwell-api.os.mieweb.org
ARG NEXT_PUBLIC_APP_NAME="WorkWell Measure Studio"
ARG NEXT_PUBLIC_APP_TAGLINE="occupational-health compliance."
ARG NEXT_PUBLIC_APP_DESCRIPTION="Four measures, complete case management, and a full audit trail — one reviewable dashboard."
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_APP_TAGLINE=$NEXT_PUBLIC_APP_TAGLINE
ENV NEXT_PUBLIC_APP_DESCRIPTION=$NEXT_PUBLIC_APP_DESCRIPTION
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

EXPOSE 3000
LABEL org.mieweb.opensource-server.services.http.default-port=3000

CMD ["node", "server.js"]
