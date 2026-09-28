#!/bin/sh
# Sauvegardes de la base PostgreSQL de Plume (service « backup », UID 70, sans root).
#
#   backup.sh loop            sauvegarde, puis toutes les PLUME_BACKUP_INTERVAL secondes
#   backup.sh now             sauvegarde immédiate ; affiche le chemin du fichier
#   backup.sh list            liste les sauvegardes
#   backup.sh restore <nom>   restaure une sauvegarde (api et worker doivent être arrêtés)
#
# Format personnalisé de pg_dump (compressé), écrit sous un nom temporaire puis renommé : un
# fichier plume-*.dump est toujours complet. Rétention : PLUME_BACKUP_RETENTION_DAYS jours.
set -eu
umask 077

DIR=/var/lib/postgresql/backups
INTERVAL=${PLUME_BACKUP_INTERVAL:-86400}
RETENTION=${PLUME_BACKUP_RETENTION_DAYS:-14}

# Mot de passe lu dans le secret monté, jamais dans l'environnement du conteneur.
PGPASSWORD=$(cat /run/secrets/postgres_password)
export PGPASSWORD PGHOST=postgres PGUSER=plume PGDATABASE=plume

backup() {
  mkdir -p "$DIR"
  name="plume-$(date -u +%Y%m%dT%H%M%SZ).dump"
  pg_dump --format=custom --compress=6 --no-owner --file "$DIR/.$name.partial"
  mv "$DIR/.$name.partial" "$DIR/$name"
  find "$DIR" -name 'plume-*.dump' -type f -mtime "+$RETENTION" -delete
  find "$DIR" -name '.plume-*.partial' -type f -mmin +720 -delete
  echo "$DIR/$name"
}

case "${1:-}" in
  loop)
    while :; do
      if ! backup; then echo "sauvegarde en échec" >&2; fi
      sleep "$INTERVAL"
    done
    ;;
  now)
    backup
    ;;
  list)
    ls -l "$DIR"
    ;;
  restore)
    name=$(basename "${2:?nom de la sauvegarde attendu (voir « list »)}")
    file="$DIR/$name"
    [ -f "$file" ] || { echo "sauvegarde introuvable : $name" >&2; exit 1; }
    pg_restore --list "$file" > /dev/null
    pg_restore --clean --if-exists --no-owner --single-transaction --exit-on-error \
      --dbname plume "$file"
    echo "restauré : $name"
    ;;
  *)
    echo "usage : backup.sh loop | now | list | restore <nom>" >&2
    exit 64
    ;;
esac
