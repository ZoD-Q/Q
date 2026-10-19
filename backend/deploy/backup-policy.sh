#!/usr/bin/env bash
# Shared by the deployed backup job and the real PostgreSQL restoration acceptance test.
# Keep schemas and minimal idempotency/expiry tombstones, never temporary content/evidence.
Q_DUMP_EXCLUDES=(
  --exclude-table-data='*.social_ephemeral_payloads'
  --exclude-table-data='*.social_report_evidence'
  --exclude-table-data='*.social_reports'
)
