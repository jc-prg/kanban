#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/backup"
TIMESTAMP=$(date +"%Y%m%d-%H%M")
FILENAME="jc-kanban-${TIMESTAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"

tar -czf "$BACKUP_DIR/$FILENAME" \
  -C "$SCRIPT_DIR" \
  --exclude="./backup" \
  --exclude="./app/node_modules" \
  --exclude="./.git" \
  .

echo "Backup saved: $BACKUP_DIR/$FILENAME"
