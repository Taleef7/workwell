# The Node base image, pinned by digest. The deploy builds pass the same image back from whichever registry
# served it first (.github/scripts/pull-base-image.sh reads this default), so a registry refusing
# anonymous pulls no longer fails the build. To move to a newer Node 24 patch, replace the digest with
# the tag's current one (every registry answers the same index digest).
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

FROM ${NODE_IMAGE} AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Vendored `datavis` (NITRO grid) is a file: dependency — its package.json must be
# present before install so pnpm can link it. Copy the whole vendored source.
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile

FROM ${NODE_IMAGE} AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
ARG NEXT_PUBLIC_API_URL=https://twh-api-ts.os.mieweb.org
ARG NEXT_PUBLIC_APP_NAME="WorkWell Measure Studio"
# Empty falls back to the home page's own default copy for NEXT_PUBLIC_SUBJECT_TERM.
ARG NEXT_PUBLIC_APP_TAGLINE=""
ARG NEXT_PUBLIC_APP_DESCRIPTION=""
ARG NEXT_PUBLIC_CODIFY_INDEX_URL=""
# Deployment-level subject noun: "employee" (default) or "patient" (the Maui pilot).
ARG NEXT_PUBLIC_SUBJECT_TERM=employee
ARG NEXT_PUBLIC_PUBLIC_DEMO=on
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_APP_TAGLINE=$NEXT_PUBLIC_APP_TAGLINE
ENV NEXT_PUBLIC_APP_DESCRIPTION=$NEXT_PUBLIC_APP_DESCRIPTION
ENV NEXT_PUBLIC_CODIFY_INDEX_URL=$NEXT_PUBLIC_CODIFY_INDEX_URL
ENV NEXT_PUBLIC_SUBJECT_TERM=$NEXT_PUBLIC_SUBJECT_TERM
ENV NEXT_PUBLIC_PUBLIC_DEMO=$NEXT_PUBLIC_PUBLIC_DEMO
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM ${NODE_IMAGE} AS runner
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
