import { startGreenMail, type StartedGreenMail } from '@plume/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyImapLogin } from '../src/imap.js';
import type { ServerTarget } from '../src/server.js';

let gm: StartedGreenMail;
let target: ServerTarget;

beforeAll(async () => {
  gm = await startGreenMail([{ email: 'sacha@exemple.com', password: 'bon-mot-de-passe' }]);
  target = {
    host: gm.host,
    port: gm.imapsPort,
    security: 'tls',
    // Certificat auto-signé de GreenMail : uniquement pour les tests.
    tls: { reject_unauthorized: false, min_version: 'TLSv1.2' },
  };
});

afterAll(async () => {
  await gm?.stop();
});

describe('verifyImapLogin (GreenMail)', () => {
  it('accepte des identifiants valides', async () => {
    expect(await verifyImapLogin(target, 'sacha@exemple.com', 'bon-mot-de-passe')).toBe('ok');
  });

  it('refuse un mauvais mot de passe', async () => {
    expect(await verifyImapLogin(target, 'sacha@exemple.com', 'mauvais')).toBe('invalid');
  });

  it('refuse une injection de commande IMAP sans contacter le serveur', async () => {
    expect(await verifyImapLogin(target, 'sacha@exemple.com', 'x\r\na2 LOGOUT')).toBe('invalid');
  });

  it('signale un serveur indisponible', async () => {
    expect(
      await verifyImapLogin({ ...target, port: 1 }, 'sacha@exemple.com', 'x', {
        connectionTimeout: 2_000,
      }),
    ).toBe('unavailable');
  });

  it('refuse un certificat non valide quand la vérification est active', async () => {
    const strict: ServerTarget = { ...target, tls: { ...target.tls, reject_unauthorized: true } };
    expect(await verifyImapLogin(strict, 'sacha@exemple.com', 'bon-mot-de-passe')).toBe(
      'unavailable',
    );
  });
});
