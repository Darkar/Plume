import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED, redactSensitive } from '../src/logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, stream };
}

describe('redactSensitive', () => {
  it('masque les champs sensibles à toute profondeur', () => {
    const input = {
      user: 'a@b.fr',
      password: 'hunter2',
      nested: { imapPassword: 'x', token: 't', list: [{ sessionId: 's', ok: 1 }] },
      mail: { subject: 'ok', html: '<p>secret</p>', body: 'texte' },
    };
    expect(redactSensitive(input)).toEqual({
      user: 'a@b.fr',
      password: REDACTED,
      nested: { imapPassword: REDACTED, token: REDACTED, list: [{ sessionId: REDACTED, ok: 1 }] },
      mail: { subject: 'ok', html: REDACTED, body: REDACTED },
    });
  });

  it('limite la profondeur (structures cycliques ou très imbriquées)', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(JSON.stringify(redactSensitive(deep))).toContain('profondeur max');
  });
});

describe('createLogger', () => {
  it("n'écrit jamais les secrets", () => {
    const { lines, stream } = capture();
    const logger = createLogger({ level: 'info', format: 'json', name: 'test' }, stream);
    logger.info(
      {
        password: 'hunter2',
        req: { headers: { cookie: '__Host-plume_sid=abc', authorization: 'Bearer x' } },
        credentials: { user: 'u', pass: 'p' },
      },
      'connexion',
    );
    const output = lines.join('');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('__Host-plume_sid=abc');
    expect(output).not.toContain('Bearer x');
    expect(output).toContain('connexion');
  });
});

describe('instances', () => {
  it('laisse les instances aux sérialiseurs', () => {
    class Requete {
      url = '/api/v1/messages';
    }
    const req = new Requete();
    expect((redactSensitive({ req }) as { req: unknown }).req).toBe(req);
  });
});
