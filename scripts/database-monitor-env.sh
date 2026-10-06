#!/bin/bash
# Shared by cron monitors. Never fall back to a source-controlled password.
if [[ -z "${PGPASSWORD:-}" ]]; then
  export PGPASSFILE="${PGPASSFILE:-/etc/cheaterfinder/monitor.pgpass}"
  if [[ ! -r "$PGPASSFILE" ]]; then
    echo "Database monitor credentials unavailable: set PGPASSWORD or a protected PGPASSFILE" >&2
    exit 2
  fi
  if [[ "$(stat -c '%a' "$PGPASSFILE")" != "600" ]]; then
    echo "Database monitor PGPASSFILE must have mode 600" >&2
    exit 2
  fi
fi
