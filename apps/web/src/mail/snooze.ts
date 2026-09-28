/** Échéances proposées pour « Reporter » (heure locale de l'utilisateur). */
export type SnoozePreset = 'laterToday' | 'tomorrow' | 'nextWeek';

export function snoozeDate(preset: SnoozePreset, now = new Date()): Date {
  const date = new Date(now);
  switch (preset) {
    case 'laterToday':
      // Dans trois heures, arrondi au quart d'heure suivant.
      date.setMinutes(Math.ceil((date.getMinutes() + 180) / 15) * 15, 0, 0);
      return date;
    case 'tomorrow':
      date.setDate(date.getDate() + 1);
      date.setHours(8, 0, 0, 0);
      return date;
    case 'nextWeek': {
      // Lundi prochain à 8 h (jamais le jour même).
      const days = (8 - date.getDay()) % 7 || 7;
      date.setDate(date.getDate() + days);
      date.setHours(8, 0, 0, 0);
      return date;
    }
  }
}

/** Valeur minimale d'un champ datetime-local (maintenant + 5 minutes), en heure locale. */
export function minLocalInput(now = new Date()): string {
  const d = new Date(now.getTime() + 5 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
