# Bot image — compiles TypeScript, then runs DB migrations before starting.
# Single stage on purpose: the entrypoint needs devDependencies at runtime
# (drizzle-kit for migrations), so we keep the full dependency set.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching.
# Includes devDeps: tsup (build) + drizzle-kit (migrations).
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build to dist/ (see .dockerignore for what's excluded).
COPY . .
RUN npm run build

# Entrypoint applies migrations, then execs `npm run start`.
ENTRYPOINT ["sh", "/app/docker/entrypoint.sh"]
