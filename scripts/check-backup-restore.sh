#!/bin/sh
# Sauvegarde, perte simulée des données, puis restauration, sur une pile en service (après les
# tests de bout en bout). Échoue si les données restaurées diffèrent des données sauvegardées.
set -eu

sql() {
  docker compose exec -T backup sh -c \
    'PGPASSWORD=$(cat /run/secrets/postgres_password) psql -h postgres -U plume -d plume -v ON_ERROR_STOP=1 -tAc "$1"' \
    sh "$1"
}
snapshot() {
  sql "SELECT (SELECT count(*) FROM users) || '/' || (SELECT count(*) FROM credentials) || '/' || (SELECT count(*) FROM rules) || '/' || (SELECT count(*) FROM preferences)"
}

before=$(snapshot)
echo "avant : $before (utilisateurs/identifiants/règles/préférences)"
[ "$before" != "0/0/0/0" ] || { echo "ÉCHEC : base vide, rien à vérifier" >&2; exit 1; }

file=$(docker compose exec -T backup /bin/sh /usr/local/bin/plume-backup now | tail -n 1)
name=$(basename "$file")
echo "sauvegarde : $name"

docker compose stop api worker
sql "TRUNCATE users CASCADE" > /dev/null
lost=$(snapshot)
echo "après perte simulée : $lost"

docker compose exec -T backup /bin/sh /usr/local/bin/plume-backup restore "$name"
after=$(snapshot)
echo "après restauration : $after"
docker compose up -d --wait --wait-timeout 180 api worker

if [ "$after" != "$before" ]; then
  echo "ÉCHEC : données restaurées différentes ($after, attendu $before)" >&2
  exit 1
fi
echo "ok : sauvegarde restaurée à l'identique"
