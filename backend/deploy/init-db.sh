#!/usr/bin/env bash
set -euo pipefail
# New databases only. psql quotes the password as a SQL literal, never shell code.
# Hex credentials are required because the API embeds this value in DATABASE_URL.
[[ ${Q_DB_PASSWORD:-} =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Q_DB_PASSWORD must be 32 random bytes encoded as hex' >&2; exit 1; }
psql --username "$POSTGRES_USER" --dbname postgres --set=ON_ERROR_STOP=1 <<'SQL'
\getenv q_password Q_DB_PASSWORD
CREATE ROLE q_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'q_password';
CREATE DATABASE q OWNER q_app;
REVOKE CONNECT ON DATABASE q FROM PUBLIC;
GRANT CONNECT ON DATABASE q TO q_app;
SQL
