#!/usr/bin/env bash
# Local development PostgreSQL (Docker), no Docker Compose required.
#
#   ./scripts/dev-db.sh
#   # then export DATABASE_URL=... (printed below)
#
# The data volume is named after the container and survives restarts.
set -euo pipefail

NAME="${PG_CONTAINER:-statuspilot-dev-pg}"
PORT="${PG_PORT:-55432}"
DB_USER="${PG_USER:-statuspilot}"
DB_PASSWORD="${PG_PASSWORD:-statuspilot}"
DB_NAME="${PG_DB:-statuspilot}"

if docker ps -a --format '{{.Names}}' | grep -qx "${NAME}"; then
  docker start "${NAME}" >/dev/null
else
  docker run -d \
    --name "${NAME}" \
    -e "POSTGRES_USER=${DB_USER}" \
    -e "POSTGRES_PASSWORD=${DB_PASSWORD}" \
    -e "POSTGRES_DB=${DB_NAME}" \
    -p "127.0.0.1:${PORT}:5432" \
    -v "${NAME}-data:/var/lib/postgresql/data" \
    postgres:16-alpine >/dev/null
fi

for _ in $(seq 1 60); do
  if docker exec "${NAME}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "${NAME}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null

echo "PostgreSQL is ready on 127.0.0.1:${PORT} (container ${NAME})"
echo
echo "export DATABASE_URL='postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${PORT}/${DB_NAME}?schema=public'"
