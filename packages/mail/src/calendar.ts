import ICAL from 'ical.js';
import { isValidRecipient } from './compose.js';
import type { AttachmentInfo } from './mailbox.js';

/**
 * Invitations (iCalendar, RFC 5545) reçues par courriel et réponses iMIP (RFC 6047). Le contenu
 * d'un `.ics` vient de l'expéditeur : il est lu ici, côté serveur, avec des limites, et seules des
 * données structurées en texte brut sont exposées à l'interface.
 */

/** Taille maximale d'une invitation analysée. */
export const MAX_INVITATION_BYTES = 256 * 1024;
const MAX_ATTENDEES = 100;

export type InvitationMethod = 'REQUEST' | 'CANCEL' | 'REPLY' | 'PUBLISH' | 'OTHER';
export type ParticipationStatus =
  'accepted' | 'tentative' | 'declined' | 'needs-action' | 'delegated';
export type ReplyStatus = 'accepted' | 'tentative' | 'declined';

export interface CalendarAddress {
  name: string;
  email: string;
}

export interface InvitationAttendee extends CalendarAddress {
  status: ParticipationStatus;
}

/**
 * Horodatage : instant UTC (ISO), journée entière (AAAA-MM-JJ) ou heure « flottante » (sans
 * fuseau, à afficher telle quelle).
 */
export interface InvitationTime {
  kind: 'utc' | 'date' | 'floating';
  value: string;
}

export interface Invitation {
  method: InvitationMethod;
  uid: string;
  sequence: number;
  summary: string;
  location: string;
  description: string;
  start: InvitationTime | null;
  end: InvitationTime | null;
  /** Événement récurrent (RRULE ou RDATE). */
  recurring: boolean;
  /** Ne concerne qu'une occurrence d'un événement récurrent (RECURRENCE-ID). */
  occurrence: boolean;
  cancelled: boolean;
  organizer: CalendarAddress | null;
  attendees: InvitationAttendee[];
  /** Nombre total de participants (la liste est tronquée au-delà de 100). */
  attendeeCount: number;
}

const METHODS = new Set(['REQUEST', 'CANCEL', 'REPLY', 'PUBLISH']);
const PARTSTAT: Record<string, ParticipationStatus> = {
  ACCEPTED: 'accepted',
  TENTATIVE: 'tentative',
  DECLINED: 'declined',
  DELEGATED: 'delegated',
};
const REPLY_PARTSTAT: Record<ReplyStatus, string> = {
  accepted: 'ACCEPTED',
  tentative: 'TENTATIVE',
  declined: 'DECLINED',
};

/** Partie MIME portant l'invitation : text/calendar d'abord, puis un fichier .ics joint. */
export function invitationPart(attachments: AttachmentInfo[]): AttachmentInfo | null {
  return (
    attachments.find((a) => a.contentType === 'text/calendar') ??
    attachments.find((a) => a.contentType === 'application/ics') ??
    attachments.find((a) => /\.ics$/i.test(a.filename)) ??
    null
  );
}

/** Texte brut : caractères de contrôle retirés (sauf retours à la ligne si permis), tronqué. */
function cleanText(value: unknown, maxLength: number, multiline: boolean): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (multiline && char === '\n') out += '\n';
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) out += ' ';
    else if (code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e)) out += ' ';
    else out += char;
  }
  const normalized = multiline
    ? out
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : out.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, maxLength);
}

interface ParsedCalendar {
  calendar: ICAL.Component;
  event: ICAL.Component;
  zones: Map<string, ICAL.Timezone>;
}

function parseCalendar(ics: string): ParsedCalendar | null {
  if (Buffer.byteLength(ics, 'utf8') > MAX_INVITATION_BYTES) return null;
  let jcal: unknown;
  try {
    jcal = ICAL.parse(ics);
  } catch {
    return null;
  }
  if (!Array.isArray(jcal) || jcal.length === 0) return null;
  // Plusieurs VCALENDAR : ICAL.parse renvoie une liste ; seul le premier est lu.
  const root = typeof jcal[0] === 'string' ? jcal : jcal[0];
  let calendar: ICAL.Component;
  try {
    calendar = new ICAL.Component(root as unknown[]);
  } catch {
    return null;
  }
  if (calendar.name !== 'vcalendar') return null;
  const event = calendar.getFirstSubcomponent('vevent');
  if (!event) return null;
  const zones = new Map<string, ICAL.Timezone>();
  for (const component of calendar.getAllSubcomponents('vtimezone')) {
    try {
      const zone = new ICAL.Timezone(component);
      if (zone.tzid) zones.set(zone.tzid, zone);
    } catch {
      // Définition de fuseau invalide : les heures concernées seront traitées sans elle.
    }
  }
  return { calendar, event, zones };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Décalage (ms) d'un fuseau IANA à un instant donné, ou null si le fuseau est inconnu. */
function zoneOffset(ms: number, timeZone: string): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms));
  } catch {
    return null;
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Number.isNaN(local) ? null : local - Math.floor(ms / 1000) * 1000;
}

/** Heure murale d'un fuseau IANA convertie en instant UTC (TZID sans VTIMEZONE). */
function zonedToUtc(time: ICAL.Time, timeZone: string): number | null {
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const first = zoneOffset(wall, timeZone);
  if (first === null) return null;
  const second = zoneOffset(wall - first, timeZone);
  return second === null ? null : wall - second;
}

function utc(date: Date): InvitationTime | null {
  return Number.isNaN(date.getTime()) ? null : { kind: 'utc', value: date.toISOString() };
}

function floating(time: ICAL.Time): InvitationTime {
  return {
    kind: 'floating',
    value: `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`,
  };
}

function timeOf(
  prop: ICAL.Property | null,
  zones: Map<string, ICAL.Timezone>,
): InvitationTime | null {
  if (!prop) return null;
  const value = prop.getFirstValue();
  if (!(value instanceof ICAL.Time)) return null;
  if (value.isDate) {
    return { kind: 'date', value: `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}` };
  }
  const tzid = prop.getParameter('tzid');
  if (typeof tzid === 'string' && tzid) {
    const zone = zones.get(tzid);
    if (zone) {
      const zoned = value.clone();
      zoned.zone = zone;
      return utc(zoned.toJSDate());
    }
    const ms = zonedToUtc(value, tzid);
    // Fuseau ni défini dans le fichier ni connu (nom Windows…) : heure affichée telle quelle.
    return ms === null ? floating(value) : utc(new Date(ms));
  }
  if (value.zone === ICAL.Timezone.utcTimezone || value.zone?.tzid === 'UTC') {
    return utc(value.toJSDate());
  }
  return floating(value);
}

function addressOf(prop: ICAL.Property): CalendarAddress | null {
  const raw = prop.getFirstValue();
  if (typeof raw !== 'string') return null;
  const email = raw
    .replace(/^mailto:/i, '')
    .trim()
    .toLowerCase();
  if (!isValidRecipient(email)) return null;
  return { name: cleanText(prop.getParameter('cn'), 200, false), email };
}

/** Analyse une invitation ; null si le contenu n'est pas un événement exploitable. */
export function parseInvitation(ics: string): Invitation | null {
  const parsed = parseCalendar(ics);
  if (!parsed) return null;
  const { calendar, event, zones } = parsed;
  const uid = cleanText(event.getFirstPropertyValue('uid'), 255, false);
  if (!uid) return null;

  const rawMethod = String(calendar.getFirstPropertyValue('method') ?? 'PUBLISH').toUpperCase();
  const method = (METHODS.has(rawMethod) ? rawMethod : 'OTHER') as InvitationMethod;
  const sequence = Number(event.getFirstPropertyValue('sequence') ?? 0);
  const start = timeOf(event.getFirstProperty('dtstart'), zones);
  let end = timeOf(event.getFirstProperty('dtend'), zones);
  if (!end && start) {
    // Durée (DURATION) plutôt qu'une fin explicite.
    const duration = event.getFirstPropertyValue('duration');
    if (duration instanceof ICAL.Duration && start.kind === 'utc') {
      end = utc(new Date(new Date(start.value).getTime() + duration.toSeconds() * 1000));
    }
  }

  const organizerProp = event.getFirstProperty('organizer');
  const attendeeProps = event.getAllProperties('attendee');
  const attendees: InvitationAttendee[] = [];
  for (const prop of attendeeProps.slice(0, MAX_ATTENDEES)) {
    const address = addressOf(prop);
    if (!address) continue;
    const partstat = String(prop.getParameter('partstat') ?? '').toUpperCase();
    attendees.push({ ...address, status: PARTSTAT[partstat] ?? 'needs-action' });
  }

  return {
    method,
    uid,
    sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0,
    summary: cleanText(event.getFirstPropertyValue('summary'), 500, false),
    location: cleanText(event.getFirstPropertyValue('location'), 500, false),
    description: cleanText(event.getFirstPropertyValue('description'), 5000, true),
    start,
    end,
    recurring: event.hasProperty('rrule') || event.hasProperty('rdate'),
    occurrence: event.hasProperty('recurrence-id'),
    cancelled:
      method === 'CANCEL' ||
      String(event.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED',
    organizer: organizerProp ? addressOf(organizerProp) : null,
    attendees,
    attendeeCount: attendeeProps.length,
  };
}

function addressProperty(name: 'organizer' | 'attendee', address: CalendarAddress): ICAL.Property {
  const prop = new ICAL.Property(name);
  prop.setValue(`mailto:${address.email}`);
  if (address.name) prop.setParameter('cn', address.name);
  return prop;
}

/**
 * Réponse iMIP (METHOD:REPLY) à une invitation : seuls l'identifiant de l'événement, sa
 * séquence, l'occurrence visée et l'organisateur sont repris de l'original (RFC 5546, 3.2.3).
 */
export function buildInvitationReply(
  ics: string,
  attendee: CalendarAddress,
  status: ReplyStatus,
  now = new Date(),
): { content: string; organizer: CalendarAddress; summary: string } | null {
  const parsed = parseCalendar(ics);
  if (!parsed) return null;
  const invitation = parseInvitation(ics);
  if (!invitation?.organizer || invitation.method !== 'REQUEST') return null;
  const { event, zones } = parsed;

  const calendar = new ICAL.Component(['vcalendar', [], []]);
  calendar.updatePropertyWithValue('prodid', '-//Plume//Plume//FR');
  calendar.updatePropertyWithValue('version', '2.0');
  calendar.updatePropertyWithValue('method', 'REPLY');
  const reply = new ICAL.Component('vevent');
  reply.updatePropertyWithValue('uid', invitation.uid);
  reply.updatePropertyWithValue('sequence', invitation.sequence);
  reply.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(now, true));
  if (invitation.summary) reply.updatePropertyWithValue('summary', invitation.summary);
  reply.addProperty(addressProperty('organizer', invitation.organizer));
  const me = addressProperty('attendee', attendee);
  me.setParameter('partstat', REPLY_PARTSTAT[status]);
  reply.addProperty(me);

  const occurrence = event.getFirstProperty('recurrence-id');
  if (occurrence) {
    const value = occurrence.getFirstValue();
    if (value instanceof ICAL.Time) {
      const copy = new ICAL.Property('recurrence-id');
      copy.setValue(value);
      const tzid = occurrence.getParameter('tzid');
      if (typeof tzid === 'string' && tzid) {
        copy.setParameter('tzid', tzid);
        // Le fuseau de l'occurrence doit être défini dans la réponse.
        const zone = zones.get(tzid);
        if (zone?.component) calendar.addSubcomponent(new ICAL.Component(zone.component.toJSON()));
      }
      reply.addProperty(copy);
    }
  }
  calendar.addSubcomponent(reply);
  return {
    content: calendar.toString(),
    organizer: invitation.organizer,
    summary: invitation.summary,
  };
}
