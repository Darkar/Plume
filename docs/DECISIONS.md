# Décisions d'implémentation

Ce fichier consigne les choix faits lorsque la spécification laissait une ambiguïté ou lorsqu'un
écart était nécessaire. En cas de doute, l'option **la plus sûre** a été retenue.

## Jalon 1 — Socle

### D-001 — Versions des outils

- **React 18** (et non 19, pourtant disponible) : la spécification l'impose. Renovate est configuré
  pour ne pas proposer React ≥ 19.
- **TypeScript 6.0** : `typescript-eslint` ne prend pas encore en charge TypeScript 7.
- **Zod 4**, **Fastify 5**, **Vitest 5**, **Vite 8**, **ioredis 5**, **BullMQ 5** : dernières versions
  stables dont l'API est éprouvée.

### D-002 — Paquet supplémentaire `packages/db`

Le schéma Drizzle, le client PostgreSQL et les migrations sont partagés par `api` et `worker`. Ils
vivent dans `packages/db`, absent de l'arborescence indicative de la spécification.

### D-003 — Migrations SQL écrites à la main

Plutôt que `drizzle-kit` (qui tire une version vulnérable d'`esbuild` et génère du SQL qu'il faut de
toute façon relire), les migrations sont des fichiers SQL versionnés dans `packages/db/migrations`,
appliqués dans l'ordre sous verrou consultatif (`pg_advisory_lock`), dans une transaction, et
tracés dans une table `plume_migrations`. Le schéma Drizzle (TypeScript) sert aux requêtes typées.

### D-004 — Emplacement du fichier Compose

La spécification place `docker-compose.yml` dans `deploy/` mais demande `docker compose up` depuis la
racine. Un `compose.yaml` à la racine **inclut** `deploy/docker-compose.yml` (directive `include`).

### D-005 — Front servi par une image Caddy dédiée

Au lieu d'un volume `web_dist` qu'il faudrait remplir par un service ad hoc, l'image Caddy est
construite en plusieurs étapes et embarque la SPA compilée (`deploy/caddy/Dockerfile`). Le
`Caddyfile` reste monté en lecture seule comme dans la spécification.

### D-006 — Caddy recompilé

Le binaire Caddy officiel embarque des modules Go présentant des vulnérabilités élevées corrigées
en amont (détectées par Trivy). Caddy est recompilé avec `xcaddy`, une chaîne Go récente et des
versions corrigées de ces modules. Les versions sont épinglées dans le Dockerfile.

### D-007 — Aucun conteneur en root

- `api` / `worker` : UID 10001, système de fichiers en lecture seule, `cap_drop: ALL`,
  `no-new-privileges`, limites mémoire / CPU / PID.
- `caddy` : UID 10002. La capacité fichier `cap_net_bind_service` du binaire est incompatible avec
  `no-new-privileges` ; Docker autorisant déjà les ports < 1024 aux utilisateurs non privilégiés
  (`net.ipv4.ip_unprivileged_port_start=0`), le binaire recompilé n'en a pas besoin.
- `postgres` (UID 70) et `redis` (UID 999) tournent aussi en non-root, en lecture seule avec
  `cap_drop: ALL`. Le script `scripts/check-nonroot.sh` le vérifie en CI.

### D-008 — Réseaux

- `internal` (réseau Docker `internal: true`, sans accès extérieur) : `api`, `worker`, `postgres`,
  `redis`. Postgres et Redis ne sont reliés qu'à ce réseau.
- `egress` : `api` et `worker`, qui doivent joindre les serveurs IMAP/SMTP.
- `edge` : `caddy` ↔ `api`. Seul Caddy publie des ports.

### D-009 — Secrets

- La spécification mélange `postgres_password` (Compose) et `url_file` (YAML). Retenu : secrets
  `plume_master_key`, `postgres_password`, `database_url`, `redis_url` et `redis_acl` (génération
  et montage : voir D-057, qui remplace le script `scripts/init-secrets.sh` initial).
- Le mot de passe Redis n'est **pas** passé en variable d'environnement ni en ligne de commande
  (visible via `docker inspect` / `ps`) : Redis lit un fichier ACL monté en secret. L'utilisateur
  `default` est désactivé ; l'utilisateur `health` ne peut exécuter que `PING` (sonde Docker).
- Le YAML accepte `*_file` (recommandé) **ou** `*_env`, jamais une valeur en clair : un champ
  `url:` est refusé comme champ inconnu.

### D-010 — Pas d'`apk upgrade` dans les images

Les images de base sont épinglées par empreinte (`@sha256:…`) et mises à jour par Renovate
(`docker:pinDigests`). Un `apk upgrade` rendrait la construction non reproductible.

### D-011 — Certificat d'autorité de construction optionnel

Derrière un proxy d'entreprise qui intercepte TLS, un certificat (PEM) peut être fourni à la
construction par l'argument `BUILD_CA_PEM` (ex. dans un `compose.override.yaml` local). Il n'existe
que dans les étapes de construction, jamais dans l'image finale. Un argument plutôt qu'un secret
BuildKit (`RUN --mount=type=secret`, choix initial) : les images doivent aussi se construire avec
le builder historique de Docker, sans BuildKit ; un certificat d'autorité est public.

### D-012 — Serveurs IMAP / SMTP : TLS obligatoire

Seuls `tls` et `starttls` sont acceptés pour `security` ; aucune connexion en clair. La version
minimale de TLS est configurable par domaine (`tls.min_version`, défaut `TLSv1.2`).

### D-013 — Normalisation des adresses

- Partie locale ASCII uniquement (« dot-atom » RFC 5322) ; les parties locales entre guillemets et
  Unicode (SMTPUTF8) sont refusées.
- Tout caractère de contrôle, espace (y compris invisible : U+200B, U+FEFF…) ou contrôle bidi est
  refusé ; exactement un `@`.
- Le domaine ne peut contenir que lettres, chiffres, `-` et `.` avant conversion IDNA
  (`domainToASCII`), car cette dernière accepte des entrées comme `domaine/../x`.
- Un TLD entièrement numérique est refusé (pas d'adresse IP).

### D-014 — Rechargement à chaud (SIGHUP)

Sont rechargés : `domains`, `auth.rate_limit`, `rules`, `security` (hors `master_key_file`).
Tout autre changement est ignoré et signalé dans les journaux (redémarrage nécessaire). Une
configuration invalide au rechargement est rejetée et l'ancienne reste active.

### D-015 — En-têtes et CSP

- L'API ne sert que du JSON : CSP `default-src 'none'; frame-ancestors 'none'`, `Cache-Control:
no-store` par défaut.
- La CSP de la SPA est posée par Caddy (`script-src 'self'`, `object-src 'none'`, etc.).
- `/healthz` et `/readyz` ne sont pas exposés publiquement par Caddy (404) ; Docker les interroge
  directement dans le conteneur via un petit script Node (les images n'ont ni `curl` ni `wget`).

### D-016 — Seuils de la CI de sécurité

- Semgrep : « sévérité élevée » = `ERROR`.
- OSV-Scanner ne filtre pas par sévérité : **toute** vulnérabilité connue fait échouer la CI (plus
  strict que la spécification). Exceptions possibles dans `osv-scanner.toml`, justifiées et datées.
- `pnpm audit --audit-level high`.
- Dépendances : `minimumReleaseAge` de 24 h dans pnpm (3 jours dans Renovate) pour limiter
  l'exposition aux paquets compromis fraîchement publiés ; `esbuild` est forcé en ≥ 0.28.1
  et `source-map-js` en ≥ 1.2.2 (outillage de couverture).
- Les actions GitHub sont épinglées par empreinte de commit.

### D-017 — Désactivations ponctuelles de règles ESLint

`security/detect-non-literal-fs-filename` est désactivée **ligne par ligne** (avec justification)
uniquement pour la lecture du fichier de configuration et des secrets, dont les chemins proviennent
de l'administrateur. `security/detect-object-injection` est désactivée globalement (faux positifs
systématiques sur les accès indexés typés ; les entrées externes sont validées par Zod).

### D-018 — Clés i18n

Format `module.fonctionnalité.clé` (ex. `auth.login.title`). Les paramètres sont substitués en
texte brut, jamais interprétés comme HTML.

## Jalon 2 — Authentification

### D-019 — Réponse unique en cas d'échec de connexion

Adresse mal formée, domaine hors liste blanche, mauvais mot de passe et serveur IMAP indisponible
renvoient tous `401 invalid_credentials`, avec une **durée minimale de réponse** (600 à 1000 ms)
pour masquer par le temps l'absence de connexion IMAP. Une indisponibilité du serveur IMAP est
journalisée mais **n'est pas comptée** comme tentative de force brute. Le verrouillage par compte
s'applique à toute adresse syntaxiquement valide, y compris d'un domaine refusé : son
comportement ne révèle pas la liste blanche.

### D-020 — CSRF : jeton synchronisé maison plutôt que `@fastify/csrf-protection`

`@fastify/csrf-protection` repose sur un secret en cookie (« double soumission ») ou sur
`@fastify/session`. Retenu, plus strict : un jeton aléatoire de 256 bits stocké **dans la session
Redis**, renvoyé au client dans le corps des réponses (jamais dans un cookie lisible) et exigé dans
l'en-tête `X-CSRF-Token` pour toute méthode non sûre, comparé en temps constant. S'y ajoutent,
pour **toutes** les requêtes non sûres (y compris la connexion) : contrôle de l'en-tête `Origin`
(égal à `server.public_url`, absent = refusé) et de `Sec-Fetch-Site`, et refus des corps autres
que JSON (`415`), ce qui exclut les requêtes « simples » cross-site.

### D-021 — Sessions

- Identifiant de 256 bits ; Redis ne stocke que son empreinte SHA-256.
- Session « se souvenir de moi » : durée absolue `remember_me_ttl`, inactivité maximale de 7 jours
  (sinon, `idle_timeout` rendrait l'option inutile).
- Session partielle (second facteur attendu) : 5 minutes, 5 essais, puis destruction.
- Nouvel identifiant à la connexion, après le second facteur et après l'activation du TOTP
  (les autres sessions sont alors révoquées).
- À chaque requête, le domaine de la session est revérifié contre la liste blanche courante.

### D-022 — Politique TOTP

- `optional` : l'utilisateur choisit ; `required` : la connexion ouvre une session limitée à
  l'enrôlement ; `disabled` : le second facteur n'est ni proposé ni exigé (un secret existant est
  ignoré).
- TOTP implémenté selon la RFC 6238 (SHA-1, 6 chiffres, 30 s, fenêtre ±1) avec `node:crypto`,
  testé sur les vecteurs de la RFC. Anti-rejeu : le dernier pas accepté est enregistré de façon
  atomique ; tout code d'un pas inférieur ou égal est refusé.
- Le secret en cours d'enrôlement est conservé **chiffré** dans la session Redis.
- 10 codes de secours (≈ 49 bits chacun), hachés en Argon2id (m = 19 Mio, t = 2), à usage unique.
- Le QR code est généré dans le navigateur (bibliothèque `qrcode`), jamais par un service tiers.

### D-023 — Chiffrement des secrets

Les données authentifiées (AAD) lient chaque valeur chiffrée à son utilisateur **et** à son usage
(`imap-password`, `totp-secret`, `totp-pending`) : une valeur copiée d'une ligne ou d'un usage à
l'autre est rejetée. Le format inclut l'identifiant de la clé maître, ce qui rend la rotation
vérifiable. La rotation (`plume rotate-key`) est transactionnelle.

### D-024 — Hôtes des serveurs de messagerie

Les hôtes IMAP/SMTP (fournis par l'administrateur) peuvent être un nom à un seul label (réseau
Docker, ex. `dovecot`) ou une adresse IP. Les domaines de la liste blanche, eux, doivent être des
noms DNS pleinement qualifiés. Option `login_format` (`email` par défaut, ou `local_part`) pour les
serveurs attendant la seule partie locale.

### D-025 — Retrait d'un domaine

Au démarrage et après chaque `SIGHUP`, les comptes dont le domaine ne correspond plus à la liste
blanche sont marqués `suspended_at` (le moteur de règles les ignorera), leurs sessions sont
détruites et l'événement est audité. Une reconnexion réussie (domaine réautorisé) lève la
suspension.

### D-026 — `server.public_url` et `PLUME_SITE_ADDRESS`

L'origine attendue par le contrôle CSRF est `server.public_url` : elle doit correspondre à l'adresse
servie par Caddy (`PLUME_SITE_ADDRESS`). La pile de test (`deploy/docker-compose.e2e.yml`,
`config/plume.e2e.yaml`) utilise `https://localhost` et un serveur GreenMail.

## Jalon 3 — Lecture

### D-027 — Affichage des mails HTML

- Nettoyage serveur par DOMPurify (jsdom) avec **listes d'autorisation** de balises et
  d'attributs ; SVG, MathML, formulaires, `meta`, `base`, `link`, médias et tout attribut `on*`
  sont supprimés. Les feuilles de style (`<style>` et `style=`) sont conservées mais filtrées :
  tout échappement CSS (`\`), `expression()`, `behavior`, `-moz-binding`, `@import`,
  `@font-face`, `image-set()` fait rejeter le bloc ; `url()` suit la même politique que les images.
- Le corps est servi par l'API comme **document autonome** (`/messages/:id/body`) chargé dans une
  `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` : **ni** `allow-scripts`
  **ni** `allow-same-origin`. `allow-popups*` est nécessaire pour que les liens (réécrits avec
  `target="_blank" rel="noopener noreferrer nofollow"`) s'ouvrent. La réponse porte sa propre CSP
  (`default-src 'none'`, aucune `script-src`, directive `sandbox`, `frame-ancestors 'self'`).
  _Modifié par D-064 : `allow-scripts` pour le seul script de mesure de hauteur, autorisé par
  son empreinte CSP ; toujours pas `allow-same-origin`._
- `style-src 'unsafe-inline'` est accepté **dans ce document uniquement** : la mise en forme des
  mails en dépend et aucun script ne peut s'y exécuter. La CSP de l'application reste
  `style-src 'self'`.
- Un `srcdoc` a été écarté : il hériterait de la CSP de l'application (styles bloqués).

### D-028 — Ressources de l'iframe : URL signées

L'iframe a une origine opaque : le cookie `SameSite=Strict` n'est pas envoyé pour ses
sous-ressources. Les images intégrées (`cid:`) et le proxy d'images utilisent donc des **URL
signées HMAC** (clé dérivée de la clé maître par HKDF, expiration 1 h, liées à l'utilisateur pour
les pièces jointes). Une URL signée ne permet que l'affichage d'une image raster (type vérifié
par signature binaire), jamais le téléchargement d'une pièce jointe. Ces réponses portent
`Cross-Origin-Resource-Policy: cross-origin` (sinon bloquées dans l'iframe opaque).

### D-029 — Proxy d'images (anti-SSRF)

Schémas http/https et ports 80/443 uniquement ; toute adresse non « unicast » publique est refusée
(boucle locale, privées, 169.254.0.0/16 dont les métadonnées cloud, CGNAT, IPv6 locales, IPv4
encapsulées, 6to4/Teredo/NAT64…) ; la vérification est faite **au moment de la connexion** sur
l'adresse réellement utilisée (résolveur épinglé dans l'agent undici : pas de rebinding DNS) ;
redirections suivies manuellement (3 max) et revérifiées ; 5 Mo et 10 s max ; SVG refusé ; type
réel vérifié par signature. Ni cookie ni référent ; agent utilisateur générique.

### D-030 — Pièces jointes

- Téléchargement : toujours `application/octet-stream`, `Content-Disposition: attachment` avec
  nom nettoyé (dernier segment, sans caractères de contrôle ni contrôles bidirectionnels,
  « .. » supprimés, noms réservés Windows préfixés, 150 caractères max) et
  `X-Content-Type-Options: nosniff`. Une double extension est conservée mais inoffensive (type
  neutre, jamais exécuté par le navigateur).
- Aperçu : seulement si le contenu **réel** est une image raster ou un PDF (type annoncé ignoré).
  Toujours servi avec une CSP `sandbox`. **Remplacé par D-043** pour l'affichage des PDF
  (la visionneuse intégrée du navigateur, hors bac à sable, n'est plus utilisée).

### D-031 — Accès IMAP depuis l'API

- Une connexion IMAP par utilisateur, réutilisée (pool), fermée après 5 min d'inactivité,
  200 connexions au plus (LRU). Le mot de passe est déchiffré à l'ouverture de la connexion.
- Identifiants opaques (dossier, UIDVALIDITY, UID, partie) encodés en base64url et strictement
  validés ; ils ne sont interprétés que dans la boîte de l'utilisateur authentifié : un
  identifiant forgé ou volé ne donne accès à aucune donnée d'un tiers (pas d'IDOR possible).
- Pagination par curseur (UIDVALIDITY + UID) ; un curseur périmé renvoie `409 stale_cursor`.
- Le filtre « Pièces jointes » examine la structure MIME (500 messages max par requête).
- « Favoris » est une vue (drapeau `\Flagged` de la boîte de réception), pas un dossier.
- Corps limité à 5 Mo (`413 too_large` au-delà, jamais de corps tronqué).
- `disableBinary` : les parties sont décodées côté client (certains serveurs annoncent FETCH
  BINARY sans décoder) ; repli sur l'encodage et le jeu de caractères de la BODYSTRUCTURE si le
  serveur ne fournit pas les en-têtes MIME d'une partie imbriquée.

### D-032 — Temps réel

`GET /events` (SSE) ouvre une connexion IMAP IDLE dédiée sur la boîte de réception (3 flux max
par utilisateur), envoie un battement toutes les 25 s et se ferme si la session expire (vérifiée
chaque minute sans la prolonger). Caddy ne compresse que les fichiers statiques pour ne pas mettre
le flux en tampon.

## Jalon 4 — Actions et envoi

### D-033 — Actions sur les messages

- Libellés = mots-clés IMAP. Pour rester des « atoms » IMAP valides partout, ils sont limités à
  l'ASCII (`[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}`), sans les noms des drapeaux système.
- Archiver / supprimer / déplacer renvoient l'identifiant du message dans le dossier de
  destination (UIDPLUS, ou recherche par `Message-ID` à défaut) : c'est ce qui permet
  « Annuler » (5 s) par un déplacement inverse. Le dossier d'archives ou la corbeille est trouvé
  par usage spécial (RFC 6154), puis par nom, et créé au besoin.
- Supprimer depuis la corbeille supprime définitivement (pas d'annulation).

### D-034 — Envoi

- JSON uniquement, pièces jointes encodées en base64 (limite de corps propre à la route,
  calculée au démarrage à partir de `max_upload_total`) : pas de `multipart/form-data`, qui
  rouvrirait la porte aux requêtes « simples » cross-site.
- L'expéditeur est toujours l'adresse du compte connecté ; aucun en-tête n'est accepté du client
  (schéma strict). Sujet, noms affichés, noms et types de pièces jointes passent par
  `headerSafe` (suppression des caractères de contrôle, dont CR/LF et séparateurs Unicode) avant
  Nodemailer. Les destinataires en copie cachée ne figurent que dans l'enveloppe SMTP.
- Réponse : le client ne transmet que l'identifiant opaque du message d'origine ; `In-Reply-To`
  et `References` sont lus sur le serveur IMAP.
- Le HTML de l'éditeur (et de la signature) est nettoyé côté serveur avec une liste
  d'autorisation courte (mise en forme, listes, liens http(s)/mailto) ; une alternative
  text/plain est générée. Le message brut envoyé est copié tel quel dans « Envoyés ».
- 100 destinataires et 200 envois par heure et par utilisateur au plus.
- SMTP : TLS implicite ou STARTTLS **obligatoire** (`requireTLS`), accès fichiers/URL de
  Nodemailer désactivés.
- Limites V1 : le transfert cite le texte du message d'origine mais ne rattache pas ses pièces
  jointes ; la citation est en texte brut (le HTML d'origine n'est jamais réinjecté dans
  l'éditeur).

### D-035 — Éditeur

Éditeur `contenteditable` minimal (gras, italique, souligné, listes, liens http(s)/mailto). Le
collage et le glisser-déposer n'insèrent que du texte brut. La citation est du texte échappé ;
la signature provient du serveur, déjà nettoyée. Aucune donnée non fiable n'est insérée en HTML.

### D-036 — Préférences

Table `preferences` (thème, accent, densité, notifications, signature) créée dès ce jalon pour la
signature ; les valeurs sont contraintes en base (`CHECK`) et par le schéma Zod de l'API. Le nom
affiché est nettoyé comme un en-tête (il est utilisé dans `From`).

## Jalon 5 — Moteur de règles

### D-037 — Évaluation

- Bibliothèque pure `packages/rules` (aucune I/O), schéma Zod unique pour l'API, l'import et le
  typage ; la définition est revalidée à chaque lecture en base (une ligne altérée n'est jamais
  exécutée).
- Expressions régulières compilées avec **RE2** (`re2-wasm`, sans compilation native) : temps
  linéaire garanti, donc pas de ReDoS ; rétroréférences et assertions sont refusées à la
  validation. Texte examiné limité à 100 000 caractères, budget de 250 ms par message.
- Comparaisons insensibles à la casse après normalisation NFKC.
- En-têtes lisibles : liste fermée (`List-Id`, `X-Spam-*`, `Precedence`…), jamais `Cookie`,
  `Authorization` ou `Received`.

### D-038 — Exécution

- Une connexion IMAP IDLE par compte ayant une règle active (500 au plus), reconnexion à délai
  croissant (2 s → 5 min), et interrogation de repli toutes les 5 minutes.
- Seuls les messages arrivés **après** la première exécution sont traités (curseur UID par
  boîte) ; « Appliquer aux messages existants » est une action explicite, suivie par une tâche
  BullMQ dont seul le propriétaire peut lire l'état.
- **Idempotence** : chaque message (boîte, UIDVALIDITY, UID) est réservé en base **avant** toute
  action (au plus une exécution : un redémarrage ne provoque jamais un second transfert).
- Ordre d'application : drapeaux et libellés, puis transfert / réponse automatique, puis **un
  seul** déplacement (plusieurs sont refusés à la validation).
- Statistiques par règle (dernière exécution, messages traités, erreurs avec code court).

### D-039 — Transfert et réponse automatique

- Transfert : désactivable, limité aux domaines de `rules.forward.allowed_destination_domains`
  (vérifié à l'enregistrement **et** à l'exécution : un domaine retiré de la configuration
  bloque les règles existantes). Le message d'origine est joint en `message/rfc822`, marqué
  `Auto-Submitted: auto-generated` et `X-Plume-Forwarded` ; un message portant ces marqueurs
  n'est jamais re-transféré (anti-boucle).
- Réponse automatique (RFC 3834) : jamais aux listes (`List-Id`, `List-Unsubscribe`,
  `Precedence: bulk|list|junk`), aux messages automatiques (`Auto-Submitted` ≠ `no`), aux
  adresses « noreply » / `MAILER-DAEMON` ni à soi-même ; au plus une par expéditeur et par 24 h
  (réservation atomique en base). Texte brut échappé.
- Ni transfert ni réponse automatique lors de l'application rétroactive.

### D-040 — Interface

- Réordonnancement par **glisser-déposer**, doublé de boutons « monter / descendre » pour le
  clavier et les lecteurs d'écran (le glisser-déposer HTML n'est pas accessible au clavier).
  L'ordre est appliqué immédiatement à l'écran puis confirmé par le serveur.
- Duplication (« nom (copie) »), soumise à la même limite de règles par utilisateur.
- Éditeur « Si [toutes / au moins une] des conditions suivantes… Alors… » ; les conditions sur
  en-tête proposent la liste fermée des en-têtes autorisés, fournie par l'API.
- « Créer une règle à partir de ce message » ouvre l'éditeur pré-rempli (expéditeur exact et
  objet), à ajuster avant enregistrement. Seul l'identifiant opaque du message transite dans
  l'URL ; le contenu est relu par l'API dans la boîte de l'utilisateur.
- Test à blanc sur les 200 derniers messages de la boîte de réception, sans aucune modification.

### D-045 — Une tâche BullMQ par arrivée, pas par message

L'IDLE signale l'arrivée de messages (EXISTS), pas leur identité. Chaque signal met en file une
tâche `process-new` pour la boîte, dédoublonnée sur 5 s, qui traite tous les nouveaux messages
depuis le curseur. C'est équivalent à « une tâche par message » (chaque message est évalué et
réservé individuellement, avec la même idempotence) tout en évitant une rafale de tâches lors
d'une réception massive ; la tâche est rejouée (3 essais, délai croissant) en cas d'échec.

## Section 6 — Compléments de lecture et d'envoi

### D-041 — Libellés dans la barre latérale

Les libellés sont des mots-clés IMAP. La liste est calculée à la demande (`GET /labels`) à partir
des mots-clés déclarés par la boîte (réponse FLAGS) et de ceux des 1 000 derniers messages de la
boîte de réception et des archives (FETCH FLAGS, peu coûteux) : aucune copie n'est stockée par
Plume. Un libellé ouvre la boîte de réception filtrée par `SEARCH KEYWORD`. Les dossiers créés
par l'utilisateur restent listés sous « Dossiers ».

### D-042 — Reporter

IMAP ne connaît pas le report. Le message est déplacé dans un dossier « Reportés » (créé à la
demande) et un enregistrement (`snoozes`) garde sa position (UIDVALIDITY + UID, et Message-ID en
repli), son dossier d'origine et l'échéance. Le worker vérifie les échéances toutes les 30 s et
remet le message, **non lu**, dans son dossier d'origine. Un message déplacé ou supprimé
entre-temps clôt le report ; une erreur le repousse (délai croissant, abandon après 10 essais).
Échéance entre 1 minute et 1 an. « Annuler » (5 s) et « Annuler le report » remettent le
message immédiatement, sans changer son état lu.

Conséquence sur le moteur de règles : un message remis dans la boîte (réveil, ou « Annuler »
après un archivage) y reçoit un **nouvel UID**. Pour ne jamais rejouer une règle (un second
transfert, par exemple), le moteur mémorise aussi l'empreinte SHA-256 du Message-ID des messages
traités (`processed_message_ids`, purgée après 90 jours).

### D-043 — Aperçu des PDF dans un bac à sable

Visionneuse pdf.js dédiée (`/viewer/pdf.html`), chargée dans une
`<iframe sandbox="allow-scripts">` **sans** `allow-same-origin` : elle s'exécute dans une
origine opaque, sans accès aux cookies, au stockage ni au document de l'application. Sa CSP :
`default-src 'none'; script-src 'self'; style-src 'self'; img-src blob: data:; connect-src
'none'; sandbox allow-scripts`. L'interface lit le PDF (fetch avec la session) et ne transmet
que ses octets par `postMessage`, après avoir vérifié que la demande vient bien de cette iframe.

- pdf.js 6 n'utilise pas `eval` ; le JavaScript des PDF, les formulaires XFA et les polices
  embarquées (`disableFontFace`) ne sont ni exécutés ni chargés ; 200 pages et 50 Mo au plus.
- Pas de Worker (impossible depuis une origine opaque) : le code du worker pdf.js est embarqué
  et exécuté sur le fil principal.
- Le script est un IIFE classique (un module ES serait chargé en mode CORS depuis l'origine
  opaque) ; `Cross-Origin-Resource-Policy: cross-origin` n'est posé que sur `/viewer/*`.
- Les images sont affichées dans une `<iframe sandbox="">` ; la réponse d'aperçu porte
  toujours une CSP `sandbox` et `X-Frame-Options: SAMEORIGIN`.

### D-044 — Taille des pièces jointes à l'envoi

Les limites de la configuration sont exposées avec les préférences et vérifiées dès la sélection
des fichiers dans le composeur ; le serveur les applique de toute façon (413).

## Jalon 6 — Préférences et finitions

### D-046 — Thème, accent et densité sans flash

Les préférences sont en base ; une copie **non sensible** (`plume:appearance` : thème, accent,
densité, langue) est gardée en `localStorage` pour que le script en ligne de `index.html` pose
`data-theme`, `data-accent`, `data-density` et `lang` sur `<html>` **avant** le premier rendu. Ce
script est le seul script en ligne ; il est autorisé par son empreinte SHA-256 dans la CSP de
Caddy (`script-src 'self' 'sha256-…'`, jamais `'unsafe-inline'`). `apps/web/test/csp-hash.test.ts`
échoue si le script change sans que l'empreinte soit mise à jour (c'est arrivé : Prettier l'avait
reformaté). Les valeurs lues sont validées par des expressions strictes avant d'être appliquées.

### D-047 — Couleurs et contrastes

Six accents fixes, chacun avec une teinte pour le thème clair (texte blanc dessus) et une pour le
thème sombre (texte foncé dessus). `apps/web/test/tokens.test.ts` calcule les contrastes WCAG de
toutes les combinaisons (textes ≥ 4,5:1 sur les trois fonds, texte d'accent sur fond d'accent
translucide, bordures ≥ 3:1). Il a révélé une bordure de champ à 2,93:1 depuis le jalon 1 et trois
accents trop clairs, corrigés.

### D-048 — Accessibilité (WCAG 2.2 AA)

Audits axe-core de bout en bout (`e2e/tests/a11y.spec.ts`, règles `wcag2a/2aa/21a/21aa/22aa`) sur
la connexion, les paramètres, la sécurité, l'éditeur de règles, la boîte de réception avec aperçu
et la rédaction, en thème clair **et** sombre : aucune violation tolérée. Le contenu des mails
(HTML de l'expéditeur, dans l'iframe isolée) est exclu de l'audit.

### D-049 — Langues

Français (par défaut) et anglais. Le dictionnaire anglais est typé par le français (une clé
manquante casse la compilation) et un test vérifie que les paramètres `{…}` sont identiques.
Préférence `auto` : première langue du navigateur reconnue, sinon français. Les dates et tailles
suivent la langue. Le résumé quotidien est rédigé dans la langue choisie.

### D-050 — Photo de profil

JSON (base64, 5 Mo au plus) comme le reste de l'API. Réencodage par `sharp` (libvips) : formats
raster courants uniquement (SVG refusé), 40 millions de pixels au plus (bombes de décompression),
orientation appliquée, recadrage 256 × 256, WebP ; **aucune métadonnée** n'est conservée (EXIF,
GPS, ICC, XMP). Stockée en base (≤ 256 Ko) et servie seulement à son propriétaire
(`GET /me/avatar`, `nosniff`, CSP `sandbox`).

### D-051 — Notifications

- Bureau : API Notification, permission demandée à l'activation, affichée seulement si l'onglet
  n'est pas visible ; elle n'indique que le **nombre** de nouveaux messages (ni expéditeur, ni
  objet).
- Son : bref signal Web Audio (aucun fichier, compatible avec `media-src 'none'`).
- Résumé quotidien : le worker l'envoie à partir de 7 h (fuseau `TZ` du conteneur), une fois par
  jour (créneau réservé en base avant l'envoi), à l'utilisateur lui-même par son SMTP, marqué
  `Auto-Submitted: auto-generated`. Il liste expéditeur et objet des non-lus récents de la boîte
  de réception, jamais leur contenu, exclut les messages envoyés par le compte à lui-même et
  n'est pas envoyé s'il n'y a rien à signaler.

### D-052 — Audit des préférences

Chaque modification des préférences (et de la photo) est journalisée avec la **liste des champs
modifiés**, jamais leurs valeurs. Les changements de sécurité (TOTP, sessions) l'étaient déjà.

### D-053 — Préférences : écritures partielles

Une modification des préférences n'écrit que les champs fournis, et les notifications sont
fusionnées en SQL (`notifications || $1::jsonb`). La version précédente relisait puis réécrivait
tout l'enregistrement : deux modifications rapprochées (langue puis thème) se croisaient et la
seconde effaçait la première. Test d'intégration à l'appui (cinq modifications simultanées).

### D-054 — Charge sur la connexion IMAP de l'utilisateur

Les requêtes d'un utilisateur partagent une connexion IMAP et s'exécutent donc à la suite :

- vérifier l'existence d'un dossier ou trouver un usage spécial ne demande plus les compteurs
  (plus de STATUS sur chaque dossier à chaque déplacement : archiver passe de 5,5 s à 0,6 s sur
  GreenMail) ;
- la liste des libellés est gardée 60 s en mémoire par l'API (invalidée quand l'utilisateur
  modifie un libellé) ;
- l'interface ne relit libellés et reports qu'après les actions qui les modifient.

### D-055 — Seuils de couverture

La CI (`pnpm run test:coverage`) échoue sous 80 % de lignes et d'instructions sur l'ensemble,
et sous 90 % pour `packages/rules`, `packages/config` et `packages/crypto`. Sont exclus de la
mesure : les points d'entrée `apps/api/src/main.ts` et `apps/worker/src/main.ts` (composition,
signaux, écoute réseau) et la visionneuse `apps/web/src/viewer/pdf-viewer.ts` (exécutée dans une
iframe à origine opaque, hors jsdom). Tous trois sont exercés par les tests de bout en bout.

### D-056 — Description OpenAPI

La description OpenAPI 3.1 est calculée à partir des schémas Zod de validation
(`z.toJSONSchema`, en mode « entrée » : les champs à valeur par défaut sont facultatifs) et d'une
table des routes (`apps/api/src/openapi.ts`). Elle est versionnée dans `docs/openapi.json` plutôt
que servie par l'application : elle ne sert qu'aux clients et au scan ZAP authentifié, et une
route de plus serait une surface inutile. Un test compare la table aux routes réellement
enregistrées par Fastify et le fichier au résultat de la génération.

### D-057 — Secrets générés au premier démarrage

Critère d'acceptation : `cp config/plume.example.yaml config/plume.yaml && docker compose up -d`
doit suffire. Les secrets ne peuvent donc plus être préparés sur l'hôte par un script :

- un service `secrets` (image de l'API, UID 10001, `network_mode: none`, lecture seule sauf le
  volume) exécute `plume init-secrets` au démarrage et s'arrête ; les autres services en
  dépendent (`service_completed_successfully`). Il est idempotent : les valeurs de référence
  (clé maître, mots de passe) ne sont jamais régénérées, les fichiers qui en dérivent (URL, ACL
  Redis) sont réécrits ;
- les secrets vivent dans le volume nommé `plume_secrets`. Un volume neuf hérite du propriétaire
  du point de montage de l'image (UID 10001) : aucun conteneur root n'est nécessaire ;
- chaque service monte **son** sous-dossier en lecture seule (`volume.subpath`, Docker Engine 26+
  et Compose 2.26+) : `postgres` ne voit pas la clé maître, `redis` ne voit que son ACL. `app/` est
  en `0700` (UID 10001), les fichiers de `postgres/` et `redis/` en `0444` car lus par d'autres
  UID ;
- la rotation de la clé maître se fait par le service d'administration `admin` (profil `tools`) :
  nouvelle clé écrite en `.next` avant le rechiffrement (reprise possible), puis échange des
  fichiers.

Un volume Docker n'est pas chiffré au repos : l'hôte reste dans le périmètre de confiance, comme
avec les secrets Compose (fichiers en clair sur l'hôte). Sauvegarder ce volume avec la base :
sans la clé maître, les identifiants conservés sont perdus (voir OPERATIONS.md).

### D-058 — Scan ZAP authentifié de l'API

`scripts/zap-api-scan.sh` se connecte (compte GreenMail dédié), prépare des données réelles
(messages envoyés à soi-même, règles) et lance `zap-api-scan.py` sur `docs/openapi.json` :

- chaque requête porte le cookie de session, `X-CSRF-Token` et `Origin` (règles « replacer » de
  ZAP) ; sans cela, seule la surface anonyme (401 / 403) serait analysée ;
- les paramètres `{id}` reçoivent des identifiants réels ; les opérations qui déplacent ou
  suppriment reçoivent chacune leur exemplaire sacrifiable, pour ne pas invalider l'identifiant
  des autres ;
- `/auth/logout` et `/auth/logout-all` sont retirées du scan (elles fermeraient sa session) ; le
  script vérifie en fin de scan que la session est toujours valide ;
- seuil bloquant : aucune alerte de niveau élevé (`scripts/zap-check.mjs`), comme pour le scan de
  base. L'avertissement « CSP: style-src unsafe-inline » sur le document du corps de message est
  attendu (D-027).

### D-059 — Refonte visuelle

Inspirée de la maquette fournie (connexion en deux panneaux, boîte de réception en trois zones,
paramètres à navigation latérale) :

- **Polices** : Inter (texte) et Instrument Serif (titres d'affichage), licence OFL,
  auto-hébergées via `@fontsource` : la CSP reste `font-src 'self'`, aucune requête vers un
  service tiers.
- **Icônes** : `lucide-react` (licence ISC), SVG en ligne décoratifs (`aria-hidden`), le nom
  accessible étant toujours porté par le contrôle.
- **Couleurs** : palette neutre (fond, panneaux, surfaces) ; l'aplat d'accent garde un texte
  blanc dans les deux thèmes, le texte d'accent est éclairci en thème sombre. Pastilles
  (avatars, libellés) choisies par hachage du nom. Tous les contrastes restent vérifiés par
  `test/tokens.test.ts` et par axe-core (WCAG 2.2 AA) en bout en bout.
- **Corps des mails en thème sombre** : l'interface passe `theme=dark` au document du corps ;
  un mail texte ou un HTML sans couleurs imposées s'affiche en texte clair sur fond
  transparent (`color-scheme: dark`). Un mail qui impose ses couleurs (styles `color`,
  `background`, `bgcolor`, `<font color>`) reste sur fond blanc : ses choix supposent un fond
  clair.
- **Barre d'outils du message** : actions en icônes ; Reporter, Déplacer et « Plus
  d'actions » (répondre à tous, transférer, créer une règle) sont des menus ARIA (flèches,
  Échap, focus rendu au bouton), les libellés un panneau non modal.
- **Paramètres** : la barre latérale devient la navigation des paramètres (sections de la
  page générale, Règles, Sécurité) ; la déconnexion s'y trouve. Le nom affiché est enregistré
  en quittant le champ, comme les autres préférences ; la signature garde son bouton.
- **Connexion** : pas de « mot de passe oublié », de clé d'accès ni de création de compte
  (présents sur la maquette) : l'authentification est celle du serveur IMAP.

### D-060 — Plusieurs comptes dans une session

Une session peut contenir jusqu'à 5 comptes ; `userId` / `email` / `domain` restent ceux du
compte **actif**, si bien que toutes les routes (messagerie, règles, préférences) agissent pour
lui sans modification et que chaque compte garde ses propres données.

- **Ajout** (`POST /auth/accounts`) : exactement les contrôles de la connexion (fonction
  commune : limites par IP et par compte, verrouillage, liste blanche avant toute connexion
  IMAP, réponse d'échec uniforme et différée). Un compte protégé par TOTP n'est ajouté qu'après
  son second facteur (`/auth/accounts/totp`, 5 essais, 5 minutes) ; un compte qui devrait
  s'enrôler est refusé (enrôlement lors d'une connexion directe).
- **Anti-fixation** : l'identifiant de session change à chaque ajout ou bascule.
- **Révocation** : la session est indexée sous chacun de ses comptes ; « déconnecter tous mes
  appareils » d'un compte ferme aussi les sessions où il a été ajouté. Un compte dont le
  domaine sort de la liste blanche est retiré de la session (la session entière si c'est le
  compte actif).
- **Bascule côté interface** : rechargement complet de l'application, pour qu'aucune donnée du
  compte précédent (cache, flux temps réel, apparence) ne subsiste sous le nouveau.
- « Se déconnecter » ferme tous les comptes ; « Fermer … » (menu du compte) n'en ferme qu'un.
- Audit : `account_added`, `account_switched`, `account_removed`.

### D-061 — Suppression des libellés, signature, mobile

- **Supprimer un libellé** (`DELETE /labels/:name`) retire le mot-clé IMAP de tous les
  messages qui le portent, dans tous les dossiers ; les messages sont conservés. Les serveurs
  gardent souvent le mot-clé dans la liste déclarée de la boîte (`FLAGS`) : la liste des
  libellés ne retient donc un mot-clé déclaré que s'il est encore porté par un message
  (recherche `KEYWORD`). Une règle qui ajoute ce libellé continuera de l'ajouter.
- **Signature** insérée telle quelle, sans séparateur « -- » : à la discrétion de
  l'utilisateur.
- **Message archivé** : « Remettre dans la boîte de réception » remplace « Archiver ».
- **Mobile** (≤ 760 px) : barre supérieure (menu, marque, nouveau message) et tiroir de
  navigation (`inert` et masqué lorsqu'il est fermé, Échap pour fermer, fermé à chaque
  navigation) ; rédaction en plein écran ; barre d'outils du message sur une ligne.

### D-062 — Derrière un reverse proxy, aperçu PDF navigable, logo

- **Reverse proxy existant** : `deploy/docker-compose.behind-proxy.yml` publie Caddy en HTTP
  sur `127.0.0.1:${PLUME_LOCAL_PORT:-8080}` (`PLUME_SITE_ADDRESS=:8080`, ni certificat ni
  ports 80/443). Caddy n'est pas désactivé : il porte la CSP (empreinte du script en ligne),
  les en-têtes de sécurité, la CSP propre à `/viewer/*` et le routage `/api`. Les reproduire
  dans chaque proxy amont serait fragile ; le proxy n'a qu'à relayer.
- **Adresse du client** : Caddy ne conserve `X-Forwarded-For` / `-Proto` que depuis
  `PLUME_TRUSTED_PROXIES` (vide par défaut : en-têtes remplacés, comme avant). En mode
  reverse proxy, `private_ranges` par défaut : seul l'hôte atteint le port local, via la
  passerelle Docker. À restreindre si le port est publié sur une autre interface.
- **Aperçu PDF** : barre d'outils (page précédente / suivante, saisie du numéro de page, zoom
  de 50 à 400 %, ajustement à la largeur ; `+`, `-`, `0`, Ctrl + molette). Seules les pages
  proches de la zone visible sont dessinées, à la résolution de l'écran (canevas plafonné à
  16 Mpx). Pas de `<form>` : l'iframe n'a pas `allow-forms`. Polyfill des méthodes
  `Map`/`WeakMap.getOrInsert*` (ES2026) utilisées par pdf.js 6. Textes en français ou en
  anglais selon la langue transmise avec le document.
- **Logo** : dessin du favicon (tuile arrondie, plume blanche), tuile dans la couleur d'accent
  choisie (même aplat que les boutons) ; le favicon garde le violet #4f46e5.

### D-063 — Relais SMTP commun au domaine

- Bloc facultatif `smtp.auth` par domaine : `username` et un secret (`password_file` ou
  `password_env`, jamais en clair). Sans ce bloc, comportement inchangé (identifiants de la
  boîte, `login_format`).
- L'enveloppe et l'en-tête `From` restent l'adresse de l'utilisateur connecté : le relais ne
  donne aucun moyen de choisir l'expéditeur.
- Secret relu à chaque envoi (API et moteur de règles) ; illisible → envoi refusé
  (`503 smtp_unavailable`), jamais d'identifiants de repli.
- Un `EAUTH` du relais n'est pas une erreur de l'utilisateur : `503 smtp_unavailable` et
  journal d'erreur, au lieu de `401 smtp_auth_failed` (réservé aux identifiants de la boîte).
- `PLUME_SMTP_RELAY_PASSWORD` transmis à `api` et `worker` par Compose (vide par défaut).

### D-064 — Corps du mail à la hauteur de son contenu ; pas de zone vide

- Problème : l'iframe du corps avait une hauteur fixe (360 px) ; le mail défilait dans une
  petite fenêtre, elle-même dans un panneau défilant. Sans `allow-same-origin`, l'interface ne
  peut pas lire la hauteur du document.
- Solution : un **unique script de mesure**, écrit par Plume (`BODY_HEIGHT_SCRIPT`), placé dans
  `<head>` avant tout contenu du mail, envoie la hauteur à l'interface par `postMessage`
  (`{type:'plume:body-height', height}`). L'iframe reçoit `allow-scripts` mais **toujours pas**
  `allow-same-origin` : origine opaque, ni cookies, ni stockage, ni accès à l'interface. La CSP
  du document n'autorise que ce script par son empreinte (`script-src 'sha256-…'`, sans
  `unsafe-inline` ni `unsafe-hashes`) : un script ou un gestionnaire d'événement qui
  échapperait au nettoyage serait bloqué par le navigateur, en plus de DOMPurify.
  L'interface n'accepte que des nombres, venant de cette iframe (`event.source`), bornés à
  200 000 px.
- Les unités relatives à la hauteur de la fenêtre (`vh`, `vmin`, `vmax`, `dvh`…) sont
  remplacées par `auto` dans le CSS des mails : l'iframe prenant la hauteur du contenu,
  `100vh` la ferait grandir sans fin. `body` en `flow-root` pour compter les flottants.
- Zone vide sous la page : des éléments en `position: absolute` (champs radio masqués des
  paramètres, textes réservés aux lecteurs d'écran) se plaçaient par rapport à la page et non
  à leur panneau défilant, allongeant le document. Les conteneurs défilants sont désormais
  positionnés (`position: relative`). Vérifié en E2E (hauteur du document = hauteur de
  l'écran, bureau et mobile).
- Mails qui fixent `html, body { height: 100%; overflow: auto }` (courant dans les
  newsletters) : le contenu défilait dans le `body`, invisible pour la mesure. Une feuille
  ajoutée après celles du mail impose `height: auto` et interdit le défilement vertical de
  `html`/`body` (`!important`, spécificité d'identifiant via `:is(body, #plume-id)`).

### D-065 — Comptes autorisés par domaine

- Option `accounts` d'une entrée de `domains` : parties locales (`sacha`) ou adresses
  complètes (`alice@exemple.com`, obligatoirement du domaine de l'entrée), normalisées au
  chargement. Absente : tout le domaine (comportement antérieur). Liste vide refusée (ambiguë).
- Contrôle par `matchAccount` partout où le domaine l'était : connexion et ajout de compte
  (avant toute connexion IMAP, même réponse qu'un mauvais mot de passe), chaque requête d'une
  session (compte actif et comptes secondaires), accès IMAP/SMTP de l'API, moteur de règles.
- Rechargement à chaud : `enforceWhitelist` suspend aussi les comptes retirés de la liste
  (audit `account_suspended`, motif `account_not_allowed`) et révoque leurs sessions.

### D-066 — Indésirables ; déplacer le message ouvert

- **Signaler comme indésirable** (`POST /messages/:id/junk`) : déplacement vers le dossier
  d'usage spécial `\Junk`, créé sous le nom `Junk` s'il n'existe pas ; même réponse (et même
  « Annuler ») que l'archivage. Dans ce dossier, le bouton devient « Pas un indésirable » et
  remet le message dans la boîte de réception. L'apprentissage éventuel est celui du serveur
  (IMAPSieve, rspamd…) déclenché par le déplacement ; Plume n'analyse pas les messages.
- **Message ouvert** : sous 1 100 px de large, l'ouverture d'un message masque la liste ; son
  titre se glisse alors vers un dossier ou un libellé (mêmes données que la ligne de liste).

### D-067 — Brouillons

- Fermer une fenêtre de rédaction **modifiée** (destinataires, objet, corps ou pièces jointes
  différents de l'état d'ouverture) demande « Enregistrer le brouillon / Supprimer / Continuer
  la rédaction » ; une fenêtre intacte se ferme sans question. Le reste de la fenêtre est
  inerte pendant la question. Un bouton « Enregistrer le brouillon » existe aussi en pied.
- La même question est posée quand une autre rédaction s'ouvre par-dessus (« Nouveau message »,
  « Répondre »…) ; la nouvelle fenêtre ne s'ouvre qu'après. Fermer l'onglet ou recharger la
  page avec une rédaction modifiée déclenche l'avertissement du navigateur (`beforeunload`).
- Stockage **IMAP**, dans le dossier d'usage spécial `\Drafts` (créé sous `Drafts` au besoin),
  drapeaux `\Draft \Seen` : les brouillons restent visibles des autres clients. Aucun stockage
  côté Plume. `POST /messages/drafts` n'exige aucun destinataire ; il conserve le Cci (jamais
  présent dans un message envoyé) et remplace l'ancienne version (`replaces`), qui doit être
  un message `\Draft` du dossier Brouillons (sinon 400 `not_a_draft`).
- **Reprise** : `GET /messages/:id/draft` renvoie le corps nettoyé (`sanitizeOutgoingHtml`) ;
  les pièces jointes sont rechargées, la signature n'est pas rajoutée. L'envoi passe
  `draftId` : le brouillon est supprimé après l'envoi (au mieux, un échec n'annule pas
  l'envoi) et une réponse reprise garde ses en-têtes de fil (`In-Reply-To`, `References`).

### D-068 — Recherche

- Recherche **côté serveur IMAP** (`SEARCH TEXT`), dans le dossier affiché (rappelé dans le champ :
  « Rechercher dans « Archives » »). Plume n'indexe rien lui-même.
- `SEARCH TEXT` cherche une sous-chaîne : « jean budget » ne trouvait que ces deux mots côte à côte.
  La requête est donc découpée en termes (8 au plus), une « expression entre guillemets » restant
  d'un seul tenant ; chaque terme restreint les résultats du précédent (tous doivent figurer).
- Casse et accents : selon le serveur. Dovecot ignore la casse et trouve les mots accentués tapés
  avec leurs accents ; un mot tapé sans accent (« reunion ») n'est pas garanti de trouver sa forme
  accentuée. GreenMail (tests) ne trouve pas les mots accentués des objets encodés.
- Le champ suit la recherche active (changement de dossier, retour arrière) et le vider rétablit
  la liste sans attendre Entrée.
