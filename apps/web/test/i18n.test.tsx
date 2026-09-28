import { describe, expect, it } from 'vitest';
import { createTranslator, format } from '../src/i18n';
import { fr } from '../src/i18n/fr';

describe('i18n', () => {
  it('traduit une clé', () => {
    expect(createTranslator('fr')('app.brand.name')).toBe('Plume');
  });

  it('remplace les paramètres sans interpréter de HTML', () => {
    expect(format('Bonjour {nom}', { nom: '<img src=x onerror=alert(1)>' })).toBe(
      'Bonjour <img src=x onerror=alert(1)>',
    );
  });

  it('laisse intacts les paramètres inconnus', () => {
    expect(format('{a} {b}', { a: 1 })).toBe('1 {b}');
  });

  it('ne résout pas les propriétés héritées', () => {
    expect(format('{constructor}', {})).toBe('{constructor}');
  });

  it('respecte le format de clé module.fonctionnalité.clé', () => {
    for (const key of Object.keys(fr)) {
      const parts = key.split('.');
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(parts[0]).toMatch(/^[a-z]+$/);
      for (const part of parts) expect(part).toMatch(/^[a-zA-Z0-9]+$/);
    }
  });
});

describe('langues', () => {
  it('les dictionnaires français et anglais ont exactement les mêmes clés', async () => {
    const { en } = await import('../src/i18n/en');
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    for (const [key, value] of Object.entries(en)) {
      const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(params(value), key).toEqual(params(fr[key as keyof typeof fr]));
    }
  });

  it('résout la langue : préférence explicite, puis navigateur, puis français', async () => {
    const { resolveLocale } = await import('../src/i18n');
    expect(resolveLocale('en', ['fr-FR'])).toBe('en');
    expect(resolveLocale('auto', ['de-DE', 'en-GB'])).toBe('en');
    expect(resolveLocale('auto', ['fr-CA'])).toBe('fr');
    expect(resolveLocale('auto', ['de-DE'])).toBe('fr');
    expect(createTranslator('en')('app.nav.inbox')).toBe('Inbox');
  });
});

describe('apparence', () => {
  it('applique thème, accent, densité et langue au document et les mémorise', async () => {
    const { applyAppearance, APPEARANCE_KEY } = await import('../src/appearance');
    applyAppearance({ theme: 'dark', accent: 'teal', density: 'compact', lang: 'en' });
    const root = document.documentElement;
    expect([
      root.getAttribute('data-theme'),
      root.getAttribute('data-accent'),
      root.getAttribute('data-density'),
      root.getAttribute('lang'),
    ]).toEqual(['dark', 'teal', 'compact', 'en']);
    expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? '{}')).toMatchObject({
      theme: 'dark',
    });
  });
});
