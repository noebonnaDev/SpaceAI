#!/usr/bin/env bash
# Backup giornaliero del database di Ritrovo (formato custom di pg_dump), conservando gli ultimi N giorni.
# Uso:   ./scripts/backup.sh            (da eseguire nella cartella di Ritrovo, ad esempio con cron)
# Cron:  15 2 * * * cd /opt/ritrovo && ./scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p backups
FILE="backups/ritrovo-$(date +%Y-%m-%d_%H%M).dump"
docker compose exec -T db pg_dump -U ritrovo -d ritrovo -Fc > "$FILE"
if [ ! -s "$FILE" ]; then echo "Backup vuoto: controlla che il servizio db sia attivo" >&2; rm -f "$FILE"; exit 1; fi
find backups -name 'ritrovo-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "$(date '+%d/%m/%Y %H:%M') backup completato: $FILE ($(du -h "$FILE" | cut -f1))"
