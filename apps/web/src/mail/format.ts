import type { Address } from '../api/mail';
import { getLocale } from '../i18n';

const TAGS = { fr: 'fr-FR', en: 'en-GB' } as const;
const cache = new Map<string, Intl.DateTimeFormat>();

/** Formateur de date pour la langue courante (mis en cache). */
function dateFormat(name: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = getLocale();
  const key = `${locale}:${name}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(TAGS[locale], options);
    cache.set(key, formatter);
  }
  return formatter;
}

const timeFormat = () => dateFormat('time', { hour: '2-digit', minute: '2-digit' });
const dayFormat = () => dateFormat('day', { day: 'numeric', month: 'short' });
const yearFormat = () => dateFormat('year', { day: 'numeric', month: 'short', year: 'numeric' });
const fullFormat = () => dateFormat('full', { dateStyle: 'full', timeStyle: 'short' });

/** Date courte pour la liste : heure si aujourd'hui, jour et mois cette année, sinon avec l'année. */
export function formatListDate(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === now.toDateString()) return timeFormat().format(date);
  if (date.getFullYear() === now.getFullYear()) return dayFormat().format(date);
  return yearFormat().format(date);
}

export function formatFullDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : fullFormat().format(date);
}

export function formatSize(bytes: number): string {
  const en = getLocale() === 'en';
  if (bytes < 1024) return `${bytes} ${en ? 'B' : 'o'}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ${en ? 'KB' : 'Ko'}`;
  const mb = (bytes / 1024 / 1024).toFixed(1);
  return en ? `${mb} MB` : `${mb.replace('.', ',')} Mo`;
}

export function displayName(address: Address | undefined): string {
  if (!address) return '';
  return address.name.trim() || address.address;
}

export function formatAddress(address: Address): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

/** Initiales pour l'avatar (texte brut, jamais interprété). */
export function initials(address: Address | undefined): string {
  const source = displayName(address)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();
  const parts = source.split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : source.slice(0, 2);
  return letters.toUpperCase() || '?';
}
