#!/bin/sh
# Runs inside the bot container. Postgres/Redis readiness is guaranteed by
# compose `depends_on: condition: service_healthy`, so migrations can run
# immediately on startup.
set -e

echo "[entrypoint] Applying database migrations..."
npm run db:migrate

echo "[entrypoint] Starting bot (mode from TRADING_MODE)..."
# exec node directly, NOT `npm run start`: npm would be PID 1 and does not
# forward SIGTERM to the node grandchild, so `docker stop` killed the process
# without ever running main.ts's graceful shutdown (drain, DB flush).
exec node dist/main.js
