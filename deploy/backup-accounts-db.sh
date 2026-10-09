#!/bin/sh
# Nightly pg_dump backup for the accounts DB. Install as root's crontab:
#   0 3 * * * /usr/local/bin/backup-accounts-db.sh
# Keeps 7 daily dumps in /var/backups/songnest. Fails loudly (cron mails).
set -eu

DB_URL="${ACCOUNTS_DATABASE_URL:-postgres://songnest@127.0.0.1:5432/songnest}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/songnest}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%F)"
OUT="$BACKUP_DIR/songnest-accounts-$STAMP.dump"

pg_dump --format=custom --file="$OUT" "$DB_URL"
chmod 600 "$OUT"
# Rotate: keep the newest 7.
ls -1t "$BACKUP_DIR"/songnest-accounts-*.dump | tail -n +8 | xargs -r rm -f

echo "accounts backup: $OUT"
