import { describe, expect, it } from 'vitest';
import {
  matchAccount,
  matchDomain,
  normalizeDomain,
  normalizeDomainPattern,
  normalizeEmail,
} from '../src/domains.js';

describe('normalizeEmail', () => {
  it('normalise la casse et les espaces', () => {
    expect(normalizeEmail('  Sacha@Exemple.COM ')).toEqual({
      address: 'sacha@exemple.com',
      local: 'sacha',
      domain: 'exemple.com',
    });
  });

  it('convertit les domaines IDN en punycode', () => {
    expect(normalizeEmail('a@exémple.fr')?.domain).toBe('xn--exmple-cva.fr');
  });

  it('convertit les homoglyphes en un domaine distinct', () => {
    // « a » cyrillique (U+0430) à la place du « a » latin.
    const result = normalizeEmail('user@m\u{430}gnan.one');
    expect(result).not.toBeNull();
    expect(result?.domain).not.toBe('exemple.com');
    expect(result?.domain.startsWith('xn--')).toBe(true);
  });

  it.each([
    ['user@evil.com@exemple.com', 'plusieurs @'],
    ['user@', 'domaine vide'],
    ['@exemple.com', 'partie locale vide'],
    ['user', 'sans @'],
    ['us er@exemple.com', 'espace interne'],
    ['user@exemple .com', 'espace dans le domaine'],
    ['user\u0000@exemple.com', 'caractère nul'],
    ['user@exemple.com\u0000', 'caractère nul final'],
    ['user@exemple.com\r\nRCPT TO:<x@y.z>', 'CRLF'],
    ['user\t@exemple.com', 'tabulation'],
    ['user\u{200b}@exemple.com', 'espace de largeur nulle'],
    ['user@exemple.com\u{202e}', 'contrôle bidi'],
    ['user@localhost', 'domaine sans point'],
    ['user@127.0.0.1', 'adresse IP'],
    ['user@[127.0.0.1]', 'littéral IP'],
    ['.user@exemple.com', 'point initial'],
    ['us..er@exemple.com', 'points consécutifs'],
    ['"user"@exemple.com', 'partie locale entre guillemets'],
    ['user@-exemple.com', 'label commençant par un tiret'],
    ['user@exemple.com.', 'point final'],
    ['user@exemple..com', 'label vide'],
    ['user@mag_nan.one', 'souligné'],
    [`${'a'.repeat(65)}@exemple.com`, 'partie locale trop longue'],
    [`a@${'b'.repeat(250)}.one`, 'adresse trop longue'],
    ['user@exemple.com/../x', 'chemin'],
    ['user@exemple.com:993', 'port'],
  ])('rejette %j (%s)', (input) => {
    expect(normalizeEmail(input)).toBeNull();
  });

  it.each([null, undefined, 42, {}, ['a@b.fr']])('rejette les non-chaînes (%j)', (input) => {
    expect(normalizeEmail(input)).toBeNull();
  });

  it('accepte les caractères autorisés de la partie locale', () => {
    expect(normalizeEmail("first.last+tag-x_y'z@exemple.com")?.local).toBe("first.last+tag-x_y'z");
  });
});

describe('normalizeDomain', () => {
  it('rejette un TLD numérique', () => {
    expect(normalizeDomain('10.0.0.1')).toBeNull();
  });
  it('accepte un domaine valide', () => {
    expect(normalizeDomain('Mail.Exemple.FR')).toBe('mail.exemple.fr');
  });
});

describe('normalizeDomainPattern', () => {
  it.each([
    ['exemple.com', 'exemple.com'],
    ['*.Exemple.fr', '*.exemple.fr'],
    ['*.exémple.fr', '*.xn--exmple-cva.fr'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeDomainPattern(input)).toBe(expected);
  });

  it.each(['*', '*.', '*.*.fr', 'a.*.fr', '*exemple.fr', '**.exemple.fr', '*.fr.', 'fr', '.fr'])(
    'rejette %j',
    (input) => {
      expect(normalizeDomainPattern(input)).toBeNull();
    },
  );
});

describe('matchDomain', () => {
  const entries = [
    { domain: 'exemple.com', id: 'exact' },
    { domain: '*.exemple.fr', id: 'wild' },
    { domain: '*.eu.exemple.fr', id: 'wild-eu' },
    { domain: 'special.exemple.fr', id: 'special' },
  ];

  it.each([
    ['exemple.com', 'exact'],
    ['a.exemple.fr', 'wild'],
    ['a.b.exemple.fr', 'wild'],
    ['x.eu.exemple.fr', 'wild-eu'],
    ['special.exemple.fr', 'special'],
  ])('%s → %s', (domain, id) => {
    expect(matchDomain(entries, domain)?.id).toBe(id);
  });

  it.each([
    'exemple.fr', // le joker n'inclut pas le domaine lui-même
    'sub.exemple.com', // pas de sous-domaine sans joker
    'evilexemple.fr', // suffixe sans point
    'exemple.com.evil.com',
    'evil.com',
    'xn--mgnan-2ve.one',
    '',
  ])('refuse %j', (domain) => {
    expect(matchDomain(entries, domain)).toBeNull();
  });
});

describe('matchAccount', () => {
  const entries = [
    { domain: 'exemple.com', accounts: ['sacha', 'alice@exemple.com'] },
    { domain: '*.exemple.fr', accounts: ['bob@eu.exemple.fr'] },
    { domain: 'libre.fr' },
  ];

  it.each([
    ['sacha@exemple.com', 'exemple.com'],
    ['alice@exemple.com', 'exemple.com'],
    ['bob@eu.exemple.fr', '*.exemple.fr'],
    ['nimporte@libre.fr', 'libre.fr'],
  ])('autorise %s', (email, domain) => {
    expect(matchAccount(entries, email)?.domain).toBe(domain);
  });

  it.each([
    'bob@exemple.com',
    'sacha@eu.exemple.fr',
    'bob@fr.exemple.fr',
    'sacha@autre.fr',
    'pas-une-adresse',
  ])('refuse %s', (email) => {
    expect(matchAccount(entries, email)).toBeNull();
  });
});
