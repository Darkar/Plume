import { loginFor, serverFor, verifyImapLogin } from '@plume/mail';
import { RULES_CHANGED_CHANNEL } from '@plume/shared';
import { seedMailbox, startGreenMail, type StartedGreenMail } from '@plume/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  client,
  createTestApp,
  login,
  resetInfra,
  startInfra,
  testConfig,
  type Client,
  type Infra,
  type TestApp,
} from './support/harness.js';

const SACHA = { email: 'sacha@exemple.com', password: 'imap-sacha' };
const ALICE = { email: 'alice@exemple.com', password: 'imap-alice' };

let infra: Infra;
let gm: StartedGreenMail;
let t: TestApp;
let sacha: Client;
let alice: Client;

const invoiceRule = {
  name: 'Factures fournisseurs',
  conditions: [
    { field: 'from', op: 'ends_with', value: '@nimbus.example' },
    { field: 'subject', op: 'contains', value: 'facture' },
  ],
  actions: [{ type: 'add_label', label: 'Factures' }, { type: 'mark_read' }],
  stop_processing: true,
};

beforeAll(async () => {
  [infra, gm] = await Promise.all([startInfra(), startGreenMail([SACHA, ALICE])]);
  await resetInfra(infra);
  await seedMailbox(gm, SACHA, [
    { subject: 'Facture 1', from: 'Nimbus <f@nimbus.example>', text: 'x' },
    { subject: 'Facture 2', from: 'Autre <f@autre.example>', text: 'x' },
    { subject: 'Bonjour', from: 'Nimbus <f@nimbus.example>', text: 'x' },
  ]);
  const config = testConfig((raw) => {
    raw.domains[0].imap = { host: gm.host, port: gm.imapsPort, security: 'tls' };
    raw.domains[0].tls = { reject_unauthorized: false };
    raw.rules.max_rules_per_user = 5;
  });
  t = await createTestApp(infra, {
    config,
    verifyLogin: (domain, email, password) =>
      verifyImapLogin(serverFor(domain, 'imap'), loginFor(domain, email), password),
  });
  sacha = client(t.app);
  alice = client(t.app);
  await login(sacha, SACHA.email, SACHA.password);
  await login(alice, ALICE.email, ALICE.password);
});

afterAll(async () => {
  await t?.app.close();
  await Promise.all([infra?.stop(), gm?.stop()]);
});

beforeEach(async () => {
  await infra.db.pool.query('DELETE FROM rules');
});

describe('CRUD', () => {
  it('crée, lit, modifie et supprime une règle ; prévient le worker', async () => {
    const sub = infra.redis.duplicate();
    const messages: string[] = [];
    await sub.subscribe(RULES_CHANGED_CHANNEL);
    sub.on('message', (_c, m: string) => messages.push(m));

    const created = await sacha.request('POST', '/api/v1/rules', invoiceRule);
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    expect(created.json()).toMatchObject({
      name: 'Factures fournisseurs',
      enabled: true,
      position: 0,
    });

    const list = (await sacha.request('GET', '/api/v1/rules')).json();
    expect(list.rules).toHaveLength(1);
    expect(list.limits).toMatchObject({ enabled: true, maxRules: 5 });

    const patched = await sacha.request('PATCH', `/api/v1/rules/${id}`, { enabled: false });
    expect(patched.json().enabled).toBe(false);

    expect((await sacha.request('DELETE', `/api/v1/rules/${id}`)).statusCode).toBe(204);
    expect((await sacha.request('GET', '/api/v1/rules')).json().rules).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.length).toBeGreaterThanOrEqual(3);
    sub.disconnect();
  });

  it.each([
    [
      { ...invoiceRule, conditions: [{ field: 'subject', op: 'matches', value: '(a)\\1' }] },
      'invalid_pattern',
    ],
    [
      { ...invoiceRule, actions: [{ type: 'forward', to: 'x@evil.example' }] },
      'forward_destination_not_allowed',
    ],
    [{ ...invoiceRule, actions: [{ type: 'archive' }, { type: 'delete' }] }, 'conflicting_actions'],
    [
      { ...invoiceRule, conditions: [{ field: 'header:cookie', op: 'contains', value: 'x' }] },
      undefined,
    ],
    [{ ...invoiceRule, actions: [{ type: 'exec', cmd: 'rm -rf /' }] }, undefined],
  ])('refuse une règle invalide (%#)', async (body, code) => {
    const res = await sacha.request('POST', '/api/v1/rules', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_rule');
    if (code) expect(JSON.stringify(res.json().issues)).toContain(code);
  });

  it('limite le nombre de règles par utilisateur', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await sacha.request('POST', '/api/v1/rules', invoiceRule)).statusCode).toBe(201);
    }
    expect((await sacha.request('POST', '/api/v1/rules', invoiceRule)).statusCode).toBe(409);
  });

  it('réordonne ; refuse un ordre incomplet ou étranger', async () => {
    const a = (await sacha.request('POST', '/api/v1/rules', { ...invoiceRule, name: 'A' })).json()
      .id;
    const b = (await sacha.request('POST', '/api/v1/rules', { ...invoiceRule, name: 'B' })).json()
      .id;
    const res = await sacha.request('POST', '/api/v1/rules/reorder', { ids: [b, a] });
    expect(res.json().rules.map((r: { name: string }) => r.name)).toEqual(['B', 'A']);
    expect((await sacha.request('POST', '/api/v1/rules/reorder', { ids: [a] })).statusCode).toBe(
      400,
    );
    expect((await alice.request('POST', '/api/v1/rules/reorder', { ids: [a, b] })).statusCode).toBe(
      400,
    );
  });
});

describe('contrôle d’accès', () => {
  it('les règles d’un utilisateur sont invisibles et intouchables pour un autre', async () => {
    const id = (await sacha.request('POST', '/api/v1/rules', invoiceRule)).json().id;
    expect((await alice.request('GET', '/api/v1/rules')).json().rules).toEqual([]);
    expect(
      (await alice.request('PATCH', `/api/v1/rules/${id}`, { enabled: false })).statusCode,
    ).toBe(404);
    expect((await alice.request('DELETE', `/api/v1/rules/${id}`)).statusCode).toBe(404);
    expect((await alice.request('POST', `/api/v1/rules/${id}/test`)).statusCode).toBe(404);
    expect((await alice.request('POST', `/api/v1/rules/${id}/apply`)).statusCode).toBe(404);
    expect((await sacha.request('GET', '/api/v1/rules')).json().rules[0].enabled).toBe(true);
  });

  it('une tâche d’application n’est consultable que par son propriétaire', async () => {
    const id = (await sacha.request('POST', '/api/v1/rules', invoiceRule)).json().id;
    const applied = await sacha.request('POST', `/api/v1/rules/${id}/apply`);
    const { jobId } = applied.json();
    expect(jobId).toMatch(/^apply-/);
    expect((await sacha.request('GET', `/api/v1/rules/jobs/${jobId}`)).statusCode).toBe(200);
    expect((await alice.request('GET', `/api/v1/rules/jobs/${jobId}`)).statusCode).toBe(404);
  });

  it('exige une session et le jeton CSRF', async () => {
    expect((await client(t.app).request('GET', '/api/v1/rules')).statusCode).toBe(401);
    const res = await sacha.request('POST', '/api/v1/rules', invoiceRule, {
      'x-csrf-token': 'faux',
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('test à blanc', () => {
  it('liste les messages correspondants sans rien modifier', async () => {
    const res = await sacha.request('POST', '/api/v1/rules/test', invoiceRule);
    expect(res.statusCode).toBe(200);
    expect(res.json().tested).toBe(3);
    expect(res.json().matches.map((m: { subject: string }) => m.subject)).toEqual(['Facture 1']);
    const list = (await sacha.request('GET', '/api/v1/messages')).json().messages;
    expect(
      list.every((m: { seen: boolean; keywords: string[] }) => !m.seen && m.keywords.length === 0),
    ).toBe(true);
  });
});

describe('import / export', () => {
  it('exporte puis réimporte (remplacement)', async () => {
    await sacha.request('POST', '/api/v1/rules', invoiceRule);
    const exported = await sacha.request('GET', '/api/v1/rules/export');
    expect(exported.headers['content-disposition']).toContain('plume-regles.json');
    const file = exported.json();
    expect(file.version).toBe(1);
    const res = await sacha.request('POST', '/api/v1/rules/import', { ...file, mode: 'replace' });
    expect(res.json()).toEqual({ imported: 1 });
    expect((await sacha.request('GET', '/api/v1/rules')).json().rules).toHaveLength(1);
  });

  it('refuse un fichier invalide ou un transfert interdit, sans rien importer', async () => {
    const bad = await sacha.request('POST', '/api/v1/rules/import', {
      version: 1,
      rules: [
        invoiceRule,
        { ...invoiceRule, actions: [{ type: 'forward', to: 'x@evil.example' }] },
      ],
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (await sacha.request('POST', '/api/v1/rules/import', { version: 2, rules: [] })).statusCode,
    ).toBe(400);
    expect((await sacha.request('GET', '/api/v1/rules')).json().rules).toHaveLength(0);
  });

  it('respecte la limite de règles à l’import', async () => {
    const res = await sacha.request('POST', '/api/v1/rules/import', {
      version: 1,
      rules: Array(6).fill(invoiceRule),
    });
    expect(res.statusCode).toBe(409);
  });
});
