import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { en } from './en';
import { fr, type MessageKey, type Messages } from './fr';

export type Locale = 'fr' | 'en';
const catalogs: Record<Locale, Messages> = { fr, en };

export type TranslateParams = Record<string, string | number>;
export type Translate = (key: MessageKey, params?: TranslateParams) => string;

/**
 * Remplace les paramètres « {nom} ». Le résultat est toujours rendu comme texte par React
 * (jamais via innerHTML), donc aucune donnée n'est interprétée comme du HTML.
 */
export function format(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function createTranslator(locale: string): Translate {
  const messages = catalogs[locale as Locale] ?? fr;
  return (key, params) => format(messages[key] ?? fr[key] ?? key, params);
}

/** Langue effective : préférence explicite, sinon celle du navigateur (français par défaut). */
export function resolveLocale(
  preference: 'auto' | Locale | undefined,
  languages?: readonly string[],
): Locale {
  if (preference === 'fr' || preference === 'en') return preference;
  const list = languages ?? (typeof navigator !== 'undefined' ? navigator.languages : []);
  for (const lang of list) {
    const base = lang.toLowerCase().split('-')[0];
    if (base === 'fr') return 'fr';
    if (base === 'en') return 'en';
  }
  return 'fr';
}

/** Langue courante, lue par les fonctions de mise en forme (dates, tailles). */
let currentLocale: Locale = 'fr';
export function getLocale(): Locale {
  return currentLocale;
}

interface I18nValue {
  t: Translate;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nValue>({
  t: createTranslator('fr'),
  locale: 'fr',
  setLocale: () => undefined,
});

function initialLocale(): Locale {
  if (typeof document === 'undefined') return 'fr';
  const lang = document.documentElement.getAttribute('lang');
  return lang === 'en' ? 'en' : 'fr';
}

export function I18nProvider({ locale, children }: { locale?: Locale; children: ReactNode }) {
  const [state, setState] = useState<Locale>(locale ?? initialLocale());
  currentLocale = state;
  const setLocale = useCallback((next: Locale) => {
    currentLocale = next;
    if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', next);
    setState(next);
  }, []);
  const value = useMemo(
    () => ({ t: createTranslator(state), locale: state, setLocale }),
    [state, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  return useContext(I18nContext).t;
}

export function useLocale(): Pick<I18nValue, 'locale' | 'setLocale'> {
  const { locale, setLocale } = useContext(I18nContext);
  return { locale, setLocale };
}
