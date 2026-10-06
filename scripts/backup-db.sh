#!/bin/bash
set -euo pipefail
umask 077

# Cron keeps calling this entry point. No credentials in source, argv or logs.
BACKUP_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_NODE_BIN="${BACKUP_NODE_BIN:-/root/.nvm/versions/node/v22.22.2/bin/node}"
if [[ ! -x "$BACKUP_NODE_BIN" ]]; then
  BACKUP_NODE_BIN="$(command -v node)"
fi
exec "$BACKUP_NODE_BIN" "$BACKUP_SCRIPT_DIR/backup-database.mjs"
