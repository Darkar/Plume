import { useEffect, useState } from 'react';
import type { Preferences } from './api/preferences';

/** Clé de la copie locale (non sensible) lue par le script d'avant rendu de index.html. */
export const APPEARANCE_KEY = 'plume:appearance';

export type Appearance = Pick<Preferences, 'theme' | 'accent' | 'density'> & { lang?: 'fr' | 'en' };

/** Applique l'apparence au document et la mémorise pour le prochain chargement. */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', appearance.theme);
  root.setAttribute('data-accent', appearance.accent);
  root.setAttribute('data-density', appearance.density);
  if (appearance.lang) root.setAttribute('lang', appearance.lang);
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
  } catch {
    // Stockage indisponible (navigation privée…) : l'apparence reste appliquée pour la session.
  }
}

/** Thème réellement affiché (« auto » résolu par la préférence système). */
export function effectiveTheme(): 'light' | 'dark' {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'light' || theme === 'dark') return theme;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** Suit le thème effectif : changement de préférence ou du réglage système. */
export function useEffectiveTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(effectiveTheme);
  useEffect(() => {
    const update = () => setTheme(effectiveTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const media =
      typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    media?.addEventListener('change', update);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', update);
    };
  }, []);
  return theme;
}
