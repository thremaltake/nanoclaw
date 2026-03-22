#!/bin/bash
# Daily backup of NanoClaw data
# Run via cron: 0 3 * * * /home/nanoclaw/nanoclaw/backup.sh >> /home/nanoclaw/nanoclaw/logs/backup.log 2>&1

set -euo pipefail

NANOCLAW_DIR="/home/nanoclaw/nanoclaw"
BACKUP_DIR="/home/nanoclaw/backups"
TIMESTAMP=$(date +%Y%m%d)
BACKUP_FILE="$BACKUP_DIR/nanoclaw-$TIMESTAMP.tar.gz"

# Skip if today's backup already exists
if [ -f "$BACKUP_FILE" ]; then
  echo "$(date): Backup already exists for today: $BACKUP_FILE"
  exit 0
fi

mkdir -p "$BACKUP_DIR"

# Hot backup SQLite (safe while service is running)
sqlite3 "$NANOCLAW_DIR/store/messages.db" ".backup '/tmp/messages-backup.db'"

# Archive essential data
tar czf "$BACKUP_FILE" \
  -C / \
  tmp/messages-backup.db \
  home/nanoclaw/nanoclaw/groups/ \
  home/nanoclaw/nanoclaw/tenants.json 2>/dev/null || \
tar czf "$BACKUP_FILE" \
  -C / \
  tmp/messages-backup.db \
  home/nanoclaw/nanoclaw/groups/

rm -f /tmp/messages-backup.db

# Keep 14 days locally
find "$BACKUP_DIR" -name "nanoclaw-*.tar.gz" -mtime +14 -delete

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "$(date): Backup completed: $BACKUP_FILE ($SIZE)"
