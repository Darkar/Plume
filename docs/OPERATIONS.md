# Exploitation

Toutes les commandes se lancent depuis la racine du dépôt. Prérequis : Docker Engine 26+ et
Compose 2.26+ (montage de sous-dossiers de volumes).

## Installation

```sh
cp config/plume.example.yaml config/plume.yaml   # domaines, serveurs IMAP/SMTP, public_url
echo "PLUME_SITE_ADDRESS=mail.exemple.fr" > .env  # nom public (défaut : localhost)
docker compose up -d
```

`server.public_url` doit valoir `https://` suivi de `PLUME_SITE_ADDRESS` (contrôle d'origine).
Caddy obtient le certificat automatiquement (ports 80 et 443 joignables depuis Internet) ; avec
`localhost`, il utilise son autorité locale.

### Derrière un reverse proxy existant

Si un reverse proxy (nginx, Traefik, HAProxy…) assure déjà le TLS sur l'hôte, Caddy passe en
HTTP simple sur un port publié uniquement en local (D-062). Dans `.env` :

```sh
COMPOSE_FILE=compose.yaml:deploy/docker-compose.behind-proxy.yml
PLUME_LOCAL_PORT=8080        # défaut 8080
# PLUME_LOCAL_BIND=127.0.0.1 # défaut ; autre interface si le proxy est sur une autre machine
# PLUME_TRUSTED_PROXIES=192.168.1.10/32  # à restreindre si l'interface n'est pas locale
```

`server.public_url` reste l'adresse publique (`https://mail.exemple.fr`) ; `PLUME_SITE_ADDRESS`
est ignoré. Caddy n'est pas supprimé : il sert l'interface avec sa politique CSP et les en-têtes
de sécurité, et route `/api` ; le proxy amont n'a qu'à tout relayer. Exemple nginx :

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_buffering off;          # flux temps réel (SSE) de /api/v1/events
    proxy_read_timeout 1h;
    client_max_body_size 60m;     # pièces jointes
}
```

L'adresse IP réelle du client (limites de débit, journal d'audit) est reprise de
`X-Forwarded-For`, en provenance des seules adresses privées (passerelle Docker) par défaut.

Au premier démarrage, le service `secrets` génère la clé maître et les mots de passe internes dans
le volume `plume_secrets`, puis s'arrête (état « Exited (0) » normal).

| Service    | Rôle                                                    | UID   |
| ---------- | ------------------------------------------------------- | ----- |
| `caddy`    | HTTPS, en-têtes de sécurité, fichiers de l'interface    | 10002 |
| `api`      | API REST, applique les migrations au démarrage          | 10001 |
| `worker`   | Moteur de règles (IMAP IDLE), reports, résumé quotidien | 10001 |
| `postgres` | Base de données                                         | 70    |
| `redis`    | Sessions, files de tâches                               | 999   |
| `backup`   | Sauvegardes de la base                                  | 70    |
| `secrets`  | Génération des secrets (au démarrage, puis s'arrête)    | 10001 |
| `admin`    | Outils ponctuels (profil `tools`, `docker compose run`) | 10001 |

Aucun conteneur ne tourne en root (vérifié en CI par `scripts/check-nonroot.sh`).

## Configuration

- Valider sans redémarrer : `docker compose run --rm --no-deps api node dist/cli.js check-config`.
- Recharger à chaud la liste blanche et les limites : `docker compose kill -s HUP api worker`. Un
  fichier invalide est refusé et la configuration précédente reste active (voir les journaux).
- Les autres changements (base, Redis, clé maître, `public_url`) demandent
  `docker compose up -d`.

### Comptes autorisés d'un domaine

Pour n'ouvrir Plume qu'à certains comptes d'un domaine, lister ces comptes dans son entrée :

```yaml
- domain: exemple.com
  accounts: [sacha, alice@exemple.com] # parties locales ou adresses complètes
  imap: { host: mail.exemple.com, port: 993, security: tls }
  smtp: { host: mail.exemple.com, port: 465, security: tls }
```

Un compte absent est refusé comme un mauvais mot de passe, sans connexion au serveur IMAP. La
liste se recharge à chaud (`docker compose kill -s HUP api worker`) : un compte retiré perd
immédiatement ses sessions, son compte Plume est suspendu (journal d'audit
`account_suspended`, motif `account_not_allowed`) et ses règles cessent de s'exécuter. Le
remettre dans la liste lui permet de se reconnecter. Sans `accounts`, tout le domaine est
autorisé.

### Relais SMTP commun

Par défaut, Plume envoie avec les identifiants de la boîte de l'utilisateur. Si l'envoi passe
par un relais dont le compte est différent (prestataire d'envoi, relais du FAI), le déclarer
dans le bloc `smtp` du domaine :

```yaml
smtp:
  host: smtp-relay.fournisseur.example
  port: 587
  security: starttls
  auth:
    username: relais@exemple.org
    password_env: PLUME_SMTP_RELAY_PASSWORD
```

puis ajouter `PLUME_SMTP_RELAY_PASSWORD=…` au fichier `.env` (transmis aux services `api` et
`worker`) et `docker compose up -d`. Variante par fichier : `password_file: /chemin` et un
montage en lecture seule de ce fichier dans `api` et `worker` (lisible par l'UID 10001).
`check-config` vérifie que le secret est lisible. L'expéditeur reste l'adresse de
l'utilisateur : le relais doit l'accepter pour le domaine (SPF, DKIM). Un refus du relais est
journalisé et présenté à l'utilisateur comme un service d'envoi indisponible. Le secret est
relu à chaque envoi (changement pris en compte sans redémarrage si le fichier est modifié).

## Mise à jour

```sh
git pull
docker compose up -d --build
```

Les migrations de base sont appliquées par l'API au démarrage, dans une transaction. Faire une
sauvegarde juste avant (voir ci-dessous).

## Supervision

- `docker compose ps` : chaque service a une sonde de santé ; `backup` n'est sain que si une
  sauvegarde de moins de 26 h existe.
- `GET /healthz` (vivant) et `GET /readyz` (PostgreSQL et Redis joignables), non exposés par
  Caddy ; interrogés par les sondes Docker.
- Journaux JSON sur la sortie standard, sans secrets ni contenu de messages :
  `docker compose logs -f api worker`. Rotation par Docker (10 Mo × 5 par conteneur).
- Journal d'audit (connexions, TOTP, sessions, préférences, règles) : table `audit_log`.

## Sauvegardes

Le service `backup` exécute `pg_dump` (format personnalisé, compressé) au démarrage puis toutes
les 24 h, dans le volume `pg_backups`, et supprime les sauvegardes de plus de 14 jours. Réglages
(fichier `.env`) : `PLUME_BACKUP_INTERVAL` (secondes), `PLUME_BACKUP_RETENTION_DAYS`.

Seule la base est sauvegardée : les messages restent sur le serveur IMAP, et Redis ne contient
que des sessions et des files de tâches (une perte déconnecte les utilisateurs).

```sh
docker compose exec backup plume-backup now     # sauvegarde immédiate
docker compose exec backup plume-backup list    # liste
docker compose cp backup:/var/lib/postgresql/backups/plume-20260925T030000Z.dump ./
```

**Copier régulièrement les sauvegardes hors de la machine** (le volume disparaît avec elle). Elles
contiennent les identifiants IMAP **chiffrés** par la clé maître, qui n'est pas dans la
sauvegarde : c'est voulu, une sauvegarde volée ne suffit pas à les lire.

La clé maître n'est pas indispensable à une reprise : sans elle, les identifiants conservés sont
illisibles, et chaque utilisateur doit se reconnecter une fois pour que ses règles reprennent
(la connexion les enregistre de nouveau). Pour l'éviter, conserver une copie hors ligne de la
clé, **séparément** des sauvegardes :

```sh
docker compose run --rm --entrypoint cat admin /var/lib/plume/secrets/app/plume_master_key
```

### Restauration

```sh
docker compose stop api worker
docker compose exec backup plume-backup restore plume-20260925T030000Z.dump
docker compose up -d
```

La restauration se fait dans une seule transaction (`--single-transaction --exit-on-error`) :
en cas d'erreur, la base reste inchangée. Pour restaurer une copie externe, la placer d'abord
dans le volume : `docker compose cp ./plume-….dump backup:/var/lib/postgresql/backups/`.

Pour repartir d'une base neuve (machine perdue) : `docker compose up -d` crée une base vide et de
nouveaux secrets ; restaurer ensuite la sauvegarde comme ci-dessus, puis, si une copie de la clé
maître existe, la remettre en place **avant** de redémarrer api et worker :

```sh
docker compose stop api worker
docker compose run --rm -T --entrypoint sh admin -c \
  'f=/var/lib/plume/secrets/app/plume_master_key; umask 377; rm -f "$f"; cat > "$f"' \
  < plume_master_key.sauvegarde
docker compose up -d
```

La procédure complète (sauvegarde, perte simulée, restauration, vérification) est exécutée en CI
(`scripts/check-backup-restore.sh`).

## Rotation de la clé maître

À faire périodiquement, ou immédiatement en cas de soupçon de fuite.

```sh
docker compose stop worker
docker compose run --rm admin rotate-key --secrets-dir /var/lib/plume/secrets
docker compose restart api worker
```

La commande écrit une nouvelle clé (`plume_master_key.next`), rechiffre tous les identifiants
et secrets TOTP dans une seule transaction, puis met la nouvelle clé en place et conserve
l'ancienne en `plume_master_key.previous`. Si elle est interrompue, la relancer : elle reprend
avec la même nouvelle clé. Une fois le fonctionnement vérifié (le worker journalise
`worker démarré` avec `watching` supérieur à 0) :

```sh
docker compose run --rm --entrypoint rm admin /var/lib/plume/secrets/app/plume_master_key.previous
```

Mettre à jour la copie hors ligne de la clé. En cas de compromission, demander aussi aux
utilisateurs de changer leur mot de passe IMAP. Procédure exécutée en CI
(`scripts/check-key-rotation.sh`).

### Autres secrets

Les mots de passe PostgreSQL et Redis sont internes au réseau `internal` (sans accès extérieur).
Pour les renouveler : arrêter la pile, supprimer `postgres/postgres_password` et/ou
`redis/redis_password` du volume avec le service `admin`, puis changer le mot de passe côté
PostgreSQL (`ALTER ROLE plume PASSWORD …`) avant `docker compose up -d`. Les sessions Redis
n'ont pas à être conservées : supprimer le volume `redis_data` déconnecte simplement tout le
monde.

## Incidents

- **« Requête refusée par mesure de sécurité »** (`403 invalid_origin`) : l'adresse utilisée
  dans le navigateur ne correspond pas à `server.public_url` (schéma `https`, nom et port
  identiques, sans barre finale). Le journal de l'API indique l'origine reçue et celle
  attendue : `docker compose logs api | grep origine`. Corriger `public_url` puis
  `docker compose up -d`. Derrière un reverse proxy, `public_url` est l'adresse publique, pas
  `http://127.0.0.1:8080`.

- **Déconnecter tout le monde** : `docker compose restart redis` ne suffit pas (données
  persistées) ; `docker compose down redis && docker volume rm plume_redis_data && docker compose up -d`.
- **Compte compromis** : l'utilisateur peut fermer toutes ses sessions (Paramètres › Sécurité).
  Après changement de son mot de passe IMAP, les identifiants conservés par le worker ne
  fonctionnent plus ; ils sont remplacés à la connexion suivante.
- **Signalement de vulnérabilité** : voir [SECURITY.md](SECURITY.md).
