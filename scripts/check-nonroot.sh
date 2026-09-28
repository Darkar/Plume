#!/bin/sh
# Vérifie qu'aucun conteneur de la pile ne tourne en root (UID 0).
set -eu
status=0
for service in $(docker compose ps --services --status running); do
  uid=$(docker compose exec -T "$service" id -u)
  if [ "$uid" = "0" ]; then
    echo "ÉCHEC : $service tourne en root" >&2
    status=1
  else
    echo "ok : $service (uid $uid)"
  fi
done
exit $status
