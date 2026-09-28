#!/bin/sh
# Scan ZAP authentifié de l'API (routes décrites par docs/openapi.json) sur une pile de test.
# Usage : scripts/zap-api-scan.sh <https://hôte> <adresse> <mot de passe>
# Rapports dans zap/ (api.json, api.html) ; le seuil bloquant est appliqué par zap-check.mjs.
set -eu

BASE=${1:?URL de base}
EMAIL=${2:?adresse}
PASSWORD=${3:?mot de passe}
ZAP_IMAGE=${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:2.17.0}

mkdir -p zap
chmod 777 zap
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT

# Connexion : cookie de session (__Host-plume_sid) et jeton CSRF.
body=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")
response=$(curl -sS -k --fail -c "$jar" -H 'Content-Type: application/json' -H "Origin: $BASE" \
  --data "$body" "$BASE/api/v1/auth/login")
csrf=$(printf '%s' "$response" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')
sid=$(awk '$6 == "__Host-plume_sid" { print $7 }' "$jar")
[ -n "$csrf" ] && [ -n "$sid" ] || { echo "ÉCHEC : connexion impossible" >&2; exit 1; }

api() {
  method=$1 path=$2
  shift 2
  curl -sS -k --fail -b "__Host-plume_sid=$sid" -H "X-CSRF-Token: $csrf" -H "Origin: $BASE" \
    -H 'Content-Type: application/json' -X "$method" "$@" "$BASE/api/v1$path"
}
ids() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log((j.messages??[j]).map(m=>m.id).join(" "))})'; }

# Données réelles pour les paramètres de chemin, sans quoi ZAP n'atteint que des 404 : un
# message et une règle stables, plus un exemplaire sacrifiable par opération qui les déplace ou
# les supprime (sinon le premier appel invaliderait l'identifiant pour tous les autres).
for n in 1 2 3 4 5; do
  api POST /messages/send --data "{\"to\":[{\"address\":\"$EMAIL\"}],\"subject\":\"Scan ZAP $n\",\"html\":\"<p>x</p>\"}" > /dev/null
done
set --
i=0
while [ $# -lt 5 ] && [ $i -lt 30 ]; do
  # shellcheck disable=SC2046
  set -- $(api GET '/messages?limit=5' | ids)
  [ $# -ge 5 ] || { i=$((i + 1)); sleep 2; }
done
[ $# -ge 5 ] || { echo "ÉCHEC : messages de test non reçus" >&2; exit 1; }
rule_body='{"name":"Scan ZAP","conditions":[{"field":"subject","op":"contains","value":"zzz-scan"}],"actions":[{"type":"mark_read"}]}'
rule=$(api POST /rules --data "$rule_body" | ids)
spare_rule=$(api POST /rules --data "$rule_body" | ids)

node scripts/zap-openapi.mjs docs/openapi.json zap/openapi.scan.json "$BASE" \
  "/messages/=$1" "post /messages/{id}/archive=$2" "post /messages/{id}/move=$3" \
  "post /messages/{id}/snooze=$4" "delete /messages/{id}=$5" \
  "/rules/=$rule" "delete /rules/{id}=$spare_rule"

# Chaque requête de ZAP porte la session, le jeton CSRF et l'origine attendue (règles du
# « replacer »), sans quoi l'API répondrait 401 / 403 et seule la surface anonyme serait testée.
replacer() {
  i=$1 name=$2 value=$3
  printf -- ' -config replacer.full_list(%s).description=%s' "$i" "$name"
  printf -- ' -config replacer.full_list(%s).enabled=true' "$i"
  printf -- ' -config replacer.full_list(%s).matchtype=REQ_HEADER' "$i"
  printf -- ' -config replacer.full_list(%s).matchstr=%s' "$i" "$name"
  printf -- ' -config replacer.full_list(%s).regex=false' "$i"
  printf -- ' -config replacer.full_list(%s).replacement=%s' "$i" "$value"
}
options="$(replacer 0 Cookie "__Host-plume_sid=$sid")$(replacer 1 X-CSRF-Token "$csrf")$(replacer 2 Origin "$BASE")"

docker run --rm --network host -v "$PWD/zap:/zap/wrk:rw" -v "$PWD/.zap:/zap/cfg:ro" \
  "$ZAP_IMAGE" zap-api-scan.py \
  -t /zap/wrk/openapi.scan.json -f openapi \
  -c /zap/cfg/rules.tsv -J api.json -r api.html -I -T 25 \
  -z "$options"

# La session doit être restée valide pendant tout le scan (sinon il n'était plus authentifié).
status=$(curl -sS -k -o /dev/null -w '%{http_code}' -b "__Host-plume_sid=$sid" "$BASE/api/v1/me")
if [ "$status" != "200" ]; then
  echo "ÉCHEC : la session du scan n'est plus valide (HTTP $status)" >&2
  exit 1
fi
echo "Session toujours valide à la fin du scan."
