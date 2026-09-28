#!/bin/sh
# Rotation de la clé maître sur une pile en service (après les tests de bout en bout), puis
# vérification que le worker relit les identifiants rechiffrés : il doit surveiller au moins un
# compte au redémarrage, ce qui suppose de les avoir déchiffrés avec la nouvelle clé.
set -eu

docker compose stop worker
docker compose run --rm admin rotate-key --secrets-dir /var/lib/plume/secrets
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose restart api worker
docker compose up -d --wait --wait-timeout 180

i=0
while [ $i -lt 30 ]; do
  line=$(docker compose logs --no-color --since "$since" worker | grep '"msg":"worker démarré"' | tail -n 1 || true)
  if [ -n "$line" ]; then
    watching=$(printf '%s' "$line" | sed -n 's/.*"watching":\([0-9]*\).*/\1/p')
    if [ "${watching:-0}" -ge 1 ]; then
      echo "ok : le worker surveille $watching compte(s) après la rotation"
      exit 0
    fi
    echo "ÉCHEC : le worker ne surveille aucun compte après la rotation" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 2
done
echo "ÉCHEC : le worker n'a pas redémarré" >&2
exit 1
