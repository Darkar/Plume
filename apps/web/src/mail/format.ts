import type { Address, InvitationTime } from '../api/mail';
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

const eventDayFormat = () =>
  dateFormat('eventDay', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** Horodatage d'un événement en date locale (heure « flottante » et journée : sans conversion). */
function eventDate(time: InvitationTime): Date | null {
  if (time.kind === 'utc') {
    const date = new Date(time.value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const [datePart = '', timePart = '00:00:00'] = time.value.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, mi, sec] = timePart.split(':').map(Number);
  const parts = [y, m, d, h, mi, sec];
  if (parts.length !== 6 || !parts.every((n) => Number.isInteger(n))) return null;
  const date = new Date(y as number, (m as number) - 1, d, h, mi, sec);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Période d'un événement, dans le fuseau du navigateur : « jeudi 15 octobre 2026, 14:00 – 15:00 ».
 * Journée entière : la fin iCalendar est exclusive (lendemain du dernier jour).
 */
export function formatEventRange(
  start: InvitationTime | null,
  end: InvitationTime | null,
): { text: string; allDay: boolean } | null {
  const from = start ? eventDate(start) : null;
  if (!start || !from) return null;
  const day = eventDayFormat();
  const to = end ? eventDate(end) : null;
  if (start.kind === 'date') {
    const last = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() - 1) : from;
    const text =
      last > from && last.toDateString() !== from.toDateString()
        ? `${day.format(from)} – ${day.format(last)}`
        : day.format(from);
    return { text, allDay: true };
  }
  const time = timeFormat();
  if (!to) return { text: `${day.format(from)}, ${time.format(from)}`, allDay: false };
  const text =
    to.toDateString() === from.toDateString()
      ? `${day.format(from)}, ${time.format(from)} – ${time.format(to)}`
      : `${day.format(from)}, ${time.format(from)} – ${day.format(to)}, ${time.format(to)}`;
  return { text, allDay: false };
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
