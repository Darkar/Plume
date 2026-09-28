import { ruleSchema } from '@plume/rules';
import { z } from 'zod';
import { SESSION_COOKIE } from './plugins/session.js';
import { avatarBody, flagsBody, moveBody, sendBody, snoozeBody } from './routes/actions.js';
import { accountBody, loginBody, totpBody } from './routes/auth.js';
import { attachmentQuery, bodyQuery, labelParam, listQuery, proxyQuery } from './routes/mail.js';
import { codeBody } from './routes/me.js';
import { importBody, reorderBody } from './routes/rules.js';
import { preferencesPatch } from './services/preferences.js';

/**
 * Description OpenAPI 3.1 de l'API, produite à partir des schémas Zod qui valident réellement
 * les requêtes (aucune description parallèle à maintenir). Générée par `plume openapi` dans
 * docs/openapi.json ; un test vérifie que chaque route enregistrée y figure et que le fichier
 * est à jour. Elle n'est pas servie par l'application (surface d'attaque inutile).
 */

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
type Auth = 'none' | 'session' | 'enroll';

export interface RouteDoc {
  method: Method;
  path: string;
  summary: string;
  tag: string;
  auth: Auth;
  body?: z.ZodType;
  query?: z.ZodObject;
  /** Réponse principale (code et type de contenu). */
  success?: { status: number; contentType?: string };
}

const uuid = z.uuid();
const messageId = z.string().max(1500).describe('Identifiant opaque de message');

export const API_ROUTES: RouteDoc[] = [
  // Authentification
  {
    method: 'post',
    path: '/auth/login',
    tag: 'auth',
    auth: 'none',
    summary: 'Connexion (identifiants IMAP)',
    body: loginBody,
  },
  {
    method: 'post',
    path: '/auth/totp/verify',
    tag: 'auth',
    auth: 'none',
    summary: 'Second facteur TOTP ou code de secours',
    body: totpBody,
  },
  {
    method: 'get',
    path: '/auth/session',
    tag: 'auth',
    auth: 'none',
    summary: 'État de la session',
  },
  {
    method: 'post',
    path: '/auth/logout',
    tag: 'auth',
    auth: 'session',
    summary: 'Déconnexion',
    success: { status: 204 },
  },
  {
    method: 'post',
    path: '/auth/logout-all',
    tag: 'auth',
    auth: 'session',
    summary: 'Déconnexion de toutes les sessions',
    success: { status: 204 },
  },
  {
    method: 'post',
    path: '/auth/accounts',
    tag: 'auth',
    auth: 'session',
    summary: 'Ajoute un compte à la session (mêmes contrôles qu’une connexion)',
    body: loginBody,
  },
  {
    method: 'post',
    path: '/auth/accounts/totp',
    tag: 'auth',
    auth: 'session',
    summary: 'Second facteur du compte en cours d’ajout',
    body: totpBody,
  },
  {
    method: 'post',
    path: '/auth/accounts/cancel',
    tag: 'auth',
    auth: 'session',
    summary: 'Abandonne l’ajout d’un compte',
    success: { status: 204 },
  },
  {
    method: 'post',
    path: '/auth/accounts/remove',
    tag: 'auth',
    auth: 'session',
    summary: 'Ferme un compte de la session',
    body: accountBody,
  },
  {
    method: 'post',
    path: '/auth/switch',
    tag: 'auth',
    auth: 'session',
    summary: 'Bascule vers un autre compte de la session',
    body: accountBody,
  },
  // Compte
  { method: 'get', path: '/me', tag: 'me', auth: 'enroll', summary: 'Utilisateur courant' },
  {
    method: 'post',
    path: '/me/totp/setup',
    tag: 'me',
    auth: 'enroll',
    summary: 'Prépare l’activation TOTP',
  },
  {
    method: 'post',
    path: '/me/totp/enable',
    tag: 'me',
    auth: 'enroll',
    summary: 'Active TOTP',
    body: codeBody,
  },
  {
    method: 'post',
    path: '/me/totp/disable',
    tag: 'me',
    auth: 'session',
    summary: 'Désactive TOTP',
    body: codeBody,
    success: { status: 204 },
  },
  {
    method: 'post',
    path: '/me/totp/backup-codes',
    tag: 'me',
    auth: 'session',
    summary: 'Régénère les codes de secours',
    body: codeBody,
  },
  { method: 'get', path: '/me/preferences', tag: 'me', auth: 'session', summary: 'Préférences' },
  {
    method: 'patch',
    path: '/me/preferences',
    tag: 'me',
    auth: 'session',
    summary: 'Modifie les préférences (champs fournis uniquement)',
    body: preferencesPatch,
  },
  {
    method: 'get',
    path: '/me/avatar',
    tag: 'me',
    auth: 'session',
    summary: 'Photo de profil',
    success: { status: 200, contentType: 'image/webp' },
  },
  {
    method: 'put',
    path: '/me/avatar',
    tag: 'me',
    auth: 'session',
    summary: 'Remplace la photo (réencodée, sans métadonnées)',
    body: avatarBody,
    success: { status: 204 },
  },
  {
    method: 'delete',
    path: '/me/avatar',
    tag: 'me',
    auth: 'session',
    summary: 'Supprime la photo',
    success: { status: 204 },
  },
  // Messagerie
  {
    method: 'get',
    path: '/folders',
    tag: 'mail',
    auth: 'session',
    summary: 'Dossiers et compteurs',
  },
  { method: 'get', path: '/labels', tag: 'mail', auth: 'session', summary: 'Libellés' },
  {
    method: 'delete',
    path: '/labels/{name}',
    tag: 'mail',
    auth: 'session',
    summary: 'Supprime un libellé (retiré de tous les messages)',
  },
  {
    method: 'get',
    path: '/messages',
    tag: 'mail',
    auth: 'session',
    summary: 'Liste paginée des messages',
    query: listQuery,
  },
  {
    method: 'get',
    path: '/messages/{id}',
    tag: 'mail',
    auth: 'session',
    summary: 'Message (en-têtes, pièces jointes)',
  },
  {
    method: 'get',
    path: '/messages/{id}/quote',
    tag: 'mail',
    auth: 'session',
    summary: 'Citation pour répondre ou transférer',
  },
  {
    method: 'get',
    path: '/messages/{id}/body',
    tag: 'mail',
    auth: 'session',
    summary: 'Corps HTML assaini (document pour iframe isolée)',
    query: bodyQuery,
    success: { status: 200, contentType: 'text/html' },
  },
  {
    method: 'get',
    path: '/attachments/{id}',
    tag: 'mail',
    auth: 'session',
    summary: 'Pièce jointe (URL signée)',
    query: attachmentQuery,
    success: { status: 200, contentType: 'application/octet-stream' },
  },
  {
    method: 'get',
    path: '/image-proxy',
    tag: 'mail',
    auth: 'session',
    summary: 'Image distante via le proxy (URL signée)',
    query: proxyQuery,
    success: { status: 200, contentType: 'image/*' },
  },
  {
    method: 'patch',
    path: '/messages/{id}',
    tag: 'mail',
    auth: 'session',
    summary: 'Lu, suivi, libellés',
    body: flagsBody,
    success: { status: 204 },
  },
  {
    method: 'post',
    path: '/messages/{id}/move',
    tag: 'mail',
    auth: 'session',
    summary: 'Déplace le message',
    body: moveBody,
  },
  {
    method: 'post',
    path: '/messages/{id}/archive',
    tag: 'mail',
    auth: 'session',
    summary: 'Archive le message',
  },
  {
    method: 'post',
    path: '/messages/{id}/junk',
    tag: 'mail',
    auth: 'session',
    summary: 'Signale le message comme indésirable (dossier Junk)',
  },
  {
    method: 'delete',
    path: '/messages/{id}',
    tag: 'mail',
    auth: 'session',
    summary: 'Met le message à la corbeille (ou le supprime)',
  },
  {
    method: 'post',
    path: '/messages/{id}/snooze',
    tag: 'mail',
    auth: 'session',
    summary: 'Reporte le message',
    body: snoozeBody,
  },
  { method: 'get', path: '/snoozes', tag: 'mail', auth: 'session', summary: 'Reports en cours' },
  {
    method: 'delete',
    path: '/snoozes/{id}',
    tag: 'mail',
    auth: 'session',
    summary: 'Annule un report',
    success: { status: 204 },
  },
  {
    method: 'post',
    path: '/messages/send',
    tag: 'mail',
    auth: 'session',
    summary: 'Envoie un message',
    body: sendBody,
  },
  {
    method: 'get',
    path: '/events',
    tag: 'mail',
    auth: 'session',
    summary: 'Flux d’événements (Server-Sent Events)',
    success: { status: 200, contentType: 'text/event-stream' },
  },
  // Règles
  { method: 'get', path: '/rules', tag: 'rules', auth: 'session', summary: 'Règles et limites' },
  {
    method: 'post',
    path: '/rules',
    tag: 'rules',
    auth: 'session',
    summary: 'Crée une règle',
    body: ruleSchema,
    success: { status: 201 },
  },
  {
    method: 'patch',
    path: '/rules/{id}',
    tag: 'rules',
    auth: 'session',
    summary: 'Modifie une règle',
    body: ruleSchema.partial(),
  },
  {
    method: 'delete',
    path: '/rules/{id}',
    tag: 'rules',
    auth: 'session',
    summary: 'Supprime une règle',
    success: { status: 204 },
  },
  {
    method: 'post',
    path: '/rules/reorder',
    tag: 'rules',
    auth: 'session',
    summary: 'Réordonne les règles',
    body: reorderBody,
  },
  {
    method: 'post',
    path: '/rules/test',
    tag: 'rules',
    auth: 'session',
    summary: 'Test à blanc d’une règle non enregistrée',
    body: ruleSchema,
  },
  {
    method: 'post',
    path: '/rules/{id}/test',
    tag: 'rules',
    auth: 'session',
    summary: 'Test à blanc d’une règle',
  },
  {
    method: 'post',
    path: '/rules/{id}/apply',
    tag: 'rules',
    auth: 'session',
    summary: 'Applique une règle aux messages existants',
    success: { status: 202 },
  },
  {
    method: 'get',
    path: '/rules/jobs/{jobId}',
    tag: 'rules',
    auth: 'session',
    summary: 'Avancement d’une application',
  },
  {
    method: 'get',
    path: '/rules/export',
    tag: 'rules',
    auth: 'session',
    summary: 'Exporte les règles (JSON)',
  },
  {
    method: 'post',
    path: '/rules/import',
    tag: 'rules',
    auth: 'session',
    summary: 'Importe des règles',
    body: importBody,
  },
];

const PATH_PARAMS: Record<string, z.ZodType> = {
  id: uuid,
  jobId: z.string().regex(/^apply-[0-9a-f-]{36}-[0-9a-f-]{36}-\d+$/),
  name: labelParam.shape.name,
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  return rest;
}

function parameters(route: RouteDoc) {
  const params: Record<string, unknown>[] = [];
  for (const [, name] of route.path.matchAll(/\{(\w+)\}/g)) {
    const schema =
      route.path.startsWith('/messages/') && name === 'id' ? messageId : PATH_PARAMS[name!];
    params.push({ name, in: 'path', required: true, schema: jsonSchema(schema ?? z.string()) });
  }
  if (route.query) {
    const query = jsonSchema(route.query) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    for (const [name, schema] of Object.entries(query.properties ?? {})) {
      params.push({ name, in: 'query', required: query.required?.includes(name) ?? false, schema });
    }
  }
  return params;
}

function operation(route: RouteDoc) {
  const success = route.success ?? { status: 200 };
  const unsafe = route.method !== 'get';
  const op: Record<string, unknown> = {
    operationId: `${route.method}${route.path.replace(/[{}]/g, '').replace(/[/-](\w)/g, (_m, c: string) => c.toUpperCase())}`,
    summary: route.summary,
    tags: [route.tag],
    security: route.auth === 'none' ? [] : [unsafe ? { session: [], csrf: [] } : { session: [] }],
    responses: {
      [String(success.status)]:
        success.status === 204
          ? { description: 'Succès, sans contenu' }
          : {
              description: 'Succès',
              content: { [success.contentType ?? 'application/json']: {} },
            },
      '400': { $ref: '#/components/responses/Error' },
      ...(route.auth === 'none' ? {} : { '401': { $ref: '#/components/responses/Error' } }),
      ...(unsafe && route.auth !== 'none'
        ? { '403': { $ref: '#/components/responses/Error' } }
        : {}),
      '429': { $ref: '#/components/responses/Error' },
    },
  };
  const params = parameters(route);
  if (params.length > 0) op.parameters = params;
  if (route.body) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: jsonSchema(route.body) } },
    };
  }
  return op;
}

export function buildOpenApi(version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of API_ROUTES) {
    (paths[route.path] ??= {})[route.method] = operation(route);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Plume',
      version,
      description:
        'API REST de Plume. Toutes les requêtes et réponses sont en JSON (sauf mention). ' +
        'Les requêtes qui modifient un état exigent la session et l’en-tête X-CSRF-Token ' +
        '(jeton renvoyé par /auth/login et /auth/session), ainsi qu’un en-tête Origin identique ' +
        'à l’URL publique.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'auth', description: 'Authentification' },
      { name: 'me', description: 'Compte et préférences' },
      { name: 'mail', description: 'Messagerie' },
      { name: 'rules', description: 'Moteur de règles' },
    ],
    paths,
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
        csrf: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' },
      },
      responses: {
        Error: {
          description: 'Erreur (code stable, sans détail interne)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { error: { type: 'string' } },
                required: ['error'],
              },
            },
          },
        },
      },
    },
  };
}
