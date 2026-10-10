# Sécurité de Plume

## Signaler une vulnérabilité

Merci de **ne pas** ouvrir de ticket public. Utilisez le signalement privé de GitHub
(onglet _Security_ → _Report a vulnerability_) du dépôt. Indiquez :

- la version (commit) concernée et la configuration utile (sans secret) ;
- les étapes de reproduction et l'impact estimé ;
- si possible, une proposition de correctif.

Nous accusons réception sous 72 h et visons un correctif sous 30 jours pour une vulnérabilité
élevée ou critique. Le signalement est crédité dans les notes de version si vous le souhaitez.

## Modèle de menaces (STRIDE)

### Actifs

- Mots de passe IMAP (en transit à la connexion ; chiffrés au repos pour le moteur de règles).
- Contenu des mails (jamais stocké durablement par Plume : le serveur IMAP fait foi).
- Sessions, jetons CSRF, secrets TOTP et codes de secours.
- Règles et préférences des utilisateurs, journal d'audit.
- Clé maître et mots de passe internes (volume Docker `plume_secrets`).
- Sauvegardes de la base (volume `pg_backups`, copies hors machine).

### Frontières de confiance

1. Navigateur ↔ Caddy (Internet, HTTPS).
2. Caddy ↔ API (réseau Docker `edge`).
3. API / worker ↔ PostgreSQL / Redis (réseau Docker `internal`, sans accès extérieur).
4. API / worker ↔ serveurs IMAP / SMTP (Internet, TLS obligatoire, hôtes fixés par l'administrateur).
5. Contenu des mails (données **non fiables** par nature : HTML, pièces jointes, en-têtes).

| Menace                     | Exemples                                                                                    | Contre-mesures                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S**poofing (usurpation)  | Vol de session, fixation de session, force brute                                            | Cookie `__Host-` `HttpOnly` `Secure` `SameSite=Strict`, identifiant de 256 bits régénéré à la connexion, limitation de débit par IP et par compte avec verrouillage, TOTP facultatif, message d'erreur unique                 |
| **T**ampering (altération) | CSRF, injection d'en-têtes SMTP, modification des identifiants chiffrés                     | Jeton CSRF synchronisé, en-têtes construits uniquement par Nodemailer, AES-256-GCM (tag d'authentification), requêtes SQL paramétrées (Drizzle)                                                                               |
| **R**epudiation            | Contestation d'une action                                                                   | Journal d'audit (connexion, échec, déconnexion, règles, sécurité) sans données sensibles                                                                                                                                      |
| **I**nformation disclosure | XSS dans un mail, fuite de secrets dans les journaux, SSRF, énumération de la liste blanche | DOMPurify côté serveur + `iframe sandbox` sans scripts + CSP stricte, masquage automatique des champs sensibles dans les journaux, proxy d'images anti-SSRF, erreurs génériques, liste blanche vérifiée avant toute connexion |
| **D**enial of service      | Bombe YAML, ReDoS dans une règle, pièces jointes énormes                                    | Limites de taille (corps, pièces jointes), alias YAML plafonnés, expressions régulières RE2 (temps linéaire) avec longueur maximale, limites mémoire / CPU / PID des conteneurs                                               |
| **E**levation of privilege | IDOR, évasion de conteneur, SSRF vers les métadonnées cloud                                 | Contrôle d'accès systématique par utilisateur (testé sur chaque route), conteneurs non-root en lecture seule sans capacités, hôtes IMAP/SMTP jamais choisis par l'utilisateur                                                 |

### Surfaces particulières

| Surface                       | Risque                                                                                        | Contre-mesures                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corps HTML des mails          | XSS, pistage, exfiltration par CSS                                                            | Nettoyage serveur (DOMPurify, CSS filtré), document autonome dans une iframe sans même origine (origine opaque), seul script autorisé par empreinte CSP : la mesure de hauteur (D-064), CSP propre, images distantes bloquées par défaut puis servies par un proxy signé anti-SSRF                |
| Aperçu PDF                    | Exploitation de pdf.js, accès à la session                                                    | Visionneuse dans une iframe `sandbox="allow-scripts"` **sans** `allow-same-origin` (origine opaque : ni cookies ni stockage), octets transmis par `postMessage`, CSP dédiée sans aucune connexion réseau                                                                                          |
| Pièces jointes                | Exécution dans l'origine de l'application                                                     | Téléchargement forcé sauf PDF et images, `Content-Disposition` nettoyé, CSP `sandbox` sur toute réponse d'aperçu, `nosniff`, URL signées et limitées dans le temps                                                                                                                                |
| Signature                     | XSS stocké (affiché dans les paramètres, inséré dans les mails envoyés)                       | Nettoyage serveur à l'enregistrement, relu par l'éditeur ; corpus XSS complet testé de bout en bout (paramètres, rédaction, réception)                                                                                                                                                            |
| Photo de profil               | Fichier polyglotte, bombe de décompression, fuite de métadonnées (GPS)                        | Taille d'entrée plafonnée, nombre de pixels limité, décodage puis réencodage par sharp en WebP 256 × 256 sans aucune métadonnée, servie uniquement à son propriétaire                                                                                                                             |
| Moteur de règles              | ReDoS, transfert vers l'extérieur, boucles de réponses automatiques                           | RE2 (temps linéaire), budget de temps par message, transferts limités aux domaines autorisés, `Auto-Submitted` et une réponse automatique par expéditeur et par période                                                                                                                           |
| Invitations (iCalendar)       | XSS par le contenu de l'invitation, déni de service à l'analyse, usurpation de l'organisateur | Analyse côté serveur (ical.js) d'au plus 256 Kio, texte brut uniquement (aucun HTML interprété), 100 participants exposés au plus ; réponse construite à partir de l'invitation relue sur le serveur IMAP, envoyée seulement à l'organisateur indiqué, avertissement s'il diffère de l'expéditeur |
| Résumé quotidien, reports     | Envoi en masse, réveil de messages d'un autre utilisateur                                     | Résumé envoyé uniquement à l'utilisateur lui-même (réclamation atomique avant envoi, `Auto-Submitted`), reports liés à l'utilisateur en base et vérifiés à chaque accès                                                                                                                           |
| Plusieurs comptes par session | Contournement des contrôles de connexion, fixation, compte révoqué resté ouvert               | Ajout soumis aux mêmes contrôles qu'une connexion (liste blanche, limites, TOTP du compte ajouté), nouvel identifiant de session à chaque ajout ou bascule, session indexée sous chaque compte (révocation globale), audit                                                                        |
| Secrets et sauvegardes        | Lecture de la clé maître par un autre conteneur, sauvegarde volée                             | Un sous-dossier de secrets par conteneur, en lecture seule ; sauvegardes sans la clé maître (identifiants illisibles), en `0600` ; rotation de la clé testée en CI                                                                                                                                |

### Hypothèses

- L'hôte Docker et son administrateur sont de confiance.
- Les serveurs IMAP/SMTP configurés sont de confiance pour l'authentification, mais **pas** pour le
  contenu des messages.
- Le fichier `config/plume.yaml` n'est modifiable que par l'administrateur.

## Durcissement en place

- En-têtes HTTP : CSP stricte, HSTS (2 ans, `preload`), `nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy` restrictive, `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options`.
- Conteneurs : non-root, système de fichiers en lecture seule, `cap_drop: ALL`,
  `no-new-privileges`, limites de ressources, images épinglées par empreinte.
- CI de sécurité : Semgrep, ESLint `security`, `pnpm audit`, OSV-Scanner, Trivy (images et
  configuration), Gitleaks, Hadolint, OWASP ZAP (scan de base de l'interface et scan authentifié
  de toute l'API décrite par `docs/openapi.json`, bloquants sur toute alerte de niveau élevé).
  Voir `.github/workflows/security.yml`.

## Gestion des secrets

- Générés au premier démarrage par le service `secrets` (UID 10001, sans réseau) dans le volume
  Docker `plume_secrets`, jamais sur l'hôte ni dans le dépôt ; jamais régénérés ensuite.
- Chaque conteneur ne reçoit que son sous-dossier, en lecture seule sur `/run/secrets/…` : `api`
  et `worker` la clé maître et les URL, `postgres` son mot de passe, `redis` son fichier ACL. Le
  YAML ne contient que des références.
- Aucun secret dans les journaux, les messages d'erreur ou les réponses de l'API.

## Rotation de la clé maître

La clé maître (32 octets aléatoires, encodés en base64) chiffre les mots de passe IMAP conservés
pour le moteur de règles. Chaque entrée est chiffrée avec une clé dérivée par utilisateur (HKDF).

Procédure (détaillée dans [OPERATIONS.md](OPERATIONS.md#rotation-de-la-clé-maître)) :

1. `docker compose stop worker`
2. `docker compose run --rm admin rotate-key --secrets-dir /var/lib/plume/secrets` : génère la
   nouvelle clé à côté de l'actuelle, rechiffre toutes les entrées dans une seule transaction
   (en cas d'échec, rien n'est modifié et une nouvelle exécution reprend avec la même clé), puis
   la met en place ; l'ancienne est conservée en `plume_master_key.previous`.
3. `docker compose restart api worker`
4. Une fois le fonctionnement vérifié, supprimer l'ancienne clé :
   `docker compose run --rm --entrypoint rm admin /var/lib/plume/secrets/app/plume_master_key.previous`.

La procédure est exécutée par la CI sur la pile de bout en bout
(`scripts/check-key-rotation.sh`) : le worker doit relire les identifiants rechiffrés, puis le
test des règles est rejoué.

En cas de compromission de la clé maître, effectuer la rotation **et** demander aux utilisateurs de
changer leur mot de passe IMAP (ou leur mot de passe d'application).
