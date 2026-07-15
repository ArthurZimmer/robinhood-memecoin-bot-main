#!/bin/sh
# Runs inside the bot container. Postgres/Redis readiness is guaranteed by
# compose `depends_on: condition: service_healthy`, so migrations can run
# immediately on startup.
set -e

echo "[entrypoint] Applying database migrations..."
npm run db:migrate

echo "[entrypoint] Starting bot (mode from TRADING_MODE)..."
exec npm run start
