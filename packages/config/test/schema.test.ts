import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify, parse } from 'yaml';
import { ConfigError, ConfigStore, loadConfig, parseConfig, readSecret } from '../src/load.js';

const examplePath = new URL('../../../config/plume.example.yaml', import.meta.url);
const example = readFileSync(examplePath, 'utf8');

function withChange(mutate: (raw: Record<string, any>) => void): string {
  const raw = parse(example) as Record<string, any>;
  mutate(raw);
  return stringify(raw);
}

function expectInvalid(source: string, fragment: string | RegExp) {
  try {
    parseConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(fragment);
    return;
  }
  throw new Error('la configuration aurait dû être refusée');
}

describe('parseConfig', () => {
  it('refuse un fichier vide avec un message explicite', () => {
    expect(() => parseConfig('')).toThrow(/Fichier de configuration vide/);
    expect(() => parseConfig('  \n')).toThrow(/Fichier de configuration vide/);
  });

  it("valide le fichier d'exemple", () => {
    const config = parseConfig(example);
    expect(config.server.public_url).toBe('https://localhost');
    expect(config.domains.map((d) => d.domain)).toEqual(['exemple.com', '*.exemple.fr']);
    expect(config.domains[0]?.tls.reject_unauthorized).toBe(true);
    expect(config.auth.session_ttl).toBe(12 * 3_600_000);
    expect(config.auth.rate_limit.per_account.lockout).toBe(30 * 60_000);
    expect(config.security.max_attachment_size).toBe(25 * 1024 * 1024);
    expect(config.database).toEqual({ kind: 'file', path: '/run/secrets/database_url' });
    expect(config.rules.forward.allowed_destination_domains).toEqual(['exemple.com']);
  });

  it('refuse un champ inconnu à la racine', () => {
    expectInvalid(`${example}\nunknown_section: true\n`, /unknown_section/);
  });

  it('refuse un champ inconnu imbriqué', () => {
    expectInvalid(
      withChange((raw) => {
        raw.domains[0].imap.password = 'secret';
      }),
      /domains\.0\.imap.*password/,
    );
  });

  it('refuse un secret en clair pour la base de données', () => {
    expectInvalid(
      withChange((raw) => {
        raw.database = { url: 'postgres://u:p@h/db' };
      }),
      /database/,
    );
  });

  it('refuse deux sources pour un même secret', () => {
    expectInvalid(
      withChange((raw) => {
        raw.redis = { url_file: '/run/secrets/redis_url', url_env: 'REDIS_URL' };
      }),
      /exactement un/,
    );
  });

  it('accepte un secret par variable d’environnement', () => {
    const config = parseConfig(
      withChange((raw) => {
        raw.redis = { url_env: 'PLUME_REDIS_URL' };
      }),
    );
    expect(config.redis).toEqual({ kind: 'env', name: 'PLUME_REDIS_URL' });
  });

  it('accepte une liste de comptes autorisés (normalisée)', () => {
    const config = parseConfig(
      withChange((raw) => {
        raw.domains[0].accounts = [' Sacha ', 'Alice@Exemple.COM'];
        raw.domains[1].accounts = ['bob@eu.exemple.fr'];
      }),
    );
    expect(config.domains[0]?.accounts).toEqual(['sacha', 'alice@exemple.com']);
    expect(config.domains[1]?.accounts).toEqual(['bob@eu.exemple.fr']);
    expect(parseConfig(example).domains[0]?.accounts).toBeUndefined();
  });

  it.each([
    [[], /liste de comptes vide/],
    [['jean dupont'], /compte invalide/],
    [['a@b@exemple.com'], /compte invalide/],
    [['bob@autre.fr'], /n'appartient pas au domaine/],
  ])('refuse une liste de comptes invalide (%j)', (accounts, fragment) => {
    expectInvalid(
      withChange((raw) => {
        raw.domains[0].accounts = accounts;
      }),
      fragment,
    );
  });

  it('accepte un relais SMTP commun au domaine (secret par fichier ou variable)', () => {
    const config = parseConfig(
      withChange((raw) => {
        raw.domains[0].smtp.auth = {
          username: ' relais@fournisseur.example ',
          password_file: '/run/secrets/smtp_relay',
        };
        raw.domains[1].smtp.auth = {
          username: 'apikey',
          password_env: 'PLUME_SMTP_RELAY_PASSWORD',
        };
      }),
    );
    expect(config.domains[0]?.smtp.auth).toEqual({
      username: 'relais@fournisseur.example',
      password: { kind: 'file', path: '/run/secrets/smtp_relay' },
    });
    expect(config.domains[1]?.smtp.auth?.password).toEqual({
      kind: 'env',
      name: 'PLUME_SMTP_RELAY_PASSWORD',
    });
    // Sans bloc « auth », l'envoi utilise les identifiants de la boîte.
    expect(parseConfig(example).domains[0]?.smtp.auth).toBeUndefined();
  });

  it.each([
    [{ username: 'u', password: 'en-clair' }, /password/],
    [{ username: 'u' }, /password_file.*password_env/],
    [{ username: 'u', password_file: '/a', password_env: 'B' }, /password_file.*password_env/],
    [{ username: '', password_file: '/a' }, /username/],
    [{ username: 'u', password_file: 'relatif' }, /password_file/],
  ])('refuse un relais SMTP mal décrit (%j)', (auth, fragment) => {
    expectInvalid(
      withChange((raw) => {
        raw.domains[0].smtp.auth = auth;
      }),
      fragment,
    );
  });

  it.each([
    [
      'public_url non https',
      (r: any) => (r.server.public_url = 'http://mail.exemple.fr'),
      /public_url/,
    ],
    ['durée invalide', (r: any) => (r.auth.session_ttl = '12 heures'), /durée invalide/],
    [
      'taille invalide',
      (r: any) => (r.security.max_attachment_size = 'beaucoup'),
      /taille invalide/,
    ],
    ['totp inconnu', (r: any) => (r.auth.totp = 'maybe'), /auth\.totp/],
    ['sécurité IMAP en clair', (r: any) => (r.domains[0].imap.security = 'none'), /security/],
    ['port hors bornes', (r: any) => (r.domains[0].imap.port = 70000), /port/],
    ['hôte invalide', (r: any) => (r.domains[0].imap.host = 'imap exemple'), /hôte invalide/],
    ['hôte avec chemin', (r: any) => (r.domains[0].smtp.host = 'mail.fr/x'), /hôte invalide/],
    ['domaine regex', (r: any) => (r.domains[0].domain = '.*'), /domaine invalide/],
    ['joker central', (r: any) => (r.domains[0].domain = 'mail.*.fr'), /domaine invalide/],
    ['domaine en double', (r: any) => (r.domains[1].domain = 'EXEMPLE.com'), /en double/],
    ['liste blanche vide', (r: any) => (r.domains = []), /au moins un domaine/],
    ['CIDR invalide', (r: any) => (r.server.trusted_proxies = ['10.0.0.0/33']), /CIDR/],
    ['idle > session', (r: any) => (r.auth.idle_timeout = '24h'), /idle_timeout/],
    ['PJ > total', (r: any) => (r.security.max_attachment_size = '100MB'), /max_attachment_size/],
    ['chemin relatif', (r: any) => (r.security.master_key_file = 'secrets/key'), /master_key_file/],
    ['mauvais type', (r: any) => (r.rules.enabled = 'yes'), /rules\.enabled/],
  ])('refuse : %s', (_name, mutate, fragment) => {
    expectInvalid(withChange(mutate), fragment);
  });

  it('accepte un hôte IP ou à un seul label (réseau interne)', () => {
    const config = parseConfig(
      withChange((raw) => {
        raw.domains[0].imap.host = 'Dovecot';
        raw.domains[0].smtp.host = '10.0.0.5';
      }),
    );
    expect(config.domains[0]?.imap.host).toBe('dovecot');
    expect(config.domains[0]?.smtp.host).toBe('10.0.0.5');
  });

  it('refuse un YAML syntaxiquement invalide', () => {
    expectInvalid('server: [unterminated', /illisible/);
  });

  it('refuse les clés en double', () => {
    expectInvalid(`${example}\nlogging:\n  level: debug\n`, /illisible/);
  });

  it('refuse une bombe à alias (billion laughs)', () => {
    const lines = ['a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 12; i++) {
      lines.push(
        `a${i}: &a${i} [${Array(10)
          .fill(`*a${i - 1}`)
          .join(', ')}]`,
      );
    }
    expect(() => parseConfig(lines.join('\n'))).toThrow(ConfigError);
  });

  it('refuse un document vide', () => {
    expectInvalid('', /Fichier de configuration vide/);
  });

  it('refuse les balises YAML personnalisées', () => {
    expect(() => parseConfig(`${example}\nextra: !!js/function "function(){}"\n`)).toThrow(
      ConfigError,
    );
  });
});

describe('loadConfig', () => {
  it('signale un fichier absent sans planter', () => {
    expect(() => loadConfig('/nonexistent/plume.yaml')).toThrow(/Impossible de lire/);
  });

  it('refuse un répertoire', () => {
    expect(() => loadConfig(tmpdir())).toThrow(ConfigError);
  });
});

describe('readSecret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plume-secret-'));

  it('lit un fichier en supprimant les espaces', () => {
    const path = join(dir, 's1');
    writeFileSync(path, 'valeur-secrète\n');
    expect(readSecret({ kind: 'file', path })).toBe('valeur-secrète');
  });

  it('refuse un fichier vide', () => {
    const path = join(dir, 's2');
    writeFileSync(path, '\n');
    expect(() => readSecret({ kind: 'file', path })).toThrow(/vide/);
  });

  it("n'inclut jamais le contenu dans l'erreur", () => {
    expect(() => readSecret({ kind: 'env', name: 'PLUME_ABSENT' }, {})).toThrow(/PLUME_ABSENT/);
  });

  it("lit une variable d'environnement", () => {
    expect(readSecret({ kind: 'env', name: 'X' }, { X: ' v ' })).toBe('v');
  });
});

describe('ConfigStore', () => {
  function storeWith(source: string) {
    const dir = mkdtempSync(join(tmpdir(), 'plume-config-'));
    const path = join(dir, 'plume.yaml');
    writeFileSync(path, source);
    return { store: new ConfigStore(path), path };
  }

  it('recharge la liste blanche et signale les domaines retirés', () => {
    const { store, path } = storeWith(example);
    const events: string[][] = [];
    store.on('reload', (_config, result) => events.push(result.removedDomains));
    writeFileSync(
      path,
      withChange((raw) => {
        raw.domains = [raw.domains[0]];
        raw.auth.rate_limit.per_ip.max = 3;
      }),
    );
    const result = store.reload();
    expect(result.removedDomains).toEqual(['*.exemple.fr']);
    expect(store.current.domains).toHaveLength(1);
    expect(store.current.auth.rate_limit.per_ip.max).toBe(3);
    expect(events).toEqual([['*.exemple.fr']]);
  });

  it('ignore les sections non rechargeables', () => {
    const { store, path } = storeWith(example);
    writeFileSync(
      path,
      withChange((raw) => {
        raw.database = { url_file: '/run/secrets/other' };
        raw.security.master_key_file = '/run/secrets/other_key';
        raw.auth.session_ttl = '1h';
      }),
    );
    const result = store.reload();
    expect(result.ignoredSections).toEqual(
      expect.arrayContaining(['database', 'security.master_key_file', 'auth (hors rate_limit)']),
    );
    expect(store.current.database).toEqual({ kind: 'file', path: '/run/secrets/database_url' });
    expect(store.current.security.master_key_file).toBe('/run/secrets/plume_master_key');
    expect(store.current.auth.session_ttl).toBe(12 * 3_600_000);
  });

  it('conserve l’ancienne configuration si la nouvelle est invalide', () => {
    const { store, path } = storeWith(example);
    writeFileSync(path, 'domains: []');
    expect(() => store.reload()).toThrow(ConfigError);
    expect(store.current.domains).toHaveLength(2);
  });
});
