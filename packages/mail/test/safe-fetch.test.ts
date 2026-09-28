import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isPublicAddress,
  safeFetchImage,
  SafeFetchError,
  sniffImageType,
  validateTarget,
} from '../src/safe-fetch.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3d1a1e30000000049454e44ae426082',
  'hex',
);

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '::1',
    '0.0.0.0',
    '::',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '198.18.0.1',
    'pas-une-ip',
  ])('refuse %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:93.184.216.34'])(
    'accepte %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('validateTarget', () => {
  it.each([
    ['http://127.0.0.1/a.png', 'forbidden_address'],
    ['http://[::1]/a.png', 'forbidden_address'],
    ['http://169.254.169.254/latest/meta-data/', 'forbidden_address'],
    ['http://10.1.2.3/', 'forbidden_address'],
    ['http://172.16.0.5/', 'forbidden_address'],
    ['http://192.168.0.1/', 'forbidden_address'],
    ['http://0.0.0.0/', 'forbidden_address'],
    ['http://[::ffff:127.0.0.1]/', 'forbidden_address'],
    ['http://2130706433/', 'forbidden_address'], // 127.0.0.1 en décimal
    ['http://0x7f.0.0.1/', 'forbidden_address'],
    ['http://0177.0.0.1/', 'forbidden_address'],
    ['http://localhost/', 'forbidden_address'],
    ['http://intranet/', 'forbidden_address'],
    ['http://a.localhost/', 'forbidden_address'],
    ['ftp://example.org/a.png', 'forbidden_scheme'],
    ['file:///etc/passwd', 'forbidden_scheme'],
    ['javascript:alert(1)', 'forbidden_scheme'],
    ['gopher://example.org/', 'forbidden_scheme'],
    ['http://user:pass@example.org/', 'credentials_in_url'],
    ['http://example.org:22/', 'forbidden_port'],
    ['http://example.org:6379/', 'forbidden_port'],
    ['pas une url', 'invalid_url'],
  ])('refuse %s (%s)', (url, reason) => {
    expect(() => validateTarget(url)).toThrow(new SafeFetchError(reason));
  });

  it('accepte une URL publique ordinaire', () => {
    expect(validateTarget('https://images.example.org/logo.png').hostname).toBe(
      'images.example.org',
    );
  });
});

describe('sniffImageType', () => {
  it('reconnaît un PNG et refuse SVG et HTML', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<html><script>'))).toBeNull();
  });
});

describe('safeFetchImage (serveurs locaux)', () => {
  // 127.0.0.1 joue le rôle d'un hôte « public » ; 127.0.0.2 celui d'un hôte interne.
  const policy = (address: string) => address === '127.0.0.1';
  let allowed: Server;
  let internal: Server;
  let port = 0;
  let internalPort = 0;

  const fakeDns = (map: Record<string, string>) =>
    ((hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
      const address = map[hostname];
      if (!address) return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      callback(null, [{ address, family: 4 }]);
    }) as never;

  beforeAll(async () => {
    allowed = createServer((req, res) => {
      switch (req.url) {
        case '/image.png':
          res.writeHead(200, { 'content-type': 'image/png', 'set-cookie': 'track=1' });
          return res.end(PNG);
        case '/fake.png':
          res.writeHead(200, { 'content-type': 'image/png' });
          return res.end('<svg onload="window.__xss=1"/>');
        case '/big.png':
          res.writeHead(200, { 'content-type': 'image/png' });
          return res.end(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
        case '/to-internal':
          res.writeHead(302, { location: `http://127.0.0.2:${internalPort}/secret` });
          return res.end();
        case '/to-internal-name':
          res.writeHead(302, { location: `http://interne.test:${internalPort}/secret` });
          return res.end();
        case '/loop':
          res.writeHead(302, { location: '/loop' });
          return res.end();
        case '/slow':
          return; // ne répond jamais
        case '/echo-headers':
          res.writeHead(200, { 'content-type': 'image/png' });
          return res.end(Buffer.concat([PNG, Buffer.from(JSON.stringify(req.headers))]));
        default:
          res.writeHead(404);
          return res.end();
      }
    });
    internal = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    });
    await new Promise<void>((resolve) => allowed.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => internal.listen(0, '127.0.0.2', resolve));
    port = (allowed.address() as AddressInfo).port;
    internalPort = (internal.address() as AddressInfo).port;
  });

  afterAll(() => {
    allowed.close();
    internal.close();
  });

  const opts = () => ({
    addressPolicy: policy,
    allowedPorts: new Set([String(port), String(internalPort)]),
    lookup: fakeDns({ 'images.test': '127.0.0.1', 'interne.test': '127.0.0.2' }),
  });

  it('récupère une image et vérifie son type réel', async () => {
    const image = await safeFetchImage(`http://images.test:${port}/image.png`, opts());
    expect(image.contentType).toBe('image/png');
    expect(image.body.equals(PNG)).toBe(true);
  });

  it("n'envoie ni cookie ni référent", async () => {
    const image = await safeFetchImage(`http://images.test:${port}/echo-headers`, opts());
    const headers = JSON.parse(image.body.subarray(PNG.length).toString());
    expect(headers.cookie).toBeUndefined();
    expect(headers.referer).toBeUndefined();
  });

  it('refuse un contenu qui n’est pas une image (SVG déguisé)', async () => {
    await expect(safeFetchImage(`http://images.test:${port}/fake.png`, opts())).rejects.toThrow(
      new SafeFetchError('not_an_image'),
    );
  });

  it('limite la taille', async () => {
    await expect(
      safeFetchImage(`http://images.test:${port}/big.png`, { ...opts(), maxBytes: 1024 * 1024 }),
    ).rejects.toThrow(new SafeFetchError('too_large'));
  });

  it('refuse une redirection vers une adresse interne', async () => {
    await expect(safeFetchImage(`http://images.test:${port}/to-internal`, opts())).rejects.toThrow(
      new SafeFetchError('forbidden_address'),
    );
  });

  it('refuse une redirection vers un nom résolu en adresse interne', async () => {
    await expect(
      safeFetchImage(`http://images.test:${port}/to-internal-name`, opts()),
    ).rejects.toThrow(new SafeFetchError('forbidden_address'));
  });

  it('refuse un nom résolu en adresse interne (DNS rebinding)', async () => {
    let calls = 0;
    // Aucune résolution préalable n'est faite : seule celle effectuée au moment de la connexion
    // compte, et c'est elle qui est vérifiée (pas de fenêtre entre vérification et connexion).
    const rebinding = ((_h: string, _o: unknown, cb: (...a: unknown[]) => void) => {
      calls += 1;
      cb(null, [{ address: '127.0.0.2', family: 4 }]);
    }) as never;
    await expect(
      safeFetchImage(`http://rebind.test:${internalPort}/x.png`, { ...opts(), lookup: rebinding }),
    ).rejects.toThrow(new SafeFetchError('forbidden_address'));
    expect(calls).toBeGreaterThan(0);
  });

  it('refuse un nom dont une des adresses est interne', async () => {
    const mixed = ((_h: string, _o: unknown, cb: (...a: unknown[]) => void) => {
      cb(null, [
        { address: '127.0.0.1', family: 4 },
        { address: '127.0.0.2', family: 4 },
      ]);
    }) as never;
    await expect(
      safeFetchImage(`http://mixte.test:${port}/image.png`, { ...opts(), lookup: mixed }),
    ).rejects.toThrow(new SafeFetchError('forbidden_address'));
  });

  it('limite le nombre de redirections', async () => {
    await expect(safeFetchImage(`http://images.test:${port}/loop`, opts())).rejects.toThrow(
      new SafeFetchError('too_many_redirects'),
    );
  });

  it('limite la durée', async () => {
    await expect(
      safeFetchImage(`http://images.test:${port}/slow`, { ...opts(), timeoutMs: 300 }),
    ).rejects.toThrow(SafeFetchError);
  });

  it('refuse une adresse IP interne littérale même si le port est autorisé', async () => {
    await expect(safeFetchImage(`http://127.0.0.2:${internalPort}/x.png`, opts())).rejects.toThrow(
      new SafeFetchError('forbidden_address'),
    );
  });
});
