import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fetchPreferences, preferencesKey } from './api/preferences';
import { applyAppearance } from './appearance';
import { resolveLocale, useLocale } from './i18n';

/** Applique les préférences d'apparence et de langue de l'utilisateur connecté. */
export function useAppearanceSync(): void {
  const { setLocale } = useLocale();
  const prefs = useQuery({
    queryKey: preferencesKey,
    queryFn: fetchPreferences,
    staleTime: 60_000,
  });
  const data = prefs.data;
  useEffect(() => {
    if (!data?.theme) return;
    const lang = resolveLocale(data.language);
    applyAppearance({ theme: data.theme, accent: data.accent, density: data.density, lang });
    setLocale(lang);
  }, [data, setLocale]);
}
