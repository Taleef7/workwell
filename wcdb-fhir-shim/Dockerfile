# wcdb-fhir-shim — dev/demo FHIR facade over the WebChart dev database (ADR-034).
# Dev-grade by design: runs TypeScript directly via tsx (no build step), synthetic data only.
# Reproducible: installs exactly the committed lockfile CI verifies (npm ci), nothing unpinned.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
EXPOSE 8085
ENV SHIM_PORT=8085
CMD ["npx", "tsx", "src/main.ts"]
