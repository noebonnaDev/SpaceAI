#!/usr/bin/env bash
# Ripristino di un backup: ATTENZIONE, sostituisce i dati attuali.
# Uso: ./scripts/restore.sh backups/ritrovo-AAAA-MM-GG_HHMM.dump
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?Indica il file di backup da ripristinare}"
read -r -p "Ripristino $FILE: i dati attuali verranno sostituiti. Continuare? (scrivi SI) " ok
[ "$ok" = "SI" ] || { echo "Annullato."; exit 1; }
docker compose stop app
docker compose exec -T db pg_restore -U ritrovo -d ritrovo --clean --if-exists < "$FILE"
docker compose start app
echo "Ripristino completato."
